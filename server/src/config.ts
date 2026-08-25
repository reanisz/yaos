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

		return json({ error: "not found" }, 404);
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const claimed = await this.state.storage.get<boolean>(CLAIMED_KEY);
		const tokenHash = await this.state.storage.get<string>(TOKEN_HASH_KEY);
		const updateProvider = await this.state.storage.get<UpdateProvider>(UPDATE_PROVIDER_KEY);
		const updateRepoUrl = await this.state.storage.get<string>(UPDATE_REPO_URL_KEY);
		const updateRepoBranch = await this.state.storage.get<string>(UPDATE_REPO_BRANCH_KEY);
		const vaultTokens = readVaultTokenMap(await this.state.storage.get(VAULT_TOKENS_KEY));
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
		};
	}
}

export default ServerConfig;
