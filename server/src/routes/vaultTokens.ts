/**
 * Per-vault access tokens — operator API.
 *
 * # Why
 * One server-wide token is the right shape for one operator syncing their own
 * vaults.  It is the wrong shape the moment a deployment hosts vaults for more
 * than one trust boundary: the single token opens every vault, so handing it to
 * a second device or a second person hands over all of them.
 *
 * A vault token is scoped to exactly one vaultId.  It authorizes that vault's
 * HTTP routes, its ticket issuance and its sync socket, and nothing else — not
 * a sibling vault, and not this API.  The global token keeps opening
 * everything, so an existing deployment that never calls these routes behaves
 * exactly as before.
 *
 * # Operator authentication
 * These routes gate on isAuthorized (the global token) rather than
 * isAuthorizedForVault.  A vault token must not be able to mint or revoke
 * tokens — including its own — or the scope boundary is decorative.
 *
 * # Claim mode only
 * Env mode (SYNC_TOKEN) makes zero Durable Object calls per request; the vault
 * token map lives in the config DO.  Supporting env mode would mean either a
 * YAOS_CONFIG round-trip on every request or a second source of truth, so
 * these routes answer 409 there instead.
 *
 * # Propagation
 * Mutations invalidate this isolate's config cache immediately.  Other
 * isolates keep serving their cached config until its 60s TTL expires, so an
 * issue or a revoke is globally in effect within one TTL window — see
 * AUTH_CONFIG_CACHE_TTL_MS in routes/auth.ts.
 *
 * # Two front doors, one implementation
 * The three operations below (listVaultTokens / issueVaultToken /
 * revokeVaultToken) are exported because the Access-gated admin API in
 * routes/admin.ts drives exactly the same state.  They deliberately return
 * data rather than Responses: the two surfaces authenticate differently and
 * shape their errors differently, but a second copy of "mint 32 bytes, store
 * the hash, invalidate the cache" is how the two would drift into disagreeing
 * about what a token is.
 */

import { randomBase64Url } from "../base64url";
import {
	normalizeVaultId,
	normalizeVaultTokenLabel,
	STRICT_TOKEN_ID_BYTES,
	type StoredServerConfig,
} from "../config";
import { sha256Hex } from "../hex";
import {
	buildObsidianSetupUrl,
	getHttpAuthToken,
	invalidateStoredServerConfigCache,
	isAuthorized,
	isStrictPermissionsEnabled,
} from "./auth";
import { json } from "./http";
import type { AuthStateCached, Env } from "./types";

/**
 * 32 bytes of CSPRNG output rendered base64url — the same entropy class as the
 * token the setup page generates for the global claim.
 */
const VAULT_TOKEN_BYTES = 32;

/** The three shapes classifyWorkerRoute recognises under /api/vault-tokens. */
export type VaultTokensAction = "list" | "issue" | "revoke";

/** Public view of one stored token.  Deliberately never carries tokenHash. */
export interface VaultTokenSummary {
	vaultId: string;
	label: string | null;
	createdAt: number;
}

/** Everything a freshly issued token consists of.  `token` exists only here. */
export interface IssuedVaultToken {
	vaultId: string;
	token: string;
	label: string | null;
	createdAt: number;
	obsidianUrl: string;
}

/**
 * A rejected mutation, already mapped to the status its caller should answer
 * with.  Returned rather than thrown so neither front door can forget to
 * distinguish "the operator asked for something invalid" (400) from "the
 * config Durable Object failed" (500) — see forwardConfigFailure.
 */
export interface VaultTokenFailure {
	error: string;
	status: 400 | 500;
}

export type IssueVaultTokenResult =
	| { ok: true; issued: IssuedVaultToken }
	| { ok: false; failure: VaultTokenFailure };

export type RevokeVaultTokenResult =
	| { ok: true; existed: boolean }
	| { ok: false; failure: VaultTokenFailure };

/**
 * Summarise the stored map for the operator.
 *
 * The hash is a verifier, not a secret, but publishing it would still hand an
 * offline attacker a target, so the projection is explicit rather than a
 * spread of the record.
 */
export function listVaultTokens(config: StoredServerConfig): VaultTokenSummary[] {
	const tokens = config.vaultTokens ?? {};
	return Object.entries(tokens)
		.map(([vaultId, record]) => ({ vaultId, label: record.label, createdAt: record.createdAt }))
		.sort((a, b) => a.createdAt - b.createdAt || a.vaultId.localeCompare(b.vaultId));
}

/** The singleton config Durable Object — the same instance routes/auth.ts reads. */
function configStub(env: Env): DurableObjectStub {
	return env.YAOS_CONFIG.get(env.YAOS_CONFIG.idFromName("global-config"));
}

async function callConfigDurableObject(env: Env, path: string, body: unknown): Promise<Response> {
	return await configStub(env).fetch(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Turn a Durable Object failure into an operator-facing failure.
 *
 * A 400 from the DO is a rejected input (bad vaultId, label too long, cap
 * reached) and is forwarded verbatim; anything else is a server fault and must
 * not be reported as the caller's mistake.
 */
async function forwardConfigFailure(res: Response, fallback: string): Promise<VaultTokenFailure> {
	let message = fallback;
	try {
		const payload: { error?: unknown } = await res.json();
		if (typeof payload.error === "string" && payload.error.length > 0) {
			message = payload.error;
		}
	} catch {
		// Non-JSON body: keep the fallback message.
	}
	return { error: message, status: res.status === 400 ? 400 : 500 };
}

/**
 * Mint a token for `vaultId`, replacing any token that vault already had.
 *
 * The plaintext exists only in the return value: the DO stores its SHA-256 and
 * nothing writes the token itself anywhere — not a log line, not a trace.
 * `origin` is the server's own origin, used to build the setup deep link.
 *
 * Callers MUST treat a successful result as the single delivery of the
 * plaintext: the rotation is already durable by the time this returns, so
 * dropping the value on the floor locks the operator out of that vault until
 * they issue again.
 */
export async function issueVaultToken(
	env: Env,
	origin: string,
	vaultId: string,
	label: string | null,
): Promise<IssueVaultTokenResult> {
	const token = randomBase64Url(VAULT_TOKEN_BYTES);
	const tokenHash = await sha256Hex(new TextEncoder().encode(token));
	const createdAt = Date.now();

	const res = await callConfigDurableObject(env, "/__yaos/vault-tokens", {
		vaultId,
		tokenHash,
		label,
		createdAt,
	});
	if (!res.ok) {
		return { ok: false, failure: await forwardConfigFailure(res, "vault token write failed") };
	}
	invalidateStoredServerConfigCache();

	return {
		ok: true,
		issued: {
			vaultId,
			token,
			label,
			createdAt,
			obsidianUrl: buildObsidianSetupUrl(origin, token, vaultId),
		},
	};
}

// ── Strict-mode device tokens ───────────────────────────────────────────────
//
// The same three operations against the separate strictTokens store (see the
// StrictTokenRecord comment in config.ts for why it is separate).  Three
// differences, all of them the point of the mode:
//
//   - issuing APPENDS rather than rotates, so one vault holds one token per
//     device and onboarding a second device never logs the first one out;
//   - `label` is required, because it is the only handle for deciding which of
//     a vault's tokens to revoke;
//   - revocation is by tokenId, for the same reason.

/** Public view of one strict token.  Deliberately never carries tokenHash. */
export interface StrictTokenSummary {
	tokenId: string;
	vaultId: string;
	label: string;
	createdAt: number;
}

/** Everything a freshly issued strict token consists of.  `token` only here. */
export interface IssuedStrictToken {
	tokenId: string;
	vaultId: string;
	token: string;
	label: string;
	createdAt: number;
	obsidianUrl: string;
}

export type IssueStrictTokenResult =
	| { ok: true; issued: IssuedStrictToken }
	| { ok: false; failure: VaultTokenFailure };

/**
 * Summarise the strict store for the operator.
 *
 * Flat rather than grouped by vault: the admin page groups it for display, and
 * a flat list keeps this response the same shape as the claim-mode listing, so
 * both front doors and both modes read one array of records.  Sorted by vault
 * first so a page that groups gets its groups contiguous for free, then by
 * issue time within a vault.
 *
 * The projection is explicit, never a spread: tokenHash must not appear.
 */
export function listStrictTokens(config: StoredServerConfig): StrictTokenSummary[] {
	const tokens = config.strictTokens ?? {};
	return Object.entries(tokens)
		.map(([tokenId, record]) => ({
			tokenId,
			vaultId: record.vaultId,
			label: record.label,
			createdAt: record.createdAt,
		}))
		.sort((a, b) =>
			a.vaultId.localeCompare(b.vaultId)
			|| a.createdAt - b.createdAt
			|| a.tokenId.localeCompare(b.tokenId));
}

/**
 * Mint a new device token for `vaultId`.  Never replaces an existing one.
 *
 * As with issueVaultToken, the plaintext exists only in the return value and
 * the caller MUST treat a successful result as its single delivery.
 */
export async function issueStrictToken(
	env: Env,
	origin: string,
	vaultId: string,
	label: string,
): Promise<IssueStrictTokenResult> {
	const token = randomBase64Url(VAULT_TOKEN_BYTES);
	const tokenHash = await sha256Hex(new TextEncoder().encode(token));
	// The tokenId is a revocation handle, not a credential — it is listed to
	// the operator in the clear — so it is deliberately shorter than the token.
	const tokenId = randomBase64Url(STRICT_TOKEN_ID_BYTES);
	const createdAt = Date.now();

	const res = await callConfigDurableObject(env, "/__yaos/strict-tokens", {
		tokenId,
		vaultId,
		tokenHash,
		label,
		createdAt,
	});
	if (!res.ok) {
		return { ok: false, failure: await forwardConfigFailure(res, "strict token write failed") };
	}
	invalidateStoredServerConfigCache();

	return {
		ok: true,
		issued: {
			tokenId,
			vaultId,
			token,
			label,
			createdAt,
			obsidianUrl: buildObsidianSetupUrl(origin, token, vaultId),
		},
	};
}

/** Delete one device token by id.  `existed` is false when there was none. */
export async function revokeStrictToken(env: Env, tokenId: string): Promise<RevokeVaultTokenResult> {
	const res = await callConfigDurableObject(env, "/__yaos/strict-tokens/revoke", { tokenId });
	if (!res.ok) {
		return { ok: false, failure: await forwardConfigFailure(res, "strict token revoke failed") };
	}
	const payload: { existed?: unknown } = await res.json();
	invalidateStoredServerConfigCache();
	return { ok: true, existed: payload.existed === true };
}

/** Delete `vaultId`'s token.  `existed` is false when it had none. */
export async function revokeVaultToken(env: Env, vaultId: string): Promise<RevokeVaultTokenResult> {
	const res = await callConfigDurableObject(env, "/__yaos/vault-tokens/revoke", { vaultId });
	if (!res.ok) {
		return { ok: false, failure: await forwardConfigFailure(res, "vault token revoke failed") };
	}
	const payload: { existed?: unknown } = await res.json();
	invalidateStoredServerConfigCache();
	return { ok: true, existed: payload.existed === true };
}

async function readVaultTokenBody(req: Request): Promise<{ vaultId?: unknown; label?: unknown } | null> {
	try {
		return await req.json();
	} catch {
		return null;
	}
}

/**
 * GET  /api/vault-tokens          → list (never includes hashes)
 * POST /api/vault-tokens          → issue/rotate, returns the plaintext once
 * POST /api/vault-tokens/revoke   → delete
 *
 * `action` comes from classifyWorkerRoute, which has already rejected every
 * other method/path combination under /api/vault-tokens as not-found.
 */
export async function handleVaultTokensRoute(
	req: Request,
	env: Env,
	authState: AuthStateCached,
	action: VaultTokensAction,
): Promise<Response> {
	// STRICT MODE closes this whole surface: it is the bearer-token operator
	// API, and strict mode has no operator token.  Management moves to /admin,
	// which authenticates with Cloudflare Access instead.
	//
	// WHY THIS IS BEFORE THE AUTH GATE, when the 409 below is deliberately
	// after it.  The rule that ordering serves is "a rejection must not tell an
	// unauthenticated caller anything /api/capabilities does not already
	// publish".  For the env-mode 409 that means sitting behind the 401,
	// because nothing publishes it.  Strict mode is the opposite case: the
	// capabilities payload carries `strictPermissions: true` to every
	// unauthenticated GET, by design — a client has no other way to learn that
	// its global token is dead.  A 403 here therefore discloses nothing new,
	// and putting it behind the operator gate would be worse than pointless: in
	// strict mode isAuthorized is always false, so the 403 would be
	// unreachable and every caller — including the operator holding what used
	// to be the right credential — would get a bare 401 that names no reason.
	if (isStrictPermissionsEnabled(env)) {
		return json({ error: "strict_permissions" }, 403);
	}
	if (!authState.claimed) {
		return json({ error: "unclaimed" }, 503);
	}
	if (authState.mode === "env" && !authState.envToken) {
		return json({ error: "server_misconfigured" }, 503);
	}
	// Operator gate, checked before the mode gate so that an unauthenticated
	// caller learns nothing about the server it could not already read from
	// /api/capabilities.
	if (!(await isAuthorized(authState, getHttpAuthToken(req)))) {
		return json({ error: "unauthorized" }, 401);
	}
	if (authState.mode !== "claim") {
		return json({ error: "unsupported_in_env_mode" }, 409);
	}

	if (action === "list") {
		// Served from the config the auth path already fetched — no extra DO
		// call.  Reflects writes made through another isolate within the config
		// cache TTL.
		return json({ ok: true, vaultTokens: listVaultTokens(authState.config) });
	}

	const body = await readVaultTokenBody(req);
	if (body === null) {
		return json({ error: "invalid json" }, 400);
	}

	let vaultId: string;
	let label: string | null;
	try {
		vaultId = normalizeVaultId(body.vaultId);
		label = action === "issue" ? normalizeVaultTokenLabel(body.label) : null;
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : "invalid request" }, 400);
	}

	if (action === "revoke") {
		const revoked = await revokeVaultToken(env, vaultId);
		if (!revoked.ok) {
			return json({ error: revoked.failure.error }, revoked.failure.status);
		}
		return json({ ok: true, existed: revoked.existed });
	}

	// Issue.  The plaintext is in this response and nowhere else.
	const issued = await issueVaultToken(env, new URL(req.url).origin, vaultId, label);
	if (!issued.ok) {
		return json({ error: issued.failure.error }, issued.failure.status);
	}
	return json({ ok: true, ...issued.issued });
}
