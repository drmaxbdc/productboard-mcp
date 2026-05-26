# OAuth 2.0 Authentication for productboard-mcp

**Status:** Design (not yet implemented)
**Date:** 2026-05-26
**Target release:** `@drmaxbdc/productboard-mcp@2.1.0` (minor bump)
**Author:** Brainstormed with Claude (Opus 4.7); decisions by Jiří Šubrt

## Goal

Add OAuth 2.0 Authorization Code flow (with PKCE) as a second authentication mechanism alongside the existing Personal Access Token (PAT) path. After this release:

- **Public users (npm consumers outside Dr.Max):** both PAT and OAuth are first-class options indefinitely.
- **Dr.Max internal users (via tars):** OAuth becomes the migration target. The MCP package itself does not enforce migration; tars orchestrates the rollout in phases (soft default → forced OAuth → PB admin PAT revocation).

## Drivers

The OAuth addition is motivated by three problems with the current PAT-only auth:

1. **Security.** PATs are eternal — no rotation, no per-app revocation. OAuth gives short-lived access tokens, rotating refresh tokens, and admin-level revocation per OAuth application.
2. **Auditability.** Today multiple users share the same PAT or each generate their own. Productboard's audit log cannot reliably attribute API calls to a specific human. OAuth grants are per-user, identifying the authenticated identity behind every request.
3. **Rollout friction.** Provisioning a PAT requires admin-level access to the Productboard UI, generating a token, copying it, and distributing it to users (typically via a shared password manager or env file). OAuth replaces this with a one-click "Authorize" flow in the browser.

## Critical constraint

Productboard's OAuth implementation supports **only** the Authorization Code flow (with optional PKCE). It does not offer Client Credentials grant or any other machine-to-machine flow. Verified against [https://developer.productboard.com/reference/oauth-authorization-code.md](https://developer.productboard.com/reference/oauth-authorization-code.md) on 2026-05-26:

- Authorize endpoint: `https://app.productboard.com/oauth2/authorize`
- Token endpoint: `https://app.productboard.com/oauth2/token`
- Supported `response_type`: `code` only
- Supported `grant_type`: `authorization_code` and `refresh_token`
- PKCE: supported (S256 only; plain rejected)
- Refresh token lifetime: 180 days; the refresh token rotates on every use and the old one stays valid for 60 minutes after use (grace window for retries)
- Application registration: [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications); redirect URI must be exact match

This shapes the design: because the only flow is interactive, the MCP server must trigger a browser-based setup. There is no headless / machine-to-machine path.

## Architecture overview

```
                                       ┌──────────────────┐
                                       │ Productboard     │
                                       │ OAuth2 server    │
                                       └──────────────────┘
                                                ▲
                  ┌─────────── browser ─────────┘
                  ▼              redirect to localhost
   ┌──────────────────────┐
   │ User in browser      │
   │ (scope chooser →     │
   │  PB authorize +      │
   │  consent)            │
   └──────────────────────┘
                                                  callback
                                       ┌────────────────────────┐
                                       │ Local HTTP listener    │
                                       │ http://localhost:7779  │   ← spun up only during setup
                                       │ /, /start, /callback   │
                                       └────────────────────────┘
                                                ▲
                                                │ launches browser via `open`
                                                │
   ┌─────────────────────────────────────────────────────────────────────┐
   │                                                                     │
   │   MCP server process (stdio child of Claude Code / Cursor / TARS)   │
   │                                                                     │
   │   ┌─────────────┐     ┌─────────────┐     ┌────────────────────┐    │
   │   │ Auth        │────▶│ Token store │     │ Productboard API   │    │
   │   │ resolver    │     │ (file 0600) │     │ client.ts          │    │
   │   │             │     │             │     │                    │    │
   │   │ OAuth?      │     │ {access,    │◀────│ refresh on 401     │    │
   │   │ PAT?        │     │  refresh,   │     │                    │    │
   │   │ neither?    │     │  expires_at}│     │                    │    │
   │   └─────────────┘     └─────────────┘     └────────────────────┘    │
   │         │                                                            │
   │         └─ if neither: trigger OAuth setup (listener + browser)      │
   │                                                                      │
   └──────────────────────────────────────────────────────────────────────┘
            ▲
            │ JSON-RPC via stdin/stdout
            │
   ┌──────────────────┐
   │ MCP client       │  (Claude Code, Cursor, TARS overlay)
   └──────────────────┘
```

**Key boundaries:**

- The token store is a persistent file on disk. The local HTTP listener is transient — it exists only during setup and shuts down once tokens are persisted.
- The auth resolver is the single choke point. All API calls go through it. The existing `apiRequest()` in [src/api/client.ts](../../src/api/client.ts) gets a new "get current Bearer token" helper; the request logic itself is unchanged.
- Browser launching uses platform-native commands (`open` on macOS, `xdg-open` on Linux, `start` on Windows). Failure falls through to printing the URL to stderr.

## Auth source resolution

At server startup, the auth resolver picks the auth source based on this priority:

```
                  Server startup
                        │
                        ▼
              ┌─────────────────────┐
              │ PRODUCTBOARD_       │
              │ AUTH_MODE env var   │
              └──────────┬──────────┘
       "oauth" ◀───────┬─┴───┬─────────▶ "pat"
                       │     │
                       ▼     ▼
                  (skip PAT  (require PAT
                  branch     env var or
                  below)     fail at startup)
                       │     │
                       ▼     ▼
                       │  ┌──────────┐
                       │  │ PAT mode │
                       │  └──────────┘
                       │
                       ▼
              ┌─────────────────────┐
              │ PRODUCTBOARD_       │  ← skipped when AUTH_MODE=oauth
              │ ACCESS_TOKEN env    │
              │ set & non-empty?    │
              └──────────┬──────────┘
                  yes ◀──┴──▶ no
                   │           │
                   ▼           ▼
            ┌──────────┐  ┌─────────────────────┐
            │ PAT mode │  │ tokens.json exists  │
            └──────────┘  │ on disk?            │
                          └──────────┬──────────┘
                              yes ◀──┴──▶ no
                               │          │
                               ▼          ▼
                         ┌─────────┐  ┌──────────────────┐
                         │ OAuth   │  │ First-run setup  │
                         │ mode    │  │ flow             │
                         └─────────┘  └──────────────────┘
```

### Rules and rationale

| Rule | Why |
|---|---|
| `PRODUCTBOARD_AUTH_MODE` overrides everything when set | Lets tars or admins force a mode without editing user `.env` files |
| `PRODUCTBOARD_ACCESS_TOKEN` env var beats OAuth tokens on disk | Back-compat for existing tars deployments + dev workflow + explicit override semantics |
| `tokens.json` on disk is the persistent OAuth default | Once setup ran, the server must not re-prompt on every restart |
| Neither set → setup flow | This is the new "default" state for fresh installs |

### `PRODUCTBOARD_AUTH_MODE` semantics

| Value | Behavior |
|---|---|
| (unset) | Auto — walk the priority tree above |
| `oauth` | Force OAuth. Ignore `PRODUCTBOARD_ACCESS_TOKEN`. If no `tokens.json`, trigger setup |
| `pat` | Force PAT. If `PRODUCTBOARD_ACCESS_TOKEN` missing → exit with clear error |
| anything else | Exit at startup with clear error |

### Hard cutover for stale PATs

When the server is in PAT mode and the first call to Productboard returns HTTP 401, we surface a structured error message instead of a generic auth failure:

```
Productboard API rejected your PAT (HTTP 401). Possible causes:
  • The token was revoked (check with your PB admin).
  • The token was rotated and the new value is not in your env.

To switch to OAuth authentication instead:
  1. Unset PRODUCTBOARD_ACCESS_TOKEN in your environment / config
  2. Restart this MCP server
  3. Complete the browser-based authorization flow that opens

For Dr.Max users on tars: rerun tars-setup.sh to refresh config.
```

This is the recovery path for the eventual Dr.Max migration when a PB admin revokes all PATs in the workspace.

## First-run setup flow

When the auth resolver detects "setup required" (no PAT env var, no `tokens.json`, or `PRODUCTBOARD_AUTH_MODE=oauth` + no tokens), the server kicks off an asynchronous OAuth setup task after responding to the MCP `initialize` handshake.

```
T+0    Server init: registers tools, responds to MCP `initialize` handshake.
T+1    Auth resolver: setup required.
       → background OAuth task starts; tools accept calls but return
         an "auth pending" error until task succeeds.

T+1.1  Generate PKCE pair (code_verifier + code_challenge S256) + state nonce.

T+1.2  Bind localhost listener on port 7779 (configurable):
        ┌─────────────────────────────────────────────────────────┐
        │ GET  /             → scope chooser HTML                 │
        │ POST /start        → builds PB authorize URL + redirect │
        │ GET  /callback     → exchanges code for tokens          │
        └─────────────────────────────────────────────────────────┘
       If port busy → fail with stderr message + tool error.

T+1.3  open http://localhost:7779/    (NOT directly to PB)

T+1.4  Listener serves chooser page:

       ┌────────────────────────────────────────────────────────────┐
       │ Productboard MCP — Choose your access level                │
       │                                                            │
       │ ○ Read only                                                │
       │   Browse and search. Cannot create or modify anything.     │
       │                                                            │
       │ ○ Read + Write                                             │
       │   Browse, search, create, update. Cannot delete.           │
       │                                                            │
       │ ● Full access (recommended)                                │
       │   Includes delete operations. Required for the full MCP    │
       │   tool surface.                                            │
       │                                                            │
       │             [   Authorize with Productboard →   ]          │
       └────────────────────────────────────────────────────────────┘

T+1.5  User clicks → POST /start?level=full|readwrite|read
       Listener builds PB authorize URL with the chosen scope set:

         https://app.productboard.com/oauth2/authorize?
           response_type=code
           &client_id=<embedded Dr.Max client_id, override-able>
           &redirect_uri=http%3A%2F%2Flocalhost%3A7779%2Fcallback
           &state=<random>
           &code_challenge=<derived>
           &code_challenge_method=S256
           &scope=<preset scopes joined by space>

       302-redirects to that URL.

T+2-N  User reviews + clicks "Authorize" in Productboard.

T+N    Productboard redirects back to http://localhost:7779/callback?code=...&state=...

       Listener:
         1. Verifies state matches our nonce (CSRF guard).
         2. Exchanges code for tokens via POST app.productboard.com/oauth2/token
            with grant_type=authorization_code, code, client_id, redirect_uri,
            and code_verifier (PKCE).
         3. Receives {access_token, refresh_token, expires_in,
                       refresh_token_expires_in}.
         4. Atomic write of tokens.json (perms 0600).
         5. Responds 200 with a simple HTML "You can close this tab" page.
         6. Shuts down listener (port freed).

T+N+ε  Background task signals "ready" to auth resolver.
       Subsequent tool calls succeed.
```

### Scope presets

| Preset | Scopes |
|---|---|
| Read only | `entities:read notes:read analytics:read members_pii:read` |
| Read + Write | adds `entities:write notes:write` |
| Full (default) | adds `entities:delete notes:delete` |

If `PRODUCTBOARD_OAUTH_SCOPES` env var is set, the chooser page is skipped and the env var's value is used verbatim.

### Auth-pending tool error

If a tool call arrives before setup completes:

```
Productboard MCP is finishing OAuth setup. A browser should have opened
at http://localhost:7779/ — please complete the authorization there.
The MCP server will pick up the new tokens automatically; retry this
tool call in a few seconds.

If no browser opened: open the URL above manually.
```

### 10-minute timeout

If the setup flow hasn't completed within 10 minutes of starting:

- Listener shuts down (port freed)
- All subsequent tool calls return an error: `OAuth flow timed out after 10 minutes. Restart MCP to retry.`

This protects against the user closing the browser without authorizing, leaving the listener bound forever.

### Configurable parameters

| Env var | Default | Purpose |
|---|---|---|
| `PRODUCTBOARD_OAUTH_CLIENT_ID` | Dr.Max embedded value | Override for non-Dr.Max users |
| `PRODUCTBOARD_OAUTH_CALLBACK_PORT` | `7779` | Override if 7779 conflicts; requires registering the new URL in the OAuth app |
| `PRODUCTBOARD_OAUTH_TOKEN_PATH` | Platform-native cache dir | Override for Docker volumes, multi-tenant tests, etc. |
| `PRODUCTBOARD_OAUTH_SCOPES` | (chooser shown) | Power-user override; bypasses chooser page |
| `PRODUCTBOARD_AUTH_MODE` | (unset = auto) | `oauth` or `pat` to force a mode |

## Token storage and refresh

### Storage location

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/productboard-mcp/tokens.json` |
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/productboard-mcp/tokens.json` |
| Windows | `%APPDATA%\productboard-mcp\tokens.json` |

File permissions on create/write: `0600` (POSIX). On Windows the mode bits are not honored; this is documented as a known limitation.

### File format (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-05-26T10:00:00.000Z",
  "updatedAt": "2026-05-26T11:30:00.000Z",
  "accessToken": "eyJ...",
  "accessTokenExpiresAt": "2026-05-26T12:30:00.000Z",
  "refreshToken": "eyJ...",
  "refreshTokenExpiresAt": "2026-11-22T10:00:00.000Z",
  "scope": "entities:read entities:write entities:delete notes:read notes:write notes:delete analytics:read members_pii:read",
  "clientId": "drmax-default-client-id-or-override",
  "issuer": "https://app.productboard.com"
}
```

- `schemaVersion`: incremented if the file shape changes; lets future versions detect old files
- `clientId`: recorded so the resolver can invalidate tokens when the configured client_id changes (prevents token mix-up across OAuth apps)
- `expires_at` fields: computed at write time from `expires_in` + now

### Refresh strategy

**Proactive (preferred path).** Before each API request, the resolver checks `accessTokenExpiresAt`. If it's within 5 minutes of expiry, refresh first. 5-min buffer absorbs clock skew and long-running requests.

**Reactive (fallback).** If a request returns 401 despite proactive check (token revoked server-side, etc.), refresh once and retry the original request. Second 401 → hard error.

### Refresh details

Productboard rotates refresh tokens on every use, with a 60-minute grace window on the old one. Each refresh therefore writes a new `refresh_token` to disk. The flow must be atomic:

```
1. Re-read tokens.json from disk (concurrency mitigation — see below).
2. POST https://app.productboard.com/oauth2/token
     grant_type=refresh_token
     refresh_token=<current>
     client_id=<embedded or override>
3. Receive new {access_token, refresh_token, expires_in,
                refresh_token_expires_in}.
4. Atomic write:
     fs.writeFileSync("tokens.json.tmp", payload, {mode: 0o600})
     fs.renameSync("tokens.json.tmp", "tokens.json")
   (POSIX rename is atomic — readers always see complete file.)
5. Update in-memory cache.
```

Refresh HTTP errors retry with exponential backoff (3 attempts: ~1s / 4s / 16s). After exhaustion → hard error.

### Refresh expiry / revocation (hard error)

When refresh returns 400 `invalid_grant` (token expired past 180 days, or revoked):

```
OAuth refresh token has expired or was revoked. The MCP server cannot
reauthorize automatically without user interaction.

To recover:
  1. Restart this MCP server (in Claude Code: /mcp → reconnect)
  2. A new browser-based authorization flow will start automatically
  3. After you authorize, tools will work again

If this happens unexpectedly, your tokens may have been revoked by
a workspace admin. Contact them.
```

The server stays running but all subsequent tool calls return this message until the user restarts.

### Concurrent access mitigation

Two MCP server processes (e.g., Claude Code + Cursor running side by side for the same user) may both read the same `tokens.json`. To handle the race where both try to refresh from the same `refresh_token`:

- Before any refresh, re-read `tokens.json` from disk and compare its `accessTokenExpiresAt` against the in-memory copy. If disk has a fresher timestamp, adopt it and skip refresh (another process already refreshed).
- Productboard's 60-minute grace window on rotated refresh tokens covers the remaining races without explicit file locking.

File locking (`flock`, lock files) is intentionally not implemented in v1 — the two-phase read covers ~99% of contention and avoids new dependencies / edge cases.

## Error handling

### Setup-time failures

| Failure | Detection | Response |
|---|---|---|
| Port 7779 (or custom) is in use | `EADDRINUSE` on `listen()` | Stderr + tool error: `OAuth callback port 7779 is in use. Free it or set PRODUCTBOARD_OAUTH_CALLBACK_PORT=<n> (and add http://localhost:<n>/callback to your PB OAuth app's redirect URIs).` |
| Browser fails to spawn | Child process error | Stderr + tool error: `Browser did not open automatically. Open this URL manually to authorize: <URL>` |
| User closes browser without authorizing | (no event) | 10-minute timeout fires; listener shuts down; tool error: `OAuth flow timed out after 10 minutes. Restart MCP to retry.` |
| Productboard returns `error=access_denied` | Callback query params | Listener shuts down; tool error: `Productboard authorization was denied. Restart MCP to retry, or set PRODUCTBOARD_ACCESS_TOKEN to use PAT instead.` |
| PB returns other `error=<x>` | Callback query params | Stderr logs full error + description; tool error includes PB error code |
| Token exchange fails (HTTP 400/500) | Response check | Stderr logs PB response body; tool error: `Token exchange failed: <PB error>. This usually means client_id or redirect_uri mismatch.` |
| State nonce mismatch | nonce compare | Listener responds 400 to browser ("Authorization state mismatch — possible CSRF. Aborting."); tool error |
| Filesystem write fails | `fs.writeFile` throws | Tool error explaining path + fs error; tokens not persisted |

### Runtime auth failures

| Failure | Detection | Response |
|---|---|---|
| Access token expired (proactive) | `expires_at` < now + 5min | Refresh first, then make request. No user-visible error. |
| 401 from PB API (reactive) | HTTP 401 | One refresh + retry. Second 401 → hard error. |
| Refresh `invalid_grant` | 400 with that error | Hard error (see above). User must restart MCP. |
| Refresh OK but disk write fails | fs error after PB success | Stderr warning: `Tokens refreshed but could not be persisted: <err>. Restart MCP and you will need to re-authorize.` In-memory tokens still valid for this session. |
| PAT 401 (admin revoked it) | HTTP 401 in PAT mode | Structured "switch to OAuth" hint (see Auth resolution section) |
| Productboard 429 | HTTP 429 | Existing retry-on-429 logic in `client.ts`. No change. |
| Productboard 5xx | HTTP 5xx | Existing `ProductboardApiError` flow. No change. |
| Network error | fetch throws | Existing error propagation. No change. |

### Configuration errors (caught at startup)

| Failure | Detection | Response |
|---|---|---|
| Unknown `PRODUCTBOARD_AUTH_MODE` value | Startup validation | Server exit with clear stderr |
| `AUTH_MODE=pat` but no `PRODUCTBOARD_ACCESS_TOKEN` | Auth resolver | Server exit: `PRODUCTBOARD_AUTH_MODE=pat requires PRODUCTBOARD_ACCESS_TOKEN to be set.` |
| `PRODUCTBOARD_OAUTH_CALLBACK_PORT` not in 1024-65535 | Startup validation | Server exit with clear message |
| `PRODUCTBOARD_OAUTH_TOKEN_PATH` parent dir missing | First write | Auto-create with `0700` perms; no error |
| Embedded Dr.Max `client_id` missing in build (regression) | Auth resolver | Server exit: `OAuth client_id missing — this is a packaging bug. Set PRODUCTBOARD_OAUTH_CLIENT_ID to override or report at github.com/drmaxbdc/productboard-mcp/issues.` |

### Structured error response shape

Auth-related tool errors carry optional discriminator fields so LLM callers can branch programmatically:

```ts
toolError(new Error(message), {
  authError: true,
  authStatus: "pending" | "expired" | "denied" | "config_invalid" | "scope_insufficient",
  remediation: "restart_mcp" | "set_env_var" | "manual_url_open" | "rerun_setup",
});
```

### Insufficient scope errors

When the user picked Read-only or Read+Write and then triggers a tool requiring a higher scope (e.g., `delete_entity`), PB returns 403. The server surfaces:

```
This operation requires the 'entities:delete' OAuth scope, which was
not granted during setup. You chose "Read + Write" access.

To enable: delete <tokens.json path> and restart MCP — you'll see
the scope chooser again. Or set PRODUCTBOARD_OAUTH_SCOPES env var with
the needed scopes and restart.
```

We do not gate tool registration on scopes in v1 — all tools remain registered, and scope failures are clear per-call errors.

## OAuth scopes — full table

| Scope | Tool categories covered |
|---|---|
| `entities:read` | `list_entities`, `get_entity`, `search_entities`, `get_entity_configurations`, `get_entity_relationships`, all entity reads |
| `entities:write` | `create_entity`, `update_entity`, `create_entity_relationship`, `set_entity_parent` |
| `entities:delete` | `delete_entity`, `delete_entity_relationship` |
| `notes:read` | `list_notes`, `list_all_notes`, `get_note`, `get_note_v1`, `search_notes`, `resolve_note`, `get_note_configurations`, `get_note_relationships` |
| `notes:write` | `create_note`, `update_note`, `add_note_comment` (V1 fallback), `create_note_relationship`, `set_note_customer` |
| `notes:delete` | `delete_note`, `delete_note_relationship` |
| `analytics:read` | `get_member_activities` |
| `members_pii:read` | `list_members`, `get_member`, `ownerEmail` / `creatorEmail` filters in note/entity tools |

## Code organization

New files (no changes to existing `tools/*.ts` modules):

```
src/
  auth/
    resolver.ts       # priority tree, picks PAT or OAuth at startup
    oauth-setup.ts    # listener, chooser HTML, browser launch, code exchange
    oauth-refresh.ts  # proactive + reactive refresh logic
    token-store.ts    # tokens.json read/write/atomic-rename
    types.ts          # AuthMode, ScopePreset, TokenFile, etc.
  api/
    client.ts         # MODIFIED: imports auth resolver instead of reading env var directly
```

`apiRequest()` in `client.ts` becomes a thin wrapper that asks the resolver for a current Bearer token (refresh-on-demand) and applies the existing retry/error normalization. The auth implementation is fully isolated from tool modules.

## Version impact

This is a **minor** version bump: **2.0.0 → 2.1.0**.

Rationale:
- PAT path remains fully functional via the priority tree
- No tool name, response shape, or parameter changes
- New env vars are all optional
- Existing deployments require zero changes

### Files touched

| File | Change |
|---|---|
| `package.json` | version → `2.1.0` |
| `src/server.ts` | server `version` → `"2.1.0"` |
| `src/auth/*.ts` | new directory |
| `src/api/client.ts` | call auth resolver instead of reading env var |
| `README.md` | add Authentication section: OAuth (default) + PAT (fallback); existing PAT docs preserved |
| `CHANGELOG.md` | new `## [2.1.0]` block: Added OAuth, internal refactor of `apiRequest` |
| `CLAUDE.md` | update Authentication section: OAuth flow architecture, edge cases |

### New dependencies

Minimal. The OAuth flow needs:

- A local HTTP listener: use Node's built-in `http` module (no dep)
- PKCE: implement with Node's built-in `crypto` (no dep — 10 lines of code)
- Browser launch: shell out via `child_process.spawn` using `open` / `xdg-open` / `start` (no dep)

No new npm dependencies are required for v1.

## Tars integration (separate workstream)

After publishing 2.1.0, the following changes ship to `~/tars` (separate repo, separate PR):

1. **`roles.json`**: bump `@drmaxbdc/productboard-mcp@2.0.0` → `@2.1.0`.
2. **`roles.json` productboard entry**: change `severity` of the `PRODUCTBOARD_ACCESS_TOKEN` prompt from `"warning"` to `"info"`, update `instructions`:
   ```
   Optional. Leave blank to use OAuth (recommended) — the MCP will open
   a browser at first start.
   ```
3. **No changes to `tars-setup.sh` `ENV_KEY_MIGRATIONS`** (PAT key remains as-is).
4. **Phase 2 (future, after OAuth proven in production):** tars adds `PRODUCTBOARD_AUTH_MODE=oauth` to the productboard env block in `roles.json` → forces OAuth for all tars users regardless of any lingering PAT in their `.env`.
5. **Phase 3 (admin action, after Phase 2 has settled):** PB workspace admin revokes all PATs in workspace settings. Any non-tars users still on PAT hit the structured "switch to OAuth" error.

## Out of scope for v1

These are deferred to later iterations or accepted as known limitations:

- **OS keychain integration.** Tokens live in a plain file with 0600 perms. macOS Keychain / Windows Credential Manager / libsecret would be more secure but require platform-native dependencies. Defer to v2 if real demand emerges.
- **File locking for concurrent refresh.** The two-phase read pattern handles realistic contention. `flock` / lock files defer to later if production logs show contention races.
- **Server-side tool gating based on scope.** If user picks Read-only, all delete tools are still registered and fail at PB on call. A future version could inspect granted scopes (visible in token response) and hide incompatible tools.
- **Polling `tokens.json` for cross-process token updates.** When one MCP instance refreshes, peers still hold the previous access token until their own refresh trigger. Acceptable given short access token lifetimes.
- **`delete_tokens` admin tool** to force re-auth without manually removing `tokens.json`. Could be added if support tickets demand it.
- **Multiple OAuth applications per server instance.** v1 supports one `client_id` at a time (default Dr.Max or env override). Multi-tenant scenarios would need a richer config schema.
- **Refresh window > 60 minutes resilience.** If PB ever changes the refresh-token grace window, our concurrent-access mitigation may need adjustment. No code change planned in v1.

## Security considerations

- **Tokens at rest.** File perms `0600` limit reads to the file owner on POSIX. Windows lacks an equivalent — documented limitation.
- **client_id leak.** The Dr.Max default `client_id` is embedded in the npm package and therefore public. This is consistent with the OAuth Public Client model (PKCE provides the auth-code-interception protection that the `client_secret` would otherwise provide). No `client_secret` is shipped.
- **CSRF protection.** State parameter is a random nonce per setup, verified on callback.
- **PKCE.** S256 code challenge protects against authorization code interception on the redirect.
- **HTTPS on PB endpoints.** All requests to `app.productboard.com/oauth2/*` go over HTTPS. No mixed-content risks.
- **Loopback listener.** The local HTTP listener binds to `127.0.0.1` only (not `0.0.0.0`), so other hosts on the network can't intercept the OAuth callback.
- **stderr leak risk.** When errors echo URLs or token-exchange responses to stderr, redact `access_token` / `refresh_token` / `code` query params before logging. The existing PAT leak in error messages (observed during smoke testing) must be fixed at the `apiRequest` level — that hardening item is tracked separately but should land in the same release.

## References

- Productboard OAuth Authorization Code reference: [https://developer.productboard.com/reference/oauth-authorization-code.md](https://developer.productboard.com/reference/oauth-authorization-code.md)
- Productboard OAuth app registration: [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications)
- Productboard OAuth Public Client (Dynamic Registration) reference: [https://developer.productboard.com/reference/oauth-public-client.md](https://developer.productboard.com/reference/oauth-public-client.md)
- RFC 7591 (Dynamic Client Registration): [https://datatracker.ietf.org/doc/html/rfc7591](https://datatracker.ietf.org/doc/html/rfc7591)
- RFC 7636 (PKCE): [https://datatracker.ietf.org/doc/html/rfc7636](https://datatracker.ietf.org/doc/html/rfc7636)
- RFC 8252 (OAuth 2.0 for Native Apps): [https://datatracker.ietf.org/doc/html/rfc8252](https://datatracker.ietf.org/doc/html/rfc8252) (loopback redirect rationale)

---

## Addendum (2026-05-27): pivot to Public Client Self-registered

After the initial design landed and implementation began, the user identified a third OAuth option in Productboard's UI we missed in initial research: **Public Client Self-registered**. PB's UI text explicitly lists "MCP clients" as the target audience for this option.

### What it is

[Productboard Public Client OAuth](https://developer.productboard.com/reference/oauth-public-client.md) implements RFC 7591 Dynamic Client Registration on top of the same Authorization Code + PKCE flow this design uses. The MCP calls `POST https://app.productboard.com/oauth2/register` once at install time with `{redirect_uris, client_name}` and receives a fresh `client_id` issued specifically for that installation. All subsequent endpoints (`/oauth2/authorize`, `/oauth2/token`), PKCE behavior, scopes, refresh-token TTL/rotation, and consent screen UX are identical to the regular Authorization Code flow.

### Why we pivot

The pivot eliminates the hybrid "Dr.Max-registered default + env-var override for outsiders" complexity from the original design. Every consumer of the npm package self-registers a fresh client at first run, scoped to their own PB workspace:

- No pre-publish OAuth app registration step required (the `DEFAULT_OAUTH_CLIENT_ID = ""` placeholder goes away).
- Package is self-contained for any PB workspace consumer, not just Dr.Max users.
- Better security posture — each install has an independently-revocable grant in PB.
- `PRODUCTBOARD_OAUTH_CLIENT_ID` env var remains as an advanced override for orgs that pre-register a custom-branded OAuth app, but it's optional.

### What changes in implementation

Most of the implementation is reused. Specifically the PKCE generation, HTTP listener, chooser HTML, code-for-token exchange, refresh logic, and token store are all unchanged.

New code:

- **`src/auth/oauth-register.ts`** (~80 LOC) — implements `registerClient({callbackPort, clientName})` returning `{clientId}`. Persists a registration record to a sibling file `registration.json` alongside `tokens.json` so registration survives token-store deletion (a user deleting `tokens.json` to re-auth shouldn't burn one of PB's daily registration quota slots).
- Helpers in `oauth-register.ts`: `readRegistration()`, `writeRegistration()`, `getRegistrationPath()` — same platform-native cache directory as `tokens.json`.

Modified code:

- **`src/auth/resolver.ts`** — `makeOauthResolution()` no longer calls a sync `resolveClientId()`. Instead, the background IIFE first calls a new async `resolveOrRegisterClient(callbackPort)` helper that resolves the client_id from (a) `PRODUCTBOARD_OAUTH_CLIENT_ID` env override, (b) loaded `registration.json`, or (c) fresh `registerClient()`. Then proceeds to load `tokens.json` (matching by clientId) or trigger `performOAuthSetup()`.
- **`src/auth/types.ts`** — drop `DEFAULT_OAUTH_CLIENT_ID` (no default needed); add `RegistrationFile` interface with `{schemaVersion, clientId, clientName, redirectUri, registeredAt}`.

### Rate limit awareness

PB rate-limits registration to 5/minute and 50/day per remote IP. The implementation persists the registered `client_id` immediately, so a stable install only hits the endpoint once. Concurrent registrations from two MCP processes for the same user are an edge case — both succeed (independent client_ids); the file is last-write-wins. Either client_id remains valid in PB independently. Worst case: one of the two MCP instances has a "ghost" registration that the other one's `registration.json` doesn't reference. Harmless.

### Failure mode if PB rejects a stored client_id

If PB ever rejects the stored `client_id` (the user manually revoked the app in PB admin, the registration aged out, etc.), the refresh or token-exchange will return an OAuth error. The resolver detects this kind of error and deletes `registration.json` + `tokens.json`, then re-runs the full register-then-setup flow on the next request. Not implemented in v1's first iteration if not strictly needed — a user can manually delete both files to recover. Added if smoke testing reveals it's necessary.

### Migration from the pre-pivot design

The pre-pivot implementation (commits `259c25c` through `414978c` on this branch) already handles 90% of what's needed. The pivot is additive: insert a registration step before the existing setup flow, and remove the `DEFAULT_OAUTH_CLIENT_ID` empty-check path. Roughly two additional tasks (oauth-register module + resolver refactor), plus a docs revision.

The body of this design document above describes the pre-pivot architecture. The implementation reflects the pivoted architecture per the addendum. Where the two disagree, the addendum wins.
