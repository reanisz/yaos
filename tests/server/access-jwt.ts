/**
 * Cloudflare Access JWT verification tests.
 *
 * Everything here runs against a real RSA-2048 keypair generated in-process
 * and a JWKS served from a stub — no network, no fixed key material checked
 * into the repo, and a deterministic clock so expiry and skew are exact rather
 * than "probably still valid when CI got round to it".
 *
 * Covers:
 *   - valid token → ok, email/sub extracted
 *   - aud as string and as array; wrong aud; wrong iss
 *   - expired, just-inside-skew, nbf in the future, nbf inside skew
 *   - tampered payload → bad_signature
 *   - alg "none" and alg HS256 rejected on the alg check, before any key lookup
 *   - missing kid, unknown kid, rotation re-fetch, re-fetch cooldown
 *   - JWKS fetch failure (bad status and thrown), JWKS cache hit
 *   - malformed token strings
 *   - getAccessConfig: enable/disable, normalization, rejection, warn behaviour
 *   - getAccessConfig: the misconfiguration warning is deduplicated per isolate
 */

import {
	getAccessConfig,
	resetAccessModuleStateForTests,
	verifyAccessJwt,
	type AccessConfig,
	type AccessJwtResult,
} from "../../server/src/accessJwt";
import {
	accessJwksDocument,
	encodeJwtSegment,
	signAccessJwt,
	TEST_ACCESS_AUD,
	TEST_ACCESS_KID,
	TEST_ACCESS_TEAM_DOMAIN,
} from "../mocks/accessJwt.ts";
import { bytesToBase64Url } from "../../server/src/base64url";
import { suite } from "../harness.ts";

const s = suite("access-jwt");

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	s.check(
		actual === expected,
		`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
	);
}

/** Reason of a failed result, or a marker that makes a wrong success obvious. */
function reasonOf(result: AccessJwtResult): string {
	return result.ok ? "<ok>" : result.reason;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_DOMAIN = TEST_ACCESS_TEAM_DOMAIN;
const ISS = `https://${TEAM_DOMAIN}`;
/** A syntactically real Access AUD tag: 64 hex chars. */
const AUD = TEST_ACCESS_AUD;

/** Frozen clock. Every token below is dated relative to this instant. */
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const nowMs = (): number => NOW;
const nowSec = Math.floor(NOW / 1_000);

/**
 * getAccessConfig() with the null branch turned into a setup failure. An
 * AccessConfig is branded and cannot be written by hand, which is the point:
 * these tests exercise the same construction path production uses.
 */
function requireConfig(teamDomain: string, aud: string): AccessConfig {
	const config = getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: teamDomain, YAOS_ACCESS_AUD: aud });
	if (!config) throw new Error(`test setup: expected a valid AccessConfig for ${teamDomain}`);
	return config;
}

const CONFIG = requireConfig(TEAM_DOMAIN, AUD);

// Keypair, JWKS document and RS256 signer come from tests/mocks/accessJwt.ts,
// which tests/server/admin-routes.ts shares — one definition of "a valid Access
// token" for the verifier tests and the whole-Worker tests alike.
const PRIMARY_KID = TEST_ACCESS_KID;
const ROTATED_KID = "access-key-2";

const jwksDoc = accessJwksDocument;
const encodeSegment = encodeJwtSegment;

/** Default Access claims; `over` replaces individual claims per test. */
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iss: ISS,
		aud: AUD,
		iat: nowSec - 10,
		exp: nowSec + 600,
		email: "admin@example.test",
		sub: "cf-access-sub-1",
		...over,
	};
}

function signRs256(
	payload: Record<string, unknown>,
	header: Record<string, unknown> = { alg: "RS256", kid: PRIMARY_KID, typ: "JWT" },
): Promise<string> {
	return signAccessJwt(payload, header);
}

interface JwksStub {
	fetchJwks: (url: string) => Promise<Response>;
	/** Number of fetches performed so far. */
	calls: () => number;
	/** URLs requested, in order. */
	urls: string[];
}

/**
 * Serve `documents` in order, repeating the last one once exhausted, so a test
 * can express "first fetch sees the old JWKS, every later fetch sees the new
 * one" without counting calls it does not care about.
 */
function makeJwksStub(documents: readonly unknown[]): JwksStub {
	const urls: string[] = [];
	return {
		urls,
		calls: () => urls.length,
		fetchJwks: (url: string) => {
			urls.push(url);
			const index = Math.min(urls.length - 1, documents.length - 1);
			return Promise.resolve(new Response(JSON.stringify(documents[index]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}));
		},
	};
}

/** A stub plus a fresh module cache: every section starts from cold. */
function freshStub(documents: readonly unknown[] = [jwksDoc(PRIMARY_KID)]): JwksStub {
	resetAccessModuleStateForTests();
	return makeJwksStub(documents);
}

function verify(jwt: string, stub: JwksStub, config: AccessConfig = CONFIG, at: number = NOW): Promise<AccessJwtResult> {
	return verifyAccessJwt(jwt, config, { fetchJwks: stub.fetchJwks, nowMs: () => at });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

s.section("verifyAccessJwt: a valid Access token is accepted and its identity extracted");
{
	const stub = freshStub();
	const result = await verify(await signRs256(claims()), stub);

	s.check(result.ok, `valid token verifies (reason: ${reasonOf(result)})`);
	if (result.ok) {
		assertEqual(result.email, "admin@example.test", "email claim extracted");
		assertEqual(result.sub, "cf-access-sub-1", "sub claim extracted");
	}
	assertEqual(stub.calls(), 1, "one JWKS fetch for a cold cache");
	assertEqual(stub.urls[0], `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`, "JWKS fetched from the Access certs endpoint");
}

s.section("verifyAccessJwt: identity claims that are absent or not strings become null");
{
	const stub = freshStub();
	const result = await verify(await signRs256(claims({ email: undefined, sub: 42 })), stub);

	s.check(result.ok, `token without usable identity claims still verifies (reason: ${reasonOf(result)})`);
	if (result.ok) {
		assertEqual(result.email, null, "missing email → null");
		assertEqual(result.sub, null, "non-string sub → null");
	}
}

// ---------------------------------------------------------------------------
// Audience and issuer
// ---------------------------------------------------------------------------

s.section("verifyAccessJwt: aud may be an array as long as it contains the application tag");
{
	const stub = freshStub();
	const other = "f".repeat(64);
	const result = await verify(await signRs256(claims({ aud: [other, AUD] })), stub);
	s.check(result.ok, `aud array containing the tag is accepted (reason: ${reasonOf(result)})`);
}

s.section("verifyAccessJwt: a token minted for a different Access application is rejected");
{
	const stub = freshStub();
	const wrongAud = "b".repeat(64);

	const single = await verify(await signRs256(claims({ aud: wrongAud })), stub);
	assertEqual(reasonOf(single), "bad_aud", "wrong aud string → bad_aud");

	const array = await verify(await signRs256(claims({ aud: [wrongAud, "c".repeat(64)] })), stub);
	assertEqual(reasonOf(array), "bad_aud", "aud array without the tag → bad_aud");

	const missing = await verify(await signRs256(claims({ aud: undefined })), stub);
	assertEqual(reasonOf(missing), "bad_aud", "absent aud → bad_aud");
}

s.section("verifyAccessJwt: a token from another Access team is rejected");
{
	const stub = freshStub();

	const otherTeam = await verify(await signRs256(claims({ iss: "https://someoneelse.cloudflareaccess.com" })), stub);
	assertEqual(reasonOf(otherTeam), "bad_iss", "iss of a different team → bad_iss");

	// The iss comparison is exact: a trailing slash or a bare host is not the
	// issuer Access stamps, and accepting either would widen the match.
	const trailingSlash = await verify(await signRs256(claims({ iss: `${ISS}/` })), stub);
	assertEqual(reasonOf(trailingSlash), "bad_iss", "iss with a trailing slash → bad_iss");

	const bareHost = await verify(await signRs256(claims({ iss: TEAM_DOMAIN })), stub);
	assertEqual(reasonOf(bareHost), "bad_iss", "iss without the scheme → bad_iss");
}

// ---------------------------------------------------------------------------
// Time claims
// ---------------------------------------------------------------------------

s.section("verifyAccessJwt: expiry is enforced with a 60s skew allowance");
{
	const stub = freshStub();

	const expired = await verify(await signRs256(claims({ exp: nowSec - 120 })), stub);
	assertEqual(reasonOf(expired), "expired", "two minutes past exp → expired");

	const insideSkew = await verify(await signRs256(claims({ exp: nowSec - 30 })), stub);
	s.check(insideSkew.ok, `thirty seconds past exp is still accepted inside the skew (reason: ${reasonOf(insideSkew)})`);

	const noExp = await verify(await signRs256(claims({ exp: undefined })), stub);
	assertEqual(reasonOf(noExp), "expired", "a token with no exp never becomes valid");

	const badExp = await verify(await signRs256(claims({ exp: "soon" })), stub);
	assertEqual(reasonOf(badExp), "expired", "a non-numeric exp is treated as no exp");
}

s.section("verifyAccessJwt: nbf in the future is rejected, inside the skew accepted");
{
	const stub = freshStub();

	const future = await verify(await signRs256(claims({ nbf: nowSec + 300 })), stub);
	assertEqual(reasonOf(future), "not_yet_valid", "nbf five minutes out → not_yet_valid");

	const insideSkew = await verify(await signRs256(claims({ nbf: nowSec + 30 })), stub);
	s.check(insideSkew.ok, `nbf thirty seconds out is accepted inside the skew (reason: ${reasonOf(insideSkew)})`);

	const past = await verify(await signRs256(claims({ nbf: nowSec - 300 })), stub);
	s.check(past.ok, `nbf in the past is accepted (reason: ${reasonOf(past)})`);
}

// ---------------------------------------------------------------------------
// Signature and algorithm
// ---------------------------------------------------------------------------

s.section("verifyAccessJwt: a tampered payload fails the signature check");
{
	const stub = freshStub();
	const jwt = await signRs256(claims());
	const [header, payload, signature] = jwt.split(".");
	if (!header || !payload || !signature) throw new Error("test setup: expected three JWT segments");

	// Swap a character well inside the payload segment. It stays valid
	// base64url, so this exercises the signature check rather than the parser.
	const index = 5;
	const tamperedPayload = `${payload.slice(0, index)}${payload[index] === "a" ? "b" : "a"}${payload.slice(index + 1)}`;
	const result = await verify(`${header}.${tamperedPayload}.${signature}`, stub);
	assertEqual(reasonOf(result), "bad_signature", "tampered payload → bad_signature");

	const tamperedSig = `${signature.slice(0, index)}${signature[index] === "a" ? "b" : "a"}${signature.slice(index + 1)}`;
	const forged = await verify(`${header}.${payload}.${tamperedSig}`, stub);
	assertEqual(reasonOf(forged), "bad_signature", "tampered signature → bad_signature");
}

s.section("verifyAccessJwt: alg \"none\" is refused before any key is consulted");
{
	const stub = freshStub();
	const header = encodeSegment({ alg: "none", kid: PRIMARY_KID, typ: "JWT" });
	const payload = encodeSegment(claims());

	// A signature segment is present but meaningless — this is the classic
	// "none" forgery, and it must die on the alg check.
	const withSegment = await verify(`${header}.${payload}.AAAA`, stub);
	assertEqual(reasonOf(withSegment), "bad_alg", "alg none with a dummy signature → bad_alg");
	assertEqual(stub.calls(), 0, "alg none does not trigger a JWKS fetch");

	// The other common shape: an empty third segment.
	const emptySegment = await verify(`${header}.${payload}.`, stub);
	assertEqual(reasonOf(emptySegment), "malformed_jwt", "alg none with an empty signature → malformed_jwt");
	assertEqual(stub.calls(), 0, "an empty signature segment does not trigger a JWKS fetch");
}

s.section("verifyAccessJwt: an HS256 token is refused on the alg check, not on the signature");
{
	const stub = freshStub();
	// The algorithm-confusion attack: sign with a symmetric key the attacker
	// knows (here the AUD tag, which is not secret) and hope the verifier picks
	// its algorithm from the token. Rejecting on alg means the forged MAC is
	// never even computed against a key.
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(AUD),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signingInput = `${encodeSegment({ alg: "HS256", kid: PRIMARY_KID, typ: "JWT" })}.${encodeSegment(claims())}`;
	const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(signingInput));
	const jwt = `${signingInput}.${bytesToBase64Url(new Uint8Array(mac))}`;

	const result = await verify(jwt, stub);
	assertEqual(reasonOf(result), "bad_alg", "HS256 → bad_alg");
	assertEqual(stub.calls(), 0, "HS256 does not trigger a JWKS fetch");
}

s.section("verifyAccessJwt: a header without a usable kid is rejected before any key lookup");
{
	const stub = freshStub();

	const noKid = await verify(await signRs256(claims(), { alg: "RS256", typ: "JWT" }), stub);
	assertEqual(reasonOf(noKid), "missing_kid", "absent kid → missing_kid");

	const numericKid = await verify(await signRs256(claims(), { alg: "RS256", kid: 7 }), stub);
	assertEqual(reasonOf(numericKid), "missing_kid", "non-string kid → missing_kid");

	const emptyKid = await verify(await signRs256(claims(), { alg: "RS256", kid: "" }), stub);
	assertEqual(reasonOf(emptyKid), "missing_kid", "empty kid → missing_kid");

	assertEqual(stub.calls(), 0, "a bad kid never triggers a JWKS fetch");
}

// ---------------------------------------------------------------------------
// JWKS cache, rotation and cooldown
// ---------------------------------------------------------------------------

s.section("verifyAccessJwt: the JWKS is cached across verifications");
{
	const stub = freshStub();

	const first = await verify(await signRs256(claims()), stub);
	const second = await verify(await signRs256(claims({ sub: "cf-access-sub-2" })), stub);

	s.check(first.ok && second.ok, "both verifications succeed");
	assertEqual(stub.calls(), 1, "second verification is served from the cache");
}

s.section("verifyAccessJwt: an unknown kid triggers exactly one rotation re-fetch, then a cooldown");
{
	// First document publishes only the old key; every later fetch publishes
	// both, which is what a real rotation looks like from the client side.
	const stub = freshStub([jwksDoc(PRIMARY_KID), jwksDoc(PRIMARY_KID, ROTATED_KID)]);

	const warm = await verify(await signRs256(claims()), stub);
	s.check(warm.ok, `token signed by the published key verifies (reason: ${reasonOf(warm)})`);
	assertEqual(stub.calls(), 1, "cold cache costs one fetch");

	const rotatedJwt = await signRs256(claims(), { alg: "RS256", kid: ROTATED_KID, typ: "JWT" });
	const rotated = await verify(rotatedJwt, stub);
	s.check(rotated.ok, `unknown kid is retried against a fresh JWKS (reason: ${reasonOf(rotated)})`);
	assertEqual(stub.calls(), 2, "rotation costs exactly one extra fetch");

	// A kid that is in no document: the first miss may re-fetch, every further
	// miss inside the cooldown must not.
	const bogusJwt = await signRs256(claims(), { alg: "RS256", kid: "attacker-supplied-kid", typ: "JWT" });
	for (let attempt = 1; attempt <= 5; attempt++) {
		const result = await verify(bogusJwt, stub);
		assertEqual(reasonOf(result), "unknown_kid", `bogus kid attempt ${attempt} → unknown_kid`);
	}
	assertEqual(stub.calls(), 2, "a flood of unknown-kid tokens inside the cooldown causes no further fetches");

	// Past the cooldown, one more re-fetch is allowed — key rotation has to be
	// able to converge eventually.
	const afterCooldown = await verify(bogusJwt, stub, CONFIG, NOW + 61_000);
	assertEqual(reasonOf(afterCooldown), "unknown_kid", "still unknown after the cooldown re-fetch");
	assertEqual(stub.calls(), 3, "one re-fetch is allowed once the cooldown has elapsed");
}

s.section("verifyAccessJwt: the JWKS is re-fetched once its TTL has elapsed");
{
	const stub = freshStub();

	const first = await verify(await signRs256(claims()), stub);
	s.check(first.ok, `first verification succeeds (reason: ${reasonOf(first)})`);

	// Eleven minutes later the cached document is stale. The token itself is
	// re-dated so this tests the cache TTL and not expiry.
	const later = NOW + 11 * 60 * 1_000;
	const laterJwt = await signRs256(claims({ exp: Math.floor(later / 1_000) + 600 }));
	const second = await verify(laterJwt, stub, CONFIG, later);

	s.check(second.ok, `verification after the TTL succeeds (reason: ${reasonOf(second)})`);
	assertEqual(stub.calls(), 2, "a stale cache entry is refreshed");
}

s.section("verifyAccessJwt: a JWKS that cannot be fetched fails closed");
{
	resetAccessModuleStateForTests();
	const jwt = await signRs256(claims());

	const status500: JwksStub = {
		urls: [],
		calls: () => status500.urls.length,
		fetchJwks: (url: string) => {
			status500.urls.push(url);
			return Promise.resolve(new Response("nope", { status: 500 }));
		},
	};
	const badStatus = await verifyAccessJwt(jwt, CONFIG, { fetchJwks: status500.fetchJwks, nowMs });
	assertEqual(reasonOf(badStatus), "jwks_fetch_failed", "non-2xx JWKS response → jwks_fetch_failed");

	resetAccessModuleStateForTests();
	const threw = await verifyAccessJwt(jwt, CONFIG, {
		fetchJwks: () => Promise.reject(new Error("network down")),
		nowMs,
	});
	assertEqual(reasonOf(threw), "jwks_fetch_failed", "a thrown fetch → jwks_fetch_failed (no exception escapes)");

	resetAccessModuleStateForTests();
	const garbage = await verifyAccessJwt(jwt, CONFIG, {
		fetchJwks: () => Promise.resolve(new Response("<html>not json</html>", { status: 200 })),
		nowMs,
	});
	assertEqual(reasonOf(garbage), "jwks_fetch_failed", "a non-JSON JWKS body → jwks_fetch_failed");

	resetAccessModuleStateForTests();
	const noKeys = await verifyAccessJwt(jwt, CONFIG, {
		fetchJwks: () => Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 })),
		nowMs,
	});
	assertEqual(reasonOf(noKeys), "unknown_kid", "an empty key set → unknown_kid");
}

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

s.section("verifyAccessJwt: malformed token strings are rejected without a fetch");
{
	const stub = freshStub();
	const cases: [string, string][] = [
		["", "empty string"],
		["onlyonesegment", "one segment"],
		["two.segments", "two segments"],
		["a.b.c.d", "four segments"],
		[".payload.signature", "empty header segment"],
		["!!!.###.$$$", "characters outside the base64url alphabet"],
		["ab.cd.ef", "base64url that does not decode to JSON"],
		[`${encodeSegment([1, 2, 3])}.${encodeSegment(claims())}.AAAA`, "header that is a JSON array, not an object"],
		["x".repeat(9_000), "absurdly long input"],
	];

	for (const [input, label] of cases) {
		const result = await verify(input, stub);
		assertEqual(reasonOf(result), "malformed_jwt", `${label} → malformed_jwt`);
	}
	assertEqual(stub.calls(), 0, "no malformed token reaches the JWKS fetch");
}

// ---------------------------------------------------------------------------
// getAccessConfig
// ---------------------------------------------------------------------------

/** Run `body` with console.warn captured, so a suite run stays readable. */
function captureWarn<T>(body: () => T): { value: T; warnings: string[] } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		return { value: body(), warnings };
	} finally {
		console.warn = original;
	}
}

s.section("getAccessConfig: admin stays disabled, and silent, when neither variable is set");
{
	resetAccessModuleStateForTests();
	const { value, warnings } = captureWarn(() => getAccessConfig({}));
	assertEqual(value, null, "no Access variables → null");
	assertEqual(warnings.length, 0, "an unconfigured deployment is not a misconfiguration and logs nothing");

	const blank = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: "   ", YAOS_ACCESS_AUD: "\t" }));
	assertEqual(blank.value, null, "whitespace-only values → null");
	assertEqual(blank.warnings.length, 0, "whitespace-only values read as unset, not malformed");
}

s.section("getAccessConfig: a half-configured deployment is disabled and warned about");
{
	resetAccessModuleStateForTests();

	const domainOnly = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }));
	assertEqual(domainOnly.value, null, "team domain without aud → null");
	assertEqual(domainOnly.warnings.length, 1, "exactly one warning");
	s.check(domainOnly.warnings[0]?.includes("YAOS_ACCESS_AUD") === true, "warning names the missing YAOS_ACCESS_AUD");

	const audOnly = captureWarn(() => getAccessConfig({ YAOS_ACCESS_AUD: AUD }));
	assertEqual(audOnly.value, null, "aud without team domain → null");
	assertEqual(audOnly.warnings.length, 1, "exactly one warning");
	s.check(audOnly.warnings[0]?.includes("YAOS_ACCESS_TEAM_DOMAIN") === true, "warning names the missing YAOS_ACCESS_TEAM_DOMAIN");
	s.check(audOnly.warnings[0]?.includes(AUD) === false, "warning does not echo the AUD tag into the logs");
}

s.section("getAccessConfig: the misconfiguration warning fires once per isolate, not once per request");
{
	// The admin gate calls this on every admin-shaped request, and a
	// misconfigured deployment answers 404 — which is precisely the traffic a
	// scanner generates by the thousand. The operator needs the line once; the
	// log pipeline must not carry one per probe.
	resetAccessModuleStateForTests();

	const first = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }));
	assertEqual(first.warnings.length, 1, "the first look at a broken config warns");

	const immediateRepeat = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }));
	assertEqual(immediateRepeat.value, null, "the repeat call still disables admin");
	assertEqual(immediateRepeat.warnings.length, 0, "an identical second call is silent");

	const probeFlood = captureWarn(() => {
		let disabled = 0;
		for (let probe = 0; probe < 50; probe++) {
			if (getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }) === null) disabled++;
		}
		return disabled;
	});
	assertEqual(probeFlood.value, 50, "every probe of a broken config is still refused");
	assertEqual(probeFlood.warnings.length, 0, "fifty further probes add nothing to the log");

	// Deduplication keys on the raw input pair, so a deployment that changes
	// one variable — including "fixed one, still wrong on the other" — is a
	// different misconfiguration and gets its own line.
	const differentDomain = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: "evil.example.com" }));
	assertEqual(differentDomain.warnings.length, 1, "a different malformed pair warns on its own");
	s.check(
		differentDomain.warnings[0]?.includes("YAOS_ACCESS_TEAM_DOMAIN") === true,
		"the second warning names the newly malformed YAOS_ACCESS_TEAM_DOMAIN",
	);

	const partiallyFixed = captureWarn(() => getAccessConfig({
		YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		YAOS_ACCESS_AUD: "still-not-a-tag",
	}));
	assertEqual(partiallyFixed.warnings.length, 1, "adding a malformed aud to a known-bad domain warns again");
	s.check(
		partiallyFixed.warnings[0]?.includes("YAOS_ACCESS_AUD") === true,
		"the follow-up warning names the variable that is now wrong",
	);

	const stillDeduped = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: "evil.example.com" }));
	assertEqual(stillDeduped.warnings.length, 0, "an earlier pair stays deduplicated after other pairs warned");

	// A fresh isolate starts a fresh ledger: the operator of a newly deployed
	// Worker must still see the line.
	resetAccessModuleStateForTests();
	const freshIsolate = captureWarn(() => getAccessConfig({ YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }));
	assertEqual(freshIsolate.warnings.length, 1, "a fresh isolate warns again for the same broken config");
}

s.section("getAccessConfig: operator-typed team domains normalize to the bare host");
{
	const accepted: [string, string][] = [
		["myteam", "bare team name"],
		["myteam.cloudflareaccess.com", "full team domain"],
		["https://myteam.cloudflareaccess.com", "with scheme"],
		["https://myteam.cloudflareaccess.com/", "with scheme and trailing slash"],
		["http://myteam.cloudflareaccess.com//", "with http scheme and repeated trailing slashes"],
		["  MyTeam.CloudflareAccess.com  ", "mixed case with surrounding whitespace"],
	];

	for (const [input, label] of accepted) {
		const { value, warnings } = captureWarn(() => getAccessConfig({
			YAOS_ACCESS_TEAM_DOMAIN: input,
			YAOS_ACCESS_AUD: AUD,
		}));
		assertEqual(value?.teamDomain, TEAM_DOMAIN, `${label} normalizes to the bare host`);
		assertEqual(warnings.length, 0, `${label} produces no warning`);
	}
}

s.section("getAccessConfig: anything that is not a bare Access team domain is refused");
{
	// Fresh ledger: every input below must produce its own warning, and a
	// pair carried over from an earlier section would be deduplicated away.
	resetAccessModuleStateForTests();
	const rejected: [string, string][] = [
		["myteam.cloudflareaccess.com/path", "a path"],
		["https://myteam.cloudflareaccess.com/cdn-cgi/access/certs", "a full JWKS URL"],
		["myteam.cloudflareaccess.com:8443", "a port"],
		["myteam.cloudflareaccess.com?x=1", "a query string"],
		["evil.example.com", "a domain outside cloudflareaccess.com"],
		["my_team", "an underscore, which is not a hostname character"],
		["my team", "an internal space"],
		["-myteam", "a leading hyphen"],
		["sub.myteam.cloudflareaccess.com", "an extra label"],
		[".cloudflareaccess.com", "an empty team label"],
	];

	for (const [input, label] of rejected) {
		const { value, warnings } = captureWarn(() => getAccessConfig({
			YAOS_ACCESS_TEAM_DOMAIN: input,
			YAOS_ACCESS_AUD: AUD,
		}));
		assertEqual(value, null, `${label} → null`);
		assertEqual(warnings.length, 1, `${label} warns exactly once`);
		s.check(
			warnings[0]?.includes("YAOS_ACCESS_TEAM_DOMAIN") === true,
			`${label} warning names YAOS_ACCESS_TEAM_DOMAIN`,
		);
	}
}

s.section("getAccessConfig: the AUD tag must be 64 hex characters");
{
	resetAccessModuleStateForTests();
	const rejected: [string, string][] = [
		["0123456789abcdef".repeat(3), "too short (48 chars)"],
		[`${AUD}0`, "too long (65 chars)"],
		["g".repeat(64), "non-hex characters"],
		[`${AUD.slice(0, 63)} `, "a trailing space inside the tag length"],
		["not-a-tag", "obviously not a tag"],
	];

	for (const [input, label] of rejected) {
		const { value, warnings } = captureWarn(() => getAccessConfig({
			YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			YAOS_ACCESS_AUD: input,
		}));
		assertEqual(value, null, `${label} → null`);
		assertEqual(warnings.length, 1, `${label} warns exactly once`);
		s.check(warnings[0]?.includes("YAOS_ACCESS_AUD") === true, `${label} warning names YAOS_ACCESS_AUD`);
	}

	const upper = captureWarn(() => getAccessConfig({
		YAOS_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		YAOS_ACCESS_AUD: `  ${AUD.toUpperCase()}  `,
	}));
	assertEqual(upper.value?.aud, AUD, "an uppercase tag is trimmed and lowercased");
	assertEqual(upper.warnings.length, 0, "a valid uppercase tag produces no warning");
}

s.section("getAccessConfig: a normalized config verifies tokens for the domain it normalized to");
{
	const config = requireConfig("https://myteam.cloudflareaccess.com/", AUD.toUpperCase());
	const stub = freshStub();
	const result = await verify(await signRs256(claims()), stub, config);
	s.check(result.ok, `token verifies against the normalized config (reason: ${reasonOf(result)})`);
	assertEqual(stub.urls[0], `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`, "JWKS URL is built from the normalized host");
}

await s.done();
