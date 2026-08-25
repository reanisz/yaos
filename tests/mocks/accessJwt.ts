/**
 * Cloudflare Access token fixtures: a real RSA-2048 keypair generated in
 * process, the JWKS document that publishes it, and an RS256 signer.
 *
 * WHY A SHARED MODULE. Two suites need signed Access tokens —
 * tests/server/access-jwt.ts (verifier unit tests, JWKS injected through
 * `deps`) and tests/server/admin-routes.ts (whole-Worker tests, JWKS served by
 * a stubbed global fetch). A second copy of "generate a keypair, export the
 * JWK, base64url three segments" is a copy that can disagree with the first
 * about what a valid token looks like, which would let a verifier bug pass one
 * suite while the other tests a token no Access deployment would ever mint.
 *
 * No key material is checked in: every run generates its own. The FOREIGN key
 * exists so a suite can produce a well-formed token that the published JWKS
 * cannot verify — the "signed by someone else" case, which is not the same
 * failure as a tampered signature and must be tested on its own.
 */

import { bytesToBase64Url } from "../../server/src/base64url.ts";

/** A syntactically real Access AUD tag: 64 hex chars. */
export const TEST_ACCESS_AUD = "0123456789abcdef".repeat(4);
export const TEST_ACCESS_TEAM_DOMAIN = "myteam.cloudflareaccess.com";
/** The kid the published JWKS carries by default. */
export const TEST_ACCESS_KID = "access-key-1";

/** Where verifyAccessJwt fetches the JWKS for `teamDomain`. */
export function accessJwksUrl(teamDomain: string = TEST_ACCESS_TEAM_DOMAIN): string {
	return `https://${teamDomain}/cdn-cgi/access/certs`;
}

const RSA_PARAMS: RsaHashedKeyGenParams = {
	name: "RSASSA-PKCS1-v1_5",
	hash: "SHA-256",
	modulusLength: 2048,
	publicExponent: new Uint8Array([1, 0, 1]),
};

async function generateKeyPair(): Promise<CryptoKeyPair> {
	const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
	if (!("privateKey" in pair)) throw new Error("test setup: expected an RSA key pair");
	return pair;
}

/** The key the JWKS publishes — tokens signed with it verify. */
const primaryKeyPair = await generateKeyPair();
/** Never published anywhere. Tokens signed with it must fail verification. */
const foreignKeyPair = await generateKeyPair();

const primaryPublicJwk = await crypto.subtle.exportKey("jwk", primaryKeyPair.publicKey);

/** Base64url-encode one JSON JWT segment. */
export function encodeJwtSegment(value: unknown): string {
	return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * A JWKS document publishing the primary public key once per `kid`, so a test
 * can express key rotation by listing two.
 */
export function accessJwksDocument(...kids: readonly string[]): unknown {
	return { keys: kids.map((kid) => ({ ...primaryPublicJwk, kid, alg: "RS256", use: "sig" })) };
}

/** The header a real Access token carries, for `kid`. */
export function accessJwtHeader(kid: string = TEST_ACCESS_KID): Record<string, unknown> {
	return { alg: "RS256", kid, typ: "JWT" };
}

async function sign(
	key: CryptoKey,
	payload: Record<string, unknown>,
	header: Record<string, unknown>,
): Promise<string> {
	const signingInput = `${encodeJwtSegment(header)}.${encodeJwtSegment(payload)}`;
	const signature = await crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Sign with the key the JWKS publishes. */
export function signAccessJwt(
	payload: Record<string, unknown>,
	header: Record<string, unknown> = accessJwtHeader(),
): Promise<string> {
	return sign(primaryKeyPair.privateKey, payload, header);
}

/**
 * Sign with a key no JWKS publishes. Structurally a perfect Access token,
 * including the `kid` of the real key, and it must still be refused.
 */
export function signAccessJwtWithForeignKey(
	payload: Record<string, unknown>,
	header: Record<string, unknown> = accessJwtHeader(),
): Promise<string> {
	return sign(foreignKeyPair.privateKey, payload, header);
}
