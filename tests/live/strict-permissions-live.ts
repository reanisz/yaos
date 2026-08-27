/**
 * Strict permissions mode, against a real workerd.
 *
 * This suite is phase 3 of tests/live/run-live.ts: a third `wrangler dev` on a
 * fresh persist directory, booted with YAOS_STRICT_PERMISSIONS=1, WITHOUT
 * SYNC_TOKEN (reusing phase 2's env-deletion machinery), and with STUB
 * Cloudflare Access variables so the /admin surface exists to be probed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PHASE PROVES THE NEGATIVE SURFACE AND NOT ISSUANCE
 *
 * Strict mode has exactly one way to mint a credential: the Access-gated
 * /admin API.  Reaching it needs a JWT that verifies against the team's
 * published JWKS, and the Worker fetches that JWKS itself, through global
 * fetch, from `https://<team-domain>/cdn-cgi/access/certs`.  Inside a real
 * workerd there is no seam to inject: `verifyAccessJwt`'s `deps` parameter is
 * an in-process affordance that tests/server/admin-routes.ts uses by stubbing
 * globalThis.fetch, and neither is reachable across an HTTP boundary.  The
 * three ways to get a positive path here were all rejected:
 *
 *   1. A real Cloudflare Access team.  Turns a hermetic local suite into one
 *      that needs network, credentials, and an account — the regression gate
 *      would fail on an aeroplane and pass or fail for reasons outside this
 *      repository.
 *   2. An external route that seeds a strict token directly.  There is none,
 *      and adding one would be a route that mints credentials without Access —
 *      i.e. reintroducing, for the convenience of a test, exactly the
 *      unauthenticated bootstrap this mode exists to remove.  A test must not
 *      be the reason a product grows a back door.
 *   3. A test-only environment variable that bypasses JWT verification.  Same
 *      objection, plus it would ship in the same binary as production.
 *
 * So issuance is proven exhaustively in-process by
 * tests/server/strict-permissions.ts (which runs the REAL ServerConfig Durable
 * Object and the REAL Access verifier against a real RSA keypair), and this
 * phase proves what only a real deployment can: that a strict server, booted by
 * wrangler with nothing but an environment variable, actually refuses
 * everything it is supposed to refuse — over real HTTP, through a real config
 * Durable Object, with the real 60-second config cache in front of it.
 *
 * WHAT THAT IS WORTH, CONCRETELY
 * The failure this phase is built to catch is a strict deployment that boots
 * into some other mode: an inherited SYNC_TOKEN silently making it env mode, a
 * claim route that still answers, an operator API that still authorizes.  None
 * of those are visible in-process, because in-process the environment is a
 * literal a test wrote.  Here it is what wrangler actually handed the Worker.
 *
 * NO PROVIDER HERE, for the reason tests/live/vault-tokens-live.ts documents at
 * length: the shared harness installs `window = globalThis`, which
 * y-partyserver reads as "this is a browser".  Raw `ws` sockets only.
 */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { SERVER_SCHEMA_VERSION } from "../../server/src/version.ts";
import { describeFatalFrame, parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { suite } from "../harness.ts";

const s = suite("strict-permissions-live");

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";

// Distinct per run so a re-run against a warm persist directory cannot pass on
// state a previous run left behind.  Comfortably over the 8-character minimum
// normalizeVaultId enforces (server/src/config.ts).
const RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const VAULT_A = `yaos-live-stricta-${RUN_ID}`;

/**
 * Credentials that must all be dead.
 *
 * A random 32-byte token stands in for "a token an operator might hold": in
 * strict mode there is no value that opens anything except a token this server
 * issued, so a real one and an invented one are indistinguishable to the
 * server, and inventing one keeps the suite from needing a claim it is not
 * allowed to perform.
 */
const INVENTED_TOKEN = randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------
// Typed JSON reading
//
// Every response is read field by field.  `as` on a parsed body would let a
// shape change pass as a green assertion, which is the failure mode a live
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
	extraHeaders: Record<string, string> = {},
): Promise<JsonResponse> {
	const headers: Record<string, string> = { ...extraHeaders };
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

async function requestText(path: string): Promise<{ status: number; contentType: string | null; text: string }> {
	const res = await fetch(`${HOST}${path}`);
	return {
		status: res.status,
		contentType: res.headers.get("Content-Type"),
		text: await res.text(),
	};
}

// ---------------------------------------------------------------------------
// Raw WebSocket admission
// ---------------------------------------------------------------------------

interface SocketOutcome {
	readonly upgradeStatus: number | null;
	readonly opened: boolean;
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
 * Open a raw socket and report how the server received it.  Every exit path
 * terminates the socket, so nothing this suite opens survives it.
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

// ===========================================================================
// 1. The server really booted into strict mode
// ===========================================================================

s.section("Test 1: capabilities report a strict server, in the shape the plugin can parse");
{
	const capabilities = await requestJson("GET", "/api/capabilities", null);
	if (capabilities.status !== 200) {
		throw new Error(`GET /api/capabilities returned ${capabilities.status}: ${capabilities.raw}`);
	}
	if (capabilities.body["strictPermissions"] !== true) {
		throw new Error(
			`PRECONDITION FAILED: this server is not in strict mode `
			+ `(strictPermissions=${JSON.stringify(capabilities.body["strictPermissions"])}, `
			+ `authMode=${JSON.stringify(capabilities.body["authMode"])}).\n`
			+ `This suite needs a wrangler dev instance booted with YAOS_STRICT_PERMISSIONS set and `
			+ `SYNC_TOKEN absent (runStrictModePhase in tests/live/run-live.ts). If you are reading this, `
			+ `the variable did not reach the Worker, or something re-enabled another mode.`,
		);
	}
	s.check(true, "GET /api/capabilities reports strictPermissions:true");

	// THE COMPATIBILITY SHIM, over the wire.  The plugin's validator
	// hard-enumerates authMode and rejects the WHOLE payload on an unknown
	// value, so a strict server must not say "strict" here.
	s.check(
		capabilities.body["authMode"] === "claim",
		`authMode is "claim", the value the plugin's validator accepts `
		+ `(got ${JSON.stringify(capabilities.body["authMode"])})`,
	);
	s.check(
		capabilities.body["claimed"] === true,
		"claimed is true, so a client does not think the server still needs setup",
	);
	s.check(
		capabilities.body["socketTicketAuth"] === true,
		"the server still advertises ticket auth",
	);

	// A SYNC_TOKEN leaking in from the parent environment is the one thing that
	// would quietly make this whole phase test another mode — phase 2 has the
	// same guard for the same reason.
	s.check(
		capabilities.body["authMode"] !== "env",
		"no SYNC_TOKEN leaked into the child environment (authMode is not env)",
	);
}

// ===========================================================================
// 2. The claim flow is closed
// ===========================================================================

s.section("Test 2: POST /claim is refused, on a server nobody has claimed");
{
	// The server is genuinely unclaimed — this phase never claims it — so a 403
	// here is the strict refusal and not "already_claimed" wearing the same
	// status code.  The body is what distinguishes them.
	for (const [label, body] of [
		["a well-formed claim", { token: "a".repeat(64) }],
		["a claim naming a vault", { token: "a".repeat(64), vaultId: VAULT_A }],
		["an invalid token", { token: "short" }],
		["an empty body", {}],
	] as Array<[string, JsonObject]>) {
		const res = await requestJson("POST", "/claim", null, body);
		s.check(res.status === 403, `${label} → 403 (got ${res.status})`);
		s.check(
			res.body["error"] === "strict_permissions",
			`${label} names the mode rather than "already_claimed" (got ${JSON.stringify(res.body["error"])})`,
		);
	}

	// And it stayed unclaimed: a refusal that had written anything would show up
	// here as a claimed server on the next probe.
	const after = await requestJson("GET", "/api/capabilities", null);
	s.check(after.body["strictPermissions"] === true, "the refused claims changed nothing");
}

// ===========================================================================
// 3. Every server-wide credential is dead
// ===========================================================================

s.section("Test 3: no bearer token opens a vault");
{
	for (const [label, token] of [
		["an invented operator token", INVENTED_TOKEN],
		["no token at all", null],
		["an obviously wrong token", "not-the-token"],
	] as Array<[string, string | null]>) {
		const ticket = await requestJson("POST", `/vault/${VAULT_A}/auth/ticket`, token);
		s.check(ticket.status === 401, `${label}: POST /vault/:id/auth/ticket → 401 (got ${ticket.status})`);
		s.check(
			ticket.body["error"] === "unauthorized",
			`${label}: the ticket route says only "unauthorized"`,
		);

		const debug = await requestJson("GET", `/vault/${VAULT_A}/debug/recent`, token);
		s.check(debug.status === 401, `${label}: GET /vault/:id/debug/recent → 401 (got ${debug.status})`);
	}

	// Not 503.  A strict AuthState carries claimed:true precisely so the
	// unclaimed paths never fire on a server that is working as intended, and
	// this is the assertion that proves it in a real deployment: an unclaimed
	// server WITHOUT strict mode answers these routes with 503 unclaimed.
	const ticket = await requestJson("POST", `/vault/${VAULT_A}/auth/ticket`, INVENTED_TOKEN);
	s.check(ticket.status !== 503, "a strict server does not answer vault routes with 503 unclaimed");
}

s.section("Test 4: the bearer operator API answers 403 strict_permissions");
{
	const calls: Array<[string, string, JsonObject | undefined]> = [
		["GET", "/api/vault-tokens", undefined],
		["POST", "/api/vault-tokens", { vaultId: VAULT_A, label: "laptop" }],
		["POST", "/api/vault-tokens/revoke", { vaultId: VAULT_A }],
	];
	for (const [method, path, body] of calls) {
		for (const [who, token] of [
			["an invented operator token", INVENTED_TOKEN],
			["no token", null],
		] as Array<[string, string | null]>) {
			const res = await requestJson(method, path, token, body);
			s.check(res.status === 403, `${method} ${path} with ${who} → 403 (got ${res.status})`);
			s.check(
				res.body["error"] === "strict_permissions",
				`${method} ${path} with ${who} names the mode`,
			);
		}
	}

	// Update metadata is gated on the same operator predicate, which is false
	// for every caller in strict mode.
	const metadata = await requestJson("POST", "/api/update-metadata", INVENTED_TOKEN, {
		updateProvider: "github",
	});
	s.check(metadata.status === 401, `POST /api/update-metadata → 401 (got ${metadata.status})`);

	// And the private half of capabilities never unlocks, for anyone.
	const caps = await requestJson("GET", "/api/capabilities", INVENTED_TOKEN);
	s.check(caps.body["updateProvider"] === null, "private update provider stays hidden");
	s.check(caps.body["updateRepoUrl"] === null, "private repo URL stays hidden");
	s.check(caps.body["updateRepoBranch"] === null, "private repo branch stays hidden");
	s.check(!caps.raw.includes("ticketSigningSecret"), "capabilities never name the signing secret field");
}

s.section("Test 5: the WebSocket route refuses every credential, in band");
{
	const outcome = await connectSocket(socketUrl(VAULT_A, {
		token: INVENTED_TOKEN,
		schemaVersion: String(SERVER_SCHEMA_VERSION),
	}));

	// The rejection is delivered IN BAND: the Worker completes the upgrade,
	// sends the fatal frame, and closes 1008.
	s.check(outcome.upgradeStatus === 101, `the rejection still upgrades with HTTP 101 (got ${outcome.upgradeStatus})`);
	s.check(outcome.closeCode === 1008, `closes with policy-violation 1008 (got ${outcome.closeCode})`);
	s.check(
		outcome.fatal?.code === "unauthorized",
		`the fatal frame is unauthorized (got ${outcome.fatal === null ? "none" : describeFatalFrame(outcome.fatal)})`,
	);

	// THE FRAME MATTERS AS MUCH AS THE REFUSAL.  A strict server is configured
	// exactly as intended, so telling a client "unclaimed" or
	// "server_misconfigured" would send it down a recovery path for a problem
	// that does not exist — and both are reachable in the socket handler for
	// states that strict mode deliberately does not produce.
	s.check(
		outcome.fatal?.code !== "unclaimed",
		"the frame is not `unclaimed` — strict mode carries claimed:true for exactly this reason",
	);
	s.check(
		outcome.fatal?.code !== "server_misconfigured",
		"the frame is not `server_misconfigured` — the env-mode branch cannot misfire here",
	);

	const ticketed = await connectSocket(socketUrl(VAULT_A, {
		ticket: "forged.ticket",
		schemaVersion: String(SERVER_SCHEMA_VERSION),
	}));
	s.check(
		ticketed.fatal?.code === "unauthorized",
		`a forged ticket is refused too (got ${ticketed.fatal === null ? "none" : describeFatalFrame(ticketed.fatal)})`,
	);
}

// ===========================================================================
// 4. The admin surface exists, and is gated
// ===========================================================================

s.section("Test 6: /admin exists on this deployment and refuses an unauthenticated caller");
{
	// The stub Access variables are well formed, so getAccessConfig returns a
	// config and the admin shapes are real routes rather than 404s.  That is the
	// difference this section is measuring: 401 means "the surface is here and
	// it wants an Access token", 404 would mean the variables never arrived.
	const shapes: Array<[string, string, JsonObject | undefined]> = [
		["GET", "/admin", undefined],
		["GET", "/admin/api/vault-tokens", undefined],
		["POST", "/admin/api/vault-tokens", { vaultId: VAULT_A, label: "laptop" }],
		["POST", "/admin/api/vault-tokens/revoke", { tokenId: "sometoken" }],
	];
	for (const [method, path, body] of shapes) {
		const res = await requestJson(method, path, null, body);
		s.check(res.status === 401, `${method} ${path} without an Access token → 401 (got ${res.status})`);
		s.check(res.body["error"] === "unauthorized", `${method} ${path} names no more than "unauthorized"`);
	}

	// A forged header is not a credential: the Worker verifies the JWT itself
	// rather than trusting that Access ran, which is the whole reason the same
	// script staying reachable off the Access hostname is safe.
	for (const [label, jwt] of [
		["not a JWT at all", "garbage"],
		["a syntactically plausible JWT", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.c2ln"],
	] as Array<[string, string]>) {
		const res = await requestJson("GET", "/admin", null, undefined, {
			"Cf-Access-Jwt-Assertion": jwt,
		});
		s.check(res.status === 401, `${label} → 401 (got ${res.status})`);
	}

	// The bearer credential does not cross over into the Access surface.
	const withBearer = await requestJson("GET", "/admin/api/vault-tokens", INVENTED_TOKEN);
	s.check(withBearer.status === 401, "a bearer token does not open the admin API");
}

// ===========================================================================
// 5. The home page
// ===========================================================================

s.section("Test 7: the home page shows strict mode instead of the claim UI");
{
	const page = await requestText("/");
	s.check(page.status === 200, `GET / → 200 (got ${page.status})`);
	s.check(
		page.contentType === "text/html; charset=utf-8",
		`the home page is served as HTML (got ${JSON.stringify(page.contentType)})`,
	);
	s.check(page.text.includes("Strict permissions mode"), "the page says strict mode is active");
	// The decisive one: this server is UNCLAIMED, so without the strict branch
	// it would render the claim page — a form whose button posts to a route that
	// now answers 403.
	s.check(!page.text.includes("<form"), "the page renders no claim form on an unclaimed strict server");
	s.check(!page.text.includes("/claim"), "the page does not reference the claim endpoint");
	s.check(!page.text.includes("crypto.getRandomValues"), "the page does not ship the token generator");
}

await s.done();
