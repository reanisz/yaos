import { getAccessConfig } from "../accessJwt";
import { sha256Hex } from "../hex";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../setupQr";
import type { StoredServerConfig } from "../config";
import {
	SERVER_MIN_PLUGIN_VERSION,
	SERVER_RECOMMENDED_PLUGIN_VERSION,
	SERVER_SCHEMA_VERSION,
	SERVER_VERSION,
} from "../version";
import { json } from "./http";
import type { AuthState, AuthStateCached, Env, UpdateProvider } from "./types";
import { MAX_BLOB_UPLOAD_BYTES } from "../contracts";

export function getHttpAuthToken(req: Request): string | null {
	const auth = req.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	const token = auth.slice("Bearer ".length).trim();
	return token || null;
}

export function getSocketAuthToken(req: Request): string | null {
	const headerToken = getHttpAuthToken(req);
	if (headerToken) return headerToken;
	return new URL(req.url).searchParams.get("token");
}

async function hashToken(token: string): Promise<string> {
	const bytes = new TextEncoder().encode(token);
	return sha256Hex(bytes);
}

export function supportsBuckets(env: Env): boolean {
	return env.YAOS_BUCKET !== undefined;
}

// ── Strict permissions mode ─────────────────────────────────────────────────
//
// One environment variable decides the whole mode, and it is read WITHOUT
// touching a Durable Object.  That is what lets index.ts refuse POST /claim
// from the environment alone, before any YAOS_CONFIG access (issue #40).

const LOG_PREFIX = "[yaos-sync:worker]";

/**
 * True when YAOS_STRICT_PERMISSIONS is set to any non-empty value.
 *
 * Truthiness on the raw string, matching YAOS_DISABLE_LEGACY_WS_TOKEN: a
 * whitespace-only value enables the mode rather than being trimmed away to
 * "off".  For a hardening flag, an ambiguous value must fail closed.
 */
export function isStrictPermissionsEnabled(env: Env): boolean {
	return typeof env.YAOS_STRICT_PERMISSIONS === "string" && env.YAOS_STRICT_PERMISSIONS.length > 0;
}

/**
 * Both warnings are once per isolate, not once per request.
 *
 * Each describes a static deployment fact that cannot change without a new
 * isolate, and the paths that reach them are exactly the ones a scanner
 * hammers — the same reasoning getAccessConfig's warning uses.
 */
let warnedStrictEnvTokenIgnored = false;
let warnedStrictAccessUnconfigured = false;

/** Test-only: clear the once-per-isolate warning latches. */
export function resetStrictWarningsForTests(): void {
	warnedStrictEnvTokenIgnored = false;
	warnedStrictAccessUnconfigured = false;
}

/**
 * Warn about the two configurations that are legal but surprising.
 *
 * 1. SYNC_TOKEN alongside strict mode.  Strict wins and the environment token
 *    authorizes nothing — fail closed, because the alternative (env mode wins)
 *    would silently hand back the server-wide credential strict mode exists to
 *    remove.  An operator who set both almost certainly believes the token
 *    still works, so it is said out loud.
 * 2. Strict mode without Cloudflare Access.  Everything still fails closed —
 *    vault auth consults the strict tokens that already exist — but /admin is
 *    the only surface that can issue a new one, so a deployment with no
 *    tokens yet and no Access has locked itself out and needs to hear it.
 */
function warnOnStrictEnvironment(env: Env): void {
	if (!warnedStrictEnvTokenIgnored && (env.SYNC_TOKEN?.trim() ?? "").length > 0) {
		warnedStrictEnvTokenIgnored = true;
		console.warn(
			`${LOG_PREFIX} YAOS_STRICT_PERMISSIONS is set: SYNC_TOKEN is IGNORED and authorizes nothing. `
			+ `Remove SYNC_TOKEN, or unset YAOS_STRICT_PERMISSIONS if you meant to use it.`,
		);
	}
	if (!warnedStrictAccessUnconfigured && getAccessConfig(env) === null) {
		warnedStrictAccessUnconfigured = true;
		console.warn(
			`${LOG_PREFIX} YAOS_STRICT_PERMISSIONS is set but Cloudflare Access is not configured. `
			+ `/admin is the only surface that can issue a strict token, so no new device can be `
			+ `onboarded until YAOS_ACCESS_TEAM_DOMAIN and YAOS_ACCESS_AUD are set. `
			+ `Existing strict tokens keep working.`,
		);
	}
}

export function canonicalRepoForSetup(env: Env): string | undefined {
	const raw = env.YAOS_CANONICAL_REPO?.trim();
	if (!raw) return undefined;
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : undefined;
}

export async function getStoredServerConfig(env: Env): Promise<StoredServerConfig> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/config");
	if (!res.ok) {
		throw new Error(`config fetch failed (${res.status})`);
	}
	return await res.json();
}

// ── Config cache (issue #40 — stop per-request DO round-trips) ───────────────
//
// getStoredServerConfig() does a live Durable Object fetch every call.  In
// claim mode that fires on every Worker request.  Cache the config for a short
// TTL so a reconnect storm or scanner traffic does not each become a separate
// YAOS_CONFIG subrequest.
//
// Security note: we cache the *stored* config (tokenHash, updateProvider etc.),
// not the auth decision itself.  Token verification still runs on every request
// against the cached tokenHash — we just avoid re-fetching the hash from the DO
// on every request.
//
// The cache is invalidated after /claim and /api/update-metadata writes so that
// the operator sees the new state immediately on the next request.

const AUTH_CONFIG_CACHE_TTL_MS = 60_000;

let cachedConfig: { value: StoredServerConfig; expiresAt: number } | null = null;
let configInflight: Promise<StoredServerConfig> | null = null;

export function invalidateStoredServerConfigCache(): void {
	cachedConfig = null;
	configInflight = null;
}

export async function getStoredServerConfigCached(env: Env): Promise<StoredServerConfig> {
	const now = Date.now();
	if (cachedConfig && cachedConfig.expiresAt > now) {
		return cachedConfig.value;
	}
	if (configInflight) {
		return configInflight;
	}
	configInflight = getStoredServerConfig(env)
		.then((config) => {
			cachedConfig = { value: config, expiresAt: Date.now() + AUTH_CONFIG_CACHE_TTL_MS };
			return config;
		})
		.finally(() => {
			configInflight = null;
		});
	return configInflight;
}

async function claimServerConfig(env: Env, tokenHash: string): Promise<boolean> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/claim", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ tokenHash }),
	});
	return res.ok;
}

/**
 * Get-or-create the strict-mode ticket signing secret, and make the new value
 * visible to this isolate immediately.
 *
 * Called only from ticket ISSUANCE, and only on the one request per deployment
 * that finds no secret yet: issuance is already an authenticated, comparatively
 * rare operation (the plugin caches a ticket for its 5-minute TTL), so one
 * extra Durable Object round-trip on it is a cost nothing else pays.  The
 * alternative — creating the secret at boot, or on the auth path — would put a
 * write in front of requests that do not need one.
 *
 * The config cache is invalidated afterwards so the next request in this
 * isolate reads a config that carries the secret.  Other isolates converge
 * within AUTH_CONFIG_CACHE_TTL_MS; until they do, a ticket signed here does not
 * verify there.  That window exists exactly once in a deployment's life, on the
 * very first ticket, and the plugin's ordinary reconnect resolves it.
 */
export async function ensureTicketSigningSecret(env: Env): Promise<string> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/signing-secret", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	if (!res.ok) {
		throw new Error(`signing secret write failed (${res.status})`);
	}
	const payload: { ticketSigningSecret?: unknown } = await res.json();
	if (typeof payload.ticketSigningSecret !== "string" || payload.ticketSigningSecret.length === 0) {
		throw new Error("signing secret write failed (missing secret)");
	}
	invalidateStoredServerConfigCache();
	return payload.ticketSigningSecret;
}

async function setServerUpdateMetadata(env: Env, metadata: {
	updateProvider?: unknown;
	updateRepoUrl?: unknown;
	updateRepoBranch?: unknown;
}): Promise<StoredServerConfig> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/update-metadata", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(metadata),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`update metadata write failed (${res.status})${body ? `: ${body}` : ""}`);
	}
	const payload: { config?: StoredServerConfig } = await res.json();
	if (!payload?.config) {
		throw new Error("update metadata write failed (missing config)");
	}
	return payload.config;
}

export async function getAuthState(env: Env): Promise<AuthState> {
	// Strict is decided first and unconditionally: it is the mode that removes
	// credentials, so any ordering where another mode could win would mean an
	// environment variable silently re-opening what strict closed.
	if (isStrictPermissionsEnabled(env)) {
		warnOnStrictEnvironment(env);
		return { mode: "strict", claimed: true, config: await getStoredServerConfig(env) };
	}

	const envToken = env.SYNC_TOKEN?.trim();
	if (envToken) {
		return { mode: "env", claimed: true, envToken };
	}

	const config = await getStoredServerConfig(env);
	if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
		return { mode: "claim", claimed: true, tokenHash: config.tokenHash };
	}

	return { mode: "unclaimed", claimed: false };
}

/**
 * Cached variant of getAuthState.  Uses getStoredServerConfigCached so that
 * repeated requests within AUTH_CONFIG_CACHE_TTL_MS share a single YAOS_CONFIG
 * subrequest instead of each paying a DO round-trip.  The cached AuthState
 * carries the full StoredServerConfig in claim/unclaimed modes so callers can
 * reuse it without a second fetch (e.g. /api/capabilities).
 */
export async function getAuthStateCached(env: Env): Promise<AuthStateCached> {
	// Strict first — see getAuthState.  It reads the config through the same
	// cached path as claim mode, because a strict server's credentials live in
	// the config DO exactly as a claimed server's vault tokens do.
	if (isStrictPermissionsEnabled(env)) {
		warnOnStrictEnvironment(env);
		return { mode: "strict", claimed: true, config: await getStoredServerConfigCached(env) };
	}

	const envToken = env.SYNC_TOKEN?.trim();
	if (envToken) {
		return { mode: "env", claimed: true, envToken };
	}

	const config = await getStoredServerConfigCached(env);
	if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
		return { mode: "claim", claimed: true, tokenHash: config.tokenHash, config };
	}

	return { mode: "unclaimed", claimed: false, config };
}

/**
 * Operator-level authorization: the server-wide credential.
 *
 * In STRICT mode this is always false, for every caller and every token.  That
 * is the mode's central claim — there is no server-wide credential — and it is
 * enforced here rather than at each call site so that a route added later
 * cannot forget it.  The consequences follow from this one line: the operator
 * API, /api/update-metadata and the private update metadata in
 * /api/capabilities all gate on isAuthorized, so all three are closed in strict
 * mode without any of them knowing the mode exists.
 */
export async function isAuthorized(
	state: AuthState,
	token: string | null,
): Promise<boolean> {
	if (!token) return false;
	if (state.mode === "env") {
		return token === state.envToken;
	}
	if (state.mode === "claim") {
		return (await hashToken(token)) === state.tokenHash;
	}
	return false;
}

/**
 * Authorization for a single vault's routes.
 *
 * Two credentials open a vault: the server-wide operator token (which opens
 * every vault, and is the only credential that existed before per-vault
 * tokens), or the token issued for exactly this vaultId.  A per-vault token
 * authorizes nothing else — not another vault, not the operator API.
 *
 * Env mode recognises the global token only.  That is a deliberate limit, not
 * an oversight: env mode makes zero Durable Object calls per request, and the
 * vault-token map lives in the config DO, so honouring it here would put a
 * YAOS_CONFIG round-trip back on every request.  See
 * docs/architecture/zero-config-auth.md.
 *
 * STRICT mode has no "or the operator token" arm at all: a request opens a
 * vault if and only if it carries one of that vault's own device tokens.
 */
export async function isAuthorizedForVault(
	state: AuthState,
	token: string | null,
	vaultId: string,
): Promise<boolean> {
	// Checked before the operator arm below, not after: in strict mode
	// isAuthorized is always false, so falling through would be correct but
	// would read as though the operator token were still a candidate here.
	if (state.mode === "strict") {
		if (!token) return false;
		const hash = await hashToken(token);
		// A flat scan of a map capped at MAX_STRICT_TOKENS.  A vaultId-keyed
		// index would be faster and would also be a second source of truth for
		// which token belongs to which vault; at this bound the scan is the
		// cheaper thing to keep correct.
		for (const record of Object.values(state.config.strictTokens ?? {})) {
			if (record.vaultId === vaultId && record.tokenHash === hash) return true;
		}
		return false;
	}

	if (await isAuthorized(state, token)) return true;
	if (!token || state.mode !== "claim") return false;

	// Claim-mode states built by getAuthStateCached always carry the config;
	// the optional chain covers the uncached getAuthState variant, which has no
	// vault-token map to consult and therefore authorizes the global token only.
	const record = state.config?.vaultTokens?.[vaultId];
	if (!record || typeof record.tokenHash !== "string" || record.tokenHash.length === 0) {
		return false;
	}
	return (await hashToken(token)) === record.tokenHash;
}

export type PreAuthRejectionReason = "unclaimed" | "server_misconfigured" | "unauthorized";

/** Typed rejection result — carries both the HTTP response and the reason for logging. */
export interface AuthRejection {
	response: Response;
	reason: PreAuthRejectionReason;
}

/**
 * Returns a typed rejection (response + reason) if the request fails pre-auth,
 * or null if the request is authorized and should proceed to the vault handler.
 * Does NOT touch any Durable Object namespace — exported for runtime testing (FU-4).
 *
 * Callers log `rejection.reason` — no duplicated decision tree.
 */
export async function rejectUnauthorizedVaultRequest(
	req: Request,
	_env: unknown,
	authState: AuthState,
	vaultId: string,
): Promise<AuthRejection | null> {
	const token = getHttpAuthToken(req);
	if (!authState.claimed) {
		return { response: json({ error: "unclaimed" }, 503), reason: "unclaimed" };
	}
	if (authState.mode === "env" && !authState.envToken) {
		return { response: json({ error: "server_misconfigured" }, 503), reason: "server_misconfigured" };
	}
	if (!(await isAuthorizedForVault(authState, token, vaultId))) {
		return { response: json({ error: "unauthorized" }, 401), reason: "unauthorized" };
	}
	return null;
}

export function buildObsidianSetupUrl(host: string, token: string, vaultId?: string): string {
	const params = new URLSearchParams({
		action: "setup",
		host,
		token,
	});
	if (vaultId) {
		params.set("vaultId", vaultId);
	}
	return `obsidian://yaos?${params.toString()}`;
}

export function getCapabilities(
	auth: AuthState,
	env: Env,
	config: StoredServerConfig | null = null,
	options: { includePrivateUpdateMetadata?: boolean } = {},
): {
	claimed: boolean;
	authMode: "env" | "claim" | "unclaimed";
	strictPermissions: boolean;
	attachments: boolean;
	snapshots: boolean;
	maxBlobUploadBytes: number;
	socketTicketAuth: boolean;
	serverVersion: string;
	minPluginVersion: string | null;
	recommendedPluginVersion: string | null;
	schemaVersion: number;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
} {
	const bucketEnabled = supportsBuckets(env);
	return {
		claimed: auth.claimed,
		// COMPATIBILITY SHIM — strict mode reports authMode "claim", not "strict".
		//
		// The plugin's own validator hard-enumerates this field
		// (isServerCapabilities in src/runtime/capabilityUpdateService.ts:
		// `authMode === "env" || "claim" || "unclaimed"`), and a value outside
		// that set makes the WHOLE capabilities payload invalid — the plugin
		// then treats the server as unreachable rather than as one it does not
		// fully understand.  Unknown EXTRA fields, by contrast, pass that
		// validator untouched.
		//
		// So the mode is published as the additive `strictPermissions` flag
		// below, and authMode carries the nearest true statement about how a
		// client authenticates: a bearer token verified against a hash in the
		// config Durable Object, which is exactly claim mode's contract and
		// exactly what a strict device token does.  The field a client acts on
		// is therefore never a lie; the field it cannot parse is never sent.
		//
		// If the plugin's validator is ever widened to accept "strict", this
		// shim can be dropped — but only after the minimum supported plugin
		// version includes that change.
		authMode: auth.mode === "strict" ? "claim" : auth.mode,
		/**
		 * Additive and always present: false in every non-strict mode, which is
		 * harmless to a client that ignores it and unambiguous to one that does
		 * not.  Public on purpose — a client cannot discover that the global
		 * token is dead any other way, and the fact leaks nothing: it describes
		 * a policy, not a credential.
		 */
		strictPermissions: auth.mode === "strict",
		attachments: bucketEnabled,
		snapshots: bucketEnabled,
		maxBlobUploadBytes: MAX_BLOB_UPLOAD_BYTES,
		socketTicketAuth: true,
		serverVersion: SERVER_VERSION,
		minPluginVersion: SERVER_MIN_PLUGIN_VERSION,
		recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
		schemaVersion: SERVER_SCHEMA_VERSION,
		updateProvider: options.includePrivateUpdateMetadata ? (config?.updateProvider ?? null) : null,
		updateRepoUrl: options.includePrivateUpdateMetadata ? (config?.updateRepoUrl ?? null) : null,
		updateRepoBranch: options.includePrivateUpdateMetadata ? (config?.updateRepoBranch ?? null) : null,
	};
}

export async function handleClaimRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	const url = new URL(req.url);
	// Strict mode closes the claim route entirely: there is no server-wide token
	// for it to mint.  index.ts refuses this route from the environment alone,
	// before getAuthStateCached and therefore before any Durable Object access
	// (issue #40) — this arm is the second lock, so that a future caller of
	// handleClaimRoute cannot reopen the flow by skipping the classifier.
	if (isStrictPermissionsEnabled(env)) {
		return json({ error: "strict_permissions" }, 403);
	}
	if (authState.claimed) {
		return json({ error: "already_claimed" }, 403);
	}

	let body: { token?: string; vaultId?: string } = {};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	if (typeof body.token !== "string" || body.token.trim().length < 32) {
		return json({ error: "invalid token" }, 400);
	}
	if (body.vaultId !== undefined && (typeof body.vaultId !== "string" || body.vaultId.trim().length < 8)) {
		return json({ error: "invalid vaultId" }, 400);
	}

	const token = body.token.trim();
	const vaultId = typeof body.vaultId === "string" ? body.vaultId.trim() : "";
	let mobileSetupQrDataUrl: string;
	try {
		// Render before the durable claim write. A renderer failure must not leave
		// an otherwise functional server irreversibly claimed with a failed setup UI.
		mobileSetupQrDataUrl = await renderSetupQrDataUrl(
			buildMobileSetupUrl(url.origin, token, vaultId),
		);
	} catch {
		return json({ error: "setup QR generation failed" }, 500);
	}

	const tokenHash = await hashToken(token);
	const claimed = await claimServerConfig(env, tokenHash);
	if (!claimed) {
		return json({ error: "already_claimed" }, 403);
	}
	// Invalidate the cached config so the next request sees the claimed state
	// immediately rather than serving a stale unclaimed response for up to TTL.
	invalidateStoredServerConfigCache();

	let claimedConfig: StoredServerConfig | null = null;
	try {
		claimedConfig = await getStoredServerConfig(env);
	} catch (err) {
		console.warn("[yaos-sync:worker] config fetch failed after claim:", err);
	}

	return json({
		ok: true,
		host: url.origin,
		obsidianUrl: buildObsidianSetupUrl(url.origin, token, vaultId || undefined),
		mobileSetupQrDataUrl,
		capabilities: getCapabilities(
			{ mode: "claim", claimed: true, tokenHash },
			env,
			claimedConfig,
			{ includePrivateUpdateMetadata: true },
		),
	});
}

export async function handleUpdateMetadataRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	const token = getHttpAuthToken(req);
	if (!authState.claimed) {
		return json({ error: "unclaimed" }, 503);
	}
	if (authState.mode === "env" && !authState.envToken) {
		return json({ error: "server_misconfigured" }, 503);
	}
	if (!(await isAuthorized(authState, token))) {
		return json({ error: "unauthorized" }, 401);
	}

	let body: {
		updateProvider?: unknown;
		updateRepoUrl?: unknown;
		updateRepoBranch?: unknown;
	} = {};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	let updatedConfig: StoredServerConfig;
	try {
		updatedConfig = await setServerUpdateMetadata(env, body);
	} catch (err) {
		const message = err instanceof Error ? err.message : "metadata write failed";
		const status = message.includes("(403)")
			? 403
			: message.includes("(400)")
				? 400
				: 500;
		return json({ error: message }, status);
	}
	// Invalidate cache so the next request sees the updated metadata immediately.
	invalidateStoredServerConfigCache();

	return json({
		ok: true,
		capabilities: getCapabilities(authState, env, updatedConfig, { includePrivateUpdateMetadata: true }),
	});
}
