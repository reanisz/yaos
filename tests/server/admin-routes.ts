/**
 * The Cloudflare Access-gated /admin surface, driven through worker.fetch.
 *
 * Runs the REAL ServerConfig Durable Object over in-memory storage and the
 * REAL Access verifier against a real RSA keypair, so the gate under test is
 * the one a deployment runs rather than a mock of it.
 *
 * The properties under test, in the order they matter:
 *
 *   1. Without the Access variables, /admin does not exist.  Every shape
 *      answers the same 404 as /wp-login.php — same body, same headers — with
 *      no Durable Object access and no outbound request at all.
 *   2. With them, a request that cannot prove Access authenticated it gets 401
 *      and still costs no Durable Object access.  A missing header costs no
 *      JWKS fetch either: there is nothing to verify.
 *   3. A token signed by the wrong key, or minted for another Access
 *      application, is refused — the header alone is not a credential, which
 *      is the whole reason the Worker verifies the JWT itself.
 *   4. Past the gate, the API manages exactly the same vault tokens the
 *      bearer-token API does, and the bearer surface is unchanged.
 *   5. CSRF posture: no CORS headers on any admin response, and a POST without
 *      a JSON content type is refused with 415.
 *
 * NETWORK. verifyAccessJwt fetches the JWKS through global fetch when it is
 * called without injected deps, which is how the Worker calls it. Each section
 * that needs one installs a scoped stub over globalThis.fetch, serves only the
 * team's certs URL, throws on anything else, and restores in a finally.
 *
 * Cache note: routes/auth.ts holds ONE module-level config cache for the whole
 * process, and accessJwt.ts holds ONE JWKS cache — freshDeployment() and
 * resetAccessModuleStateForTests() clear them between sections.
 */

import worker from "../../server/src/index";
import { ServerConfig } from "../../server/src/config";
import { resetAccessModuleStateForTests } from "../../server/src/accessJwt";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { sha256Hex } from "../../server/src/hex";
import type { Env } from "../../server/src/routes/types";
import {
	accessJwksDocument,
	accessJwksUrl,
	signAccessJwt,
	signAccessJwtWithForeignKey,
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
import { suite } from "../harness.ts";

const s = suite("admin-routes");

const HOST = "https://sync.example.test";
const GLOBAL_TOKEN = "global-operator-token-0123456789abcdef";
const VAULT_A = "vault-alpha-0001";
const VAULT_B = "vault-bravo-0002";
const JWKS_URL = accessJwksUrl(TEST_ACCESS_TEAM_DOMAIN);

/** Every admin shape, as (method, path) — the whole surface, in one list. */
const ADMIN_SHAPES: Array<[string, string]> = [
	["GET", "/admin"],
	["GET", "/admin/api/vault-tokens"],
	["POST", "/admin/api/vault-tokens"],
	["POST", "/admin/api/vault-tokens/revoke"],
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function hashOf(token: string): Promise<string> {
	return await sha256Hex(new TextEncoder().encode(token));
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

interface Deployment {
	env: Env;
	config: ServerConfig;
	/** Records every YAOS_SYNC access; no admin path may reach a room. */
	syncTrap: FakeTrapNamespace;
}

/**
 * A server with Access configured and a real ServerConfig behind YAOS_CONFIG.
 * `overrides` is applied last, so a section can drop the Access variables or
 * switch the deployment into env mode.
 */
function freshDeployment(overrides: Partial<Env> = {}): Deployment {
	invalidateStoredServerConfigCache();
	resetAccessModuleStateForTests();
	const storage = new FakeDurableObjectStorage();
	const config = new ServerConfig(makeDurableObjectState(storage));
	const syncTrap = makeTrapNamespace("YAOS_SYNC accessed by an admin test");
	const env = makeEnv({
		SYNC_TOKEN: undefined,
		YAOS_ACCESS_TEAM_DOMAIN: TEST_ACCESS_TEAM_DOMAIN,
		YAOS_ACCESS_AUD: TEST_ACCESS_AUD,
		YAOS_SYNC: syncTrap,
		YAOS_CONFIG: makeConfigNamespace(async (req) => await config.fetch(req)),
		...overrides,
	});
	return { env, config, syncTrap };
}

async function claim(config: ServerConfig, token: string): Promise<void> {
	const res = await config.fetch(new Request("https://internal/__yaos/claim", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tokenHash: await hashOf(token) }),
	}));
	if (!res.ok) throw new Error(`claim failed (${res.status})`);
}

interface AdminRequestOptions {
	body?: unknown;
	/** null omits the header entirely; a string sets it verbatim. */
	contentType?: string | null;
}

/**
 * An admin request carrying `jwt` in the header Access stamps.  A body implies
 * `Content-Type: application/json` unless the test overrides it — the whole
 * point of the 415 rule is what happens when a client does not send it.
 */
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

/** A bearer-token request against the ordinary /api surface. */
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

/** A valid body for the POST shapes, and none for the GET ones. */
function bodyFor(method: string, vaultId: string): unknown {
	return method === "POST" ? { vaultId } : undefined;
}

// ---------------------------------------------------------------------------
// Global fetch stub
// ---------------------------------------------------------------------------

interface FetchStub {
	/** URLs requested, in order. */
	readonly urls: string[];
	restore(): void;
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input instanceof Request) return input.url;
	return String(input);
}

/**
 * Replace globalThis.fetch for the duration of a section.
 *
 * `serveJwks: false` makes every call a failure, which is how a section proves
 * a path costs no outbound request: the assertion is on `urls`, and the throw
 * is the backstop if the product code swallows it.
 */
function installFetchStub(options: { serveJwks?: boolean } = {}): FetchStub {
	const serveJwks = options.serveJwks ?? true;
	const original = globalThis.fetch;
	const urls: string[] = [];
	const stub: typeof globalThis.fetch = async (input, _init) => {
		const url = urlOf(input);
		urls.push(url);
		if (!serveJwks || url !== JWKS_URL) {
			throw new Error(`admin-routes: unexpected outbound fetch to ${url}`);
		}
		return new Response(JSON.stringify(accessJwksDocument(TEST_ACCESS_KID)), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	globalThis.fetch = stub;
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
 * Run `body` with the audit trail captured.
 *
 * The audit line goes to console.debug, which it shares with index.ts's
 * per-request access log, so the capture filters on the "admin audit" marker
 * rather than collecting the channel wholesale — otherwise every assertion
 * below would be counting request lines. The marker is the same thing an
 * operator greps for, so the test reads the log the way a human would.
 */
const AUDIT_MARKER = "admin audit";

async function captureLog<T>(body: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
	const captured: string[] = [];
	const original = console.debug;
	console.debug = (...args: unknown[]) => {
		captured.push(args.map(String).join(" "));
	};
	try {
		const value = await body();
		return { value, lines: captured.filter((line) => line.includes(AUDIT_MARKER)) };
	} finally {
		console.debug = original;
	}
}

/**
 * The observable identity of a response: status, body, and the headers that
 * distinguish one route's answer from another's.  Two routes that produce the
 * same string here are indistinguishable to a client.
 */
async function fingerprint(res: Response): Promise<string> {
	return JSON.stringify({
		status: res.status,
		body: await res.text(),
		contentType: res.headers.get("Content-Type"),
		cacheControl: res.headers.get("Cache-Control"),
		cors: res.headers.get("Access-Control-Allow-Origin"),
	});
}

// ---------------------------------------------------------------------------
// 1. Access unconfigured — /admin does not exist
// ---------------------------------------------------------------------------

s.section("Test 1: without the Access variables every /admin shape is an ordinary unknown path");
{
	invalidateStoredServerConfigCache();
	resetAccessModuleStateForTests();
	const syncTrap = makeTrapNamespace("YAOS_SYNC accessed for a disabled admin route");
	const configTrap = makeTrapNamespace("YAOS_CONFIG accessed for a disabled admin route");
	const unconfigured: Env = makeEnv({
		SYNC_TOKEN: undefined,
		YAOS_SYNC: syncTrap,
		YAOS_CONFIG: configTrap,
	});

	const network = installFetchStub({ serveJwks: false });
	try {
		// The reference: a path nobody claims exists.  Every admin shape must be
		// indistinguishable from it, CORS headers included — a 404 that omitted
		// them would itself advertise that this build knows about /admin.
		const reference = await fingerprint(
			await worker.fetch(new Request(`${HOST}/wp-login.php`), unconfigured),
		);
		s.check(
			JSON.parse(reference).body === JSON.stringify({ error: "not found" }),
			"the reference unknown path answers the standard not-found JSON",
		);

		for (const [method, path] of ADMIN_SHAPES) {
			// Carrying a JWT-shaped header must not change the answer either: a
			// disabled deployment has no admin surface to be authorized against.
			const res = await worker.fetch(
				adminRequest(method, path, "not.a.jwt", { body: bodyFor(method, VAULT_A) }),
				unconfigured,
			);
			s.check(await fingerprint(res) === reference, `${method} ${path}: byte-identical to an unknown path`);
		}

		// Trailing-slash and near-miss shapes go the same way.
		for (const [method, path] of [
			["GET", "/admin/"],
			["GET", "/admin/foo"],
			["POST", "/admin"],
		] as Array<[string, string]>) {
			const res = await worker.fetch(adminRequest(method, path, null), unconfigured);
			s.check(res.status === 404, `${method} ${path}: 404`);
		}

		s.check(configTrap.touched.length === 0, "no /admin shape touched YAOS_CONFIG");
		s.check(syncTrap.touched.length === 0, "no /admin shape touched YAOS_SYNC");
		s.check(network.urls.length === 0, "no /admin shape opened an outbound request");
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 2. Configured, but the request cannot prove Access authenticated it
// ---------------------------------------------------------------------------

s.section("Test 2: a request with no Access header is refused before any DO read or JWKS fetch");
{
	const configTrap = makeTrapNamespace("YAOS_CONFIG accessed for an unauthenticated admin request");
	const { env, syncTrap } = freshDeployment({ YAOS_CONFIG: configTrap });

	const network = installFetchStub({ serveJwks: false });
	try {
		for (const [method, path] of ADMIN_SHAPES) {
			const res = await worker.fetch(
				adminRequest(method, path, null, { body: bodyFor(method, VAULT_A) }),
				env,
			);
			const body = await res.json() as { error?: unknown };
			s.check(res.status === 401, `${method} ${path} without the header → 401`);
			s.check(body.error === "unauthorized", `${method} ${path} names no more than "unauthorized"`);
		}
		s.check(configTrap.touched.length === 0, "an unauthenticated admin request did not touch YAOS_CONFIG");
		s.check(syncTrap.touched.length === 0, "an unauthenticated admin request did not touch YAOS_SYNC");
		s.check(network.urls.length === 0, "a missing header costs no JWKS fetch — there is nothing to verify");
	} finally {
		network.restore();
	}
}

s.section("Test 3: a token signed by another key, or for another application, is refused");
{
	const configTrap = makeTrapNamespace("YAOS_CONFIG accessed for a bad-JWT admin request");
	const { env, syncTrap } = freshDeployment({ YAOS_CONFIG: configTrap });

	const network = installFetchStub();
	try {
		const cases: Array<[string, string]> = [
			["signed by a key the JWKS does not publish", await signAccessJwtWithForeignKey(accessClaims())],
			["minted for a different Access application", await signAccessJwt(accessClaims({ aud: "b".repeat(64) }))],
			["minted by a different Access team", await signAccessJwt(accessClaims({ iss: "https://someoneelse.cloudflareaccess.com" }))],
			["expired", await signAccessJwt(accessClaims({ exp: Math.floor(Date.now() / 1_000) - 3_600 }))],
			["not a JWT at all", "garbage"],
		];

		const { warnings } = await captureWarn(async () => {
			for (const [label, jwt] of cases) {
				const res = await worker.fetch(adminRequest("GET", "/admin", jwt), env);
				const body = await res.json() as { error?: unknown };
				s.check(res.status === 401, `a token ${label} → 401`);
				s.check(body.error === "unauthorized", `a token ${label} leaks no reason to the client`);
			}
		});

		s.check(
			warnings.length === cases.length,
			`each rejection logged exactly one line (got ${warnings.length} for ${cases.length} rejections)`,
		);
		s.check(
			warnings.every((line) => line.includes("admin_page")),
			"the rejection log names the route bucket",
		);
		s.check(
			warnings.some((line) => line.includes("bad_signature")) && warnings.some((line) => line.includes("bad_aud")),
			"the rejection log names the machine-readable reason",
		);

		s.check(configTrap.touched.length === 0, "a rejected JWT did not touch YAOS_CONFIG");
		s.check(syncTrap.touched.length === 0, "a rejected JWT did not touch YAOS_SYNC");
		s.check(
			network.urls.every((url) => url === JWKS_URL),
			"the only outbound request a rejected JWT can cause is the JWKS fetch",
		);
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 4. Past the gate: unclaimed
// ---------------------------------------------------------------------------

s.section("Test 4: on an unclaimed server the page explains itself and the API answers 503");
{
	const { env } = freshDeployment();
	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());

		const page = await worker.fetch(adminRequest("GET", "/admin", jwt), env);
		const html = await page.text();
		s.check(page.status === 200, "GET /admin on an unclaimed server → 200");
		s.check(
			page.headers.get("Content-Type")?.startsWith("text/html") === true,
			"the unclaimed page is served as HTML",
		);
		s.check(html.includes("not claimed yet"), "the page says the server is not claimed");
		s.check(html.includes("mode: standard (unclaimed)"), "the header badge names the mode");
		s.check(!html.includes("<form"), "the unclaimed page renders no issue form");

		for (const [method, path] of ADMIN_SHAPES.slice(1)) {
			const res = await worker.fetch(
				adminRequest(method, path, jwt, { body: bodyFor(method, VAULT_A) }),
				env,
			);
			const body = await res.json() as { error?: unknown };
			s.check(res.status === 503, `${method} ${path} on an unclaimed server → 503`);
			s.check(body.error === "unclaimed", `${method} ${path} names the reason`);
		}
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 5. Past the gate: the full round trip on a claimed server
// ---------------------------------------------------------------------------

s.section("Test 5: issue → authorize → list → revoke through the admin API");
{
	const { env, config, syncTrap } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());

		const issued = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: VAULT_A, label: "alpha laptop" } }),
			env,
		);
		const issuedBody = await issued.json() as Record<string, unknown>;
		const token = typeof issuedBody.token === "string" ? issuedBody.token : "";
		s.check(issued.status === 200 && issuedBody.ok === true, "POST /admin/api/vault-tokens → 200");
		s.check(token.length >= 43, "the issued token carries at least 32 bytes of entropy");
		s.check(issuedBody.vaultId === VAULT_A && issuedBody.label === "alpha laptop", "the response echoes vaultId and label");
		s.check(
			typeof issuedBody.obsidianUrl === "string"
			&& issuedBody.obsidianUrl.startsWith("obsidian://yaos?")
			&& issuedBody.obsidianUrl.includes(`vaultId=${VAULT_A}`),
			"the response carries a vault-scoped obsidian:// setup URL",
		);
		s.check(
			typeof issuedBody.mobileSetupQrDataUrl === "string"
			&& issuedBody.mobileSetupQrDataUrl.startsWith("data:image/svg+xml;base64,"),
			"the response carries the mobile setup QR, as the claim flow does",
		);

		// The token the admin page minted is an ordinary vault token: it opens its
		// own vault through the normal bearer path and nothing else.
		const own = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, token), env);
		s.check(own.status === 200, "the issued token authorizes its own vault");
		const other = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_B}/auth/ticket`, token), env);
		s.check(other.status === 401, "the issued token does not authorize another vault");

		const listed = await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", jwt), env);
		const raw = await listed.text();
		const listBody = JSON.parse(raw) as { ok?: unknown; vaultTokens?: Array<Record<string, unknown>> };
		s.check(listed.status === 200 && listBody.ok === true, "GET /admin/api/vault-tokens → 200");
		s.check(
			listBody.vaultTokens?.length === 1
			&& listBody.vaultTokens[0]?.vaultId === VAULT_A
			&& listBody.vaultTokens[0]?.label === "alpha laptop"
			&& typeof listBody.vaultTokens[0]?.createdAt === "number",
			"the listing carries vaultId, label and createdAt",
		);
		s.check(!raw.includes("tokenHash"), "the listing never mentions tokenHash");
		s.check(!raw.includes(await hashOf(token)), "the listing does not contain the stored hash");
		s.check(!raw.includes(token), "the listing does not contain the plaintext token");

		const revoked = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { vaultId: VAULT_A } }),
			env,
		);
		const revokedBody = await revoked.json() as { ok?: unknown; existed?: unknown };
		s.check(revoked.status === 200 && revokedBody.ok === true, "POST /admin/api/vault-tokens/revoke → 200");
		s.check(revokedBody.existed === true, "revoke reports the token existed");

		const afterRevoke = await worker.fetch(bearerRequest("POST", `/vault/${VAULT_A}/auth/ticket`, token), env);
		s.check(afterRevoke.status === 401, "the revoked token stops working");

		const repeat = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { vaultId: VAULT_A } }),
			env,
		);
		const repeatBody = await repeat.json() as { existed?: unknown };
		s.check(repeat.status === 200 && repeatBody.existed === false, "revoking again reports existed=false");

		s.check(syncTrap.touched.length === 0, "the whole admin round trip never woke a vault room");
		s.check(network.urls.length === 1, `the JWKS was fetched once for the whole section (got ${network.urls.length})`);

		// Input validation is the shared implementation's, exercised through the
		// admin front door so the two cannot answer differently.
		const bad: Array<[string, unknown, number]> = [
			["short vaultId", { vaultId: "short" }, 400],
			["missing vaultId", {}, 400],
			["oversized label", { vaultId: VAULT_A, label: "l".repeat(65) }, 400],
		];
		for (const [label, body, expected] of bad) {
			const res = await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, { body }),
				env,
			);
			s.check(res.status === expected, `admin issue with ${label} → ${expected}`);
		}
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 6-8. CSRF posture and page hygiene
// ---------------------------------------------------------------------------

s.section("Test 6: a POST without a JSON content type is refused with 415");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());
		// The three content types an HTML form can send without a preflight, plus
		// the no-header case.  None of them may reach the handler.
		const contentTypes: Array<string | null> = [
			null,
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
			"text/plain;charset=UTF-8",
		];
		for (const path of ["/admin/api/vault-tokens", "/admin/api/vault-tokens/revoke"]) {
			for (const contentType of contentTypes) {
				const res = await worker.fetch(
					adminRequest("POST", path, jwt, { body: { vaultId: VAULT_A }, contentType }),
					env,
				);
				const body = await res.json() as { error?: unknown };
				s.check(res.status === 415, `POST ${path} as ${contentType ?? "no content type"} → 415`);
				s.check(body.error === "unsupported_media_type", `POST ${path} as ${contentType ?? "no content type"} names the reason`);
			}
		}

		// A parameterised JSON content type is the real-world shape and must pass.
		const withCharset = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, {
				body: { vaultId: VAULT_A },
				contentType: "application/json; charset=utf-8",
			}),
			env,
		);
		s.check(withCharset.status === 200, "application/json with a charset parameter is accepted");

		s.check(
			(await worker.fetch(
				new Request(`${HOST}/admin/api/vault-tokens`, { method: "OPTIONS" }),
				env,
			)).status === 404,
			"there is no CORS preflight arm for /admin — a cross-origin JSON POST cannot be sent",
		);
	} finally {
		network.restore();
	}
}

s.section("Test 7: no admin response carries CORS headers");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());
		const responses: Array<[string, Response]> = [
			["GET /admin", await worker.fetch(adminRequest("GET", "/admin", jwt), env)],
			["GET /admin/api/vault-tokens", await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", jwt), env)],
			["POST /admin/api/vault-tokens", await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: VAULT_A } }),
				env,
			)],
			["POST /admin/api/vault-tokens/revoke", await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { vaultId: VAULT_A } }),
				env,
			)],
			["an unauthenticated admin request", await worker.fetch(adminRequest("GET", "/admin", null), env)],
		];
		for (const [label, res] of responses) {
			s.check(
				res.headers.get("Access-Control-Allow-Origin") === null,
				`${label}: no Access-Control-Allow-Origin (a cross-origin page cannot read it)`,
			);
			s.check(
				res.headers.get("Access-Control-Allow-Credentials") === null,
				`${label}: no Access-Control-Allow-Credentials`,
			);
		}
	} finally {
		network.restore();
	}
}

s.section("Test 8: the admin page is HTML, uncached, and carries no token material");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());
		const issued = await worker.fetch(
			adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: VAULT_A, label: "laptop" } }),
			env,
		);
		const issuedBody = await issued.json() as { token?: unknown };
		const token = typeof issuedBody.token === "string" ? issuedBody.token : "";
		s.check(token.length > 0, "a token exists for the page to be checked against");

		const page = await worker.fetch(adminRequest("GET", "/admin", jwt), env);
		const html = await page.text();
		s.check(page.status === 200, "GET /admin → 200");
		s.check(
			page.headers.get("Content-Type") === "text/html; charset=utf-8",
			"GET /admin is served as HTML",
		);
		s.check(page.headers.get("Cache-Control") === "no-store", "GET /admin is Cache-Control: no-store");
		s.check(!html.includes(token), "the page does not contain the issued token");
		s.check(!html.includes(await hashOf(token)), "the page does not contain the stored hash");
		s.check(!html.includes("tokenHash"), "the page does not mention tokenHash");
		s.check(html.includes("mode: standard (claimed)"), "the header badge names the mode");
		// The vault ID and label reach the page through the JSON API and the DOM,
		// never through the rendered shell.
		s.check(!html.includes(VAULT_A), "the page shell carries no per-vault data");
		s.check(html.includes(HOST), "the page shows the server host");
		s.check(html.includes("/admin/api/vault-tokens"), "the page drives the admin API");

		// Frame protection.  This is the one authenticated page in the product,
		// its buttons change state, and Access authenticates it with an ambient
		// cookie — the combination clickjacking needs.
		s.check(
			page.headers.get("Content-Security-Policy") === "frame-ancestors 'none'",
			"GET /admin refuses to be framed (CSP frame-ancestors)",
		);
		s.check(page.headers.get("X-Frame-Options") === "DENY", "GET /admin refuses to be framed (X-Frame-Options)");

		// The JSON surface deliberately does not carry them: a JSON body is not
		// framable content, and an unnecessary header is one a future reader has
		// to reason about.
		const listed = await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", jwt), env);
		const jsonResponses: Array<[string, Response]> = [
			["the issue response", issued],
			["the list response", listed],
			["an unauthorized admin response", await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", null), env)],
		];
		for (const [label, res] of jsonResponses) {
			s.check(res.headers.get("Content-Security-Policy") === null, `${label} carries no CSP header`);
			s.check(res.headers.get("X-Frame-Options") === null, `${label} carries no X-Frame-Options header`);
		}
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 9. Env mode
// ---------------------------------------------------------------------------

s.section("Test 9: in env mode the API answers 409 and the page explains why");
{
	invalidateStoredServerConfigCache();
	resetAccessModuleStateForTests();
	// Env mode makes zero config-DO calls, so the trap is also the proof that
	// this rejection costs nothing.
	const configTrap = makeTrapNamespace("YAOS_CONFIG accessed in env mode");
	const envModeEnv: Env = makeEnv({
		SYNC_TOKEN: GLOBAL_TOKEN,
		YAOS_ACCESS_TEAM_DOMAIN: TEST_ACCESS_TEAM_DOMAIN,
		YAOS_ACCESS_AUD: TEST_ACCESS_AUD,
		YAOS_SYNC: makeTrapNamespace("YAOS_SYNC accessed in env mode"),
		YAOS_CONFIG: configTrap,
	});

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());

		for (const [method, path] of ADMIN_SHAPES.slice(1)) {
			const res = await worker.fetch(
				adminRequest(method, path, jwt, { body: bodyFor(method, VAULT_A) }),
				envModeEnv,
			);
			const body = await res.json() as { error?: unknown };
			s.check(res.status === 409, `${method} ${path} in env mode → 409`);
			s.check(body.error === "unsupported_in_env_mode", `${method} ${path} names the env-mode limit`);
		}

		// The page still renders: an operator who reaches it needs to be told why
		// there is no form, not handed a 409 in a browser tab.
		const page = await worker.fetch(adminRequest("GET", "/admin", jwt), envModeEnv);
		const html = await page.text();
		s.check(page.status === 200, "GET /admin in env mode → 200");
		s.check(html.includes("SYNC_TOKEN"), "the page names the environment variable responsible");
		s.check(html.includes("mode: environment token"), "the header badge names the mode");
		s.check(!html.includes("<form"), "the env-mode page renders no issue form");

		s.check(configTrap.touched.length === 0, "env mode did not touch YAOS_CONFIG");

		// And an unauthenticated caller still gets 401, never the 409: the mode is
		// only ever disclosed past the Access gate.
		const anonymous = await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", null), envModeEnv);
		s.check(anonymous.status === 401, "env mode: an unauthenticated admin caller gets 401, not the 409");
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 10. The bearer-token surface is untouched by any of this
// ---------------------------------------------------------------------------

s.section("Test 10: enabling Access changes nothing about the bearer-token API");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());

		const issued = await worker.fetch(
			bearerRequest("POST", "/api/vault-tokens", GLOBAL_TOKEN, { vaultId: VAULT_A, label: "bearer" }),
			env,
		);
		const issuedBody = await issued.json() as Record<string, unknown>;
		s.check(issued.status === 200 && issuedBody.ok === true, "POST /api/vault-tokens with the global token still works");
		s.check(
			issuedBody.mobileSetupQrDataUrl === undefined,
			"the bearer response is unchanged — no new fields",
		);
		s.check(
			issued.headers.get("Access-Control-Allow-Origin") === "*",
			"the bearer API keeps its CORS headers",
		);

		// The two credentials do not cross over in either direction.
		const adminWithBearer = await worker.fetch(
			bearerRequest("GET", "/admin/api/vault-tokens", GLOBAL_TOKEN),
			env,
		);
		s.check(adminWithBearer.status === 401, "the global token does not open the admin API");

		const bearerWithJwt = await worker.fetch(
			new Request(`${HOST}/api/vault-tokens`, { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
			env,
		);
		s.check(bearerWithJwt.status === 401, "an Access JWT does not open the bearer API");

		const listed = await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", jwt), env);
		const listBody = await listed.json() as { vaultTokens?: Array<Record<string, unknown>> };
		s.check(
			listBody.vaultTokens?.some((entry) => entry.vaultId === VAULT_A && entry.label === "bearer") === true,
			"both front doors read and write the same vault-token map",
		);
	} finally {
		network.restore();
	}
}

// ---------------------------------------------------------------------------
// 11. Audit trail
// ---------------------------------------------------------------------------

s.section("Test 11: every successful admin mutation logs one line naming the Access identity");
{
	const { env, config } = freshDeployment();
	await claim(config, GLOBAL_TOKEN);
	invalidateStoredServerConfigCache();

	const network = installFetchStub();
	try {
		const jwt = await signAccessJwt(accessClaims());

		const { value: issuedToken, lines: issueLines } = await captureLog(async () => {
			const res = await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: VAULT_A, label: "audited laptop" } }),
				env,
			);
			const body = await res.json() as { token?: unknown };
			return typeof body.token === "string" ? body.token : "";
		});
		s.check(issueLines.length === 1, `an issue logs exactly one line (got ${issueLines.length})`);
		const issueLine = issueLines[0] ?? "";
		// The marker is what captureLog filtered on, so assert the rest of the
		// envelope instead: the line carries the Worker's log prefix, which is how
		// it is attributable in an aggregator carrying more than one service.
		s.check(issueLine.startsWith("[yaos-sync:worker] admin audit: {"), "the audit line carries the Worker log prefix");
		s.check(issueLine.includes(`"action":"issue"`), "the audit line names the action");
		s.check(issueLine.includes(`"actor":"operator@example.test"`), "the audit line names the Access identity");
		s.check(
			issueLine.includes(`"vaultIdHint":"${VAULT_A.slice(0, 8)}"`) && !issueLine.includes(VAULT_A),
			"the audit line truncates the vaultId, as the pre-auth rejection log does",
		);
		s.check(!issueLine.includes(issuedToken), "the audit line does not contain the issued token");
		s.check(!issueLine.includes("audited laptop"), "the audit line does not contain the label");

		const { lines: revokeLines } = await captureLog(async () =>
			await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens/revoke", jwt, { body: { vaultId: VAULT_A } }),
				env,
			));
		s.check(revokeLines.length === 1, `a revoke logs exactly one line (got ${revokeLines.length})`);
		s.check(revokeLines[0]?.includes(`"action":"revoke"`) === true, "the revoke audit line names the action");
		s.check(
			revokeLines[0]?.includes(`"actor":"operator@example.test"`) === true,
			"the revoke audit line names the Access identity",
		);

		// A token with no email falls back to the subject claim, so a service or a
		// policy that omits email still leaves a usable trail.
		const subOnlyJwt = await signAccessJwt(accessClaims({ email: undefined }));
		const { lines: subLines } = await captureLog(async () =>
			await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", subOnlyJwt, { body: { vaultId: VAULT_B } }),
				env,
			));
		s.check(
			subLines.length === 1 && subLines[0]?.includes(`"actor":"cf-access-sub-1"`) === true,
			"a token without an email claim is audited under its subject",
		);

		// Reads and failures add nothing: an audit trail of things that did not
		// happen is a trail nobody reads.
		const { lines: rejectedLines } = await captureLog(async () => {
			await worker.fetch(adminRequest("GET", "/admin/api/vault-tokens", jwt), env);
			await worker.fetch(adminRequest("GET", "/admin", jwt), env);
			await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: "short" } }),
				env,
			);
			await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", jwt, { body: { vaultId: VAULT_A }, contentType: null }),
				env,
			);
			await worker.fetch(
				adminRequest("POST", "/admin/api/vault-tokens", null, { body: { vaultId: VAULT_A } }),
				env,
			);
		});
		s.check(
			rejectedLines.length === 0,
			`listing, rendering, a rejected input, a 415 and a 401 log no audit line (got ${rejectedLines.length})`,
		);

		// The bearer-token API has no caller identity to audit, and must not have
		// grown a line that implies one.
		const { lines: bearerLines } = await captureLog(async () =>
			await worker.fetch(
				bearerRequest("POST", "/api/vault-tokens", GLOBAL_TOKEN, { vaultId: VAULT_B }),
				env,
			));
		s.check(bearerLines.length === 0, "the bearer-token API logs no audit line");
	} finally {
		network.restore();
	}
}

invalidateStoredServerConfigCache();
resetAccessModuleStateForTests();
await s.done();
