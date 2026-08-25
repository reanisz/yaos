/**
 * The Access-gated /admin surface: a page for managing per-vault tokens, plus
 * the small JSON API it drives.
 *
 * # The gate
 * Cloudflare Access protects a hostname, not a Worker script.  The same script
 * stays reachable on workers.dev, where Access never runs, so "the request got
 * here" proves nothing and the Cf-Access-Jwt-Assertion header proves nothing
 * either — anyone can set a header.  verifyAccessJwt() checking the signature,
 * issuer and audience against the team's JWKS is the actual gate; see the
 * header comment of accessJwt.ts.
 *
 * # Off by default, and invisible when off
 * getAccessConfig(env) returns null unless BOTH Access variables are set and
 * well formed.  index.ts reclassifies every /admin shape as not-found in that
 * case, so a deployment that never opted in answers the ordinary 404 — same
 * body, same headers, same log bucket — and this module is never entered.
 * Nothing here may weaken that: the first thing every path below must be able
 * to say is that it cost zero Durable Object calls and zero subrequests.
 *
 * # CSRF posture — why admin responses NEVER get withCors
 * The rest of the /api surface authenticates with a bearer token, which a
 * browser never attaches on its own; a cross-origin page can therefore be
 * allowed to read those responses because it has no credential to replay.
 * Access is different: it authenticates with the CF_Authorization cookie,
 * which IS ambient.  Any page the operator visits can make their browser send
 * an authenticated request here.  Two things keep that from mattering:
 *
 *   1. No CORS headers, ever.  A cross-origin fetch may still be *sent*, but
 *      its response is unreadable, so nothing leaks — and a JSON POST is
 *      preflighted, so the mutating routes are not even reached.
 *   2. The two POST routes require Content-Type: application/json.  The three
 *      content types an HTML form can produce without a preflight (urlencoded,
 *      multipart, text/plain) are refused with 415, which closes the one
 *      cross-site shape that needs no CORS permission to arrive.
 *
 * # Audit trail
 * Every successful mutation through this front door logs one line naming the
 * Access identity that made it.  That identity exists nowhere else: the
 * bearer-token API's caller is an anonymous secret, so it can log nothing
 * comparable.  Failures add nothing beyond the rejection warning above, and no
 * token or label is ever logged.
 *
 * # No secrets in the page
 * The rendered HTML carries nothing but the server's own origin and its auth
 * mode.  Tokens exist only in the JSON body of an issue call, delivered to the
 * page that asked for them, once.
 */

import { verifyAccessJwt, type AccessConfig } from "../accessJwt";
import { normalizeVaultId, normalizeVaultTokenLabel, type StoredServerConfig } from "../config";
import { renderAdminPage } from "../adminPage";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../setupQr";
import { getAuthStateCached } from "./auth";
import { html, json } from "./http";
import type { AuthStateCached, Env } from "./types";
import {
	issueVaultToken,
	listVaultTokens,
	revokeVaultToken,
} from "./vaultTokens";

const LOG_PREFIX = "[yaos-sync:worker]";

/** The header Cloudflare Access stamps on requests it has authenticated. */
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** The four shapes classifyWorkerRoute recognises under /admin. */
export type AdminAction = "page" | "list" | "issue" | "revoke";

/**
 * Log/telemetry bucket for an admin route.  Exported so index.ts's routeBucket
 * and this module's rejection warnings cannot name the same route differently.
 */
export function adminRouteBucket(action: AdminAction): string {
	return action === "page" ? "admin_page" : `admin_api_vault_tokens_${action}`;
}

/**
 * True when the request body is declared as JSON.
 *
 * Parameters are allowed (`application/json; charset=utf-8`) because clients
 * legitimately send them; the essence check is the media type itself, which is
 * the part an HTML form cannot forge.
 */
function isJsonContentType(req: Request): boolean {
	const raw = req.headers.get("Content-Type");
	if (!raw) return false;
	return raw.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * The admin page, with frame protection.
 *
 * This is the one authenticated page in the product, its buttons change state,
 * and Access authenticates it with an ambient cookie — the exact combination
 * clickjacking needs.  Both headers are sent because they are read by
 * different generations of browser, and both say the same thing: this document
 * is never a frame.  JSON responses deliberately do not carry them; a JSON
 * body is not framable content and every header that is not doing work is a
 * header a future reader has to reason about.
 *
 * A new Response is built rather than the headers mutated, matching withCors
 * in routes/http.ts — no assumption about the header guard of a Response the
 * caller constructed.
 */
function adminHtml(body: string): Response {
	const base = html(body);
	const headers = new Headers(base.headers);
	headers.set("Content-Security-Policy", "frame-ancestors 'none'");
	headers.set("X-Frame-Options", "DENY");
	return new Response(base.body, { status: base.status, headers });
}

/**
 * One line per successful mutation, naming who did it.
 *
 * An admin surface without an audit trail cannot answer "who rotated this
 * vault's token last Tuesday", and the Access identity is the only place that
 * answer exists — the bearer-token API has no caller identity at all, which is
 * why it emits nothing.  The actor is logged in full because a truncated
 * identity is not an audit record; the vaultId keeps the truncation convention
 * used by logVaultRejection in index.ts, so it cannot become a correlation
 * handle in exported logs.  The token and the label are never logged.
 *
 * console.debug is the channel every non-warning Worker log in this codebase
 * uses (logWorkerRequest in index.ts is the other), and Cloudflare captures it
 * at the same fidelity as the rest.  The line is self-identifying — "admin
 * audit" — so it is greppable out of the request log it shares the channel
 * with.
 */
function logAdminAudit(action: "issue" | "revoke", vaultId: string, actor: string): void {
	console.debug(
		`${LOG_PREFIX} admin audit: `
		+ JSON.stringify({ action, vaultIdHint: vaultId.slice(0, 8), actor }),
	);
}

async function readAdminBody(req: Request): Promise<{ vaultId?: unknown; label?: unknown } | null> {
	try {
		return await req.json();
	} catch {
		return null;
	}
}

/**
 * The mode gate shared by the three API routes.
 *
 * Env mode has no vault-token map to manage — it makes zero Durable Object
 * calls per request by design, and the map lives in the config DO — so it
 * answers 409 exactly as the bearer-token API does.  An unclaimed server has
 * no operator yet, so there is nothing to issue against.
 *
 * Returns the stored config on success rather than a boolean, so the caller
 * that needs it cannot re-derive it from a state the gate has not narrowed.
 */
type ClaimModeGate =
	| { ok: true; config: StoredServerConfig }
	| { ok: false; response: Response };

function requireClaimMode(authState: AuthStateCached): ClaimModeGate {
	if (authState.mode === "env") {
		return { ok: false, response: json({ error: "unsupported_in_env_mode" }, 409) };
	}
	if (!authState.claimed) {
		return { ok: false, response: json({ error: "unclaimed" }, 503) };
	}
	return { ok: true, config: authState.config };
}

function handleAdminList(authState: AuthStateCached): Response {
	const gate = requireClaimMode(authState);
	if (!gate.ok) return gate.response;
	// Served from the config getAuthStateCached already fetched — no extra DO
	// call, and never a hash: listVaultTokens projects the map explicitly.
	return json({ ok: true, vaultTokens: listVaultTokens(gate.config) });
}

async function handleAdminIssue(
	req: Request,
	env: Env,
	origin: string,
	authState: AuthStateCached,
	actor: string,
): Promise<Response> {
	const gate = requireClaimMode(authState);
	if (!gate.ok) return gate.response;

	const body = await readAdminBody(req);
	if (body === null) return json({ error: "invalid json" }, 400);

	let vaultId: string;
	let label: string | null;
	try {
		vaultId = normalizeVaultId(body.vaultId);
		label = normalizeVaultTokenLabel(body.label);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "invalid request" }, 400);
	}

	const issued = await issueVaultToken(env, origin, vaultId, label);
	if (!issued.ok) {
		return json({ error: issued.failure.error }, issued.failure.status);
	}
	// Audited here rather than after the QR step: the rotation is durable as of
	// this line, and an audit trail that skipped a mutation whose cosmetic
	// follow-up failed would be worse than none.
	logAdminAudit("issue", vaultId, actor);

	// The rotation is already durable, so a QR failure must not become a lost
	// token: the plaintext is deliverable exactly once and this response is that
	// once.  The QR is a convenience for mobile onboarding, so it degrades to
	// null and the page falls back to the deep link and the copy button.
	let mobileSetupQrDataUrl: string | null = null;
	try {
		mobileSetupQrDataUrl = await renderSetupQrDataUrl(
			buildMobileSetupUrl(origin, issued.issued.token, vaultId),
		);
	} catch (err) {
		console.warn(`${LOG_PREFIX} admin setup QR rendering failed:`, err);
	}

	return json({ ok: true, ...issued.issued, mobileSetupQrDataUrl });
}

async function handleAdminRevoke(
	req: Request,
	env: Env,
	authState: AuthStateCached,
	actor: string,
): Promise<Response> {
	const gate = requireClaimMode(authState);
	if (!gate.ok) return gate.response;

	const body = await readAdminBody(req);
	if (body === null) return json({ error: "invalid json" }, 400);

	let vaultId: string;
	try {
		vaultId = normalizeVaultId(body.vaultId);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "invalid request" }, 400);
	}

	const revoked = await revokeVaultToken(env, vaultId);
	if (!revoked.ok) {
		return json({ error: revoked.failure.error }, revoked.failure.status);
	}
	// Audited whether or not a token was there to remove: "who tried to revoke
	// this vault" is as much a part of the trail as "who succeeded", and the
	// response already tells the caller which of the two it was.
	logAdminAudit("revoke", vaultId, actor);
	return json({ ok: true, existed: revoked.existed });
}

/**
 * Handle one /admin request.
 *
 * `access` is passed in rather than re-read because index.ts has already used
 * getAccessConfig() to decide that /admin exists at all on this deployment —
 * and an AccessConfig cannot be constructed any other way, so holding one IS
 * the proof that the check happened.
 *
 * The order below is load bearing.  Nothing touches YAOS_CONFIG, and nothing
 * opens a subrequest, until the JWT has verified:
 *
 *   1. no header            → 401, no JWKS fetch (there is no token to check)
 *   2. header does not verify → 401, one JWKS fetch at most
 *   3. wrong Content-Type   → 415, still no Durable Object read
 *   4. only then getAuthStateCached()
 */
export async function handleAdminRoute(
	req: Request,
	env: Env,
	url: URL,
	action: AdminAction,
	access: AccessConfig,
): Promise<Response> {
	const jwt = req.headers.get(ACCESS_JWT_HEADER);
	if (!jwt) {
		// The common case for a direct workers.dev hit, and for a scanner.  It
		// must not cost a JWKS fetch: there is nothing to verify.
		return json({ error: "unauthorized" }, 401);
	}

	const verified = await verifyAccessJwt(jwt, access);
	if (!verified.ok) {
		// The reason is a closed set of machine-readable tags derived from no
		// attacker-controlled bytes (see accessJwt.ts), so it is safe to log —
		// and it is the only way an operator debugs a misconfigured Access
		// application.  The client is told nothing beyond "unauthorized".
		console.warn(
			`${LOG_PREFIX} admin request rejected: `
			+ JSON.stringify({ route: adminRouteBucket(action), reason: verified.reason }),
		);
		return json({ error: "unauthorized" }, 401);
	}

	if (action === "issue" || action === "revoke") {
		if (!isJsonContentType(req)) {
			return json({ error: "unsupported_media_type" }, 415);
		}
	}

	// Identity for the audit trail.  Access always issues one of the two for a
	// human policy, but neither claim is structurally guaranteed, and a mutation
	// must be recorded even when the identity is not usable — "unknown" is a
	// finding an operator can act on; a missing line is not.
	const actor = verified.email ?? verified.sub ?? "unknown";

	const authState = await getAuthStateCached(env);

	switch (action) {
		case "page":
			// The page renders for every mode: an operator who lands on a server
			// that is unclaimed, or running in env mode, needs to be told why
			// there is no form rather than shown a broken one.
			return adminHtml(renderAdminPage({ host: url.origin, authMode: authState.mode }));
		case "list":
			return handleAdminList(authState);
		case "issue":
			return await handleAdminIssue(req, env, url.origin, authState, actor);
		case "revoke":
			return await handleAdminRevoke(req, env, authState, actor);
	}
}
