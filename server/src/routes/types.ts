import type { VaultSyncServer } from "../server";
import type { StoredServerConfig } from "../config";

export interface Env {
	SYNC_TOKEN?: string;
	YAOS_CANONICAL_REPO?: string;
	YAOS_SYNC: DurableObjectNamespace<VaultSyncServer>;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
	/**
	 * Set to any non-empty string to reject WebSocket connections that use
	 * the legacy ?token= query parameter instead of a short-lived ticket.
	 * Enables this after all clients in your deployment have upgraded to
	 * Release N (ticket-aware plugin).  Emits a console.warn on every legacy
	 * auth attempt even when not set, so you can monitor adoption before
	 * disabling.
	 */
	YAOS_DISABLE_LEGACY_WS_TOKEN?: string;
	/**
	 * Override the ticket TTL (milliseconds) for testing.
	 * When set, the ticket endpoint issues tickets with this TTL instead of
	 * the default 5-minute production value.  Never set this in production.
	 * Used by the local wrangler dev integration harness to make the proactive
	 * refresh timer fire in seconds rather than minutes.
	 */
	YAOS_TICKET_TTL_MS?: string;
	/**
	 * Set to any non-empty string to expose the mutating admin routes
	 * (POST /__yaos/compact). Unset, they answer 404 — the route is invisible
	 * rather than merely forbidden. Read as a plain truthiness check, so any
	 * non-empty value enables it.
	 */
	YAOS_ENABLE_ADMIN_ROUTES?: string;
	/**
	 * Set to any non-empty string to run the server in STRICT PERMISSIONS mode.
	 *
	 * Unset (the default), everything behaves exactly as it always has: the
	 * claim flow, a claimed token that opens every vault, and per-vault tokens
	 * as an additive feature.
	 *
	 * Set, the server-wide credential stops existing: the claimed token and
	 * SYNC_TOKEN authorize NOTHING, `POST /claim` answers 403, and the only
	 * credentials are per-vault, per-device tokens issued from the
	 * Access-gated /admin page — which works even on a server nobody ever
	 * claimed.  SYNC_TOKEN set alongside it is ignored (fail closed), with one
	 * console.warn per isolate.
	 *
	 * In practice this requires Cloudflare Access to be configured, since
	 * /admin is the only surface that can issue a token; with Access
	 * unconfigured the server is simply locked, and says so once per isolate.
	 *
	 * See docs/architecture/zero-config-auth.md, "strict_permissions mode".
	 */
	YAOS_STRICT_PERMISSIONS?: string;
	/**
	 * Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com" (a bare
	 * "myteam" and a full https:// URL are both accepted and normalized).
	 *
	 * Setting this AND YAOS_ACCESS_AUD enables the /admin page and its JSON API;
	 * with either missing or malformed, every /admin path answers the ordinary
	 * 404 and no Durable Object is touched.  Requires the Worker to be served on
	 * a custom domain in your zone: Access protects hostnames, and it cannot be
	 * put in front of a workers.dev URL.
	 *
	 * The Worker verifies the Access JWT itself (signature, issuer, audience)
	 * rather than trusting the Cf-Access-Jwt-Assertion header, so a request that
	 * reaches the same script directly on workers.dev — where Access never ran —
	 * is refused.  See server/src/accessJwt.ts.
	 *
	 * Provide both values as Worker Secrets (dashboard → Settings → Variables
	 * and Secrets, or `wrangler secret put`), not as committed [vars]: Secrets
	 * survive wrangler-driven deploys and keep deployment facts out of the
	 * repo.  See the setup comment in server/wrangler.toml.
	 */
	YAOS_ACCESS_TEAM_DOMAIN?: string;
	/**
	 * The AUD tag of the Cloudflare Access application protecting /admin: 64 hex
	 * characters, copied from the application's overview page.  Scopes admin to
	 * one specific Access application — a valid token minted for a different
	 * application in the same team is rejected.  Enables /admin only in
	 * combination with YAOS_ACCESS_TEAM_DOMAIN.
	 */
	YAOS_ACCESS_AUD?: string;
}

export type JsonResponse = (body: unknown, status?: number) => Response;

/**
 * The strict-mode variant carries `claimed: true` deliberately, whatever the
 * server's actual claim state.
 *
 * `claimed` is not a fact about strict mode, it is the flag every existing
 * rejection path reads to answer "is this server usable yet": the 503 in
 * rejectUnauthorizedVaultRequest, the `unclaimed` fatal socket frame, the
 * vault-token route gate.  A strict server IS usable — its tokens are issued
 * through /admin, which needs no claim — so those paths must not fire, and
 * `mode` is what gates behaviour instead.  Nothing in strict mode consults the
 * claimed flag for anything else, and `POST /claim` is refused from the
 * environment alone before any of this is built.
 */
export type AuthState =
	| { mode: "env"; claimed: true; envToken: string }
	| { mode: "claim"; claimed: true; tokenHash: string; config?: StoredServerConfig }
	| { mode: "strict"; claimed: true; config: StoredServerConfig }
	| { mode: "unclaimed"; claimed: false; config?: StoredServerConfig };

/**
 * Narrower variant returned by getAuthStateCached().  Claim/unclaimed modes
 * always carry the full StoredServerConfig (required, not optional) because
 * the cached path fetches it once and attaches it to the state.  This avoids
 * the "optional config" footgun where callers can't tell whether config is
 * present without checking.
 *
 * AuthStateCached is assignable to AuthState — all existing handlers that
 * accept AuthState continue to work when called with AuthStateCached values.
 */
export type AuthStateCached =
	| { mode: "env"; claimed: true; envToken: string }
	| { mode: "claim"; claimed: true; tokenHash: string; config: StoredServerConfig }
	| { mode: "strict"; claimed: true; config: StoredServerConfig }
	| { mode: "unclaimed"; claimed: false; config: StoredServerConfig };

export type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

export type UpdateProvider = "github" | "gitlab" | "unknown";
