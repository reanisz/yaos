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
 */

import { randomBase64Url } from "../base64url";
import {
	normalizeVaultId,
	normalizeVaultTokenLabel,
	type StoredServerConfig,
} from "../config";
import { sha256Hex } from "../hex";
import {
	buildObsidianSetupUrl,
	getHttpAuthToken,
	invalidateStoredServerConfigCache,
	isAuthorized,
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
interface VaultTokenSummary {
	vaultId: string;
	label: string | null;
	createdAt: number;
}

/**
 * Summarise the stored map for the operator.
 *
 * The hash is a verifier, not a secret, but publishing it would still hand an
 * offline attacker a target, so the projection is explicit rather than a
 * spread of the record.
 */
function summarizeVaultTokens(config: StoredServerConfig): VaultTokenSummary[] {
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
 * Turn a Durable Object failure into an operator-facing response.
 *
 * A 400 from the DO is a rejected input (bad vaultId, label too long, cap
 * reached) and is forwarded verbatim; anything else is a server fault and must
 * not be reported as the caller's mistake.
 */
async function forwardConfigFailure(res: Response, fallback: string): Promise<Response> {
	let message = fallback;
	try {
		const payload: { error?: unknown } = await res.json();
		if (typeof payload.error === "string" && payload.error.length > 0) {
			message = payload.error;
		}
	} catch {
		// Non-JSON body: keep the fallback message.
	}
	return json({ error: message }, res.status === 400 ? 400 : 500);
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
		return json({ ok: true, vaultTokens: summarizeVaultTokens(authState.config) });
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
		const res = await callConfigDurableObject(env, "/__yaos/vault-tokens/revoke", { vaultId });
		if (!res.ok) {
			return await forwardConfigFailure(res, "vault token revoke failed");
		}
		const payload: { existed?: unknown } = await res.json();
		invalidateStoredServerConfigCache();
		return json({ ok: true, existed: payload.existed === true });
	}

	// Issue.  The plaintext exists only in this response: the DO stores its
	// SHA-256 and nothing writes the token itself anywhere.
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
		return await forwardConfigFailure(res, "vault token write failed");
	}
	invalidateStoredServerConfigCache();

	return json({
		ok: true,
		vaultId,
		token,
		label,
		createdAt,
		obsidianUrl: buildObsidianSetupUrl(new URL(req.url).origin, token, vaultId),
	});
}
