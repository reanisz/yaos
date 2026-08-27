/**
 * Strict permissions mode (YAOS_STRICT_PERMISSIONS).
 *
 * Runs the REAL ServerConfig Durable Object over in-memory storage and the REAL
 * Access verifier against a real RSA keypair, driven through worker.fetch — the
 * same shape as tests/server/vault-token-auth.ts and tests/server/admin-routes.ts,
 * for the same reason: the gate under test should be the one a deployment runs.
 *
 * The claims under test, in the order they matter:
 *
 *   1. STORAGE.  A separate strictTokens store, appended to rather than
 *      rotated, capped, validated, and safe against a `__proto__` key in both
 *      of its two positions (tokenId and vaultId).
 *   2. THE SIGNING SECRET.  Get-or-create is idempotent, and the secret never
 *      appears in any HTTP response body — asserted on raw text, not on a
 *      parsed field, because the failure mode is a stray spread rather than a
 *      deliberate one.
 *   3. THE AUTH MATRIX.  A device token opens its own vault and nothing else;
 *      the claimed token and SYNC_TOKEN open nothing at all; the operator API
 *      is closed; /claim is refused from the environment alone.
 *   4. BOOTSTRAP.  /admin issues the first token on a server nobody ever
 *      claimed — the property that makes strict mode usable rather than a
 *      locked door.
 *   5. THE COMPATIBILITY SHIM.  Capabilities report authMode "claim" plus an
 *      additive strictPermissions flag, because the plugin's validator
 *      hard-enumerates authMode and rejects the whole payload otherwise.
 *
 * MODULE STATE.  routes/auth.ts holds one config cache, one pair of
 * once-per-isolate strict warning latches, and accessJwt.ts holds one JWKS
 * cache — for the whole process.  freshDeployment() clears the first and the
 * third; the warning latches are cleared only by the sections that assert on a
 * warning, so the rest of the run emits each line at most once, exactly as a
 * real isolate would.
 *
 * NETWORK.  verifyAccessJwt fetches the JWKS through global fetch when called
 * without injected deps, which is how the Worker calls it.  Sections needing
 * one install a scoped stub and restore it in a finally.
 */

import worker from "../../server/src/index";
import {
	MAX_STRICT_TOKENS,
	ServerConfig,
	type StrictTokenRecord,
} from "../../server/src/config";
import { resetAccessModuleStateForTests } from "../../server/src/accessJwt";
import {
	getAuthStateCached,
	invalidateStoredServerConfigCache,
	isAuthorized,
	isAuthorizedForVault,
	isStrictPermissionsEnabled,
	resetStrictWarningsForTests,
} from "../../server/src/routes/auth";
import { authenticateSocketRequest } from "../../server/src/routes/syncSocket";
import { verifyTicket } from "../../server/src/routes/ticket";
import { sha256Hex } from "../../server/src/hex";
import { SERVER_SCHEMA_VERSION } from "../../server/src/version";
import type { Env } from "../../server/src/routes/types";
import {
	accessJwksDocument,
	accessJwksUrl,
	signAccessJwt,
	TEST_ACCESS_AUD,
	TEST_ACCESS_KID,
	TEST_ACCESS_TEAM_DOMAIN,
} from "../mocks/accessJwt.ts";
import {
	FakeDurableObjectStorage,
	makeConfigNamespace,
	makeDurableObjectState,
	makeEnv,
	makeTrapNamespace,
	type FakeTrapNamespace,
} from "../mocks/workerEnv.ts";
import { readSource, suite } from "../harness.ts";

const s = suite("strict-permissions");

const HOST = "https://sync.example.test";
const GLOBAL_TOKEN = "global-operator-token-0123456789abcdef";
const VAULT_A = "vault-alpha-0001";
const VAULT_B = "vault-bravo-0002";
const JWKS_URL = accessJwksUrl(TEST_ACCESS_TEAM_DOMAIN);

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
	/** Records every YAOS_SYNC access; almost nothing here may reach a room. */
	syncTrap: FakeTrapNamespace;
}

/**
 * A server in strict mode with Cloudflare Access configured and a real
 * ServerConfig behind YAOS_CONFIG.
 *
 * `overrides` is applied last so a section can drop the Access variables, add a
 * SYNC_TOKEN, or turn strict mode off to check a default-mode control.
 */
function freshDeployment(overrides: Partial<Env> = {}): Deployment {
	invalidateStoredServerConfigCache();
	resetAccessModuleStateForTests();
	const storage = new FakeDurableObjectStorage();
	const config = new ServerConfig(makeDurableObjectState(storage));
	const syncTrap = makeTrapNamespace("YAOS_SYNC accessed by a strict-permissions test");
	const env = makeEnv({
		SYNC_TOKEN: undefined,
		YAOS_STRICT_PERMISSIONS: "1",
		YAOS_ACCESS_TEAM_DOMAIN: TEST_ACCESS_TEAM_DOMAIN,
		YAOS_ACCESS_AUD: TEST_ACCESS_AUD,
		YAOS_SYNC: syncTrap,
		YAOS_CONFIG: makeConfigNamespace(async (req) => await config.fetch(req)),
		...overrides,
	});
	return { env, config, storage, syncTrap };
}

async function configPost(config: ServerConfig, path: string, body: unknown): Promise<Response> {
	return await config.fetch(new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}));
}

/** Raw body variant, for the malformed-JSON case JSON.stringify cannot express. */
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
	updateProvider: string | null;
	vaultTokens: Record<string, unknown>;
	strictTokens: Record<string, StrictTokenRecord>;
	ticketSigningSecret: string | null;
}

async function readConfig(config: ServerConfig): Promise<ReadableConfig> {
	const res = await config.fetch(new Request("https://internal/__yaos/config"));
	return await res.json();
}

async function claim(config: ServerConfig, token: string): Promise<void> {
	const res = await configPost(config, "/__yaos/claim", { tokenHash: await hashOf(token) });
	if (!res.ok) throw new Error(`claim failed (${res.status})`);
}

/** Seed one strict token directly through the DO, returning its plaintext. */
async function seedStrictToken(
	config: ServerConfig,
	tokenId: string,
	vaultId: string,
	label: string,
	token: string,
): Promise<void> {
	const res = await configPost(config, "/__yaos/strict-tokens", {
		tokenId,
		vaultId,
		tokenHash: await hashOf(token),
		label,
		createdAt: Date.now(),
	});
	if (!res.ok) throw new Error(`seeding strict token failed (${res.status})`);
	invalidateStoredServerConfigCache();
}

function bearerRequest(method: string, path: string, token: string | null, body?: unknown): Request {
	const headers = new Headers();
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return new Request(`${HOST}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

interface AdminRequestOptions {
	body?: unknown;
	contentType?: string | null;
}

function adminRequest(
	method: string,
	path: string,
	jwt: string | null,
	options: AdminRequestOptions = {},
): Request {
	const headers = new Headers();
	if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
	const contentType = options.contentType === undefined
		? (options.body === undefined ? null : "application/json")
		: options.contentType;
	if (contentType !== null) headers.set("Content-Type", contentType);
	return new Request(`${HOST}${path}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
}

/** Access claims as Cloudflare mints them, dated against the real clock. */
function accessClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
	const nowSec = Math.floor(Date.now() / 1_000);
	return {
		iss: `https://${TEST_ACCESS_TEAM_DOMAIN}`,
		aud: TEST_ACCESS_AUD,
		iat: nowSec - 10,
		exp: nowSec + 600,
		email: "operator@example.test",
		sub: "cf-access-sub-1",
		...over,
	};
}

interface FetchStub {
	readonly urls: string[];
	restore(): void;
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input instanceof Request) return input.url;
	return String(input);
}

function installFetchStub(): FetchStub {
	const original = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = async (input, _init) => {
		const url = urlOf(input);
		urls.push(url);
		if (url !== JWKS_URL) {
			throw new Error(`strict-permissions: unexpected outbound fetch to ${url}`);
		}
		return new Response(JSON.stringify(accessJwksDocument(TEST_ACCESS_KID)), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	return {
		urls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

/** Run `body` with console.warn captured, so a suite run stays readable. */
async function captureWarn<T>(body: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		return { value: await body(), warnings };
	} finally {
		console.warn = original;
	}
}

/**
 * Status of a vault route, or "reached-handler" when the route got past the
 * auth gate and died on the trapped room namespace.
 *
 * Reaching the handler IS the pass condition for routes whose handler needs a
 * room: the alternative — a 401 — is exactly what the test is ruling out.
 */
async function vaultRouteOutcome(
	env: Env,
	method: string,
	path: string,
	token: string | null,
): Promise<number | "reached-handler"> {
	try {
		const res = await worker.fetch(bearerRequest(method, path, token), env);
		return res.status;
	} catch {
		return "reached-handler";
	}
}

// ---------------------------------------------------------------------------
// 1. Storage
// ---------------------------------------------------------------------------

s.section("Test 1: storage — a config written before strict mode existed reads as empty");
{
	const { config, storage } = freshDeployment();
	// Exactly what the previous version of ServerConfig wrote.
	await storage.put("claimed", true);
	await storage.put("tokenHash", await hashOf(GLOBAL_TOKEN));

	const stored = await readConfig(config);
	s.check(stored.claimed === true, "pre-existing claim still reads as claimed");
	s.check(
		stored.strictTokens !== undefined && Object.keys(stored.strictTokens).length === 0,
		"absent strictTokens key reads as {} rather than undefined",
	);
	s.check(stored.ticketSigningSecret === null, "absent signing secret reads as null");
	s.check(!storage.keys().includes("strictTokens"), "reading the config does not write the key back");
	s.check(
		!storage.keys().includes("ticketSigningSecret"),
		"reading the config does not create a signing secret",
	);
}

s.section("Test 2: storage — issuing APPENDS, and revoking removes exactly one device");
{
	const { config } = freshDeployment();

	const first = await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-one",
		vaultId: VAULT_A,
		tokenHash: "hash-one",
		label: "  work laptop  ",
		createdAt: 1_000,
	});
	s.check(first.status === 200, "issue returns 200");
	const afterFirst = await readConfig(config);
	s.check(afterFirst.strictTokens["tok-one"]?.tokenHash === "hash-one", "the hash is stored");
	s.check(afterFirst.strictTokens["tok-one"]?.label === "work laptop", "the label is trimmed");
	s.check(afterFirst.strictTokens["tok-one"]?.vaultId === VAULT_A, "the record carries its vaultId");
	s.check(afterFirst.strictTokens["tok-one"]?.createdAt === 1_000, "createdAt is stored verbatim");

	// The defining difference from vaultTokens: a second token for the SAME
	// vault is a second device, not a rotation.
	await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-two",
		vaultId: VAULT_A,
		tokenHash: "hash-two",
		label: "phone",
		createdAt: 2_000,
	});
	const afterSecond = await readConfig(config);
	s.check(Object.keys(afterSecond.strictTokens).length === 2, "a second token for the same vault is ADDED");
	s.check(afterSecond.strictTokens["tok-one"]?.tokenHash === "hash-one", "the first device's token is untouched");

	await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-three",
		vaultId: VAULT_B,
		tokenHash: "hash-three",
		label: "other vault",
		createdAt: 3_000,
	});
	s.check(Object.keys((await readConfig(config)).strictTokens).length === 3, "a second vault adds an entry");

	const revoked = await configPost(config, "/__yaos/strict-tokens/revoke", { tokenId: "tok-one" });
	const revokedBody = await revoked.json() as { existed?: unknown };
	s.check(revoked.status === 200 && revokedBody.existed === true, "revoke reports existed=true");
	const afterRevoke = await readConfig(config);
	s.check(afterRevoke.strictTokens["tok-one"] === undefined, "revoke removes the entry");
	s.check(
		afterRevoke.strictTokens["tok-two"]?.tokenHash === "hash-two"
		&& afterRevoke.strictTokens["tok-three"]?.tokenHash === "hash-three",
		"revoking one device leaves the vault's other device and the other vault alone",
	);

	const again = await configPost(config, "/__yaos/strict-tokens/revoke", { tokenId: "tok-one" });
	const againBody = await again.json() as { existed?: unknown };
	s.check(again.status === 200 && againBody.existed === false, "revoking an unknown tokenId reports existed=false");

	// A duplicate tokenId would silently overwrite another device's token —
	// the one thing append semantics exist to prevent.
	const duplicate = await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-two",
		vaultId: VAULT_A,
		tokenHash: "hash-collision",
		label: "impostor",
		createdAt: 4_000,
	});
	const duplicateBody = await duplicate.json() as { error?: unknown };
	s.check(duplicate.status === 400, "a duplicate tokenId is refused");
	s.check(duplicateBody.error === "duplicate tokenId", "the refusal names the collision");
	s.check(
		(await readConfig(config)).strictTokens["tok-two"]?.tokenHash === "hash-two",
		"the refused duplicate did not overwrite the existing device",
	);
}

s.section("Test 3: storage — input validation, with a REQUIRED label");
{
	const { config } = freshDeployment();
	const valid = { tokenId: "tok-valid", vaultId: VAULT_A, tokenHash: "h", label: "laptop", createdAt: 1 };
	const rejections: Array<[string, unknown]> = [
		["missing tokenId", { ...valid, tokenId: undefined }],
		["empty tokenId", { ...valid, tokenId: "" }],
		["non-string tokenId", { ...valid, tokenId: 1234 }],
		["tokenId outside the base64url alphabet", { ...valid, tokenId: "tok/with+slash" }],
		["tokenId longer than 64 chars", { ...valid, tokenId: "t".repeat(65) }],
		["vaultId shorter than 8 chars", { ...valid, vaultId: "short" }],
		["vaultId longer than 256 chars", { ...valid, vaultId: "v".repeat(257) }],
		["missing vaultId", { ...valid, vaultId: undefined }],
		["missing tokenHash", { ...valid, tokenHash: undefined }],
		["empty tokenHash", { ...valid, tokenHash: "" }],
		// The label rules are where strict mode differs from vaultTokens: a
		// device with no name is a token nobody dares revoke.
		["missing label", { ...valid, label: undefined }],
		["null label", { ...valid, label: null }],
		["empty label", { ...valid, label: "" }],
		["whitespace-only label", { ...valid, label: "   " }],
		["non-string label", { ...valid, label: 7 }],
		["label longer than 64 chars", { ...valid, label: "l".repeat(65) }],
		["non-numeric createdAt", { ...valid, createdAt: "yesterday" }],
	];
	for (const [label, body] of rejections) {
		const res = await configPost(config, "/__yaos/strict-tokens", body);
		s.check(res.status === 400, `${label} → 400`);
	}

	const malformed = await configPostRaw(config, "/__yaos/strict-tokens", "{not json");
	s.check(malformed.status === 400, "malformed JSON → 400");
	for (const [label, body] of [
		["missing tokenId", {}],
		["non-string tokenId", { tokenId: 5 }],
		["tokenId outside the alphabet", { tokenId: "has spaces" }],
	] as Array<[string, unknown]>) {
		const res = await configPost(config, "/__yaos/strict-tokens/revoke", body);
		s.check(res.status === 400, `revoke with ${label} → 400`);
	}

	s.check(
		Object.keys((await readConfig(config)).strictTokens).length === 0,
		"no rejected request wrote anything",
	);
}

s.section("Test 4: storage — the cap bounds the whole store");
{
	const { config } = freshDeployment();
	for (let i = 0; i < MAX_STRICT_TOKENS; i++) {
		const res = await configPost(config, "/__yaos/strict-tokens", {
			tokenId: `tok-${i.toString().padStart(4, "0")}`,
			vaultId: `vault-${i.toString().padStart(4, "0")}`,
			tokenHash: `hash-${i}`,
			label: `device ${i}`,
			createdAt: i,
		});
		if (res.status !== 200) {
			s.check(false, `filling the store failed at entry ${i} (${res.status})`);
			break;
		}
	}
	s.check(
		Object.keys((await readConfig(config)).strictTokens).length === MAX_STRICT_TOKENS,
		`the store holds ${MAX_STRICT_TOKENS} entries`,
	);

	const overflow = await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-overflow",
		vaultId: "vault-overflow-1",
		tokenHash: "hash-overflow",
		label: "one too many",
		createdAt: 1,
	});
	const overflowBody = await overflow.json() as { error?: unknown };
	s.check(overflow.status === 400, "one past the cap is refused with 400");
	s.check(overflowBody.error === "too many strict tokens", "the refusal names the cap");

	// Unlike vaultTokens there is no rotation exemption: every issue grows the
	// store, so at the cap every issue is refused until something is revoked.
	const freed = await configPost(config, "/__yaos/strict-tokens/revoke", { tokenId: "tok-0000" });
	s.check(freed.status === 200, "revoking frees a slot");
	const afterFree = await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-overflow",
		vaultId: "vault-overflow-1",
		tokenHash: "hash-overflow",
		label: "now it fits",
		createdAt: 2,
	});
	s.check(afterFree.status === 200, "the freed slot can be reused");
	s.check(
		Object.keys((await readConfig(config)).strictTokens).length === MAX_STRICT_TOKENS,
		"the store did not grow past the cap",
	);
}

s.section("Test 5: storage — __proto__ is an ordinary key in BOTH positions");
{
	// `__proto__` is the one property name that is an inherited setter rather
	// than a data property, so on a `{}` map `tokens["__proto__"] = record`
	// would swap the map's prototype and store nothing while reporting success.
	// It is also a legal base64url string, so a tokenId can be it — the
	// null-prototype map is what makes that safe, not a blacklist.
	const { env, config } = freshDeployment();

	await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-control",
		vaultId: VAULT_B,
		tokenHash: "hash-control",
		label: "control",
		createdAt: 1,
	});
	const created = await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "__proto__",
		vaultId: "__proto__vault",
		tokenHash: "hash-proto",
		label: "prototype device",
		createdAt: 2,
	});
	s.check(created.status === 200, "a tokenId of __proto__ is accepted");

	const stored = await readConfig(config);
	s.check(
		Object.prototype.hasOwnProperty.call(stored.strictTokens, "__proto__"),
		"__proto__ is an OWN property of the map, not a swapped prototype",
	);
	s.check(stored.strictTokens["__proto__"]?.tokenHash === "hash-proto", "the record is readable by index");
	s.check(stored.strictTokens["__proto__"]?.label === "prototype device", "the record kept its label");
	s.check(
		Object.keys(stored.strictTokens).length === 2
		&& stored.strictTokens["tok-control"]?.tokenHash === "hash-control",
		"the control entry is unaffected",
	);

	// The same name as a vaultId, reached through the auth path rather than
	// through storage: the record must authorize its own vault and no other.
	const protoToken = "proto-vault-device-token-000000000000";
	await seedStrictToken(config, "tok-proto-vault", "__proto__", "proto vault device", protoToken);
	const authState = await getAuthStateCached(env);
	s.check(
		await isAuthorizedForVault(authState, protoToken, "__proto__"),
		"a vaultId of __proto__ authorizes through the strict path",
	);
	s.check(
		!(await isAuthorizedForVault(authState, protoToken, "vault-never-issued")),
		"the prototype chain does not answer for a vault that has no token",
	);
}

// ---------------------------------------------------------------------------
// 2. The ticket signing secret
// ---------------------------------------------------------------------------

s.section("Test 6: the signing secret is created once and never rotates");
{
	const { config } = freshDeployment();

	const first = await configPost(config, "/__yaos/signing-secret", {});
	const firstBody = await first.json() as { ok?: unknown; ticketSigningSecret?: unknown };
	const secret = typeof firstBody.ticketSigningSecret === "string" ? firstBody.ticketSigningSecret : "";
	s.check(first.status === 200 && firstBody.ok === true, "get-or-create returns 200");
	// 32 bytes base64url with no padding is 43 characters.
	s.check(secret.length === 43, `the secret carries 32 bytes of entropy (got ${secret.length} chars)`);
	s.check(/^[A-Za-z0-9_-]+$/.test(secret), "the secret is base64url");

	const second = await configPost(config, "/__yaos/signing-secret", {});
	const secondBody = await second.json() as { ticketSigningSecret?: unknown };
	s.check(secondBody.ticketSigningSecret === secret, "a second call returns the SAME secret, never a new one");

	// Concurrent callers must converge too: a second secret would silently
	// invalidate every ticket signed with the first.
	const racers = await Promise.all([
		configPost(config, "/__yaos/signing-secret", {}),
		configPost(config, "/__yaos/signing-secret", {}),
		configPost(config, "/__yaos/signing-secret", {}),
	]);
	const raced = await Promise.all(racers.map(async (res) =>
		(await res.json() as { ticketSigningSecret?: unknown }).ticketSigningSecret));
	s.check(raced.every((value) => value === secret), "concurrent get-or-create calls all see one secret");

	s.check((await readConfig(config)).ticketSigningSecret === secret, "the secret is what the config reports");

	// Issuing and revoking tokens must not disturb it.
	await configPost(config, "/__yaos/strict-tokens", {
		tokenId: "tok-after", vaultId: VAULT_A, tokenHash: "h", label: "later device", createdAt: 1,
	});
	await configPost(config, "/__yaos/strict-tokens/revoke", { tokenId: "tok-after" });
	s.check((await readConfig(config)).ticketSigningSecret === secret, "token churn does not rotate the secret");
}

// ---------------------------------------------------------------------------
// 3. The auth matrix
// ---------------------------------------------------------------------------

const DEVICE_A1 = "device-a1-token-000000000000000000000";
const DEVICE_A2 = "device-a2-token-111111111111111111111";
const DEVICE_B1 = "device-b1-token-222222222222222222222";

s.section("Test 7: a device token opens its own vault, and only its own vault");
const matrix = freshDeployment();
{
	// A server that WAS claimed before strict mode was turned on — the case
	// where a global token exists and must nonetheless be dead.
	await claim(matrix.config, GLOBAL_TOKEN);
	await seedStrictToken(matrix.config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);
	await seedStrictToken(matrix.config, "tok-a2", VAULT_A, "phone", DEVICE_A2);
	await seedStrictToken(matrix.config, "tok-b1", VAULT_B, "laptop", DEVICE_B1);

	const authState = await getAuthStateCached(matrix.env);
	s.check(authState.mode === "strict", "the auth state is strict mode");
	s.check(authState.claimed === true, "strict carries claimed:true so the 503 paths never fire");

	s.check(await isAuthorizedForVault(authState, DEVICE_A1, VAULT_A), "device A1 opens vault A");
	s.check(await isAuthorizedForVault(authState, DEVICE_A2, VAULT_A), "device A2 opens vault A too");
	s.check(!(await isAuthorizedForVault(authState, DEVICE_A1, VAULT_B)), "device A1 does not open vault B");
	s.check(!(await isAuthorizedForVault(authState, DEVICE_B1, VAULT_A)), "device B1 does not open vault A");
	s.check(!(await isAuthorizedForVault(authState, null, VAULT_A)), "no token opens nothing");
	s.check(!(await isAuthorizedForVault(authState, "guessed-token", VAULT_A)), "a wrong token opens nothing");

	// THE CENTRAL CLAIM: the credential that used to open every vault opens none.
	s.check(
		!(await isAuthorizedForVault(authState, GLOBAL_TOKEN, VAULT_A)),
		"the claimed token does NOT open a vault in strict mode",
	);
	s.check(!(await isAuthorized(authState, GLOBAL_TOKEN)), "the claimed token is not an operator either");
	s.check(!(await isAuthorized(authState, DEVICE_A1)), "a device token is not an operator");

	// Over HTTP, through the whole worker.
	const own = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), matrix.env);
	s.check(own.status === 200, "device A1 issues a ticket for vault A");
	const other = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_B}/auth/ticket`, DEVICE_A1), matrix.env);
	s.check(other.status === 401, "device A1 gets 401 on vault B's ticket route");
	const asGlobal = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, GLOBAL_TOKEN), matrix.env);
	s.check(asGlobal.status === 401, "the claimed token gets 401 on the ticket route");
	s.check(
		(await asGlobal.json() as { error?: unknown }).error === "unauthorized",
		"and is told only that it is unauthorized",
	);

	const ownDebug = await vaultRouteOutcome(matrix.env, "GET", `/vault/${VAULT_A}/debug/recent`, DEVICE_A1);
	s.check(ownDebug === "reached-handler", "device A1 passes the gate on its own /debug/recent");
	const otherDebug = await vaultRouteOutcome(matrix.env, "GET", `/vault/${VAULT_B}/debug/recent`, DEVICE_A1);
	s.check(otherDebug === 401, "device A1 gets 401 on vault B's /debug/recent");
	const globalDebug = await vaultRouteOutcome(matrix.env, "GET", `/vault/${VAULT_A}/debug/recent`, GLOBAL_TOKEN);
	s.check(globalDebug === 401, "the claimed token gets 401 on /debug/recent");
}

s.section("Test 8: the signing secret is created lazily, and tickets verify against it");
{
	// A deployment of its own for the lazy-creation half: the point is what
	// happens BEFORE any ticket exists, and the matrix deployment above has
	// already issued several.
	const { env, config } = freshDeployment();
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);

	// Requests that are not ticket issuance must not create it: a secret
	// written on the auth path would be a Durable Object write in front of
	// every request, which is the amplification issue #40 removed.
	await worker.fetch(new Request(`${HOST}/api/capabilities`), env);
	await worker.fetch(new Request(`${HOST}/`), env);
	await worker.fetch(bearerRequest("GET", `/vault/${VAULT_A}/debug/recent`, null), env);
	s.check(
		(await readConfig(config)).ticketSigningSecret === null,
		"no signing secret exists before the first ticket is issued",
	);

	const first = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), env);
	const firstTicket = (await first.json() as { ticket?: unknown }).ticket;
	s.check(first.status === 200 && typeof firstTicket === "string", "a device token obtains a ticket");

	const created = (await readConfig(config)).ticketSigningSecret ?? "";
	s.check(created.length === 43, "issuing the first ticket created the signing secret");
	s.check(
		typeof firstTicket === "string" && created.length > 0 && !firstTicket.includes(created),
		"the ticket does not contain the secret it was signed with",
	);

	// A later ticket reuses it rather than minting another, which would
	// silently invalidate every ticket already in flight.
	await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), env);
	s.check(
		(await readConfig(config)).ticketSigningSecret === created,
		"a later ticket did not rotate the secret",
	);

	// Verification, on the matrix deployment, where two vaults exist.
	//
	// The invalidate is load bearing, not hygiene.  routes/auth.ts holds ONE
	// module-level config cache for the whole process, keyed on nothing, so the
	// requests above have left THIS deployment's config in it — and the next
	// call on matrix.env would authorize against the wrong server's token map
	// for the rest of the 60s TTL.  Without this line the assertions below
	// happen to pass for DEVICE_A1 (both deployments seeded it) and fail for
	// DEVICE_A2, which is exactly how the hazard announces itself.
	invalidateStoredServerConfigCache();

	const res = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), matrix.env);
	const ticket = (await res.json() as { ticket?: unknown }).ticket ?? "";
	s.check(res.status === 200 && typeof ticket === "string" && ticket.length > 0, "the matrix deployment issues a ticket");

	const authState = await getAuthStateCached(matrix.env);
	s.check(await verifyTicket(String(ticket), authState, VAULT_A), "the ticket verifies for its own vault");
	s.check(!(await verifyTicket(String(ticket), authState, VAULT_B)), "the ticket does not verify for another vault");

	// A ticket is scoped to the VAULT, not the device: the socket has no way
	// to present a device identity, so the vault's other device issues its own
	// ticket rather than sharing one.  Asserted so the property is deliberate.
	const otherDevice = await worker.fetch(
		bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A2),
		matrix.env,
	);
	s.check(otherDevice.status === 200, "the vault's other device obtains its own ticket");

	// The key is the dedicated secret, NOT the claimed token's hash — this is
	// the "planned hardening" item in docs/architecture/zero-config-auth.md,
	// realised for this mode.  A state carrying the old claim-mode derivation
	// must not verify a strict ticket.
	const claimState = {
		mode: "claim",
		claimed: true,
		tokenHash: await hashOf(GLOBAL_TOKEN),
	} as const;
	s.check(
		!(await verifyTicket(String(ticket), claimState, VAULT_A)),
		"a strict ticket does not verify against the claimed token's hash",
	);

	// And a ticket must actually admit a socket for its vault, including with
	// the legacy token path disabled.
	const admitted = await authenticateSocketRequest(String(ticket), null, authState, VAULT_A, true);
	s.check(admitted.ok && admitted.method === "ticket", "the strict ticket admits a socket on its own vault");
	const refused = await authenticateSocketRequest(String(ticket), null, authState, VAULT_B, true);
	s.check(!refused.ok && refused.reason === "unauthorized", "and is refused for another vault");
}

s.section("Test 9: the legacy WebSocket ?token= path consults strict tokens only");
{
	const authState = await getAuthStateCached(matrix.env);

	const own = await authenticateSocketRequest(null, DEVICE_A1, authState, VAULT_A, false);
	s.check(own.ok, "device A1 authenticates its own room");
	s.check(own.ok && own.method === "legacy-token", "and does so through the legacy-token path");

	const other = await authenticateSocketRequest(null, DEVICE_A1, authState, VAULT_B, false);
	s.check(!other.ok && other.reason === "unauthorized", "device A1 does not authenticate another room");

	const global = await authenticateSocketRequest(null, GLOBAL_TOKEN, authState, VAULT_A, false);
	s.check(
		!global.ok && global.reason === "unauthorized",
		"the claimed token does not authenticate any room",
	);
	// The env-mode misconfiguration branch must not be reachable in strict mode:
	// a "server_misconfigured" here would be a fatal socket frame on a server
	// that is configured exactly as intended.
	s.check(
		!global.ok && global.reason !== "server_misconfigured",
		"strict mode never reports server_misconfigured",
	);

	// And through the real socket route, which rejects before waking the room.
	const foreign = await vaultRouteOutcome(
		matrix.env,
		"GET",
		`/vault/sync/${VAULT_B}?token=${encodeURIComponent(DEVICE_A1)}&schemaVersion=${SERVER_SCHEMA_VERSION}`,
		null,
	);
	s.check(foreign === 401, "the sync route rejects a foreign device token with 401");
	const globalSocket = await vaultRouteOutcome(
		matrix.env,
		"GET",
		`/vault/sync/${VAULT_A}?token=${encodeURIComponent(GLOBAL_TOKEN)}&schemaVersion=${SERVER_SCHEMA_VERSION}`,
		null,
	);
	s.check(globalSocket === 401, "the sync route rejects the claimed token with 401");
	const ownSocket = await vaultRouteOutcome(
		matrix.env,
		"GET",
		`/vault/sync/${VAULT_A}?token=${encodeURIComponent(DEVICE_A1)}&schemaVersion=${SERVER_SCHEMA_VERSION}`,
		null,
	);
	s.check(ownSocket === "reached-handler", "the sync route admits a device token to its own room");
}

s.section("Test 10: SYNC_TOKEN is ignored, and said so once per isolate");
{
	const { env, config } = freshDeployment({ SYNC_TOKEN: GLOBAL_TOKEN });
	await claim(config, GLOBAL_TOKEN);
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);
	resetStrictWarningsForTests();

	const { value: statuses, warnings } = await captureWarn(async () => {
		const results: number[] = [];
		// Several requests, so "once per isolate" is a claim about repetition.
		for (let i = 0; i < 3; i++) {
			const res = await worker.fetch(
				bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, GLOBAL_TOKEN),
				env,
			);
			results.push(res.status);
		}
		return results;
	});

	s.check(statuses.every((status) => status === 401), "SYNC_TOKEN gets 401 on every vault route");
	const ignoredWarnings = warnings.filter((line) => line.includes("SYNC_TOKEN is IGNORED"));
	s.check(
		ignoredWarnings.length === 1,
		`the SYNC_TOKEN warning is emitted exactly once for three requests (got ${ignoredWarnings.length})`,
	);
	s.check(
		ignoredWarnings[0]?.includes("YAOS_STRICT_PERMISSIONS") === true,
		"the warning names the variable responsible",
	);
	s.check(
		!ignoredWarnings.some((line) => line.includes(GLOBAL_TOKEN)),
		"the warning does not echo the token it is ignoring",
	);

	// Fail closed, not open: the device token still works.
	const device = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), env);
	s.check(device.status === 200, "the device token still opens its vault with SYNC_TOKEN set");
}

s.section("Test 11: strict mode without Cloudflare Access warns once and stays locked");
{
	const { env, config } = freshDeployment({
		YAOS_ACCESS_TEAM_DOMAIN: undefined,
		YAOS_ACCESS_AUD: undefined,
	});
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);
	resetStrictWarningsForTests();

	const { warnings } = await captureWarn(async () => {
		for (let i = 0; i < 3; i++) {
			await worker.fetch(new Request(`${HOST}/api/capabilities`), env);
		}
	});
	const lockoutWarnings = warnings.filter((line) => line.includes("Cloudflare Access is not configured"));
	s.check(
		lockoutWarnings.length === 1,
		`the lockout warning is emitted exactly once (got ${lockoutWarnings.length})`,
	);
	s.check(
		lockoutWarnings[0]?.includes("/admin") === true,
		"the warning names the surface that is unavailable",
	);

	// Existing tokens keep working — the lockout is about ISSUING, not using.
	const device = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), env);
	s.check(device.status === 200, "an existing device token still works without Access");

	// And /admin is not merely forbidden, it does not exist.
	const admin = await worker.fetch(new Request(`${HOST}/admin`), env);
	s.check(admin.status === 404, "with Access unconfigured /admin is a 404, as on any deployment");
}

// ---------------------------------------------------------------------------
// 4. The closed surfaces
// ---------------------------------------------------------------------------

s.section("Test 12: the bearer operator API answers 403 strict_permissions");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);

	const calls: Array<[string, string, unknown]> = [
		["GET", "/api/vault-tokens", undefined],
		["POST", "/api/vault-tokens", { vaultId: VAULT_A, label: "x" }],
		["POST", "/api/vault-tokens/revoke", { vaultId: VAULT_A }],
	];
	// Every caller gets the same answer, and that is the point: in strict mode
	// no bearer token is an operator, so there is no credential that would see
	// a different one.  The 403 sits BEFORE the auth gate because
	// /api/capabilities already publishes strictPermissions to anonymous
	// callers — the rejection discloses nothing the server does not volunteer.
	for (const [method, path, body] of calls) {
		for (const [who, token] of [
			["the claimed token", GLOBAL_TOKEN],
			["a device token", DEVICE_A1],
			["no token", null],
			["a wrong token", "wrong-token"],
		] as Array<[string, string | null]>) {
			const res = await worker.fetch(bearerRequest(method, path, token, body), env);
			const payload = await res.json() as { error?: unknown };
			s.check(res.status === 403, `${method} ${path} with ${who} → 403`);
			s.check(payload.error === "strict_permissions", `${method} ${path} with ${who} names the mode`);
		}
	}

	// No strict token was created by any of that.
	s.check(
		Object.keys((await readConfig(config)).strictTokens).length === 1,
		"the refused operator calls wrote nothing",
	);
}

s.section("Test 13: update metadata and private capabilities stay closed");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);
	await configPost(config, "/__yaos/update-metadata", {
		updateProvider: "github",
		updateRepoUrl: "https://github.com/private/fork",
		updateRepoBranch: "secret-branch",
	});
	invalidateStoredServerConfigCache();

	for (const [who, token] of [
		["the claimed token", GLOBAL_TOKEN],
		["a device token", DEVICE_A1],
		["no token", null],
	] as Array<[string, string | null]>) {
		const res = await worker.fetch(
			bearerRequest("POST", "/api/update-metadata", token, { updateProvider: "gitlab" }),
			env,
		);
		s.check(res.status === 401, `POST /api/update-metadata with ${who} → 401`);
	}
	s.check(
		(await readConfig(config)).updateProvider === "github",
		"no refused call changed the stored metadata",
	);

	// The private half of capabilities is gated on isAuthorized, which is false
	// for every caller in strict mode — so nobody unlocks it, not even the
	// credential that used to.
	for (const [who, token] of [
		["the claimed token", GLOBAL_TOKEN],
		["a device token", DEVICE_A1],
		["no token", null],
	] as Array<[string, string | null]>) {
		const res = await worker.fetch(bearerRequest("GET", "/api/capabilities", token), env);
		const caps = await res.json() as Record<string, unknown>;
		s.check(caps.updateProvider === null, `${who}: private update provider stays hidden`);
		s.check(caps.updateRepoUrl === null, `${who}: private repo URL stays hidden`);
		s.check(caps.updateRepoBranch === null, `${who}: private repo branch stays hidden`);
	}
}

s.section("Test 14: POST /claim is 403 from the environment alone, with zero DO access");
{
	// The whole point of this section is the trap env: /claim is an
	// unauthenticated POST, so deciding it from a Durable Object read would let
	// anyone make a strict deployment wake its config DO once per request
	// (issue #40).
	const configTrap = makeTrapNamespace("YAOS_CONFIG accessed to refuse a claim in strict mode");
	const syncTrap = makeTrapNamespace("YAOS_SYNC accessed to refuse a claim in strict mode");
	const trapEnv = makeEnv({
		SYNC_TOKEN: undefined,
		YAOS_STRICT_PERMISSIONS: "1",
		YAOS_SYNC: syncTrap,
		YAOS_CONFIG: configTrap,
	});

	const bodies: Array<[string, unknown]> = [
		["a well-formed claim", { token: "a".repeat(64) }],
		["a claim naming a vault", { token: "a".repeat(64), vaultId: VAULT_A }],
		["an invalid token", { token: "short" }],
		["an empty body", {}],
	];
	for (const [label, body] of bodies) {
		const res = await worker.fetch(
			new Request(`${HOST}/claim`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			trapEnv,
		);
		const payload = await res.json() as { error?: unknown };
		s.check(res.status === 403, `${label} → 403`);
		s.check(payload.error === "strict_permissions", `${label} names the mode`);
	}

	s.check(configTrap.touched.length === 0, "refusing a claim did not touch YAOS_CONFIG");
	s.check(syncTrap.touched.length === 0, "refusing a claim did not touch YAOS_SYNC");
	s.check(isStrictPermissionsEnabled(trapEnv), "the refusal is decided from the environment");

	// CONTROL: the same request WITHOUT strict mode does reach the config DO.
	// Without this, the assertions above would pass just as well against a
	// route that had been deleted.
	const controlTrap = makeTrapNamespace("YAOS_CONFIG reached by a non-strict claim");
	const controlEnv = makeEnv({
		SYNC_TOKEN: undefined,
		YAOS_STRICT_PERMISSIONS: undefined,
		YAOS_SYNC: makeTrapNamespace("YAOS_SYNC reached by a non-strict claim"),
		YAOS_CONFIG: controlTrap,
	});
	invalidateStoredServerConfigCache();
	try {
		await worker.fetch(
			new Request(`${HOST}/claim`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: "a".repeat(64) }),
			}),
			controlEnv,
		);
	} catch {
		// The trap throws; that IS the observation.
	}
	s.check(
		controlTrap.touched.length > 0,
		"control: without strict mode the same claim does reach YAOS_CONFIG",
	);
	invalidateStoredServerConfigCache();
}

// ---------------------------------------------------------------------------
// 5. Bootstrap through /admin on a server nobody ever claimed
// ---------------------------------------------------------------------------

s.section("Test 15: /admin issues the first token on a NEVER-claimed strict server");
{
	const { env, config, syncTrap } = freshDeployment();
	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());

		// Precondition: nobody has claimed this server, and there is no token
		// of any kind.  In claim mode this state answers 503 on every admin API
		// route; strict mode must not.
		const before = await readConfig(config);
		s.check(before.claimed === false, "precondition: the server is unclaimed");
		s.check(Object.keys(before.strictTokens).length === 0, "precondition: no strict tokens exist");

		const issued = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, {
				body: { vaultId: VAULT_A, label: "work laptop" },
			}),
			env,
		);
		const issuedBody = await issued.json() as Record<string, unknown>;
		const token = typeof issuedBody.token === "string" ? issuedBody.token : "";
		const tokenId = typeof issuedBody.tokenId === "string" ? issuedBody.tokenId : "";
		s.check(issued.status === 200 && issuedBody.ok === true, "POST /admin/api/vault-tokens → 200 unclaimed");
		s.check(token.length >= 43, "the issued token carries at least 32 bytes of entropy");
		s.check(tokenId.length >= 22, "the response carries a tokenId for revocation");
		s.check(issuedBody.vaultId === VAULT_A && issuedBody.label === "work laptop", "the response echoes vaultId and label");
		s.check(typeof issuedBody.createdAt === "number", "the response carries createdAt");
		s.check(
			typeof issuedBody.obsidianUrl === "string"
			&& issuedBody.obsidianUrl.startsWith("obsidian://yaos?")
			&& issuedBody.obsidianUrl.includes(`vaultId=${VAULT_A}`),
			"the response carries a vault-scoped obsidian:// setup URL",
		);
		s.check(
			typeof issuedBody.mobileSetupQrDataUrl === "string"
			&& issuedBody.mobileSetupQrDataUrl.startsWith("data:image/svg+xml;base64,"),
			"the response carries the mobile setup QR",
		);

		// THE PROPERTY THAT MATTERS: the token the page just minted works.
		const own = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, token), env);
		s.check(own.status === 200, "the issued token opens its vault end to end");
		const other = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_B}/auth/ticket`, token), env);
		s.check(other.status === 401, "the issued token does not open another vault");
		s.check(
			(await readConfig(config)).claimed === false,
			"issuing a token did not claim the server as a side effect",
		);

		// A second device on the same vault APPENDS.
		const second = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, {
				body: { vaultId: VAULT_A, label: "phone" },
			}),
			env,
		);
		const secondBody = await second.json() as Record<string, unknown>;
		const secondToken = typeof secondBody.token === "string" ? secondBody.token : "";
		s.check(second.status === 200, "a second device is issued a token for the same vault");
		s.check(secondToken !== token, "the second device gets a different token");
		const stillFirst = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, token), env);
		s.check(stillFirst.status === 200, "onboarding a second device does NOT log the first one out");
		const alsoSecond = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, secondToken), env);
		s.check(alsoSecond.status === 200, "and the second device works too");

		// Listing: grouped-friendly, and never a hash.
		const listed = await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", jwt), env);
		const raw = await listed.text();
		const listBody = JSON.parse(raw) as {
			ok?: unknown;
			strictPermissions?: unknown;
			vaultTokens?: Array<Record<string, unknown>>;
		};
		s.check(listed.status === 200 && listBody.ok === true, "GET /admin/api/vault-tokens → 200");
		s.check(listBody.strictPermissions === true, "the listing declares the mode it is describing");
		s.check(listBody.vaultTokens?.length === 2, "both devices are listed");
		s.check(
			listBody.vaultTokens?.every((entry) =>
				typeof entry.tokenId === "string"
				&& typeof entry.vaultId === "string"
				&& typeof entry.label === "string"
				&& typeof entry.createdAt === "number") === true,
			"each entry carries tokenId, vaultId, label and createdAt",
		);
		s.check(!raw.includes("tokenHash"), "the listing never mentions tokenHash");
		s.check(!raw.includes(await hashOf(token)), "the listing does not contain a stored hash");
		s.check(!raw.includes(token) && !raw.includes(secondToken), "the listing contains no plaintext token");

		// Revocation is by tokenId, and takes exactly one device.
		const revoked = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { tokenId } }),
			env,
		);
		const revokedBody = await revoked.json() as { ok?: unknown; existed?: unknown };
		s.check(revoked.status === 200 && revokedBody.ok === true, "revoke by tokenId → 200");
		s.check(revokedBody.existed === true, "revoke reports the token existed");

		const afterRevoke = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, token), env);
		s.check(afterRevoke.status === 401, "the revoked device stops working");
		const survivor = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, secondToken), env);
		s.check(survivor.status === 200, "the vault's OTHER device is unaffected by the revocation");

		const repeat = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { tokenId } }),
			env,
		);
		s.check(
			(await repeat.json() as { existed?: unknown }).existed === false,
			"revoking again reports existed=false",
		);

		s.check(syncTrap.touched.length === 0, "the whole admin round trip never woke a vault room");
		s.check(network.urls.length === 1, `the JWKS was fetched once for the section (got ${network.urls.length})`);
	} finally {
		network.restore();
	}
}

s.section("Test 16: admin input validation — the device name is required");
{
	const { env } = freshDeployment();
	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());
		const bad: Array<[string, unknown]> = [
			["a missing label", { vaultId: VAULT_A }],
			["a null label", { vaultId: VAULT_A, label: null }],
			["an empty label", { vaultId: VAULT_A, label: "" }],
			["a whitespace label", { vaultId: VAULT_A, label: "   " }],
			["an oversized label", { vaultId: VAULT_A, label: "l".repeat(65) }],
			["a short vaultId", { vaultId: "short", label: "laptop" }],
			["a missing vaultId", { label: "laptop" }],
		];
		for (const [label, body] of bad) {
			const res = await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, { body }),
				env,
			);
			s.check(res.status === 400, `admin issue with ${label} → 400`);
		}

		const badRevoke: Array<[string, unknown]> = [
			["a missing tokenId", {}],
			["a vaultId instead of a tokenId", { vaultId: VAULT_A }],
			["an out-of-alphabet tokenId", { tokenId: "not a token id" }],
		];
		for (const [label, body] of badRevoke) {
			const res = await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body }),
				env,
			);
			s.check(res.status === 400, `admin revoke with ${label} → 400`);
		}

		// The Access gate and the CSRF posture are unchanged by the mode.
		const anonymous = await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", null), env);
		s.check(anonymous.status === 401, "an unauthenticated admin caller still gets 401, never the strict data");
		const wrongType = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, {
				body: { vaultId: VAULT_A, label: "laptop" },
				contentType: "text/plain;charset=UTF-8",
			}),
			env,
		);
		s.check(wrongType.status === 415, "a POST without a JSON content type is still refused with 415");
		s.check(
			wrongType.headers.get("Access-Control-Allow-Origin") === null,
			"admin responses still carry no CORS headers",
		);
	} finally {
		network.restore();
	}
}

s.section("Test 17: the audit trail names the device as well as the vault");
{
	const { env } = freshDeployment();
	const network = installFetchStub();
	const captured: string[] = [];
	const originalDebug = console.debug;
	console.debug = (...args: unknown[]) => {
		captured.push(args.map(String).join(" "));
	};
	try {
		const jwt = await signAccessJwt(accessClaims());
		const issued = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, {
				body: { vaultId: VAULT_A, label: "audited laptop" },
			}),
			env,
		);
		const issuedBody = await issued.json() as { token?: unknown; tokenId?: unknown };
		const token = typeof issuedBody.token === "string" ? issuedBody.token : "";
		const tokenId = typeof issuedBody.tokenId === "string" ? issuedBody.tokenId : "";

		await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { tokenId } }),
			env,
		);

		const auditLines = captured.filter((line) => line.includes("admin audit"));
		s.check(auditLines.length === 2, `an issue and a revoke log one line each (got ${auditLines.length})`);
		const issueLine = auditLines[0] ?? "";
		const revokeLine = auditLines[1] ?? "";
		s.check(issueLine.includes(`"action":"issue"`), "the issue line names the action");
		s.check(
			issueLine.includes(`"tokenIdHint":"${tokenId.slice(0, 8)}"`) && !issueLine.includes(tokenId),
			"the issue line carries a TRUNCATED tokenId — a full one would be a correlation handle",
		);
		s.check(
			issueLine.includes(`"vaultIdHint":"${VAULT_A.slice(0, 8)}"`) && !issueLine.includes(VAULT_A),
			"the issue line truncates the vaultId as it always has",
		);
		s.check(issueLine.includes(`"actor":"operator@example.test"`), "the issue line names the Access identity");
		s.check(!issueLine.includes(token), "the audit line does not contain the issued token");
		s.check(!issueLine.includes("audited laptop"), "the audit line does not contain the device name");
		s.check(
			revokeLine.includes(`"action":"revoke"`)
			&& revokeLine.includes(`"vaultIdHint":"${VAULT_A.slice(0, 8)}"`),
			"the revoke line resolves the vault from the tokenId before the record is gone",
		);
	} finally {
		console.debug = originalDebug;
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 6. Capabilities, pages, and the secret that must never escape
// ---------------------------------------------------------------------------

s.section("Test 18: capabilities report authMode \"claim\" plus strictPermissions");
{
	const { env, config } = freshDeployment();
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);

	const res = await worker.fetch(new Request(`${HOST}/api/capabilities`), env);
	const caps = await res.json() as Record<string, unknown>;
	s.check(res.status === 200, "GET /api/capabilities → 200 in strict mode");
	s.check(caps.strictPermissions === true, "capabilities carry strictPermissions: true");
	s.check(
		caps.authMode === "claim",
		`authMode is reported as "claim", not "strict" (got ${JSON.stringify(caps.authMode)})`,
	);
	s.check(caps.claimed === true, "claimed is true so a client does not think the server needs setup");

	// WHY the shim exists.  The plugin's validator hard-enumerates authMode and
	// rejects the WHOLE payload on an unknown value, while unknown extra fields
	// pass.  Asserted against the plugin source rather than by importing it:
	// this suite is server-side, and the point is to notice if the plugin ever
	// widens the enumeration — at which point the shim can be dropped, but only
	// after the minimum supported plugin version includes that change.
	const validatorSource = readSource("src/runtime/capabilityUpdateService.ts");
	s.check(
		validatorSource.includes(`candidate.authMode === "env" || candidate.authMode === "claim" || candidate.authMode === "unclaimed"`),
		"the plugin still hard-enumerates authMode — the compatibility shim is still required",
	);
	s.check(
		!validatorSource.includes(`candidate.authMode === "strict"`),
		"the plugin does not yet accept a \"strict\" authMode",
	);

	// Additive in the other direction too: a non-strict server publishes the
	// flag as false rather than omitting it, so a client never has to
	// distinguish "absent" from "off".
	const { env: normalEnv, config: normalConfig } = freshDeployment({ YAOS_STRICT_PERMISSIONS: undefined });
	await claim(normalConfig, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();
	const normal = await worker.fetch(new Request(`${HOST}/api/capabilities`), normalEnv);
	const normalCaps = await normal.json() as Record<string, unknown>;
	s.check(normalCaps.strictPermissions === false, "a claim-mode server reports strictPermissions: false");
	s.check(normalCaps.authMode === "claim", "a claim-mode server still reports authMode claim");

	const { env: envModeEnv } = freshDeployment({
		YAOS_STRICT_PERMISSIONS: undefined,
		SYNC_TOKEN: GLOBAL_TOKEN,
		YAOS_CONFIG: makeTrapNamespace("YAOS_CONFIG accessed in env mode"),
	});
	const envCaps = await (await worker.fetch(new Request(`${HOST}/api/capabilities`), envModeEnv)).json() as Record<string, unknown>;
	s.check(envCaps.strictPermissions === false, "an env-mode server reports strictPermissions: false");
	s.check(envCaps.authMode === "env", "an env-mode server still reports authMode env");
}

s.section("Test 19: the ticket signing secret never appears in an HTTP response");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	await seedStrictToken(config, "tok-a1", VAULT_A, "laptop", DEVICE_A1);

	// Force the secret into existence, then read it from the DO — the only
	// place it is supposed to exist.
	await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1), env);
	const secret = (await readConfig(config)).ticketSigningSecret ?? "";
	s.check(secret.length === 43, "a signing secret exists to test against");

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());
		// Every response an unauthenticated or authenticated caller can obtain.
		const responses: Array<[string, Response]> = [
			["GET /", await worker.fetch(new Request(`${HOST}/`), env)],
			["GET /api/capabilities", await worker.fetch(new Request(`${HOST}/api/capabilities`), env)],
			["GET /api/capabilities with a device token", await worker.fetch(
				bearerRequest("GET", "/api/capabilities", DEVICE_A1),
				env,
			)],
			["GET /api/capabilities with the claimed token", await worker.fetch(
				bearerRequest("GET", "/api/capabilities", GLOBAL_TOKEN),
				env,
			)],
			["POST /claim", await worker.fetch(
				new Request(`${HOST}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token: "a".repeat(64) }),
				}),
				env,
			)],
			["GET /admin", await worker.fetch(adminRequest("GET", "/admin", jwt), env)],
			["GET /admin/api/vault-tokens", await worker.fetch(
				adminRequest("GET", "/admin/api/vault-tokens", jwt),
				env,
			)],
			["POST /admin/api/vault-tokens", await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, {
					body: { vaultId: VAULT_B, label: "another device" },
				}),
				env,
			)],
			["POST /vault/:id/auth/ticket", await worker.fetch(
				bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, DEVICE_A1),
				env,
			)],
			["GET /api/vault-tokens", await worker.fetch(
				bearerRequest("GET", "/api/vault-tokens", GLOBAL_TOKEN),
				env,
			)],
		];

		for (const [label, res] of responses) {
			// Asserted on RAW TEXT, not on a parsed field: the failure mode this
			// is guarding against is a stray `...config` spread, which no
			// field-by-field check would see.
			const raw = await res.text();
			s.check(!raw.includes(secret), `${label}: the response body does not contain the signing secret`);
			s.check(!raw.includes("ticketSigningSecret"), `${label}: the response does not even name the field`);
			s.check(!raw.includes("tokenHash"), `${label}: the response does not carry a token hash`);
		}
	} finally {
		network.restore();
	}
}

s.section("Test 20: the home page shows strict mode instead of the claim UI");
{
	// Both claim states, because the whole point is that the page does not
	// depend on one: an unclaimed strict server must not offer a claim button,
	// and a previously-claimed one must not say it is locked behind a token
	// that no longer works.
	for (const [label, claimFirst] of [["unclaimed", false], ["previously claimed", true]] as Array<[string, boolean]>) {
		const { env, config } = freshDeployment();
		if (claimFirst) {
			await claim(config, GLOBAL_TOKEN);
			invalidateStoredServerConfigCache();
		}

		const res = await worker.fetch(new Request(`${HOST}/`), env);
		const html = await res.text();
		s.check(res.status === 200, `${label}: GET / → 200`);
		s.check(
			res.headers.get("Content-Type") === "text/html; charset=utf-8",
			`${label}: the home page is served as HTML`,
		);
		s.check(html.includes("Strict permissions mode"), `${label}: the page says strict mode is active`);
		s.check(!html.includes("<form"), `${label}: the page renders no claim form`);
		s.check(
			!html.toLowerCase().includes("claim this server") && !html.includes("/claim"),
			`${label}: the page does not offer the claim flow`,
		);
		s.check(html.includes(HOST), `${label}: the page names the host`);
		s.check(!html.includes(GLOBAL_TOKEN), `${label}: the page carries no token material`);
	}
}

s.section("Test 21: the admin page renders the strict UI, unclaimed included");
{
	const { env } = freshDeployment();
	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());
		const page = await worker.fetch(adminRequest("GET", "/admin", jwt), env);
		const html = await page.text();

		s.check(page.status === 200, "GET /admin → 200 on a never-claimed strict server");
		s.check(
			!html.includes("not claimed yet"),
			"the never-claimed strict page does NOT show the unclaimed explainer",
		);
		s.check(html.includes("<form"), "the strict page renders the issue form even unclaimed");
		s.check(html.includes("Strict permissions mode is active"), "the page carries a strict-mode banner");
		s.check(html.includes("mode: strict permissions"), "the header badge names the mode");
		s.check(html.includes("Device name (required)"), "the device-name field is labelled as required");
		s.check(
			/<input id="token-label"[^>]*\brequired\b/.test(html),
			"the device-name input carries the required attribute",
		);
		s.check(html.includes("/admin/api/vault-tokens"), "the page drives the admin API");
		s.check(html.includes(`tokenId: entry.tokenId`), "the page revokes by tokenId");
		s.check(page.headers.get("Content-Security-Policy") === "frame-ancestors 'none'", "the page refuses to be framed");
		s.check(page.headers.get("X-Frame-Options") === "DENY", "the page refuses to be framed (X-Frame-Options)");
		s.check(page.headers.get("Cache-Control") === "no-store", "the page is not cached");

		// Same hygiene rule as claim mode: no per-request data but the host, and
		// no data of any kind reaching innerHTML.
		const issued = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: VAULT_A, label: "laptop" } }),
			env,
		);
		const token = (await issued.json() as { token?: unknown }).token;
		const afterIssue = await (await worker.fetch(adminRequest("GET", "/admin", jwt), env)).text();
		s.check(
			typeof token === "string" && !afterIssue.includes(token),
			"the page never contains an issued token",
		);
		s.check(!afterIssue.includes(VAULT_A), "the page shell carries no per-vault data");
		// The house rule is "no data ever reaches innerHTML", so what must be
		// absent is an ASSIGNMENT, not the word: the script's own comment
		// explaining the rule names it, and a substring check would fail on the
		// documentation of the property it is checking.
		for (const [sink, pattern] of [
			["innerHTML", /\.innerHTML\s*=/],
			["outerHTML", /\.outerHTML\s*=/],
			["insertAdjacentHTML", /insertAdjacentHTML\s*\(/],
			["document.write", /document\s*\.\s*write\s*\(/],
		] as Array<[string, RegExp]>) {
			s.check(!pattern.test(afterIssue), `no script on the page writes through ${sink}`);
		}
		s.check(afterIssue.includes(HOST), "the page shows the server host");

		// Turning strict mode off restores exactly the claim-mode page.
		const { env: normalEnv, config: normalConfig } = freshDeployment({ YAOS_STRICT_PERMISSIONS: undefined });
		await claim(normalConfig, GLOBAL_TOKEN);
		invalidateStoredServerConfigCache();
		const normalPage = await (await worker.fetch(adminRequest("GET", "/admin", jwt), normalEnv)).text();
		s.check(
			normalPage.includes("Vault access tokens") && !normalPage.includes("Strict permissions mode is active"),
			"a non-strict server renders the unchanged claim-mode admin page",
		);
	} finally {
		network.restore();
	}
}

invalidateStoredServerConfigCache();
resetAccessModuleStateForTests();
resetStrictWarningsForTests();
await s.done();
