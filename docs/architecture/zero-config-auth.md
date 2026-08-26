# Zero Config Onboarding

Self-hosted software usually dies at the onboarding step. Forcing a user to open a terminal, run OpenSSL to generate a 32-byte cryptographic secret, and paste it into a .env file guarantees a 90% abandonment rate.

YAOS implements a consumer-grade, zero-terminal claim flow, while gracefully handling the realities of infrastructure paywalls.

## The Framework Migration: Killing the CLI

The first version of YAOS was built on PartyKit. PartyKit provided an incredible early abstraction - it wrapped Cloudflare's complex Durable Objects behind a simple "Room" API and made real-time multiplayer trivially easy to bootstrap.

However, the deployment worked exclusively through their proprietary CLI. The problem is that users must login through partykit-cli to deploy, meaning we couldn't utilize Cloudflare's "One-Click Deployment" button. This violated our core onboarding goal: Zero-terminal, consumer-grade self-hosting.

To unlock the deploy button, we stripped out the PartyKit framework and ported the entire transport layer to native Cloudflare Workers using y-partyserver, handle WebSocket transport and Durable Object coordination. We define the entire infrastructure (Workers, Durable Objects, and Storage) in a standard `wrangler.toml` file, eliminating the CLI entirely and allowing users to deploy straight from their browser.

# The Single-Use Claim Architecture

When deployed, the YAOS server boots into an "Unclaimed" state.
- The user visits the Worker URL in their browser and is greeted by a lightweight, dependency-free HTML setup page.
- The browser utilizes crypto.getRandomValues() to generate a high-entropy token locally.
- The user clicks "Claim". The token is sent to the server.
- The server hashes the token (SHA-256) and stores only the hash inside a singleton Config Durable Object via an ACID transaction.
- The setup route permanently locks itself.

For subsequent authentication, the plugin uses `Authorization: Bearer <token>` for HTTP endpoints.

For WebSocket sync transport, the plugin uses **short-lived connection tickets** issued by the server.  Before opening a WebSocket connection the plugin calls `POST /vault/:vaultId/auth/ticket` with the long-lived bearer token in the Authorization header.  The server returns a ticket valid for 5 minutes, scoped to the specific vault, and signed with HMAC-SHA256.  Only the ticket appears in the WebSocket URL query parameter — the long-lived token never touches a URL.

Old plugin versions that predate ticket auth continue to work during the migration window: the server accepts either a valid ticket (`?ticket=`) or a valid long-lived token (`?token=`) and emits a warning to Worker logs when the legacy path is used.

## Current transport model

- HTTP routes (`/vault/*`, setup helpers, snapshot APIs) authenticate with `Authorization: Bearer <token>`.
- WebSocket sync (`/vault/sync/:room`) authenticates with a short-lived `?ticket=` signed by the server.  Legacy `?token=` is accepted during the migration window.
- All traffic is expected over HTTPS/WSS in normal deployment.

## Ticket auth detail

The server issues tickets at `POST /vault/:vaultId/auth/ticket` (requires valid Bearer auth).  The ticket payload is:

```json
{ "v": 1, "aud": "yaos-ws", "vaultId": "...", "iat": <ms>, "exp": <ms>, "nonce": "<random>" }
```

Signed as `base64url(payload).base64url(HMAC-SHA256(signingKey, base64url(payload)))`.  The signing key is derived from the server's existing auth secret so no additional deployment secret is required.

The plugin caches the ticket and refreshes it when less than 30 seconds remain, so reconnects reuse a valid cached ticket without an extra HTTP round-trip.

## Reconnect behavior and the y-partyserver constraint

`YProvider.connect()` evaluates the async `params()` callback exactly once, mutates `provider.url` with the result, then calls the base `WebsocketProvider.connect()`.  The internal reconnect loop (`setupWS`) reads `provider.url` directly on every subsequent reconnect without re-invoking `params()`.

This means the ticket inserted on the initial connection would become stale after its 5-minute TTL, causing all reconnects after that point to present an expired ticket and receive 401 responses — permanently, until plugin reload.

The fix is a proactive refresh manager in `VaultSync`:

1. After the initial `params()` call succeeds with a ticket, `scheduleSocketTicketRefresh` sets a timer at `expiresAt - TICKET_REFRESH_BUFFER_MS` (i.e. 30 seconds before expiry).
2. When the timer fires, it calls the ticket callback with `force=true`, which bypasses the cache and fetches a fresh ticket from the server.
3. `patchProviderTicket` replaces `?ticket=` in `provider.url` with the new value and removes any legacy `?token=` if present.  Other query parameters (schemaVersion, `_pk`, trace context) are preserved.
4. The timer reschedules itself based on the new ticket's `expiresAt`.
5. On every `"disconnected"` status event, a best-effort refresh also fires before the internal reconnect timer retries.  This secondary path handles sleep/wake and abrupt network drops where the proactive timer may not have fired in time.  It races the first reconnect attempt (100ms backoff), but subsequent retries will use the updated URL.

The `force=true` flag causes `ticketCache.invalidate()` to run before `ticketCache.get()`, guaranteeing a network fetch rather than returning the still-cached (but about-to-expire) ticket.

If `y-partyserver` is upgraded, verify whether this behavior has changed — see also `docs/architecture/warts-and-limits.md`.

## Threat model notes

The long-lived token is no longer placed in any URL.  A leaked ticket is bounded by the 5-minute TTL — useless by the time a log rotation or audit sees it.

For legacy clients still using `?token=`, the risk profile is unchanged from v1: acceptable when TLS is enabled end-to-end and server logs are access-controlled.

## Migration path: disabling legacy token auth

Once all plugin clients in your deployment have upgraded to the ticket-aware version (identifiable by Worker logs no longer containing `"legacy ?token= WebSocket auth"`), set the operator flag to close the legacy path permanently:

```toml
# server/wrangler.toml
[vars]
YAOS_DISABLE_LEGACY_WS_TOKEN = "true"
```

When set, connections using `?token=` are rejected with 401 before the vault Durable Object is woken.  Ticket-authenticated connections are unaffected.

The `wrangler.toml` included with the server contains this setting as a commented-out example with upgrade guidance.

## Per-vault access tokens

One server-wide token is the right shape for one operator syncing their own vaults. It is the wrong shape the moment a deployment hosts vaults across more than one trust boundary: the single token opens every vault, so handing it to another person — or to a device you only half trust — hands over all of them. Rotating it after a leak means re-onboarding every client.

A **vault token** is scoped to exactly one `vaultId`. It authorizes that vault's HTTP routes, its ticket issuance and its sync socket, and nothing else.

### Scope model

| Credential | Opens | Can manage tokens |
| --- | --- | --- |
| Global token (`SYNC_TOKEN`, or the claimed token) | every vault | yes |
| Vault token | its own `vaultId` only | no |

The global token keeps opening everything, so a deployment that never calls the API below behaves exactly as it did before this feature existed — `vaultTokens` is simply an empty map, and a config written before the key existed reads as one.

The operator API authenticates with the **global** token specifically. A vault token calling it gets 401, including when it targets its own vault: a credential that can mint or revoke credentials is not scoped, whatever its nominal scope says. `POST /api/update-metadata` and the private update metadata in `GET /api/capabilities` stay operator-only for the same reason.

### API

All three routes take `Authorization: Bearer <global-token>`.

```
GET  /api/vault-tokens
  → { ok: true, vaultTokens: [ { vaultId, label, createdAt } ] }

POST /api/vault-tokens          { vaultId, label? }
  → { ok: true, vaultId, token, label, createdAt, obsidianUrl }

POST /api/vault-tokens/revoke   { vaultId }
  → { ok: true, existed: boolean }
```

The server generates the token itself — 32 bytes from `crypto.getRandomValues`, base64url — and stores only its SHA-256, the same way the global claim does. **The plaintext is in the issue response and nowhere else**: it is never logged, never re-readable, and the listing endpoint never returns a hash either. `obsidianUrl` is the usual `obsidian://yaos?action=setup&host=…&token=…&vaultId=…` deep link, so onboarding a second vault is still one click.

`vaultId` is 8–256 characters after trimming; `label` is an optional human note of at most 64 characters. A server holds at most 100 vault tokens: the map is carried inside every cached config, so it has to stay cheap on the auth path.

### One token per vault, rotation by re-issue

There is no token list per vault. Issuing for a `vaultId` that already has a token **replaces** it — that is the rotation path, and it is why the cap never blocks a rotation, only a genuinely new vault. The previous token stops working as soon as the config cache turns over.

### Revocation propagates within the config cache TTL

`getStoredServerConfigCached` caches the stored config for 60 seconds (`AUTH_CONFIG_CACHE_TTL_MS`) to keep claim mode from paying a Durable Object round-trip per request. A mutation invalidates the cache in the isolate that served it, so the operator sees the effect immediately; other isolates keep serving their cached copy until their own TTL expires.

**A revoked token can therefore still be accepted for up to 60 seconds by isolates that have not re-read the config.** That is the same staleness window the global token's hash has always had, and it is the price of not re-reading the config DO on every request. If you need a hard cut, re-deploy the Worker — a new deployment starts with cold caches.

### Env mode is global-token only

Under `SYNC_TOKEN`, the operator API answers `409 { "error": "unsupported_in_env_mode" }` and vault tokens are not consulted during authorization.

This is a deliberate limit. Env mode's defining property is that it makes **zero** Durable Object calls per request: the token comes from the environment and is compared in the Worker. The vault-token map lives in the config DO, so honouring it in env mode would mean putting a `YAOS_CONFIG` round-trip back on every authenticated request — reintroducing exactly the per-request DO amplification that issue #40 removed. Deployments that want per-vault tokens use the claim flow, which already pays for (and caches) that read.

### Access-gated admin page

Managing vault tokens with `curl` and a bearer token works, but it is the same terminal step the claim flow exists to avoid. `/admin` is a server-rendered page — one document, no external assets, same style as the setup page — that lists the issued tokens and lets an operator issue, rotate and revoke them in a browser. An issued token is shown once, with a copy button, the `obsidian://` setup link and the mobile setup QR, so onboarding a vault from the admin page is the same one-scan flow the claim page offers.

It is authenticated by **Cloudflare Access**, not by the bearer token, and it exists only where Access is configured through two Worker environment values: `YAOS_ACCESS_TEAM_DOMAIN` (the team domain, e.g. `myteam.cloudflareaccess.com`) and `YAOS_ACCESS_AUD` (the Access application's 64-hex AUD tag).

**Set them as Secrets, not as committed `[vars]`.** In the Cloudflare dashboard: Worker → **Settings → Variables and Secrets** → add both with type **Secret** — no terminal, same flow as adding the R2 binding. (From a terminal, `npx wrangler secret put YAOS_ACCESS_TEAM_DOMAIN`, then the same for the AUD.) Two reasons this is the standard path rather than editing `wrangler.toml`:

- **Secrets survive deploys.** A dashboard-set *plaintext* variable is removed by the next `wrangler`-driven deploy, which replaces the plaintext variable set with whatever `wrangler.toml` declares — the classic way an admin page silently turns back into a 404 after an update. Deploys do not touch Secrets.
- **Nothing environment-specific lands in the repository.** The team domain and AUD are deployment facts, not source, and YAOS deployments are usually driven from a Git repo (the Deploy button, the zero-ops updater). Committed `[vars]` publish those facts with the repo; Secrets keep the repo generic and fork-friendly.

Committing `[vars]` to a private deployment repo still works — the Worker reads the same `env` either way, and `wrangler.toml` carries a commented example — but it is the alternative, not the default. Neither value is a credential; the Secret type is used here for its deploy-surviving lifecycle, not its secrecy. If you would rather manage them as plaintext **Text** variables in the dashboard, add `keep_vars = true` to your own `wrangler.toml` — without it, the next `wrangler`-driven deploy removes dashboard-set plaintext variables. The shipped template deliberately leaves that default unchanged, since it alters variable-sync semantics for the whole deployment.

**Both values, or the feature does not exist.** With either absent or malformed, every `/admin` path returns the identical 404 JSON any unknown URL returns, before any Durable Object namespace is touched. Not 403, not a login redirect: a deployment that never opted in is byte-for-byte the server it was before. A half-configured deployment is treated as disabled and logs one `console.warn` naming the offending variable (once per isolate, because the 404 path is exactly what scanners hammer).

#### The custom-domain requirement, and why the Worker verifies the JWT itself

Access protects a **hostname**, so the Worker must be served on a custom domain in your zone; Access cannot be placed in front of a `workers.dev` URL. That is also why the header alone is worthless as a credential: the same Worker script stays reachable on `workers.dev` and on every other route bound to it, and those requests never traverse Access. "The request arrived, therefore Access allowed it" is false, and `Cf-Access-Jwt-Assertion` is a header anyone can set.

So `server/src/accessJwt.ts` verifies the token in the Worker: RS256 signature against the team's published JWKS (`https://<team-domain>/cdn-cgi/access/certs`, cached for 10 minutes with a rate-limited re-fetch on key rotation), `iss` equal to the team domain, and `aud` containing the configured application tag. Failures return 401 with no detail; the machine-readable reason tag is logged, never echoed to the client. A request with no header is refused before any JWKS fetch, and neither path reads the config Durable Object.

#### CSRF posture

The bearer-token `/api` surface can safely carry permissive CORS headers: a browser never attaches that credential on its own, so a cross-origin page has nothing to replay. Access is the opposite — it authenticates with the `CF_Authorization` cookie, which *is* ambient. Three properties keep that from mattering:

- **No CORS headers on any admin response, ever.** A cross-origin fetch may still be sent, but its response is unreadable, and a JSON `POST` is preflighted — the preflight has no arm in the route classifier, so it 404s and the mutating request is never made.
- **`Content-Type: application/json` is required** on both POST endpoints (`415 unsupported_media_type` otherwise). The three content types an HTML form can produce without a preflight are exactly the ones this refuses.
- **The Access cookie's `SameSite` attribute** is a third layer, and the only one this design does not rely on: Cloudflare defaults `CF_Authorization` to `SameSite=Lax` (so it is not attached to a cross-site POST at all), but the attribute is configurable per Access application and can be set to `None`. The two properties above hold whichever value it has.

#### Semantics

`GET /admin/api/vault-tokens`, `POST /admin/api/vault-tokens` and `POST /admin/api/vault-tokens/revoke` share one implementation with the bearer-token API described above, so the two front doors cannot drift. The admin API additionally requires **claim mode**: env mode answers `409 unsupported_in_env_mode` and an unclaimed server answers `503 unclaimed`, for the reasons in the section below. The page renders in all three states — an operator who lands on an unclaimed or env-mode server is told why there is no form rather than shown a broken one. The issue response also carries `mobileSetupQrDataUrl`; if QR rendering fails the field is `null` and the token is still returned, because the rotation is already durable by then and losing the plaintext would lock the operator out of that vault.

Nothing secret is rendered into the page: the HTML carries only the server's own origin and its auth mode, and tokens reach the browser exclusively as the JSON body of an issue call. The page response also carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` — it is the only authenticated, state-changing page in the product, and Access authenticates it with an ambient cookie, which is exactly what clickjacking needs. The JSON responses carry neither: a JSON body is not framable content.

#### Audit trail

A successful issue or revoke **through the admin front door** logs one line:

```
[yaos-sync:worker] admin audit: {"action":"issue","vaultIdHint":"vault-al","actor":"operator@example.test"}
```

It is emitted on `console.debug`, the channel the per-request access log already uses, and is self-identifying — grep `admin audit`. `actor` is the Access token's `email`, falling back to `sub`, then to `"unknown"`. It is logged in full — a truncated identity is not an audit record — while the `vaultId` keeps the repo's eight-character truncation so it cannot become a correlation handle in exported logs. The token and the label are never logged, and nothing is logged for reads, rejected input, or failed authentication beyond the rejection warning above. The bearer-token API emits no such line and cannot: its caller is an anonymous secret, so there is no identity to record.

## Planned hardening (post-current)

- Replace `tokenHash`-as-signing-key with a random per-server ticket signing secret generated at claim time and stored in the Config DO.  This removes the promotion of the token verifier hash to signing authority.  Existing deployments would backfill lazily on next claim.
- Ensure auth material is redacted from traces and diagnostics by default.

For the broader list of accepted compromises and tracked debt, see
`docs/architecture/warts-and-limits.md`.

# The URI Protocol Handshake

To completely eliminate the copy-paste step, the setup page generates a custom deep-link: `obsidian://yaos?action=setup&host=...&token=....`

When clicked, the OS routes this directly to the Obsidian plugin, which intercepts the URI, configures its internal settings, and immediately boots the sync engine.

# Graceful Degradation and the Credit Card Wall

Because YAOS utilizes native `wrangler.toml` bindings, Cloudflare can automatically provision Durable Objects and R2 buckets upon deployment. 

However, we made the intentional product decision **not** to force the R2 bucket binding in the default deployment template. Cloudflare enforces a strict requirement: users must have a primary payment method (credit card) on file to provision an R2 bucket. If YAOS required this binding by default, the "Deploy to Cloudflare" button would hit a billing wall, and users without a configured payment profile would abandon the setup.

We solved this via Capability Negotiation:
- The default YAOS deployment provisions only the text-sync CRDT engine (Worker + Durable Object). It requires no credit card.
- When the Obsidian plugin connects, it performs a capability probe (`GET /api/capabilities`).
- If the server lacks the `YAOS_BUCKET` binding, it returns `{ attachments: false, snapshots: false }`.
- The plugin reads this and gracefully disables the attachment and snapshot UI. It continues to sync markdown text flawlessly.

![Deploy-button resilience without mandatory R2](../diagrams/deploy-button-resilience-without-mandatory-r2.webp)


Power users who want attachment sync can easily add the R2 binding later via the Cloudflare dashboard **one-step (Just add an R2 binding to the Worker)**. The server will dynamically detect the new binding, update its capabilities, and the plugin will unlock the UI without a single line of code changing.
