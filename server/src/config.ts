import { randomBase64Url } from "./base64url";

const CLAIMED_KEY = "claimed";
const TOKEN_HASH_KEY = "tokenHash";
const UPDATE_PROVIDER_KEY = "updateProvider";
const UPDATE_REPO_URL_KEY = "updateRepoUrl";
const UPDATE_REPO_BRANCH_KEY = "updateRepoBranch";
/**
 * The whole vault-token map lives under one key.  It is read on every config
 * fetch (i.e. on every cache miss of the 60s auth config cache), so one value
 * is one storage read regardless of how many vaults exist — a key per vault
 * would turn the auth hot path into an unbounded `list()`.
 */
const VAULT_TOKENS_KEY = "vaultTokens";
/**
 * Strict-mode device tokens, keyed by tokenId.  One key for the whole map, for
 * the same reason VAULT_TOKENS_KEY is: it is read on every config cache miss.
 */
const STRICT_TOKENS_KEY = "strictTokens";
/** The strict-mode ticket signing secret.  Written once, never rotated here. */
const TICKET_SIGNING_SECRET_KEY = "ticketSigningSecret";

type UpdateProvider = "github" | "gitlab" | "unknown";

/**
 * A per-vault access token, as stored.  Only the SHA-256 hash is persisted:
 * the plaintext is returned exactly once, at issue time, and never again.
 */
export interface VaultTokenRecord {
	tokenHash: string;
	label: string | null;
	createdAt: number;
}

/**
 * One strict-mode device token, as stored.  Keyed by a random `tokenId`, so a
 * vault holds 0..N of them — one per device — rather than the single token
 * `vaultTokens` allows.
 *
 * FORK-LOCAL DECISION: kept separate from vaultTokens to minimize rebase
 * conflicts with upstream; if this is ever upstreamed, unify the two schemas.
 *
 * The two maps are never consulted together: normal mode reads only
 * `vaultTokens` and strict mode reads only `strictTokens` (see
 * isAuthorizedForVault in routes/auth.ts).  `label` is REQUIRED here — a device
 * token whose device nobody can name is a token nobody dares revoke — where
 * `vaultTokens.label` is an optional note.
 */
export interface StrictTokenRecord {
	vaultId: string;
	tokenHash: string;
	label: string;
	createdAt: number;
}

export interface StoredServerConfig {
	claimed: boolean;
	tokenHash: string | null;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
	/**
	 * Vault-scoped access tokens, keyed by vaultId.  Empty (`{}`) for every
	 * deployment that never issued one, including deployments claimed before
	 * this key existed — the storage key is simply absent and reads as `{}`.
	 */
	vaultTokens: Record<string, VaultTokenRecord>;
	/**
	 * Strict-mode device tokens, keyed by tokenId.  Empty (`{}`) on every
	 * deployment that never ran in strict mode.
	 */
	strictTokens: Record<string, StrictTokenRecord>;
	/**
	 * HMAC key material for strict-mode WebSocket tickets: 32 random bytes,
	 * base64url, created lazily on first ticket issuance and never rotated by
	 * this code.  `null` until then.
	 *
	 * SECURITY INVARIANT: this value must never leave the server.  It is carried
	 * in StoredServerConfig because the Worker signs with it, and no HTTP
	 * response may return a StoredServerConfig verbatim — /api/capabilities and
	 * the claim response both build an explicit projection (getCapabilities in
	 * routes/auth.ts), which is what keeps this field server-side.  The
	 * regression is asserted on raw response text in
	 * tests/server/strict-permissions.ts.
	 */
	ticketSigningSecret: string | null;
}

/**
 * Bounds shared by the Durable Object (authoritative) and the Worker-side
 * validator in routes/vaultTokens.ts, so the two cannot drift.
 */
export const VAULT_ID_MIN_LENGTH = 8;
export const VAULT_ID_MAX_LENGTH = 256;
export const VAULT_TOKEN_LABEL_MAX_LENGTH = 64;
/**
 * Ceiling on the number of vaults holding a token.  The map is carried inside
 * every cached config, so it must stay small enough to be a cheap value on the
 * auth path.  Rotating an existing vault's token never grows the map and is
 * always allowed; only inserting a NEW vault past the ceiling is refused.
 */
export const MAX_VAULT_TOKENS = 100;
/**
 * Ceiling on the number of strict-mode device tokens across all vaults.  Higher
 * than MAX_VAULT_TOKENS because the unit is a device, not a vault: a strict
 * deployment holding 30 vaults with 10 devices each is an ordinary shape.  The
 * map is still carried inside every cached config, so it is bounded for the
 * same reason — 300 records of four small fields is a cheap value on the auth
 * path, an unbounded map is not.
 */
export const MAX_STRICT_TOKENS = 300;
/** Entropy of a strict tokenId.  Not a secret — a handle for revocation. */
export const STRICT_TOKEN_ID_BYTES = 16;
/** Entropy of the strict-mode ticket signing secret. */
export const TICKET_SIGNING_SECRET_BYTES = 32;
/**
 * Upper bound on a tokenId the server will store.  The server mints every
 * tokenId itself (22 base64url characters), so this is a defensive bound on the
 * DO's own input surface rather than a product limit.
 */
const STRICT_TOKEN_ID_MAX_LENGTH = 64;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function normalizeUpdateProvider(value: unknown): UpdateProvider | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid updateProvider");
	}
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (raw === "github" || raw === "gitlab" || raw === "unknown") {
		return raw;
	}
	throw new Error("invalid updateProvider");
}

function normalizeUpdateRepoUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid updateRepoUrl");
	}
	const raw = value.trim();
	if (!raw) return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("invalid updateRepoUrl");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("invalid updateRepoUrl");
	}
	const pathParts = parsed.pathname.split("/").filter(Boolean);
	if (pathParts.length < 2) {
		throw new Error("invalid updateRepoUrl");
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeUpdateRepoBranch(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid updateRepoBranch");
	}
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > 120) {
		throw new Error("invalid updateRepoBranch");
	}
	// Keep this strict and safe for URL/query usage.
	if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes("..")) {
		throw new Error("invalid updateRepoBranch");
	}
	return raw;
}

export function normalizeVaultId(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("invalid vaultId");
	}
	const raw = value.trim();
	if (raw.length < VAULT_ID_MIN_LENGTH || raw.length > VAULT_ID_MAX_LENGTH) {
		throw new Error("invalid vaultId");
	}
	return raw;
}

export function normalizeVaultTokenLabel(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid label");
	}
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > VAULT_TOKEN_LABEL_MAX_LENGTH) {
		throw new Error("invalid label");
	}
	return raw;
}

/**
 * A strict-mode label is REQUIRED, where a vault-token label is optional.
 *
 * The label is the device name, and it is the only handle an operator has for
 * deciding which of a vault's tokens to revoke: an unnamed one is a token that
 * outlives the device it was issued for.  Blank after trimming is not a name,
 * so it is refused rather than normalised to null.
 */
export function normalizeStrictTokenLabel(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("invalid label");
	}
	const raw = value.trim();
	if (!raw || raw.length > VAULT_TOKEN_LABEL_MAX_LENGTH) {
		throw new Error("invalid label");
	}
	return raw;
}

/**
 * Validate a tokenId.  The charset is base64url's, which is what the server
 * mints — and which deliberately still admits `__proto__`, since `_` is in that
 * alphabet.  Refusing that one name here would be blacklisting a symptom: the
 * map's null prototype (see emptyStrictTokenMap) is what actually makes every
 * key an ordinary own property, and the test suite exercises `__proto__` as a
 * tokenId to prove it.
 */
export function normalizeStrictTokenId(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("invalid tokenId");
	}
	const raw = value.trim();
	if (raw.length === 0 || raw.length > STRICT_TOKEN_ID_MAX_LENGTH) {
		throw new Error("invalid tokenId");
	}
	if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
		throw new Error("invalid tokenId");
	}
	return raw;
}

function normalizeVaultTokenHash(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("invalid tokenHash");
	}
	return value;
}

function normalizeVaultTokenCreatedAt(value: unknown): number {
	if (value === undefined || value === null) return Date.now();
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("invalid createdAt");
	}
	return value;
}

function isVaultTokenRecord(value: unknown): value is VaultTokenRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.tokenHash === "string"
		&& record.tokenHash.length > 0
		&& (record.label === null || typeof record.label === "string")
		&& typeof record.createdAt === "number";
}

/**
 * An empty map with NO prototype.
 *
 * A vaultId is operator-supplied text, and on an ordinary `{}` the single name
 * `__proto__` is not a data property but a setter inherited from
 * Object.prototype: `tokens["__proto__"] = record` would replace the map's
 * prototype and store nothing.  The write would report success while the token
 * never persisted and never authorized — a silent lie to the operator, and the
 * polluted prototype would answer the `in` check that follows it.
 *
 * A null prototype removes the mechanism rather than blacklisting the one name
 * that currently exploits it, so every vaultId is an ordinary own property.
 * The map survives both round-trips it has to make: structured cloning into
 * Durable Object storage and JSON.stringify/JSON.parse on the way to the
 * Worker, because both write own properties directly instead of assigning
 * through setters.
 */
function emptyVaultTokenMap(): Record<string, VaultTokenRecord> {
	return Object.create(null) as Record<string, VaultTokenRecord>;
}

/**
 * Read the stored map defensively.  An absent key (every pre-existing
 * deployment) and a value that does not match the record shape both read as an
 * empty map, so a corrupt entry can never be mistaken for a valid credential.
 *
 * Every mutation path reads through here before writing, so the null-prototype
 * guarantee above covers upsert and revoke as well as plain reads.
 */
function readVaultTokenMap(value: unknown): Record<string, VaultTokenRecord> {
	if (!value || typeof value !== "object") return emptyVaultTokenMap();
	const tokens: Record<string, VaultTokenRecord> = emptyVaultTokenMap();
	for (const [vaultId, record] of Object.entries(value as Record<string, unknown>)) {
		if (isVaultTokenRecord(record)) {
			tokens[vaultId] = { tokenHash: record.tokenHash, label: record.label, createdAt: record.createdAt };
		}
	}
	return tokens;
}

function isStrictTokenRecord(value: unknown): value is StrictTokenRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.vaultId === "string"
		&& record.vaultId.length > 0
		&& typeof record.tokenHash === "string"
		&& record.tokenHash.length > 0
		&& typeof record.label === "string"
		&& record.label.length > 0
		&& typeof record.createdAt === "number";
}

/**
 * An empty strict-token map with NO prototype — the same discipline
 * emptyVaultTokenMap documents at length, applied to a map whose keys are
 * tokenIds rather than vaultIds.
 *
 * The exposure is the same shape and the reasoning is unchanged: on an ordinary
 * `{}` the single name `__proto__` is an inherited setter rather than a data
 * property, so `tokens["__proto__"] = record` would replace the map's prototype
 * and store nothing while reporting success.  A null prototype removes the
 * mechanism instead of blacklisting the one name that exploits it, and survives
 * both round-trips the map makes (structured clone into DO storage, JSON to the
 * Worker) because both write own properties directly.
 *
 * This map is reachable with an operator-chosen key only through the DO's own
 * validation, but the server also mints tokenIds from an alphabet that includes
 * `_`, so `__proto__` is a value this code could in principle produce.
 */
function emptyStrictTokenMap(): Record<string, StrictTokenRecord> {
	return Object.create(null) as Record<string, StrictTokenRecord>;
}

/**
 * Read the stored strict-token map defensively.  An absent key (every
 * deployment that never ran strict mode) and any entry that does not match the
 * record shape both drop out, so a corrupt entry can never be mistaken for a
 * valid credential.
 */
function readStrictTokenMap(value: unknown): Record<string, StrictTokenRecord> {
	if (!value || typeof value !== "object") return emptyStrictTokenMap();
	const tokens: Record<string, StrictTokenRecord> = emptyStrictTokenMap();
	for (const [tokenId, record] of Object.entries(value as Record<string, unknown>)) {
		if (isStrictTokenRecord(record)) {
			tokens[tokenId] = {
				vaultId: record.vaultId,
				tokenHash: record.tokenHash,
				label: record.label,
				createdAt: record.createdAt,
			};
		}
	}
	return tokens;
}

export class ServerConfig {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/__yaos/config") {
			return json(await this.readConfig());
		}

		if (request.method === "POST" && url.pathname === "/__yaos/claim") {
			let body: { tokenHash?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (typeof body.tokenHash !== "string" || !body.tokenHash) {
				return json({ error: "missing tokenHash" }, 400);
			}

			return await this.state.storage.transaction(async (txn) => {
				const claimed = await txn.get<boolean>(CLAIMED_KEY);
				const existingHash = await txn.get<string>(TOKEN_HASH_KEY);
				if (claimed === true && typeof existingHash === "string" && existingHash.length > 0) {
					return json({ error: "already_claimed" }, 403);
				}

				await txn.put(CLAIMED_KEY, true);
				await txn.put(TOKEN_HASH_KEY, body.tokenHash);
				return json({ ok: true });
			});
		}

		if (request.method === "POST" && url.pathname === "/__yaos/update-metadata") {
			let body: {
				updateProvider?: unknown;
				updateRepoUrl?: unknown;
				updateRepoBranch?: unknown;
			} = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			let updateProvider: UpdateProvider | null;
			let updateRepoUrl: string | null;
			let updateRepoBranch: string | null;
			try {
				updateProvider = normalizeUpdateProvider(body.updateProvider);
				updateRepoUrl = normalizeUpdateRepoUrl(body.updateRepoUrl);
				updateRepoBranch = normalizeUpdateRepoBranch(body.updateRepoBranch);
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "invalid metadata" }, 400);
			}

				await this.state.storage.transaction(async (txn) => {
					if (updateProvider !== null) {
						await txn.put(UPDATE_PROVIDER_KEY, updateProvider);
					}
					if (updateRepoUrl !== null) {
						await txn.put(UPDATE_REPO_URL_KEY, updateRepoUrl);
					}
					if (updateRepoBranch !== null) {
						await txn.put(UPDATE_REPO_BRANCH_KEY, updateRepoBranch);
					}
				});

			return json({ ok: true, config: await this.readConfig() });
		}

		// Upsert one vault token.  Issuing again for a vault that already has one
		// is a rotation: the previous hash is replaced, so the old plaintext stops
		// authorizing as soon as the Worker config cache turns over.
		if (request.method === "POST" && url.pathname === "/__yaos/vault-tokens") {
			let body: { vaultId?: unknown; tokenHash?: unknown; label?: unknown; createdAt?: unknown } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			let record: VaultTokenRecord;
			let vaultId: string;
			try {
				vaultId = normalizeVaultId(body.vaultId);
				record = {
					tokenHash: normalizeVaultTokenHash(body.tokenHash),
					label: normalizeVaultTokenLabel(body.label),
					createdAt: normalizeVaultTokenCreatedAt(body.createdAt),
				};
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "invalid vault token" }, 400);
			}

			const stored = await this.state.storage.transaction(async (txn) => {
				const tokens = readVaultTokenMap(await txn.get(VAULT_TOKENS_KEY));
				if (!(vaultId in tokens) && Object.keys(tokens).length >= MAX_VAULT_TOKENS) {
					return false;
				}
				tokens[vaultId] = record;
				await txn.put(VAULT_TOKENS_KEY, tokens);
				return true;
			});
			if (!stored) {
				return json({ error: "too many vault tokens" }, 400);
			}

			return json({ ok: true, config: await this.readConfig() });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/vault-tokens/revoke") {
			let body: { vaultId?: unknown } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			let vaultId: string;
			try {
				vaultId = normalizeVaultId(body.vaultId);
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "invalid vaultId" }, 400);
			}

			const existed = await this.state.storage.transaction(async (txn) => {
				const tokens = readVaultTokenMap(await txn.get(VAULT_TOKENS_KEY));
				if (!(vaultId in tokens)) return false;
				delete tokens[vaultId];
				await txn.put(VAULT_TOKENS_KEY, tokens);
				return true;
			});

			return json({ ok: true, existed, config: await this.readConfig() });
		}

		// ── Strict mode ──────────────────────────────────────────────────────
		//
		// Deliberately a separate store from vaultTokens above; see the comment
		// on StrictTokenRecord.  Issuing APPENDS: a vault holds one token per
		// device, and re-issuing for a vault must never invalidate the token a
		// different device is already using.  Revocation is therefore by
		// tokenId, which is the only handle that identifies one device.
		if (request.method === "POST" && url.pathname === "/__yaos/strict-tokens") {
			let body: {
				tokenId?: unknown;
				vaultId?: unknown;
				tokenHash?: unknown;
				label?: unknown;
				createdAt?: unknown;
			} = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			let tokenId: string;
			let record: StrictTokenRecord;
			try {
				tokenId = normalizeStrictTokenId(body.tokenId);
				record = {
					vaultId: normalizeVaultId(body.vaultId),
					tokenHash: normalizeVaultTokenHash(body.tokenHash),
					label: normalizeStrictTokenLabel(body.label),
					createdAt: normalizeVaultTokenCreatedAt(body.createdAt),
				};
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "invalid strict token" }, 400);
			}

			const outcome = await this.state.storage.transaction(async (txn) => {
				const tokens = readStrictTokenMap(await txn.get(STRICT_TOKENS_KEY));
				// A duplicate tokenId would silently overwrite another device's
				// token — the one thing append semantics exist to prevent.  The
				// server mints 16 random bytes, so this is unreachable in practice
				// and refused rather than tolerated.
				if (tokenId in tokens) return "duplicate" as const;
				if (Object.keys(tokens).length >= MAX_STRICT_TOKENS) return "full" as const;
				tokens[tokenId] = record;
				await txn.put(STRICT_TOKENS_KEY, tokens);
				return "stored" as const;
			});
			if (outcome === "duplicate") {
				return json({ error: "duplicate tokenId" }, 400);
			}
			if (outcome === "full") {
				return json({ error: "too many strict tokens" }, 400);
			}

			return json({ ok: true, config: await this.readConfig() });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/strict-tokens/revoke") {
			let body: { tokenId?: unknown } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			let tokenId: string;
			try {
				tokenId = normalizeStrictTokenId(body.tokenId);
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "invalid tokenId" }, 400);
			}

			const existed = await this.state.storage.transaction(async (txn) => {
				const tokens = readStrictTokenMap(await txn.get(STRICT_TOKENS_KEY));
				if (!(tokenId in tokens)) return false;
				delete tokens[tokenId];
				await txn.put(STRICT_TOKENS_KEY, tokens);
				return true;
			});

			return json({ ok: true, existed, config: await this.readConfig() });
		}

		// Get-or-create the strict-mode ticket signing secret.
		//
		// Idempotent by construction: the read and the conditional write share
		// one transaction, so a caller that races another gets the value the
		// other stored rather than a second secret that would invalidate every
		// ticket signed with the first.  Never rotates — this endpoint has no
		// path that overwrites an existing value.
		if (request.method === "POST" && url.pathname === "/__yaos/signing-secret") {
			const secret = await this.state.storage.transaction(async (txn) => {
				const existing = await txn.get<string>(TICKET_SIGNING_SECRET_KEY);
				if (typeof existing === "string" && existing.length > 0) {
					return existing;
				}
				const created = randomBase64Url(TICKET_SIGNING_SECRET_BYTES);
				await txn.put(TICKET_SIGNING_SECRET_KEY, created);
				return created;
			});
			// The secret is in this response because the Worker signs with it.
			// It is a Durable Object response, not an HTTP one: nothing forwards
			// it to a client, and getCapabilities() projects the config field by
			// field so it cannot reach one by accident.
			return json({ ok: true, ticketSigningSecret: secret });
		}

		return json({ error: "not found" }, 404);
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const claimed = await this.state.storage.get<boolean>(CLAIMED_KEY);
		const tokenHash = await this.state.storage.get<string>(TOKEN_HASH_KEY);
		const updateProvider = await this.state.storage.get<UpdateProvider>(UPDATE_PROVIDER_KEY);
		const updateRepoUrl = await this.state.storage.get<string>(UPDATE_REPO_URL_KEY);
		const updateRepoBranch = await this.state.storage.get<string>(UPDATE_REPO_BRANCH_KEY);
		const vaultTokens = readVaultTokenMap(await this.state.storage.get(VAULT_TOKENS_KEY));
		const strictTokens = readStrictTokenMap(await this.state.storage.get(STRICT_TOKENS_KEY));
		const ticketSigningSecret = await this.state.storage.get<string>(TICKET_SIGNING_SECRET_KEY);
		return {
			claimed: claimed === true && typeof tokenHash === "string" && tokenHash.length > 0,
			tokenHash: typeof tokenHash === "string" && tokenHash.length > 0 ? tokenHash : null,
			updateProvider:
				updateProvider === "github" || updateProvider === "gitlab" || updateProvider === "unknown"
					? updateProvider
					: null,
			updateRepoUrl: typeof updateRepoUrl === "string" && updateRepoUrl.length > 0 ? updateRepoUrl : null,
			updateRepoBranch:
				typeof updateRepoBranch === "string" && updateRepoBranch.length > 0 ? updateRepoBranch : null,
			vaultTokens,
			strictTokens,
			ticketSigningSecret:
				typeof ticketSigningSecret === "string" && ticketSigningSecret.length > 0
					? ticketSigningSecret
					: null,
		};
	}
}

export default ServerConfig;
