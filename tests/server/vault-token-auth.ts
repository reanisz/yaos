/**
 * Per-vault access tokens.
 *
 * Runs the REAL ServerConfig Durable Object over in-memory storage
 * (FakeDurableObjectStorage), wired into a real Worker `Env`, so the storage
 * rules, the Worker operator API and the auth gates are all exercised against
 * the same code a deployment runs.
 *
 * The properties under test:
 *   1. Storage — upsert, rotate, revoke, the 100-vault cap, input validation,
 *      and an absent key reading as `{}` (a config written before this feature
 *      existed must keep working).
 *   2. The global token still opens every vault (backward compatibility).
 *   3. A vault token opens its own vault and nothing else.
 *   4. Tickets issued through a vault token stay vault-scoped.
 *   5. The legacy WebSocket `?token=` path is vault-scoped too.
 *   6. Revocation takes effect once the config cache turns over.
 *   7. The operator API needs the global token, never leaks a hash, and is
 *      unavailable in env mode.
 *
 * Cache note: routes/auth.ts holds ONE module-level config cache for the whole
 * process, so every section that swaps in a different deployment must call
 * invalidateStoredServerConfigCache() first — freshDeployment() does it.
 */

import worker from "../../server/src/index";
import { MAX_VAULT_TOKENS, ServerConfig } from "../../server/src/config";
import {
	getAuthStateCached,
	invalidateStoredServerConfigCache,
	isAuthorizedForVault,
} from "../../server/src/routes/auth";
import { authenticateSocketRequest } from "../../server/src/routes/syncSocket";
import { verifyTicket } from "../../server/src/routes/ticket";
import { sha256Hex } from "../../server/src/hex";
import { SERVER_SCHEMA_VERSION } from "../../server/src/version";
import type { Env } from "../../server/src/routes/types";
import {
	FakeDurableObjectStorage,
	makeConfigNamespace,
	makeDurableObjectState,
	makeEnv,
	makeTrapNamespace,
} from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("vault-token-auth");

const GLOBAL_TOKEN = "global-operator-token-0123456789abcdef";
const VAULT_A = "vault-alpha-0001";
const VAULT_B = "vault-bravo-0002";
const HOST = "https://sync.example.test";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function hashOf(token: string): Promise<string> {
	return await sha256Hex(new TextEncoder().encode(token));
}

interface Deployment {
	env: Env;
	/** The real Durable Object, callable directly for storage-level tests. */
	config: ServerConfig;
	storage: FakeDurableObjectStorage;
}

/**
 * A server whose YAOS_CONFIG namespace is backed by a real ServerConfig
 * instance.  YAOS_SYNC stays a trap: no test here should reach a room, and a
 * throw from it is how "the auth gate let this through" is observed.
 */
function freshDeployment(): Deployment {
	invalidateStoredServerConfigCache();
	const storage = new FakeDurableObjectStorage();
	const config = new ServerConfig(makeDurableObjectState(storage));
	const env = makeEnv({
		SYNC_TOKEN: undefined,
		YAOS_SYNC: makeTrapNamespace("YAOS_SYNC accessed by a vault-token test"),
		YAOS_CONFIG: makeConfigNamespace(async (req) => await config.fetch(req)),
	});
	return { env, config, storage };
}

async function configPost(config: ServerConfig, path: string, body: unknown): Promise<Response> {
	return await config.fetch(new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}));
}

/** Raw body variant, for the malformed-JSON case a JSON.stringify cannot express. */
async function configPostRaw(config: ServerConfig, path: string, body: string): Promise<Response> {
	return await config.fetch(new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	}));
}

interface ReadableConfig {
	claimed: boolean;
	tokenHash: string | null;
	vaultTokens: Record<string, { tokenHash: string; label: string | null; createdAt: number }>;
}

async function readConfig(config: ServerConfig): Promise<ReadableConfig> {
	const res = await config.fetch(new Request("https://internal/__yaos/config"));
	return await res.json();
}

async function claim(config: ServerConfig, token: string): Promise<void> {
	const res = await configPost(config, "/__yaos/claim", { tokenHash: await hashOf(token) });
	if (!res.ok) throw new Error(`claim failed (${res.status})`);
}

function request(method: string, path: string, token: string | null, body?: unknown): Request {
	const headers: Record<string, string> = {};
	if (token !== null) headers["Authorization"] = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	return new Request(`${HOST}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/**
 * Status of a vault route, or "reached-handler" when the route got past the
 * auth gate and died on the trapped room namespace.
 *
 * Reaching the handler IS the pass condition for routes whose handler needs a
 * Durable Object: the alternative — a 401/503 — is exactly what the test is
 * ruling out.
 */
async function vaultRouteOutcome(
	env: Env,
	method: string,
	path: string,
	token: string | null,
): Promise<number | "reached-handler"> {
	try {
		const res = await worker.fetch(request(method, path, token), env);
		return res.status;
	} catch {
		return "reached-handler";
	}
}

async function issueVaultToken(
	env: Env,
	vaultId: string,
	label?: string,
): Promise<{ status: number; token: string; body: Record<string, unknown> }> {
	const res = await worker.fetch(
		request("POST", "/api/vault-tokens", GLOBAL_TOKEN, label === undefined ? { vaultId } : { vaultId, label }),
		env,
	);
	const body = await res.json() as Record<string, unknown>;
	return { status: res.status, token: typeof body.token === "string" ? body.token : "", body };
}

// ---------------------------------------------------------------------------
// 1. Durable Object storage
// ---------------------------------------------------------------------------

s.section("Test 1: storage — a config written before vault tokens existed reads as an empty map");
{
	const { config, storage } = freshDeployment();
	// Exactly what the previous version of ServerConfig wrote: no vaultTokens key.
	await storage.put("claimed", true);
	await storage.put("tokenHash", await hashOf(GLOBAL_TOKEN));

	const stored = await readConfig(config);
	s.check(stored.claimed === true, "pre-existing claim still reads as claimed");
	s.check(
		stored.vaultTokens !== undefined && Object.keys(stored.vaultTokens).length === 0,
		"absent vaultTokens key reads as {} rather than undefined",
	);
	s.check(!storage.keys().includes("vaultTokens"), "reading the config does not write the key back");
}

s.section("Test 2: storage — upsert, rotate and revoke");
{
	const { config } = freshDeployment();

	const created = await configPost(config, "/__yaos/vault-tokens", {
		vaultId: VAULT_A,
		tokenHash: "hash-one",
		label: "  laptop  ",
		createdAt: 1_000,
	});
	s.check(created.status === 200, "upsert returns 200");
	const afterCreate = await readConfig(config);
	s.check(afterCreate.vaultTokens[VAULT_A]?.tokenHash === "hash-one", "upsert stores the hash");
	s.check(afterCreate.vaultTokens[VAULT_A]?.label === "laptop", "label is trimmed");
	s.check(afterCreate.vaultTokens[VAULT_A]?.createdAt === 1_000, "createdAt is stored verbatim");

	await configPost(config, "/__yaos/vault-tokens", {
		vaultId: VAULT_A,
		tokenHash: "hash-two",
		label: "",
		createdAt: 2_000,
	});
	const afterRotate = await readConfig(config);
	s.check(afterRotate.vaultTokens[VAULT_A]?.tokenHash === "hash-two", "re-issuing replaces the hash (rotation)");
	s.check(afterRotate.vaultTokens[VAULT_A]?.label === null, "an empty label normalises to null");
	s.check(Object.keys(afterRotate.vaultTokens).length === 1, "rotation does not add a second entry");

	await configPost(config, "/__yaos/vault-tokens", { vaultId: VAULT_B, tokenHash: "hash-b", createdAt: 3_000 });
	s.check(Object.keys((await readConfig(config)).vaultTokens).length === 2, "a second vault adds an entry");

	const revoked = await configPost(config, "/__yaos/vault-tokens/revoke", { vaultId: VAULT_A });
	const revokedBody = await revoked.json() as { existed?: unknown };
	s.check(revoked.status === 200 && revokedBody.existed === true, "revoke reports existed=true");
	const afterRevoke = await readConfig(config);
	s.check(afterRevoke.vaultTokens[VAULT_A] === undefined, "revoke removes the entry");
	s.check(afterRevoke.vaultTokens[VAULT_B]?.tokenHash === "hash-b", "revoke leaves the other vault alone");

	const again = await configPost(config, "/__yaos/vault-tokens/revoke", { vaultId: VAULT_A });
	const againBody = await again.json() as { existed?: unknown };
	s.check(again.status === 200 && againBody.existed === false, "revoking an unknown vault reports existed=false");
}

s.section("Test 3: storage — input validation");
{
	const { config } = freshDeployment();
	const rejections: Array<[string, unknown]> = [
		["vaultId shorter than 8 chars", { vaultId: "short", tokenHash: "h" }],
		["vaultId longer than 256 chars", { vaultId: "v".repeat(257), tokenHash: "h" }],
		["non-string vaultId", { vaultId: 12345678, tokenHash: "h" }],
		["missing vaultId", { tokenHash: "h" }],
		["missing tokenHash", { vaultId: VAULT_A }],
		["empty tokenHash", { vaultId: VAULT_A, tokenHash: "" }],
		["non-string label", { vaultId: VAULT_A, tokenHash: "h", label: 7 }],
		["label longer than 64 chars", { vaultId: VAULT_A, tokenHash: "h", label: "l".repeat(65) }],
		["non-numeric createdAt", { vaultId: VAULT_A, tokenHash: "h", createdAt: "yesterday" }],
	];
	for (const [label, body] of rejections) {
		const res = await configPost(config, "/__yaos/vault-tokens", body);
		s.check(res.status === 400, `${label} → 400`);
	}

	const malformed = await configPostRaw(config, "/__yaos/vault-tokens", "{not json");
	s.check(malformed.status === 400, "malformed JSON → 400");
	const badRevoke = await configPost(config, "/__yaos/vault-tokens/revoke", { vaultId: "short" });
	s.check(badRevoke.status === 400, "revoke with an invalid vaultId → 400");

	s.check(
		Object.keys((await readConfig(config)).vaultTokens).length === 0,
		"no rejected request wrote anything",
	);
}

s.section("Test 4: storage — the vault cap bounds new vaults but never rotation");
{
	const { config } = freshDeployment();
	for (let i = 0; i < MAX_VAULT_TOKENS; i++) {
		const res = await configPost(config, "/__yaos/vault-tokens", {
			vaultId: `vault-${i.toString().padStart(4, "0")}`,
			tokenHash: `hash-${i}`,
			createdAt: i,
		});
		if (res.status !== 200) {
			s.check(false, `filling the map failed at entry ${i} (${res.status})`);
			break;
		}
	}
	s.check(
		Object.keys((await readConfig(config)).vaultTokens).length === MAX_VAULT_TOKENS,
		`the map holds ${MAX_VAULT_TOKENS} entries`,
	);

	const overflow = await configPost(config, "/__yaos/vault-tokens", {
		vaultId: "vault-overflow-1",
		tokenHash: "hash-overflow",
		createdAt: 1,
	});
	const overflowBody = await overflow.json() as { error?: unknown };
	s.check(overflow.status === 400, "a new vault past the cap is refused with 400");
	s.check(overflowBody.error === "too many vault tokens", "the refusal names the cap");

	const rotate = await configPost(config, "/__yaos/vault-tokens", {
		vaultId: "vault-0000",
		tokenHash: "hash-rotated",
		createdAt: 9,
	});
	s.check(rotate.status === 200, "rotating an existing vault at the cap still succeeds");
	const capped = await readConfig(config);
	s.check(capped.vaultTokens["vault-0000"]?.tokenHash === "hash-rotated", "the rotation was applied");
	s.check(Object.keys(capped.vaultTokens).length === MAX_VAULT_TOKENS, "the map did not grow past the cap");
}

// ---------------------------------------------------------------------------
// 2. Backward compatibility — the global token still opens everything
// ---------------------------------------------------------------------------

s.section("Test 5: the global token authorizes every vault (regression)");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	for (const vaultId of [VAULT_A, VAULT_B, "any-other-vault-id"]) {
		const res = await worker.fetch(request("POST", `/vault/${vaultId}/auth/ticket`, GLOBAL_TOKEN), env);
		s.check(res.status === 200, `global token issues a ticket for ${vaultId}`);
	}

	const debug = await vaultRouteOutcome(env, "GET", `/vault/${VAULT_A}/debug/recent`, GLOBAL_TOKEN);
	s.check(debug === "reached-handler", "global token passes the gate on /debug/recent");

	const wrong = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, "not-the-token"), env);
	s.check(wrong.status === 401, "an unrelated token is still rejected");
}

// ---------------------------------------------------------------------------
// 3-6. A vault token is scoped to its vault
// ---------------------------------------------------------------------------

s.section("Test 6: a vault token opens its own vault and no other");
const scoped = freshDeployment();
let vaultAToken = "";
{
	await claim(scoped.config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const issued = await issueVaultToken(scoped.env, VAULT_A, "alpha laptop");
	vaultAToken = issued.token;
	s.check(issued.status === 200, "POST /api/vault-tokens returns 200");
	s.check(vaultAToken.length >= 43, "the issued token carries at least 32 bytes of entropy");
	s.check(issued.body.vaultId === VAULT_A, "the response echoes the vaultId");
	s.check(issued.body.label === "alpha laptop", "the response echoes the label");
	s.check(typeof issued.body.createdAt === "number", "the response carries createdAt");
	s.check(
		typeof issued.body.obsidianUrl === "string"
		&& issued.body.obsidianUrl.startsWith("obsidian://yaos?")
		&& issued.body.obsidianUrl.includes(`vaultId=${VAULT_A}`),
		"the response carries a vault-scoped obsidian:// setup URL",
	);

	const stored = await readConfig(scoped.config);
	s.check(
		stored.vaultTokens[VAULT_A]?.tokenHash === await hashOf(vaultAToken),
		"only the SHA-256 of the issued token is persisted",
	);

	const own = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, vaultAToken), scoped.env);
	s.check(own.status === 200, "the vault token issues a ticket for its own vault");

	const other = await worker.fetch(request("POST", `/vault/${VAULT_B}/auth/ticket`, vaultAToken), scoped.env);
	s.check(other.status === 401, "the vault token is rejected for another vault");

	const ownDebug = await vaultRouteOutcome(scoped.env, "GET", `/vault/${VAULT_A}/debug/recent`, vaultAToken);
	s.check(ownDebug === "reached-handler", "the vault token passes the gate on its own /debug/recent");
	const otherDebug = await vaultRouteOutcome(scoped.env, "GET", `/vault/${VAULT_B}/debug/recent`, vaultAToken);
	s.check(otherDebug === 401, "the vault token gets 401 on another vault's /debug/recent");

	const authState = await getAuthStateCached(scoped.env);
	s.check(await isAuthorizedForVault(authState, vaultAToken, VAULT_A), "isAuthorizedForVault: own vault");
	s.check(!(await isAuthorizedForVault(authState, vaultAToken, VAULT_B)), "isAuthorizedForVault: other vault");
	s.check(await isAuthorizedForVault(authState, GLOBAL_TOKEN, VAULT_B), "isAuthorizedForVault: global token opens any vault");
	s.check(!(await isAuthorizedForVault(authState, null, VAULT_A)), "isAuthorizedForVault: no token");
	s.check(!(await isAuthorizedForVault(authState, "guessed-token", VAULT_A)), "isAuthorizedForVault: wrong token");
}

s.section("Test 7: tickets obtained with a vault token stay vault-scoped");
{
	const res = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, vaultAToken), scoped.env);
	const body = await res.json() as { ticket?: unknown };
	const ticket = typeof body.ticket === "string" ? body.ticket : "";
	s.check(ticket.length > 0, "the vault token obtained a ticket");

	const authState = await getAuthStateCached(scoped.env);
	s.check(await verifyTicket(ticket, authState, VAULT_A), "the ticket verifies for its own vault");
	s.check(!(await verifyTicket(ticket, authState, VAULT_B)), "the ticket does not verify for another vault");
}

s.section("Test 8: the legacy WebSocket ?token= path is vault-scoped");
{
	const authState = await getAuthStateCached(scoped.env);

	const own = await authenticateSocketRequest(null, vaultAToken, authState, VAULT_A, false);
	s.check(own.ok, "vault token authenticates its own room");
	s.check(own.ok && own.method === "legacy-token", "and does so through the legacy-token path");

	const other = await authenticateSocketRequest(null, vaultAToken, authState, VAULT_B, false);
	s.check(!other.ok, "vault token does not authenticate another room");
	s.check(!other.ok && other.reason === "unauthorized", "the other room reports unauthorized");

	const global = await authenticateSocketRequest(null, GLOBAL_TOKEN, authState, VAULT_B, false);
	s.check(global.ok, "the global token still authenticates any room");

	const routed = await vaultRouteOutcome(
		scoped.env,
		"GET",
		`/vault/sync/${VAULT_B}?token=${encodeURIComponent(vaultAToken)}&schemaVersion=${SERVER_SCHEMA_VERSION}`,
		null,
	);
	s.check(routed === 401, "the sync route rejects a foreign vault token with 401");
}

s.section("Test 9: revocation takes effect for the issuing isolate immediately");
{
	const res = await worker.fetch(
		request("POST", "/api/vault-tokens/revoke", GLOBAL_TOKEN, { vaultId: VAULT_A }),
		scoped.env,
	);
	const body = await res.json() as { ok?: unknown; existed?: unknown };
	s.check(res.status === 200 && body.ok === true, "revoke returns 200");
	s.check(body.existed === true, "revoke reports the token existed");

	// The handler invalidated the config cache, so the next request re-reads the
	// Durable Object rather than serving the pre-revocation map.
	const after = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, vaultAToken), scoped.env);
	s.check(after.status === 401, "the revoked token no longer opens its vault");

	const stillGlobal = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, GLOBAL_TOKEN), scoped.env);
	s.check(stillGlobal.status === 200, "the global token is unaffected by the revocation");

	const repeat = await worker.fetch(
		request("POST", "/api/vault-tokens/revoke", GLOBAL_TOKEN, { vaultId: VAULT_A }),
		scoped.env,
	);
	const repeatBody = await repeat.json() as { existed?: unknown };
	s.check(repeat.status === 200 && repeatBody.existed === false, "revoking again reports existed=false");
}

// ---------------------------------------------------------------------------
// 7. Operator API
// ---------------------------------------------------------------------------

s.section("Test 10: GET /api/vault-tokens lists metadata and never a hash");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const first = await issueVaultToken(env, VAULT_A, "alpha");
	const second = await issueVaultToken(env, VAULT_B);
	s.check(first.status === 200 && second.status === 200, "two tokens issued");

	const res = await worker.fetch(request("GET", "/api/vault-tokens", GLOBAL_TOKEN), env);
	const raw = await res.text();
	const body = JSON.parse(raw) as { ok?: unknown; vaultTokens?: Array<Record<string, unknown>> };
	s.check(res.status === 200 && body.ok === true, "list returns 200");
	s.check(body.vaultTokens?.length === 2, "list contains both vaults");
	s.check(
		body.vaultTokens?.some((entry) => entry.vaultId === VAULT_A && entry.label === "alpha") === true,
		"list carries vaultId and label",
	);
	s.check(
		body.vaultTokens?.every((entry) => typeof entry.createdAt === "number") === true,
		"list carries createdAt",
	);
	s.check(!raw.includes("tokenHash"), "list never mentions tokenHash");
	s.check(!raw.includes(await hashOf(first.token)), "list does not contain the stored hash");
	s.check(!raw.includes(first.token), "list does not contain the plaintext token");

	const rotated = await issueVaultToken(env, VAULT_A, "alpha rotated");
	s.check(rotated.status === 200 && rotated.token !== first.token, "re-issuing mints a different token");
	const afterRotate = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, first.token), env);
	s.check(afterRotate.status === 401, "the rotated-away token stops working");
	const withNew = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, rotated.token), env);
	s.check(withNew.status === 200, "the rotated-in token works");
	const listAfter = await worker.fetch(request("GET", "/api/vault-tokens", GLOBAL_TOKEN), env);
	const listAfterBody = await listAfter.json() as { vaultTokens?: Array<Record<string, unknown>> };
	s.check(listAfterBody.vaultTokens?.length === 2, "rotation does not add a list entry");
}

s.section("Test 11: the operator API rejects vault tokens and unauthenticated callers");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();
	const issued = await issueVaultToken(env, VAULT_A);
	s.check(issued.status === 200, "a vault token exists to test with");

	const calls: Array<[string, string, unknown]> = [
		["GET", "/api/vault-tokens", undefined],
		["POST", "/api/vault-tokens", { vaultId: VAULT_A }],
		["POST", "/api/vault-tokens/revoke", { vaultId: VAULT_A }],
	];
	for (const [method, path, body] of calls) {
		const withVaultToken = await worker.fetch(request(method, path, issued.token, body), env);
		s.check(withVaultToken.status === 401, `${method} ${path} with a vault token → 401`);
		const anonymous = await worker.fetch(request(method, path, null, body), env);
		s.check(anonymous.status === 401, `${method} ${path} with no token → 401`);
	}

	// The vault token must not have been able to revoke itself above.
	const stillWorks = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, issued.token), env);
	s.check(stillWorks.status === 200, "the vault token survived its own revoke attempt");

	const metadata = await worker.fetch(
		request("POST", "/api/update-metadata", issued.token, { updateProvider: "github" }),
		env,
	);
	s.check(metadata.status === 401, "POST /api/update-metadata with a vault token → 401");

	// Private update metadata stays operator-only.
	await configPost(config, "/__yaos/update-metadata", {
		updateProvider: "github",
		updateRepoUrl: "https://github.com/private/fork",
		updateRepoBranch: "secret-branch",
	});
	invalidateStoredServerConfigCache();

	const asVault = await worker.fetch(request("GET", "/api/capabilities", issued.token), env);
	const vaultCaps = await asVault.json() as Record<string, unknown>;
	s.check(vaultCaps.updateProvider === null, "a vault token does not unlock private update provider");
	s.check(vaultCaps.updateRepoUrl === null, "a vault token does not unlock private repo URL");
	s.check(vaultCaps.updateRepoBranch === null, "a vault token does not unlock private repo branch");

	const asOperator = await worker.fetch(request("GET", "/api/capabilities", GLOBAL_TOKEN), env);
	const operatorCaps = await asOperator.json() as Record<string, unknown>;
	s.check(operatorCaps.updateRepoUrl === "https://github.com/private/fork", "the global token still unlocks it");
}

s.section("Test 12: the operator API validates its input");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const bad: Array<[string, string, unknown, number]> = [
		["short vaultId", "/api/vault-tokens", { vaultId: "short" }, 400],
		["missing vaultId", "/api/vault-tokens", {}, 400],
		["oversized label", "/api/vault-tokens", { vaultId: VAULT_A, label: "l".repeat(65) }, 400],
		["short vaultId on revoke", "/api/vault-tokens/revoke", { vaultId: "short" }, 400],
	];
	for (const [label, path, body, expected] of bad) {
		const res = await worker.fetch(request("POST", path, GLOBAL_TOKEN, body), env);
		s.check(res.status === expected, `${label} → ${expected}`);
	}

	const malformed = await worker.fetch(
		new Request(`${HOST}/api/vault-tokens`, {
			method: "POST",
			headers: { Authorization: `Bearer ${GLOBAL_TOKEN}`, "Content-Type": "application/json" },
			body: "{not json",
		}),
		env,
	);
	s.check(malformed.status === 400, "malformed JSON → 400");

	s.check(
		Object.keys((await readConfig(config)).vaultTokens).length === 0,
		"no rejected operator call stored a token",
	);
}

s.section("Test 13: env mode answers 409 and unclaimed answers 503");
{
	invalidateStoredServerConfigCache();
	// Env mode makes zero config-DO calls, so the trap namespace is also the
	// proof that this rejection costs nothing.
	const envTrap = makeTrapNamespace("YAOS_CONFIG accessed in env mode");
	const envModeEnv: Env = makeEnv({
		SYNC_TOKEN: GLOBAL_TOKEN,
		YAOS_SYNC: makeTrapNamespace("YAOS_SYNC accessed in env mode"),
		YAOS_CONFIG: envTrap,
	});

	for (const [method, path, body] of [
		["GET", "/api/vault-tokens", undefined],
		["POST", "/api/vault-tokens", { vaultId: VAULT_A }],
		["POST", "/api/vault-tokens/revoke", { vaultId: VAULT_A }],
	] as Array<[string, string, unknown]>) {
		const res = await worker.fetch(request(method, path, GLOBAL_TOKEN, body), envModeEnv);
		const payload = await res.json() as { error?: unknown };
		s.check(res.status === 409, `${method} ${path} in env mode → 409`);
		s.check(payload.error === "unsupported_in_env_mode", `${method} ${path} names the env-mode limit`);
	}
	s.check(envTrap.touched.length === 0, "env mode did not touch YAOS_CONFIG");

	// The 409 sits AFTER the operator gate, so it is only ever shown to a caller
	// holding SYNC_TOKEN.  An unauthenticated prober learns nothing about the
	// server's auth mode from this route that /api/capabilities does not already
	// publish.
	for (const token of [null, "wrong-token"]) {
		const res = await worker.fetch(request("GET", "/api/vault-tokens", token), envModeEnv);
		s.check(
			res.status === 401,
			`env mode: ${token === null ? "an unauthenticated" : "a wrong-token"} caller gets 401, never the 409`,
		);
	}

	// Env mode keeps working for vault routes: the global token opens everything.
	const ticket = await worker.fetch(request("POST", `/vault/${VAULT_A}/auth/ticket`, GLOBAL_TOKEN), envModeEnv);
	s.check(ticket.status === 200, "env mode still issues tickets for the global token");

	const { env: unclaimedEnv } = freshDeployment();
	const unclaimed = await worker.fetch(request("GET", "/api/vault-tokens", GLOBAL_TOKEN), unclaimedEnv);
	const unclaimedBody = await unclaimed.json() as { error?: unknown };
	s.check(unclaimed.status === 503, "an unclaimed server → 503");
	s.check(unclaimedBody.error === "unclaimed", "the unclaimed response names the reason");
}

// ---------------------------------------------------------------------------
// 8. Prototype-shaped vault ids
// ---------------------------------------------------------------------------

s.section("Test 14: a vaultId of __proto__ is an ordinary key, not a prototype assignment");
{
	// `__proto__` is the one property name that is a setter on Object.prototype
	// rather than a data property, so on a `{}` map `tokens["__proto__"] = record`
	// would swap the map's prototype and store nothing — reporting success while
	// the token never persisted.  The stored map has a null prototype, so this is
	// an ordinary key.  Both round-trips it makes (structured clone into storage,
	// JSON through the Worker) are exercised below rather than assumed.
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	await configPost(config, "/__yaos/vault-tokens", { vaultId: VAULT_B, tokenHash: "hash-b", createdAt: 1 });
	const created = await configPost(config, "/__yaos/vault-tokens", {
		vaultId: "__proto__",
		tokenHash: "hash-proto",
		label: "prototype",
		createdAt: 2,
	});
	s.check(created.status === 200, "storage: upsert with vaultId __proto__ returns 200");

	const stored = await readConfig(config);
	s.check(
		Object.prototype.hasOwnProperty.call(stored.vaultTokens, "__proto__"),
		"storage: __proto__ is an OWN property of the map, not a swapped prototype",
	);
	s.check(stored.vaultTokens["__proto__"]?.tokenHash === "hash-proto", "storage: the record is readable by index");
	s.check(stored.vaultTokens["__proto__"]?.label === "prototype", "storage: the record kept its label");
	s.check(
		Object.keys(stored.vaultTokens).length === 2 && stored.vaultTokens[VAULT_B]?.tokenHash === "hash-b",
		"storage: the other vault's entry is unaffected",
	);
	s.check(
		typeof Object.getPrototypeOf(stored.vaultTokens) === "object",
		"storage: the JSON-parsed map is still an ordinary object (no prototype was replaced)",
	);

	// End-to-end: issue through the operator API and use the plaintext.
	const issued = await issueVaultToken(env, "__proto__", "deep link");
	s.check(issued.status === 200, "API: issuing for vaultId __proto__ returns 200");
	s.check(issued.token.length >= 43, "API: a real token was minted");

	const listed = await worker.fetch(request("GET", "/api/vault-tokens", GLOBAL_TOKEN), env);
	const listedBody = await listed.json() as { vaultTokens?: Array<Record<string, unknown>> };
	s.check(
		listedBody.vaultTokens?.some((entry) => entry.vaultId === "__proto__" && entry.label === "deep link") === true,
		"API: the listing shows the __proto__ vault like any other",
	);

	const own = await worker.fetch(
		request("POST", `/vault/${encodeURIComponent("__proto__")}/auth/ticket`, issued.token),
		env,
	);
	s.check(own.status === 200, "auth: the issued token opens /vault/__proto__ (the write really persisted)");

	const other = await worker.fetch(request("POST", `/vault/${VAULT_B}/auth/ticket`, issued.token), env);
	s.check(other.status === 401, "auth: the __proto__ token does not open another vault");

	const authState = await getAuthStateCached(env);
	s.check(await isAuthorizedForVault(authState, issued.token, "__proto__"), "auth: isAuthorizedForVault accepts it");
	s.check(
		!(await isAuthorizedForVault(authState, "wrong-token", "__proto__")),
		"auth: a wrong token is still refused for __proto__",
	);
	// The prototype chain must not be able to answer for a vault that has no token.
	s.check(
		!(await isAuthorizedForVault(authState, issued.token, "vault-never-issued")),
		"auth: an unissued vault is not authorized by the __proto__ record",
	);

	const revoked = await worker.fetch(
		request("POST", "/api/vault-tokens/revoke", GLOBAL_TOKEN, { vaultId: "__proto__" }),
		env,
	);
	const revokedBody = await revoked.json() as { existed?: unknown };
	s.check(revoked.status === 200 && revokedBody.existed === true, "revoke: __proto__ reports existed=true");
	const afterRevoke = await worker.fetch(
		request("POST", `/vault/${encodeURIComponent("__proto__")}/auth/ticket`, issued.token),
		env,
	);
	s.check(afterRevoke.status === 401, "revoke: the __proto__ token stops working");
	s.check(
		Object.keys((await readConfig(config)).vaultTokens).length === 1,
		"revoke: only the __proto__ entry was removed",
	);
}

invalidateStoredServerConfigCache();
await s.done();
