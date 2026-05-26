# OAuth Manual Registration Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a documented manual-OAuth-registration path to `@drmaxbdc/productboard-mcp` as the de-facto primary OAuth flow until Productboard's broken `POST /oauth2/register` endpoint is fixed. Ship as `v2.0.2`.

**Architecture:** Keep all existing OAuth code (PKCE listener, refresh, token store, chooser HTML) unchanged. Add (a) a Dr.Max-registered `client_id` baked into source as the default, (b) a clear runtime error when self-registration hits the upstream 404 with steps to use manual registration instead, and (c) prominent documentation of the manual path. Self-registration code stays in place so it works automatically the day PB fixes the endpoint.

**Tech Stack:** TypeScript ESM, Node ≥ 18. No new dependencies. No tests (per CLAUDE.md project policy).

---

## Background — what we know

**Discovered during v2.0.1 smoke test (2026-05-26):**

- `POST https://app.productboard.com/oauth2/register` returns **HTTP 404** with body `{"ok":false,"error":"Not found"}` via Kong gateway (`via: 1.1 kong/3.9.1`). No backend service is wired to handle POST on that route.
- `GET` on the same URL returns 200 (web UI page for manual registration).
- `POST /oauth2/token`, `GET /oauth2/authorize`, and all other documented OAuth endpoints work normally.
- All variants tried: `app.productboard.com`, `api.productboard.com`, `/api/oauth2/register`, `/oauth/register`, `/oauth2/clients`, `/v2/oauth2/register` — all 404.
- `POST /oauth2/applications` returns 422 (endpoint exists but expects different payload — that's the manual web UI, not an API).
- Documentation at [oauth-public-client.md](https://developer.productboard.com/reference/oauth-public-client.md) describes the endpoint and gives a working-looking curl example. Either the docs are aspirational or the endpoint regressed.
- User has filed support ticket with Productboard. **Until they confirm and ship a fix, dynamic registration is unusable.**

**What still works in v2.0.1:**

- PAT path: byte-for-byte back-compat with v2.0.0.
- The OAuth Authorization Code + PKCE flow (once a `client_id` exists): the chooser page, browser launch, listener, code exchange at `/oauth2/token`, token persistence, refresh, all verified end-to-end via direct curl + code review.

**What doesn't work in v2.0.1:**

- First-run OAuth when no `PRODUCTBOARD_OAUTH_CLIENT_ID` env override is set: `resolveOrRegisterClient` falls into `registerClient()` → 404 → setup fails with a confusing error.

---

## Goal of this plan

1. **Ship a v2.0.2 hotfix** that makes OAuth usable today via manual registration, while keeping the dynamic-registration code intact for when PB fixes it.
2. **Embed a Dr.Max-registered `client_id` as the default** so Dr.Max users (and any other consumer who's happy to use that registration) need zero config beyond the OAuth flow.
3. **Improve the 404 error message** so non-Dr.Max users see actionable steps (register your own app, set the env var) instead of an opaque "registration rejected" message.
4. **Document the manual registration path prominently** in README and CLAUDE.md.
5. **Mark self-registration as "currently broken upstream"** in the spec/CHANGELOG with a tracking note.

## File structure

| Path | Status | Responsibility for this plan |
|---|---|---|
| `src/auth/types.ts` | modify | Re-add `DEFAULT_OAUTH_CLIENT_ID` constant with the Dr.Max-registered value the user obtains from PB admin UI. |
| `src/auth/oauth-register.ts` | modify | On HTTP 404 from `/oauth2/register`, throw a structured `AuthError` with `kind: "config_invalid"`, `remediation: "set_env_var"` and a long message giving the manual-registration steps. Other error paths unchanged. Keep the registration code itself in place. |
| `src/auth/resolver.ts` | modify | Update `resolveOrRegisterClient` priority: env override → stored registration → `DEFAULT_OAUTH_CLIENT_ID` → tokens.json recovery → fresh register (which will now likely 404 with the new message). |
| `src/auth/oauth-setup.ts` | unchanged | No changes — the PKCE/listener/exchange flow doesn't care how the `client_id` was obtained. |
| `src/auth/token-store.ts` | unchanged | No changes. |
| `src/auth/oauth-refresh.ts` | unchanged | No changes. |
| `src/api/client.ts` | unchanged | No changes — auth resolution is opaque to the HTTP layer. |
| `package.json` | modify | Bump version to `2.0.2`. |
| `src/server.ts` | modify | Bump server version to `"2.0.2"`. |
| `CHANGELOG.md` | modify | Add `## [2.0.2] — 2026-05-27` block describing the manual-registration default, the embedded Dr.Max `client_id`, the documented upstream `/oauth2/register` bug, and what changes for callers. |
| `README.md` | modify | Restructure the OAuth section: lead with the "out-of-the-box for Dr.Max users via embedded client_id" path; document the manual-registration path for non-Dr.Max consumers as the primary alternative; note that dynamic self-registration is documented but currently 404 upstream and the code retries on next start. |
| `CLAUDE.md` | modify | Note the upstream `/oauth2/register` 404 issue; explain the priority of `DEFAULT_OAUTH_CLIENT_ID` vs env override vs self-registration; mention how to re-enable self-registration testing once PB fixes it. |
| `docs/superpowers/specs/2026-05-26-oauth-authentication-design.md` | modify | Add a second addendum documenting the upstream bug, the manual-registration fallback design, and the conditions for re-enabling dynamic registration. |

## Prerequisite (user action, before starting any task)

The user (Jiří) registers an OAuth app in Productboard's admin UI at [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications) using the form values documented in the conversation that produced this plan. The user captures the issued `client_id` and provides it to the implementer at the start of the session. **Do not start Task 1 until the user has the `client_id` ready.**

Suggested form values (lock in with user before submitting):

- Name: `Productboard MCP` or `Productboard MCP — Dr.Max`
- Redirect URI: `http://127.0.0.1:7779/callback` (and if PB UI accepts multiples, also `http://localhost:7779/callback`)
- Developer name: Dr.Max BDC / Jiří Šubrt
- Developer Email: `jiri.subrt@drmax.eu`
- Developer URL: `https://github.com/drmaxbdc/productboard-mcp`
- Tagline: "MCP server exposing Productboard API to Claude Code, Cursor, and other AI tools"
- Description: "Open-source MCP server for the Productboard API v2. Used by Dr.Max teams via the tars overlay and available on npm as @drmaxbdc/productboard-mcp. Source: github.com/drmaxbdc/productboard-mcp"
- Icon: Dr.Max BDC logo if available, else default
- API V1 Scopes: **none** (V1 sunsets 2026-07-08; OAuth was never wired to V1)
- API V2 Scopes: **all eight** — `entities:read`, `entities:write`, `entities:delete`, `notes:read`, `notes:write`, `notes:delete`, `analytics:read`, `members_pii:read`

---

## Task 1 — Embed the Dr.Max `client_id` default

**Files:**
- Modify: `src/auth/types.ts`

- [ ] **Step 1: Add the constant**

Re-add `DEFAULT_OAUTH_CLIENT_ID` to [src/auth/types.ts](../../src/auth/types.ts). Insert it after `REFRESH_BUFFER_MS` (the constant location it occupied before commit `0f3f2c3` removed it). The exact value comes from the user — replace the placeholder string with the actual `client_id` returned by PB's admin UI registration.

```ts
/**
 * Dr.Max-registered OAuth Public Client `client_id`, obtained via manual
 * registration at https://app.productboard.com/oauth2/applications. Used as
 * the default when the consumer does not set PRODUCTBOARD_OAUTH_CLIENT_ID
 * and registration.json does not exist yet.
 *
 * Non-Dr.Max consumers can override with their own OAuth app's client_id
 * via the PRODUCTBOARD_OAUTH_CLIENT_ID env var.
 *
 * Dynamic Client Registration (RFC 7591) at /oauth2/register is documented
 * by Productboard but currently returns 404 in production (Kong gateway
 * has no backend wired). Will be re-checked when PB confirms a fix; the
 * fallback to /oauth2/register in resolver.ts still runs and will start
 * working automatically the day the endpoint comes online.
 */
export const DEFAULT_OAUTH_CLIENT_ID = "REPLACE_WITH_DRMAX_CLIENT_ID_FROM_PB_ADMIN_UI";
```

- [ ] **Step 2: Build to verify**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/auth/types.ts
git commit -m "Re-add DEFAULT_OAUTH_CLIENT_ID for manual-registration fallback

Productboard's POST /oauth2/register endpoint returns 404 in production
(documented but not deployed). To make OAuth usable in 2.0.2 while
waiting for an upstream fix, re-introduce the Dr.Max-registered
client_id as a baked-in default. Non-Dr.Max consumers continue to
override via PRODUCTBOARD_OAUTH_CLIENT_ID env var.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Better error message on `POST /oauth2/register` 404

**Files:**
- Modify: `src/auth/oauth-register.ts`

- [ ] **Step 1: Locate the 4xx-handling block**

In `registerClient()`, find the non-429 4xx branch (around the point that throws an `AuthError` with the response body). Read the file to confirm exact lines.

- [ ] **Step 2: Add a 404-specific message**

Before the generic 4xx throw, add a check that detects `response.status === 404` and produces a long, actionable message:

```ts
if (response.status === 404) {
  let rawBody = "";
  try { rawBody = await response.text(); } catch { /* ignore */ }
  throw createAuthError(
    "config_invalid",
    `Productboard's Dynamic Client Registration endpoint returned HTTP 404 ` +
      `(POST ${REGISTRATION_URL}). The endpoint is documented but appears ` +
      `to be currently unavailable in production.\n\n` +
      `Workaround: register your OAuth app manually and provide the client_id ` +
      `via the PRODUCTBOARD_OAUTH_CLIENT_ID env var.\n\n` +
      `Manual registration steps:\n` +
      `  1. Open https://app.productboard.com/oauth2/applications in your ` +
      `browser (must be a Productboard admin).\n` +
      `  2. Fill in the form. Required Redirect URI: ` +
      `http://127.0.0.1:7779/callback (matches the MCP's default callback ` +
      `port; if you set PRODUCTBOARD_OAUTH_CALLBACK_PORT to a different ` +
      `value, use that port instead).\n` +
      `  3. Pick the V2 scopes your team needs (all 8 for full functionality: ` +
      `entities:read/write/delete, notes:read/write/delete, analytics:read, ` +
      `members_pii:read). Leave V1 scopes empty.\n` +
      `  4. After submission, copy the issued client_id and export it:\n` +
      `       export PRODUCTBOARD_OAUTH_CLIENT_ID='<your-client-id>'\n` +
      `  5. Restart this MCP server.\n\n` +
      `Dr.Max users on tars do not need to do this — tars provides the ` +
      `embedded Dr.Max client_id via roles.json (when bumped to 2.0.2+).\n\n` +
      `Raw upstream response body: ${rawBody || "(empty)"}`,
    "set_env_var"
  );
}
```

(Adjust formatting to match the surrounding code style. Keep all other error branches unchanged.)

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/auth/oauth-register.ts
git commit -m "Surface actionable error when /oauth2/register returns 404

Productboard's Dynamic Client Registration endpoint returns 404 in
production. Previously this surfaced as a generic config_invalid
error with the PB response body. Now produces a long, actionable
message with the exact manual-registration steps (URL, required
redirect URI, scopes to select, env var to set, restart command).

The error still uses kind: 'config_invalid' and remediation:
'set_env_var' so downstream consumers' error-handling logic is
unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Resolver priority: embedded default before fresh registration

**Files:**
- Modify: `src/auth/resolver.ts`

- [ ] **Step 1: Update imports**

Add `DEFAULT_OAUTH_CLIENT_ID` to the import from `./types.js`.

- [ ] **Step 2: Update `resolveOrRegisterClient` priority order**

Current order (after v2.0.1):

```
1. PRODUCTBOARD_OAUTH_CLIENT_ID env override
2. readRegistration() from registration.json
3. Recovery: clientId from tokens.json
4. Fresh registerClient()
```

New order for v2.0.2:

```
1. PRODUCTBOARD_OAUTH_CLIENT_ID env override
2. readRegistration() from registration.json
3. Recovery: clientId from tokens.json
4. DEFAULT_OAUTH_CLIENT_ID (if non-empty, non-placeholder)
5. Fresh registerClient() — currently 404 upstream, surfaces the manual-registration message
```

Replace the trailing `registerClient(...)` block with a check for the embedded default first:

```ts
// 4. Embedded Dr.Max default (the manual-registration fallback path used
//    while Productboard's /oauth2/register endpoint is 404 in production).
const PLACEHOLDER = "REPLACE_WITH_DRMAX_CLIENT_ID_FROM_PB_ADMIN_UI";
if (DEFAULT_OAUTH_CLIENT_ID && DEFAULT_OAUTH_CLIENT_ID !== PLACEHOLDER) {
  process.stderr.write(
    `[productboard-mcp] No registration.json and no client_id override; ` +
      `using embedded Dr.Max client_id.\n`
  );
  // Persist this as the chosen client_id so the next start finds it
  // in registration.json without re-checking the embedded default.
  try {
    await writeRegistration({
      schemaVersion: 1,
      clientId: DEFAULT_OAUTH_CLIENT_ID,
      clientName: "Productboard MCP (embedded default)",
      redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
      registeredAt: new Date().toISOString(),
      issuer: "https://app.productboard.com",
    });
  } catch (writeErr) {
    process.stderr.write(
      `[productboard-mcp] Could not persist embedded client_id to ` +
        `registration.json: ${(writeErr as Error).message}\n`
    );
  }
  return DEFAULT_OAUTH_CLIENT_ID;
}

// 5. Last resort — try fresh registerClient(). This will 404 on Productboard
//    until the upstream endpoint is fixed; the error includes manual-registration
//    instructions.
process.stderr.write(
  `[productboard-mcp] No registration.json found. Self-registering OAuth public client with Productboard…\n`
);
const registered = await registerClient({
  callbackPort,
  clientName: "Productboard MCP",
});
process.stderr.write(
  `[productboard-mcp] Registered as public client_id=${registered.clientId}.\n`
);
return registered.clientId;
```

The check against `PLACEHOLDER` lets the code compile and pass `npm run build` even if Task 1 left the placeholder in place. As soon as Task 1's commit replaces the placeholder with a real `client_id`, step 4 kicks in.

- [ ] **Step 3: Build to verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/auth/resolver.ts
git commit -m "Add DEFAULT_OAUTH_CLIENT_ID to resolver priority chain

resolveOrRegisterClient now checks DEFAULT_OAUTH_CLIENT_ID after the
disk-recovery path and before falling through to the (currently 404
upstream) /oauth2/register call. When the embedded default is used,
the resulting client_id is persisted to registration.json so future
starts find it there directly without re-running the chain.

Guards against the literal PLACEHOLDER string so the file compiles
before/after Task 1 fills in the real client_id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Bump version + update CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `src/server.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump package.json**

```json
"version": "2.0.2",
```

- [ ] **Step 2: Bump server.ts**

```ts
version: "2.0.2",
```

- [ ] **Step 3: Add CHANGELOG entry**

Insert immediately after the file header and before `## [2.0.1] — 2026-05-26`:

```markdown
## [2.0.2] — 2026-05-27

Hotfix: makes OAuth usable today by embedding a Dr.Max-registered `client_id` as the default, working around an upstream Productboard bug in `POST /oauth2/register` that returns HTTP 404 in production. The dynamic-registration code path is unchanged and will start working automatically the day Productboard fixes the endpoint.

### Added

- **Embedded `DEFAULT_OAUTH_CLIENT_ID`** in `src/auth/types.ts` pointing at Dr.Max's OAuth application registered manually at [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications). Used as the default when no `PRODUCTBOARD_OAUTH_CLIENT_ID` env override and no stored `registration.json` exist.
- **Resolver priority chain extended** to check `DEFAULT_OAUTH_CLIENT_ID` after disk-recovery and before falling back to dynamic registration. The chosen `client_id` is persisted to `registration.json` so subsequent starts skip the chain.

### Changed

- **`registerClient()` 404 handling** now surfaces a long, actionable message: how to register an OAuth app manually in PB admin UI, what redirect URI to use, what scopes to pick, and which env var to export. Replaces the previous generic config_invalid error that exposed only the upstream response body.

### Known issues (upstream)

- **Productboard's Dynamic Client Registration endpoint (`POST /oauth2/register`) returns HTTP 404** in production (Kong gateway, no backend wired). The endpoint is documented at [oauth-public-client.md](https://developer.productboard.com/reference/oauth-public-client.md). A support ticket has been filed. When upstream resolves, this MCP will use dynamic registration automatically — no code change needed.

### Migration notes for callers

- **Nothing breaks for PAT users.** PAT mode is unaffected.
- **Dr.Max users on tars:** after `roles.json` is bumped to 2.0.2, OAuth setup works out of the box (embedded Dr.Max client_id, then chooser, then PB consent, then tokens persisted).
- **Non-Dr.Max consumers:** must register their own OAuth app in PB admin UI and set `PRODUCTBOARD_OAUTH_CLIENT_ID` env var. The error message that fires when no override is set walks them through the steps.

```

- [ ] **Step 4: Build to verify**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add package.json src/server.ts CHANGELOG.md
git commit -m "Bump to 2.0.2; document the manual-registration hotfix

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Restructure the OAuth section**

Find the `## Authentication` → `### OAuth 2.0 (recommended)` subsection. Replace its body with the following content. (Keep the heading itself, keep the `### Personal Access Token (PAT, fallback)` subsection below it unchanged.)

```markdown
When neither `PRODUCTBOARD_ACCESS_TOKEN` nor a stored OAuth state exists, the MCP server runs the Productboard OAuth Authorization Code flow with PKCE at first start. The resulting access + refresh tokens are persisted to a platform-native cache directory and refreshed automatically.

Each MCP installation needs an OAuth `client_id` to drive the flow. Three sources, checked in this order:

1. **`PRODUCTBOARD_OAUTH_CLIENT_ID` env var** — explicit per-consumer override (see below).
2. **Embedded Dr.Max default `client_id`** — baked into the package at build time. Dr.Max users get OAuth working out of the box with zero config; non-Dr.Max consumers should override (the Dr.Max app's consent screen says "Dr.Max BDC", which is confusing for unrelated workspaces).
3. **Dynamic Client Registration (`POST /oauth2/register`)** — documented at [developer.productboard.com/reference/oauth-public-client](https://developer.productboard.com/reference/oauth-public-client.md). **Currently returns HTTP 404 in production** — known upstream bug. The code still attempts it as a last resort; if/when Productboard fixes the endpoint, this becomes the zero-config path for any consumer.

Storage locations:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/productboard-mcp/{tokens.json, registration.json}` |
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/productboard-mcp/{tokens.json, registration.json}` |
| Windows | `%APPDATA%\productboard-mcp\{tokens.json, registration.json}` |

Tokens are written with permissions `0600` (POSIX). Refresh is automatic — access tokens are renewed 5 minutes before expiry, and refresh tokens (180-day validity) rotate on every use.

If you need to start setup over (change scope, switch to a different PB workspace, etc.), delete `tokens.json` and restart the MCP. To also force a new `client_id` resolution, delete `registration.json` as well.

#### Registering your own OAuth app (non-Dr.Max consumers)

Until Productboard's Dynamic Client Registration endpoint comes online, non-Dr.Max workspaces need a manually registered OAuth app:

1. Sign in to Productboard as an admin and open [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications).
2. Click **New OAuth application** and pick **Public Client Self-registered**.
3. Fill in the form. Critical fields:
   - **Redirect URI:** `http://127.0.0.1:7779/callback`. If you change `PRODUCTBOARD_OAUTH_CALLBACK_PORT`, also re-register the matching URL here.
   - **API V2 Scopes:** check whichever subset your team needs. For the full MCP tool surface check all 8: `entities:read`, `entities:write`, `entities:delete`, `notes:read`, `notes:write`, `notes:delete`, `analytics:read`, `members_pii:read`.
   - **API V1 Scopes:** leave empty (V1 sunsets 2026-07-08; OAuth was never wired to V1).
4. Save and copy the issued `client_id`.
5. Set the env var and restart:

   ```bash
   export PRODUCTBOARD_OAUTH_CLIENT_ID='paste-your-client-id-here'
   ```

#### Optional env vars

| Env var | Default | Purpose |
| --- | --- | --- |
| `PRODUCTBOARD_AUTH_MODE` | (unset = auto) | Set to `oauth` to force OAuth even if `PRODUCTBOARD_ACCESS_TOKEN` is set; set to `pat` to require PAT (good for CI). |
| `PRODUCTBOARD_OAUTH_CLIENT_ID` | (embedded Dr.Max) | Your own OAuth app's client_id. Required for non-Dr.Max consumers until Productboard's dynamic registration endpoint works. |
| `PRODUCTBOARD_OAUTH_CALLBACK_PORT` | `7779` | Override the callback port. Re-register the matching `http://127.0.0.1:<port>/callback` URI in your OAuth app. |
| `PRODUCTBOARD_OAUTH_TOKEN_PATH` | (platform-native, see above) | Override the tokens.json location (e.g. for Docker volumes). |
| `PRODUCTBOARD_OAUTH_REGISTRATION_PATH` | (platform-native, see above) | Override the registration.json location. |
| `PRODUCTBOARD_OAUTH_SCOPES` | (chooser shown) | Space- or comma-separated scopes. Set this to bypass the chooser page. |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document manual OAuth registration as the primary path for non-Dr.Max consumers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the OAuth section**

In the `## Authentication` section, update the **OAuth mode** paragraph to reflect the new priority chain. Find and replace this paragraph (or its v2.0.1 equivalent):

```markdown
**OAuth mode** (default when no PAT env var, OR `PRODUCTBOARD_AUTH_MODE=oauth`): On first start, the MCP self-registers as a Productboard Public Client (RFC 7591) via `POST /oauth2/register`, persists the resulting `client_id` to `registration.json`, then opens a browser to a local scope chooser at `http://127.0.0.1:7779/`, runs the PB authorize-and-consent flow, and exchanges the returned code for tokens.
```

With:

```markdown
**OAuth mode** (default when no PAT env var, OR `PRODUCTBOARD_AUTH_MODE=oauth`): On first start, the resolver picks the OAuth `client_id` from one of (in order): `PRODUCTBOARD_OAUTH_CLIENT_ID` env override, a stored `registration.json`, the recovered `clientId` field of an existing `tokens.json`, or the embedded `DEFAULT_OAUTH_CLIENT_ID` for the Dr.Max-registered OAuth app. Only as a last resort does the resolver fall through to `POST /oauth2/register` (Dynamic Client Registration, RFC 7591) — that endpoint is documented but currently returns HTTP 404 in production (known upstream bug; the code stays in place so it works the day PB fixes it). Once a `client_id` is resolved, the MCP persists it to `registration.json`, opens a browser to a local scope chooser at `http://127.0.0.1:7779/`, runs the PB authorize-and-consent flow, and exchanges the returned code for tokens.
```

- [ ] **Step 2: Update the priority tree**

In the `**Priority tree**` numbered list, update item 3 to reflect the new client_id resolution chain. Replace whatever is there with:

```markdown
3. Otherwise: `PRODUCTBOARD_ACCESS_TOKEN` set → PAT; `tokens.json` exists → OAuth; neither → resolve the OAuth client_id (env override → `registration.json` → tokens.json recovery → embedded Dr.Max default → fresh `POST /oauth2/register` if all else fails), then trigger OAuth setup.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md authentication notes for embedded client_id default

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Spec addendum (second one)

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-oauth-authentication-design.md`

- [ ] **Step 1: Append a second addendum**

Add this section at the very end of the file (after the existing "Addendum (2026-05-27): pivot to Public Client Self-registered"):

```markdown
---

## Addendum 2 (2026-05-27 evening): upstream `/oauth2/register` returns 404 in production

The 2.0.1 build, published 2026-05-27 afternoon, was smoke-tested same day. Result: the dynamic-registration step fails. `POST https://app.productboard.com/oauth2/register` returns HTTP 404 in production via Kong gateway with no backend wired. The endpoint is documented at [oauth-public-client.md](https://developer.productboard.com/reference/oauth-public-client.md) and is supposed to follow RFC 7591, but no plausible URL variant or auth-header combination yielded a non-404.

A support ticket has been filed with Productboard. Pending their fix:

- **2.0.2 hotfix** re-introduces the manual-registration model. The Dr.Max admin manually registers one OAuth app in [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications), captures the issued `client_id`, and we embed it in `src/auth/types.ts` as `DEFAULT_OAUTH_CLIENT_ID`. Non-Dr.Max consumers override via the existing `PRODUCTBOARD_OAUTH_CLIENT_ID` env var.
- **The dynamic-registration code path is retained.** `oauth-register.ts` continues to call `POST /oauth2/register` as a last resort in the resolver priority chain. When Productboard resolves the upstream bug, the code will start using dynamic registration automatically — no further change required from us.
- **404-specific error message.** `registerClient()` now detects HTTP 404 specifically and produces a long, actionable message that walks the user through manual registration. Other error paths unchanged.
- **Priority chain post-2.0.2:**

  ```
  PRODUCTBOARD_OAUTH_CLIENT_ID env override
    → registration.json on disk
      → tokens.json recovery (read clientId field)
        → DEFAULT_OAUTH_CLIENT_ID (embedded Dr.Max)
          → registerClient() — last resort, currently 404
  ```

The body of this design document above describes the pre-hotfix architecture (where dynamic registration was the primary path). Where it disagrees with Addendum 2, Addendum 2 wins.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-26-oauth-authentication-design.md
git commit -m "Spec addendum 2: document upstream /oauth2/register 404 + manual fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Final whole-branch review + publish

- [ ] **Step 1: Sanity build + diff**

```bash
npm run build
git log --oneline main..HEAD
git diff main..HEAD --stat
```

- [ ] **Step 2: Optional whole-branch code review**

Skip if confident. Otherwise dispatch a code-reviewer subagent against `main..HEAD` to confirm the hotfix doesn't regress anything.

- [ ] **Step 3: Merge to main, tag, publish**

```bash
git checkout main
git merge --ff-only <your-branch-name>
git push origin main
git tag -a v2.0.2 -m "Release 2.0.2 — OAuth manual-registration fallback"
git push origin v2.0.2
npm publish
gh release create v2.0.2 --title "v2.0.2 — OAuth manual-registration fallback" --notes-file <(awk '/^## \[2.0.2\]/,/^## \[2.0.1\]/' CHANGELOG.md | sed '$d')
```

- [ ] **Step 4: Smoke test the published version**

In a non-tars Claude Code instance, with `PRODUCTBOARD_ACCESS_TOKEN` unset everywhere:

1. Make a Productboard tool call.
2. Expected: browser opens to scope chooser. The MCP used the embedded `DEFAULT_OAUTH_CLIENT_ID`. No 404.
3. Pick a scope, authorize at PB, return to MCP. Tool call succeeds.

Then test the override path: set `PRODUCTBOARD_OAUTH_CLIENT_ID=invalid-string`, restart MCP, make a tool call. Expected: browser opens but PB's authorize page errors out (invalid client_id). That proves the override is being honored.

- [ ] **Step 5: Bump tars `roles.json`**

In `~/tars/roles.json`, change the productboard `args` from `@drmaxbdc/productboard-mcp@1.0.3` (or `@2.0.1`) to `@drmaxbdc/productboard-mcp@2.0.2`. Re-run `~/tars/tars-setup.sh` to apply.

---

## Notes for the next session

- **Token security:** during the 2.0.1 smoke test, the Dr.Max PAT (admin scope) was repeatedly echoed into conversation logs during diagnostic checks. The user explicitly chose NOT to revoke it during the session and committed to rotating after smoke testing wraps. Confirm with the user whether the rotation has happened before starting this plan; if not, treat any conversation about it as a security-sensitive context.
- **Files containing token references:** `~/.claude.json.bak.before-pin-update`, `~/.claude.json.bak.before-pat-removal` are local backups that may still contain the leaked JWT. The user may want to delete those after rotation.
- **Tars rollout:** the tars-side bump is intentionally deferred until 2.0.2 ships. Until tars is bumped, Dr.Max users on tars continue running 1.0.3 (PAT-only). This is fine — no user is broken.
- **PB support response:** if Productboard fixes `/oauth2/register` before this plan ships, you can simplify Task 3 (remove the `DEFAULT_OAUTH_CLIENT_ID` priority step) and reduce the scope of the README/CLAUDE.md edits accordingly. The Task 2 error message stays useful as defensive code.
- **OAuth scopes:** the chooser page (`oauth-setup.ts`) still offers Read / Read+Write / Full. The Dr.Max OAuth app must have ALL 8 scopes enabled in PB admin UI so the Full chooser option works; if you only check the read scopes there, the Full preset will fail at authorize time with PB rejecting the requested scope set.
