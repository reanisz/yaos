/**
 * Per-vault access tokens, against a real workerd.
 *
 * WHY THIS SUITE EXISTS
 * tests/server/vault-token-auth.ts drives the same code in-process, with a fake
 * Durable Object storage and a hand-built `Env`. That covers the logic but not
 * the deployment: it never crosses an HTTP boundary, never opens a WebSocket,
 * and — decisively — never runs in claim mode as a deployment experiences it,
 * because the module-level config cache and the config Durable Object are both
 * fakes it resets at will. Per-vault tokens are claim-mode ONLY
 * (server/src/routes/vaultTokens.ts answers 409 under SYNC_TOKEN), and the live
 * harness has always booted `wrangler dev` WITH SYNC_TOKEN. So the entire
 * feature, and the claim flow it depends on, had zero end-to-end coverage.
 *
 * This suite is phase 2 of tests/live/run-live.ts: a second `wrangler dev` on a
 * fresh persist directory with SYNC_TOKEN explicitly removed from its
 * environment. It is handed NO credential. It claims the server itself, mints
 * its own vault tokens, and throws them away — which is also why it can assert
 * on `claimed: false` as a precondition: a leaked SYNC_TOKEN is the one thing
 * that would make that assertion fail, and catching it here is the point.
 *
 * WHAT IT PROVES THAT THE UNIT SUITE CANNOT
 *   - the claim flow works over real HTTP against a real config DO;
 *   - the operator API is reachable, and refuses a vault token, over the wire;
 *   - vault scoping holds on the real ticket route;
 *   - a real WebSocket carrying a vault-scoped ticket (and the legacy
 *     ?token= form) is admitted for its own vault and refused for another,
 *     with the server's actual fatal frame rather than a mocked return value;
 *   - rotation and revocation take effect in a process that has a REAL 60s
 *     config cache in front of it (see AUTH_CONFIG_CACHE_TTL_MS in
 *     server/src/routes/auth.ts) — hence the polls rather than single reads.
 *
 * NO y-partyserver PROVIDER HERE, DELIBERATELY
 * A full CRDT round-trip on a vault token would be a natural addition, and it
 * does not fit. tests/harness.ts installs `window = globalThis` so product code
 * written against Obsidian's globals can run under node; y-partyserver reads
 * that as "this is a browser" and calls `window.addEventListener` in its
 * constructor, which node's globalThis does not have. Every other live suite
 * uses a raw socket or hand-rolled asserts and never imports the harness, so
 * the collision has not come up before. The options were to abandon the harness
 * for this suite or to monkey-patch listeners onto globalThis; both cost more
 * than the coverage is worth, because phase 1's sync-client.ts already proves
 * rooms sync and Tests 6-7 below already prove a vault token is admitted to
 * one. If a provider is ever needed here, fix it at the harness, not here.
 */

import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { SERVER_SCHEMA_VERSION } from "../../server/src/version.ts";
import { describeFatalFrame, parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { sleep, suite } from "../harness.ts";

const s = suite("vault-tokens-live");

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";

// Distinct per run so a re-run against a warm persist directory cannot pass on
// state a previous run left behind. Both are comfortably over the 8-character
// minimum normalizeVaultId enforces (server/src/config.ts).
const RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const VAULT_A = `yaos-live-vta-${RUN_ID}`;
const VAULT_B = `yaos-live-vtb-${RUN_ID}`;

/**
 * How long a revocation or rotation is given to become visible.
 *
 * `wrangler dev` is a single workerd process, and every mutation calls
 * invalidateStoredServerConfigCache() in the isolate that served it, so in
 * practice the very next request already sees the new state. The poll exists so
 * that "in practice" never becomes an assumption this suite silently depends
 * on: if it ever takes longer than a single request, the failure message names
 * the 60s cache TTL instead of leaving a reader guessing.
 */
const PROPAGATION_TIMEOUT_MS = 10_000;
const PROPAGATION_POLL_MS = 500;

// ---------------------------------------------------------------------------
// Typed JSON reading
//
// Every response below is read field by field. `as` on a parsed body would let
// a shape change pass as a green assertion, which is the failure mode a live
// suite exists to catch.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface JsonResponse {
	readonly status: number;
	/** The undecoded body, for "this string must not appear anywhere" checks. */
	readonly raw: string;
	readonly body: JsonObject;
}

async function requestJson(
	method: string,
	path: string,
	token: string | null,
	body?: JsonObject,
): Promise<JsonResponse> {
	const headers: Record<string, string> = {};
	if (token !== null) headers["Authorization"] = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";

	const res = await fetch(`${HOST}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const raw = await res.text();
	let parsed: unknown = null;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		parsed = null;
	}
	return { status: res.status, raw, body: isJsonObject(parsed) ? parsed : {} };
}

function readString(body: JsonObject, key: string, context: string): string {
	const value = body[key];
	if (typeof value !== "string") {
		throw new Error(`${context}: expected a string "${key}", got ${JSON.stringify(value)}`);
	}
	return value;
}

/** The `vaultTokens` array of GET /api/vault-tokens, each entry still untyped. */
function readObjectArray(body: JsonObject, key: string, context: string): JsonObject[] {
	const value = body[key];
	if (!Array.isArray(value)) {
		throw new Error(`${context}: expected an array "${key}", got ${JSON.stringify(value)}`);
	}
	return value.filter(isJsonObject);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Vault-scoped helpers
// ---------------------------------------------------------------------------

/** POST /vault/:id/auth/ticket. Returns the HTTP status and the ticket, if any. */
async function requestTicket(vaultId: string, token: string): Promise<{ status: number; ticket: string | null }> {
	const res = await requestJson("POST", `/vault/${encodeURIComponent(vaultId)}/auth/ticket`, token);
	const ticket = res.body["ticket"];
	return { status: res.status, ticket: typeof ticket === "string" ? ticket : null };
}

/** As above, but a non-200 (or a body without a ticket) is a hard failure. */
async function mustGetTicket(vaultId: string, token: string, context: string): Promise<string> {
	const { status, ticket } = await requestTicket(vaultId, token);
	if (status !== 200 || ticket === null) {
		throw new Error(`${context}: ticket request for ${vaultId} returned ${status} with ticket=${ticket}`);
	}
	return ticket;
}

/**
 * Poll the ticket route until `token` stops opening `vaultId`.
 *
 * Returns the number of attempts it took, so the assertion can report whether
 * the change was immediate (the single-isolate expectation) or eventual.
 */
async function pollUntilRejected(vaultId: string, token: string, context: string): Promise<number> {
	const deadline = Date.now() + PROPAGATION_TIMEOUT_MS;
	let attempts = 0;
	for (;;) {
		attempts++;
		const { status } = await requestTicket(vaultId, token);
		if (status === 401) return attempts;
		if (Date.now() >= deadline) {
			throw new Error(
				`${context}: ${vaultId} still answered ${status} to the old token after `
				+ `${PROPAGATION_TIMEOUT_MS}ms and ${attempts} attempts. The likely cause is the 60s `
				+ `config cache (AUTH_CONFIG_CACHE_TTL_MS in server/src/routes/auth.ts) not having been `
				+ `invalidated by the mutation that should have invalidated it.`,
			);
		}
		await sleep(PROPAGATION_POLL_MS);
	}
}

/**
 * pollUntilRejected as one counted assertion.
 *
 * A timeout here is a real finding about cache invalidation, and the message
 * that explains it belongs in the suite summary — not in an uncaught throw that
 * kills the process before done() prints anything.
 */
async function checkPollUntilRejected(
	vaultId: string,
	token: string,
	message: string,
	context: string,
): Promise<void> {
	try {
		const attempts = await pollUntilRejected(vaultId, token, context);
		s.check(true, `${message} (after ${attempts} attempt(s))`);
	} catch (error) {
		s.check(false, error instanceof Error ? error.message : String(error));
	}
}

// ---------------------------------------------------------------------------
// Raw WebSocket admission
// ---------------------------------------------------------------------------

/** Everything one connection attempt tells us. */
interface SocketOutcome {
	readonly upgradeStatus: number | null;
	readonly opened: boolean;
	/** The first fatal rejection frame the server sent, if it sent one. */
	readonly fatal: FatalFrame | null;
	readonly closeCode: number | null;
}

function socketUrl(vaultId: string, params: Record<string, string>): string {
	const url = new URL(HOST);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `/vault/sync/${encodeURIComponent(vaultId)}`;
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

/**
 * Open a raw socket and report how the server received it.
 *
 * An admitted PartyServer socket is deliberately long-lived, so there is no
 * close event to wait for: settle `settleAfterOpenMs` after the upgrade and
 * treat "opened, and no fatal frame arrived in that window" as admission — the
 * same success condition tests/live/ws-admission-protocol.ts asserts. Every
 * exit path terminates the socket, so nothing this suite opens survives it.
 */
function connectSocket(url: string, settleAfterOpenMs = 400): Promise<SocketOutcome> {
	return new Promise<SocketOutcome>((resolvePromise, rejectPromise) => {
		const socket = new WebSocket(url);
		let opened = false;
		let upgradeStatus: number | null = null;
		let fatal: FatalFrame | null = null;
		let settled = false;
		let settleTimer: NodeJS.Timeout | null = null;
		const timeout = setTimeout(() => {
			finish(new Error(`timed out waiting for socket outcome: ${url}`));
		}, 10_000);

		function finish(value: SocketOutcome | Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (settleTimer !== null) clearTimeout(settleTimer);
			socket.terminate();
			if (value instanceof Error) rejectPromise(value);
			else resolvePromise(value);
		}

		socket.once("upgrade", (response) => {
			upgradeStatus = response.statusCode ?? null;
		});
		socket.once("open", () => {
			opened = true;
			settleTimer = setTimeout(() => {
				finish({ upgradeStatus, opened, fatal, closeCode: null });
			}, settleAfterOpenMs);
		});
		socket.on("message", (data) => {
			// rejectSocket() sends the payload twice — plain, then "__YPS:"-prefixed.
			// parseFatalFrame returns null for the prefixed copy and for the binary
			// sync frames a healthy room sends, so only the real rejection lands here.
			const frame = parseFatalFrame(data.toString());
			if (frame !== null && fatal === null) fatal = frame;
		});
		socket.once("unexpected-response", (_request, response) => {
			finish(new Error(`unexpected HTTP response ${response.statusCode} for ${url}`));
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", (code) => {
			finish({ upgradeStatus, opened, fatal, closeCode: code });
		});
	});
}

function checkAdmitted(outcome: SocketOutcome, label: string): void {
	s.check(outcome.upgradeStatus === 101, `${label}: upgrades with HTTP 101 (got ${outcome.upgradeStatus})`);
	s.check(outcome.opened, `${label}: socket opens`);
	s.check(
		outcome.fatal === null,
		`${label}: no fatal frame${outcome.fatal === null ? "" : ` (got ${describeFatalFrame(outcome.fatal)})`}`,
	);
}

function checkRefusedUnauthorized(outcome: SocketOutcome, label: string): void {
	// The rejection is delivered IN-BAND: the Worker completes the upgrade, sends
	// the fatal frame and closes 1008, rather than failing the HTTP handshake.
	s.check(outcome.upgradeStatus === 101, `${label}: rejection still upgrades with HTTP 101`);
	s.check(outcome.closeCode === 1008, `${label}: closes with policy-violation 1008 (got ${outcome.closeCode})`);
	s.check(
		outcome.fatal?.code === "unauthorized",
		`${label}: fatal frame is unauthorized (got ${outcome.fatal === null ? "none" : describeFatalFrame(outcome.fatal)})`,
	);
}

// ===========================================================================
// 1. Preconditions
// ===========================================================================

s.section("Test 1: the server starts unclaimed");
{
	const capabilities = await requestJson("GET", "/api/capabilities", null);
	if (capabilities.status !== 200) {
		throw new Error(`GET /api/capabilities returned ${capabilities.status}: ${capabilities.raw}`);
	}
	if (capabilities.body["claimed"] !== false) {
		throw new Error(
			`PRECONDITION FAILED: this server is already claimed `
			+ `(claimed=${JSON.stringify(capabilities.body["claimed"])}, `
			+ `authMode=${JSON.stringify(capabilities.body["authMode"])}).\n`
			+ `This suite needs a FRESH, UNCLAIMED wrangler dev instance: per-vault tokens exist only in `
			+ `claim mode, and an env-mode server answers the operator API with 409.\n`
			+ `The overwhelmingly likely cause is a leaked SYNC_TOKEN. run-live.ts spawns wrangler with `
			+ `CLOUDFLARE_INCLUDE_PROCESS_ENV=true, so ANY SYNC_TOKEN present in the parent process `
			+ `environment becomes a Worker var and silently puts the server in env mode. Phase 2 deletes `
			+ `that key from the child environment on purpose (startWrangler in tests/live/run-live.ts); if `
			+ `you are reading this, that deletion regressed or something else claimed the server first.`,
		);
	}
	s.check(true, "GET /api/capabilities reports claimed:false before anything else runs");
	s.check(
		capabilities.body["socketTicketAuth"] === true,
		"the server advertises ticket auth, so the ticket assertions below are meaningful",
	);
}

// ===========================================================================
// 2. Claim
// ===========================================================================

s.section("Test 2: the claim flow, over real HTTP");
const GLOBAL_TOKEN = randomBytes(32).toString("hex");
{
	const claimed = await requestJson("POST", "/claim", null, { token: GLOBAL_TOKEN });
	s.check(claimed.status === 200, `POST /claim returns 200 (got ${claimed.status})`);

	const obsidianUrl = readString(claimed.body, "obsidianUrl", "POST /claim");
	s.check(obsidianUrl.startsWith("obsidian://yaos?"), "the claim response carries an obsidian:// setup URL");

	const capabilities = await requestJson("GET", "/api/capabilities", null);
	s.check(capabilities.body["claimed"] === true, "capabilities now report claimed:true");
	s.check(capabilities.body["authMode"] === "claim", 'capabilities now report authMode:"claim"');
	s.check(
		capabilities.body["schemaVersion"] === SERVER_SCHEMA_VERSION,
		`capabilities publish the pinned schema v${SERVER_SCHEMA_VERSION}`,
	);

	// The claim is single-use: a second caller must not be able to take over.
	const second = await requestJson("POST", "/claim", null, { token: randomBytes(32).toString("hex") });
	s.check(second.status !== 200, `a second claim is refused (got ${second.status})`);
	const stillOurs = await requestTicket(VAULT_A, GLOBAL_TOKEN);
	s.check(stillOurs.status === 200, "the first claimant's token still works after the second claim attempt");
}

// ===========================================================================
// 3. The operator API over real HTTP
// ===========================================================================

s.section("Test 3: POST /api/vault-tokens issues, and GET lists without leaking");
let vaultAToken = "";
let vaultBToken = "";
{
	const issuedA = await requestJson("POST", "/api/vault-tokens", GLOBAL_TOKEN, {
		vaultId: VAULT_A,
		label: "live phase-2 laptop",
	});
	s.check(issuedA.status === 200, `issue for vault A returns 200 (got ${issuedA.status})`);
	vaultAToken = readString(issuedA.body, "token", "issue vault A");
	s.check(vaultAToken.length >= 43, "the issued token carries at least 32 bytes of entropy");
	s.check(issuedA.body["vaultId"] === VAULT_A, "the response echoes the vaultId");
	s.check(issuedA.body["label"] === "live phase-2 laptop", "the response echoes the label");
	s.check(typeof issuedA.body["createdAt"] === "number", "the response carries createdAt");
	const obsidianUrlA = readString(issuedA.body, "obsidianUrl", "issue vault A");
	s.check(
		obsidianUrlA.startsWith("obsidian://yaos?") && obsidianUrlA.includes(`vaultId=${VAULT_A}`),
		"the response carries a vault-scoped obsidian:// setup URL",
	);
	// The deep link is built from the request origin, so a live run is the only
	// place this can be wrong in a way a unit test would not notice.
	s.check(
		obsidianUrlA.includes(encodeURIComponent(HOST)),
		`the setup URL points at this server (${HOST})`,
	);

	const issuedB = await requestJson("POST", "/api/vault-tokens", GLOBAL_TOKEN, { vaultId: VAULT_B });
	s.check(issuedB.status === 200, `issue for vault B returns 200 (got ${issuedB.status})`);
	vaultBToken = readString(issuedB.body, "token", "issue vault B");
	s.check(vaultBToken !== vaultAToken, "the two vaults got different plaintexts");
	s.check(issuedB.body["label"] === null, "an omitted label stores as null");

	const listed = await requestJson("GET", "/api/vault-tokens", GLOBAL_TOKEN);
	s.check(listed.status === 200 && listed.body["ok"] === true, "GET /api/vault-tokens returns 200");
	const entries = readObjectArray(listed.body, "vaultTokens", "list");
	s.check(entries.length === 2, `the listing shows both vaults (got ${entries.length})`);
	s.check(
		entries.some((entry) => entry["vaultId"] === VAULT_A && entry["label"] === "live phase-2 laptop"),
		"the listing carries vault A's id and label",
	);
	s.check(
		entries.some((entry) => entry["vaultId"] === VAULT_B),
		"the listing carries vault B",
	);
	s.check(
		entries.every((entry) => typeof entry["createdAt"] === "number"),
		"every listing entry carries createdAt",
	);

	// Asserted against the RAW body, not the parsed one: a hash smuggled in under
	// an unexpected key would still be a leak.
	s.check(!listed.raw.includes("tokenHash"), "the raw listing body never mentions tokenHash");
	s.check(!listed.raw.includes(vaultAToken), "the raw listing body does not contain vault A's plaintext");
	s.check(!listed.raw.includes(vaultBToken), "the raw listing body does not contain vault B's plaintext");
	s.check(!listed.raw.includes(sha256Hex(vaultAToken)), "the raw listing body does not contain vault A's stored hash");
	s.check(!listed.raw.includes(sha256Hex(vaultBToken)), "the raw listing body does not contain vault B's stored hash");
}

s.section("Test 4: the operator API refuses a vault token and an anonymous caller");
{
	const calls: Array<[string, string, JsonObject | undefined]> = [
		["GET", "/api/vault-tokens", undefined],
		["POST", "/api/vault-tokens", { vaultId: VAULT_A }],
		["POST", "/api/vault-tokens/revoke", { vaultId: VAULT_A }],
	];
	for (const [method, path, body] of calls) {
		const asVault = await requestJson(method, path, vaultAToken, body);
		s.check(asVault.status === 401, `${method} ${path} with vault A's own token → 401 (got ${asVault.status})`);
		const anonymous = await requestJson(method, path, null, body);
		s.check(anonymous.status === 401, `${method} ${path} with no token → 401 (got ${anonymous.status})`);
	}

	// The revoke attempt above must not have succeeded: a credential that can
	// revoke itself is not scoped, whatever its nominal scope says.
	const survived = await requestTicket(VAULT_A, vaultAToken);
	s.check(survived.status === 200, "vault A's token survived its own revoke attempt");
}

// ===========================================================================
// 4. Vault scoping on the ticket route
// ===========================================================================

s.section("Test 5: a vault token opens its own vault's ticket route and no other");
{
	const ownA = await requestTicket(VAULT_A, vaultAToken);
	s.check(ownA.status === 200 && ownA.ticket !== null, `vault A token → 200 on vault A (got ${ownA.status})`);

	const crossA = await requestTicket(VAULT_B, vaultAToken);
	s.check(crossA.status === 401, `vault A token → 401 on vault B (got ${crossA.status})`);

	const crossB = await requestTicket(VAULT_A, vaultBToken);
	s.check(crossB.status === 401, `vault B token → 401 on vault A (got ${crossB.status})`);

	for (const vaultId of [VAULT_A, VAULT_B, `unissued-vault-${RUN_ID}`]) {
		const globalTicket = await requestTicket(vaultId, GLOBAL_TOKEN);
		s.check(globalTicket.status === 200, `the global token still issues a ticket for ${vaultId}`);
	}

	const wrong = await requestTicket(VAULT_A, `${vaultAToken}x`);
	s.check(wrong.status === 401, "a near-miss of vault A's token is rejected");
}

// ===========================================================================
// 5. Real WebSocket admission
// ===========================================================================

s.section("Test 6: a vault-scoped ticket is admitted on its own room and refused on another");
{
	const ticketA = await mustGetTicket(VAULT_A, vaultAToken, "Test 6");
	const admitted = await connectSocket(socketUrl(VAULT_A, {
		ticket: ticketA,
		schemaVersion: String(SERVER_SCHEMA_VERSION),
	}));
	checkAdmitted(admitted, "ticket from vault A's token on /vault/sync/A");

	// Deliberately the SAME ticket. Tickets are stateless HMACs, not one-shot
	// grants, so reusing the one that was just admitted isolates the property
	// under test: the vaultId inside the ticket, not its freshness, is what
	// keeps it out of room B.
	const refused = await connectSocket(socketUrl(VAULT_B, {
		ticket: ticketA,
		schemaVersion: String(SERVER_SCHEMA_VERSION),
	}));
	checkRefusedUnauthorized(refused, "vault A's ticket on /vault/sync/B");
}

s.section("Test 7: the legacy ?token= socket path is vault-scoped too");
{
	const admitted = await connectSocket(socketUrl(VAULT_A, {
		token: vaultAToken,
		schemaVersion: String(SERVER_SCHEMA_VERSION),
	}));
	checkAdmitted(admitted, "vault A's plaintext on /vault/sync/A");

	const refused = await connectSocket(socketUrl(VAULT_B, {
		token: vaultAToken,
		schemaVersion: String(SERVER_SCHEMA_VERSION),
	}));
	checkRefusedUnauthorized(refused, "vault A's plaintext on /vault/sync/B");
}

// ===========================================================================
// 6. Rotation
// ===========================================================================

s.section("Test 8: re-issuing rotates vault A's token");
{
	const rotated = await requestJson("POST", "/api/vault-tokens", GLOBAL_TOKEN, {
		vaultId: VAULT_A,
		label: "live phase-2 rotated",
	});
	s.check(rotated.status === 200, `re-issuing for vault A returns 200 (got ${rotated.status})`);
	const rotatedToken = readString(rotated.body, "token", "rotate vault A");
	s.check(rotatedToken !== vaultAToken, "rotation mints a different plaintext");

	await checkPollUntilRejected(VAULT_A, vaultAToken, "the rotated-away token stops opening vault A", "Test 8");

	const withNew = await requestTicket(VAULT_A, rotatedToken);
	s.check(withNew.status === 200, `the rotated-in token opens vault A (got ${withNew.status})`);

	const listed = await requestJson("GET", "/api/vault-tokens", GLOBAL_TOKEN);
	const entries = readObjectArray(listed.body, "vaultTokens", "list after rotation");
	s.check(entries.length === 2, `rotation replaces rather than appends (got ${entries.length} entries)`);
	s.check(
		entries.some((entry) => entry["vaultId"] === VAULT_A && entry["label"] === "live phase-2 rotated"),
		"the listing shows vault A's new label",
	);

	vaultAToken = rotatedToken;
}

// ===========================================================================
// 8. Revocation
// ===========================================================================

s.section("Test 9: revoking vault B closes only vault B");
{
	const revoked = await requestJson("POST", "/api/vault-tokens/revoke", GLOBAL_TOKEN, { vaultId: VAULT_B });
	s.check(revoked.status === 200 && revoked.body["ok"] === true, `revoke returns 200 (got ${revoked.status})`);
	s.check(revoked.body["existed"] === true, "revoke reports the token existed");

	await checkPollUntilRejected(VAULT_B, vaultBToken, "the revoked token stops opening vault B", "Test 9");

	const globalOnB = await requestTicket(VAULT_B, GLOBAL_TOKEN);
	s.check(globalOnB.status === 200, "the global token is unaffected by the revocation");

	const vaultAStillWorks = await requestTicket(VAULT_A, vaultAToken);
	s.check(vaultAStillWorks.status === 200, "vault A's token is unaffected by vault B's revocation");

	const again = await requestJson("POST", "/api/vault-tokens/revoke", GLOBAL_TOKEN, { vaultId: VAULT_B });
	s.check(again.status === 200 && again.body["existed"] === false, "revoking again reports existed:false");

	const listed = await requestJson("GET", "/api/vault-tokens", GLOBAL_TOKEN);
	const entries = readObjectArray(listed.body, "vaultTokens", "list after revocation");
	s.check(
		entries.length === 1 && entries[0]?.["vaultId"] === VAULT_A,
		"only vault A remains in the listing",
	);
}

// The socket helpers terminate every connection they open and destroyProvider
// tears down both providers, so nothing is holding the loop; done() exits.
await s.done();
