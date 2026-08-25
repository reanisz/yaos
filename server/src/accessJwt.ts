/**
 * Cloudflare Access JWT verification for the (future) /admin surface.
 *
 * # Why the Worker verifies this itself
 * Cloudflare Access sits in front of a hostname, not in front of a Worker
 * script. The same Worker stays directly reachable on its workers.dev URL and
 * on any other route bound to it, and those paths never traverse Access. So
 * "the request reached me, therefore Access let it through" is false, and the
 * presence of the Cf-Access-Jwt-Assertion header proves nothing on its own —
 * anyone can set a header. Application-side verification of the token's
 * signature, issuer and audience is the only thing that actually gates /admin.
 *
 * # What Access issues
 * An RS256 JWT whose signing keys are published as a JWKS at
 *   https://<team-domain>/cdn-cgi/access/certs
 * with `iss` = "https://<team-domain>" and `aud` containing the Access
 * application's AUD tag (64 hex chars). Identity claims of interest are
 * `email` and `sub`.
 *
 * # Failure discipline
 * verifyAccessJwt never throws and never reports anything derived from the
 * token's own contents: a caller may log the reason, and a reason that echoed
 * attacker-controlled bytes would turn the admin log into an injection sink.
 * Reasons are a closed set of machine-readable tags.
 */

import { base64UrlToBytes } from "./base64url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Access team domains are always under this suffix — there is no custom form. */
const TEAM_DOMAIN_SUFFIX = ".cloudflareaccess.com";

/** How long a fetched JWKS is trusted before it is re-fetched on next use. */
const JWKS_TTL_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Minimum spacing between *rotation* re-fetches for one team domain. Without
 * it, a flood of tokens carrying random `kid` values would be amplified one
 * for one into outbound JWKS requests.
 */
const JWKS_ROTATION_REFETCH_COOLDOWN_MS = 60 * 1_000; // 1 minute

/** Tolerance for clock drift between Cloudflare's signer and this isolate. */
const CLOCK_SKEW_MS = 60 * 1_000; // 1 minute

/**
 * Upper bound on a token we are willing to parse at all. Real Access tokens
 * are well under 2 KiB; the cap keeps a garbage megabyte from being base64
 * decoded before it is rejected.
 */
const MAX_JWT_CHARS = 8 * 1_024;

const LOG_PREFIX = "[yaos-sync:worker]";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Brand. An AccessConfig cannot be written by hand: the only way to obtain one
 * is getAccessConfig(), which returns null unless both variables are present
 * AND well formed. That makes the type itself the proof — a function that
 * holds an AccessConfig knows admin auth is configured, and cannot be handed
 * a half-validated pair of strings by a caller that "checked" them elsewhere.
 */
const VALIDATED: unique symbol = Symbol("yaos.accessConfig.validated");

export interface AccessConfig {
	/** Bare host, e.g. "myteam.cloudflareaccess.com". Never a URL. */
	readonly teamDomain: string;
	/** The Access application AUD tag, 64 lowercase hex chars. */
	readonly aud: string;
	readonly [VALIDATED]: true;
}

export interface AccessEnv {
	YAOS_ACCESS_TEAM_DOMAIN?: string;
	YAOS_ACCESS_AUD?: string;
}

/** Hostname label rules, minus dots: a team domain has exactly one label. */
function isTeamLabel(label: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/**
 * Accept the shapes an operator actually types — "myteam",
 * "myteam.cloudflareaccess.com", "https://myteam.cloudflareaccess.com/" — and
 * normalize to the bare host. Anything carrying a path, port, query or
 * character that cannot appear in a hostname is rejected rather than repaired:
 * this string is interpolated into the JWKS URL and compared against `iss`, so
 * a lenient parse here is a redirect of the trust anchor.
 */
function normalizeTeamDomain(raw: string): string | null {
	let host = raw.trim().toLowerCase();
	if (!host) return null;
	host = host.replace(/^https?:\/\//, "");
	host = host.replace(/\/+$/, "");
	// Rejects "/", ":", "?", "#", "@", whitespace and every other non-host char.
	if (!host || /[^a-z0-9.-]/.test(host)) return null;

	if (host.endsWith(TEAM_DOMAIN_SUFFIX)) {
		const label = host.slice(0, host.length - TEAM_DOMAIN_SUFFIX.length);
		return isTeamLabel(label) ? host : null;
	}
	return isTeamLabel(host) ? `${host}${TEAM_DOMAIN_SUFFIX}` : null;
}

/** Access AUD tags are 64 hex chars; store them lowercased for comparison. */
function normalizeAud(raw: string): string | null {
	const aud = raw.trim();
	return /^[0-9a-f]{64}$/i.test(aud) ? aud.toLowerCase() : null;
}

/**
 * Raw (env-var, post-trim) input pairs already warned about in this isolate.
 *
 * WHY: getAccessConfig() runs per admin-shaped request, and on a misconfigured
 * deployment the admin route answers 404 — which is exactly the traffic a
 * scanner generates thousands of times an hour. An always-on warn there is the
 * failure mode index.ts already samples its not_found log at 1% to avoid. The
 * operator needs the message once; a dashboard does not need it ten thousand
 * times. Keyed on the raw strings so that FIXING one variable and getting the
 * other wrong still produces a fresh line rather than silence.
 */
const warnedAccessConfigs = new Set<string>();

/**
 * Read the Access configuration from the environment.
 *
 * Returns null — admin disabled — unless both variables are set and valid. A
 * partial or malformed configuration is the dangerous case: silently treating
 * it as "disabled" leaves an operator staring at a 404 with no idea why, and
 * silently treating it as "enabled" would open the page. So it disables admin
 * AND emits one console.warn naming the offending variable — once per isolate
 * per distinct input pair, see warnedAccessConfigs.
 */
export function getAccessConfig(env: AccessEnv): AccessConfig | null {
	const rawDomain = (env.YAOS_ACCESS_TEAM_DOMAIN ?? "").trim();
	const rawAud = (env.YAOS_ACCESS_AUD ?? "").trim();

	// Neither set: admin is simply not in use. Not a misconfiguration.
	if (!rawDomain && !rawAud) return null;

	const teamDomain = rawDomain ? normalizeTeamDomain(rawDomain) : null;
	const aud = rawAud ? normalizeAud(rawAud) : null;

	if (teamDomain !== null && aud !== null) {
		return { teamDomain, aud, [VALIDATED]: true };
	}

	const problems: string[] = [];
	if (!rawDomain) {
		problems.push("YAOS_ACCESS_TEAM_DOMAIN is not set");
	} else if (teamDomain === null) {
		problems.push("YAOS_ACCESS_TEAM_DOMAIN is malformed (expected a bare team domain such as myteam.cloudflareaccess.com)");
	}
	if (!rawAud) {
		problems.push("YAOS_ACCESS_AUD is not set");
	} else if (aud === null) {
		problems.push("YAOS_ACCESS_AUD is malformed (expected the 64-hex Access application AUD tag)");
	}
	// NUL cannot appear in an env var, so it is an unambiguous separator: no two
	// distinct pairs can collide into one key and silence a real warning.
	const warnKey = `${rawDomain}\u0000${rawAud}`;
	if (!warnedAccessConfigs.has(warnKey)) {
		warnedAccessConfigs.add(warnKey);
		// Values are deliberately not echoed: the AUD tag is a deployment secret
		// in the sense that it should not be scattered through log aggregators.
		console.warn(
			`${LOG_PREFIX} Cloudflare Access admin auth is disabled: ${problems.join("; ")}.`,
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

export type AccessJwtFailureReason =
	| "malformed_jwt"
	| "bad_alg"
	| "missing_kid"
	| "unknown_kid"
	| "bad_jwk"
	| "bad_signature"
	| "expired"
	| "not_yet_valid"
	| "bad_aud"
	| "bad_iss"
	| "jwks_fetch_failed"
	| "verification_error";

export type AccessJwtResult =
	| { ok: true; email: string | null; sub: string | null }
	| { ok: false; reason: AccessJwtFailureReason };

export interface AccessJwtDeps {
	/** Injected in tests so no suite ever touches the network. */
	fetchJwks?: (url: string) => Promise<Response>;
	/** Injected in tests so expiry/skew cases are deterministic. */
	nowMs?: () => number;
}

function fail(reason: AccessJwtFailureReason): AccessJwtResult {
	return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

/**
 * The subset of a JWK this module trusts. Built by hand from the published
 * document rather than passed through: `use`, `key_ops` and an unexpected
 * `alg` all change what importKey() accepts, and a JWKS is remote input.
 */
interface RsaJwk {
	kty: "RSA";
	n: string;
	e: string;
	alg: "RS256";
}

interface JwksCacheEntry {
	keysByKid: Map<string, RsaJwk>;
	fetchedAtMs: number;
	/** null until a rotation re-fetch has happened for this domain. */
	lastRotationRefetchMs: number | null;
}

/**
 * Module-level, per team domain. Isolate-scoped and therefore best-effort —
 * a cold isolate simply fetches once. Cleared between test sections through
 * invalidateAccessJwksCacheForTests().
 */
const jwksCache = new Map<string, JwksCacheEntry>();

/**
 * In-flight de-duplication. A burst of admin requests on a cold isolate would
 * otherwise each open their own JWKS fetch.
 */
const jwksInFlight = new Map<string, Promise<Map<string, RsaJwk> | null>>();

/**
 * Reset every piece of module-level state this file keeps — the JWKS cache and
 * in-flight map, and the once-per-isolate misconfiguration warning ledger.
 * Test-only: production wants exactly the accumulation this clears.
 */
export function resetAccessModuleStateForTests(): void {
	jwksCache.clear();
	jwksInFlight.clear();
	warnedAccessConfigs.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultFetchJwks(url: string): Promise<Response> {
	return fetch(url);
}

/** Returns null for every failure — transport, status, shape. */
async function readJwksDocument(
	teamDomain: string,
	fetchJwks: (url: string) => Promise<Response>,
): Promise<Map<string, RsaJwk> | null> {
	const url = `https://${teamDomain}/cdn-cgi/access/certs`;
	try {
		const res = await fetchJwks(url);
		if (!res.ok) return null;
		const body: unknown = await res.json();
		if (!isRecord(body) || !Array.isArray(body.keys)) return null;

		const keysByKid = new Map<string, RsaJwk>();
		for (const raw of body.keys) {
			if (!isRecord(raw)) continue;
			if (raw.kty !== "RSA") continue;
			if (raw.alg !== undefined && raw.alg !== "RS256") continue;
			const { kid, n, e } = raw;
			if (typeof kid !== "string" || kid.length === 0) continue;
			if (typeof n !== "string" || typeof e !== "string") continue;
			// First entry wins: a document that repeats a kid is malformed, and
			// letting a later entry override the earlier one would let a
			// mangled document shadow a good key.
			if (keysByKid.has(kid)) continue;
			keysByKid.set(kid, { kty: "RSA", n, e, alg: "RS256" });
		}
		return keysByKid;
	} catch {
		return null;
	}
}

function fetchJwksDocumentOnce(
	teamDomain: string,
	fetchJwks: (url: string) => Promise<Response>,
): Promise<Map<string, RsaJwk> | null> {
	const existing = jwksInFlight.get(teamDomain);
	if (existing) return existing;
	const pending = readJwksDocument(teamDomain, fetchJwks).finally(() => {
		jwksInFlight.delete(teamDomain);
	});
	jwksInFlight.set(teamDomain, pending);
	return pending;
}

type JwkLookup =
	| { status: "ok"; jwk: RsaJwk }
	| { status: "unknown_kid" }
	| { status: "fetch_failed" };

/**
 * Resolve `kid` against the cached JWKS for `teamDomain`, re-fetching when the
 * cache is cold or stale, and once more — rate limited — when a live key
 * rotation is the plausible explanation for an unknown kid.
 */
async function resolveJwk(
	teamDomain: string,
	kid: string,
	fetchJwks: (url: string) => Promise<Response>,
	now: number,
): Promise<JwkLookup> {
	let entry = jwksCache.get(teamDomain);
	let fetchedThisCall = false;

	if (!entry || now - entry.fetchedAtMs >= JWKS_TTL_MS) {
		const fresh = await fetchJwksDocumentOnce(teamDomain, fetchJwks);
		if (!fresh) return { status: "fetch_failed" };
		entry = { keysByKid: fresh, fetchedAtMs: now, lastRotationRefetchMs: null };
		jwksCache.set(teamDomain, entry);
		fetchedThisCall = true;
	}

	const hit = entry.keysByKid.get(kid);
	if (hit) return { status: "ok", jwk: hit };

	// The document in hand is seconds old, so a re-fetch would return the same
	// bytes. The kid is simply not ours.
	if (fetchedThisCall) return { status: "unknown_kid" };

	const last = entry.lastRotationRefetchMs;
	if (last !== null && now - last < JWKS_ROTATION_REFETCH_COOLDOWN_MS) {
		return { status: "unknown_kid" };
	}

	// Stamp before awaiting: concurrent unknown-kid tokens must not all slip
	// through the gate while the first re-fetch is still in flight.
	entry.lastRotationRefetchMs = now;
	const rotated = await fetchJwksDocumentOnce(teamDomain, fetchJwks);
	if (!rotated) return { status: "fetch_failed" };
	entry.keysByKid = rotated;
	entry.fetchedAtMs = now;

	const rotatedHit = rotated.get(kid);
	return rotatedHit ? { status: "ok", jwk: rotatedHit } : { status: "unknown_kid" };
}

async function importRsaKey(jwk: RsaJwk): Promise<CryptoKey | null> {
	try {
		return await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

/** Decode one base64url JSON segment. Returns null on any malformation. */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** A claim that must be a number of seconds since the epoch. */
function numericClaim(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Identity claims are surfaced only when they are genuinely strings. */
function stringClaim(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function audienceMatches(claim: unknown, expected: string): boolean {
	if (typeof claim === "string") return claim.toLowerCase() === expected;
	if (!Array.isArray(claim)) return false;
	return claim.some((entry) => typeof entry === "string" && entry.toLowerCase() === expected);
}

function checkClaims(
	payload: Record<string, unknown>,
	config: AccessConfig,
	now: number,
): AccessJwtFailureReason | null {
	if (payload.iss !== `https://${config.teamDomain}`) return "bad_iss";
	if (!audienceMatches(payload.aud, config.aud)) return "bad_aud";

	// exp is mandatory: a token without one never expires, which is exactly
	// the property an admin session must not have.
	const exp = numericClaim(payload.exp);
	if (exp === null || now >= exp * 1_000 + CLOCK_SKEW_MS) return "expired";

	if (payload.nbf !== undefined) {
		const nbf = numericClaim(payload.nbf);
		if (nbf === null || now < nbf * 1_000 - CLOCK_SKEW_MS) return "not_yet_valid";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a Cloudflare Access token.
 *
 * Order matters and is deliberate:
 *   1. structure, 2. `alg`, 3. key lookup, 4. signature, 5. claims.
 *
 * `alg` is checked before anything reads a key, so "none" and the HS256
 * confusion attack (public key smuggled in as an HMAC secret) are refused
 * before there is a key to confuse. Claims are read only after the signature
 * holds, so no decision and no returned reason ever depends on unauthenticated
 * bytes.
 */
export async function verifyAccessJwt(
	jwt: string,
	config: AccessConfig,
	deps: AccessJwtDeps = {},
): Promise<AccessJwtResult> {
	const now = (deps.nowMs ?? Date.now)();
	const fetchJwks = deps.fetchJwks ?? defaultFetchJwks;

	try {
		if (typeof jwt !== "string" || jwt.length === 0 || jwt.length > MAX_JWT_CHARS) {
			return fail("malformed_jwt");
		}

		const parts = jwt.split(".");
		if (parts.length !== 3) return fail("malformed_jwt");
		const [encodedHeader, encodedPayload, encodedSignature] = parts;
		if (!encodedHeader || !encodedPayload || !encodedSignature) return fail("malformed_jwt");

		const header = decodeJsonSegment(encodedHeader);
		if (!header) return fail("malformed_jwt");
		if (header.alg !== "RS256") return fail("bad_alg");
		const kid = stringClaim(header.kid);
		if (kid === null) return fail("missing_kid");

		const lookup = await resolveJwk(config.teamDomain, kid, fetchJwks, now);
		if (lookup.status === "fetch_failed") return fail("jwks_fetch_failed");
		if (lookup.status === "unknown_kid") return fail("unknown_kid");

		const key = await importRsaKey(lookup.jwk);
		if (!key) return fail("bad_jwk");

		let signature: Uint8Array;
		try {
			signature = base64UrlToBytes(encodedSignature);
		} catch {
			return fail("malformed_jwt");
		}

		const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
		const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signed);
		if (!valid) return fail("bad_signature");

		const payload = decodeJsonSegment(encodedPayload);
		if (!payload) return fail("malformed_jwt");

		const claimFailure = checkClaims(payload, config, now);
		if (claimFailure) return fail(claimFailure);

		return {
			ok: true,
			email: stringClaim(payload.email),
			sub: stringClaim(payload.sub),
		};
	} catch {
		// The contract is that an admin gate can call this without a try/catch
		// and treat anything that is not { ok: true } as unauthorized.
		return fail("verification_error");
	}
}
