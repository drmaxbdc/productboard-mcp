# Changelog

All notable changes to `@drmaxbdc/productboard-mcp` are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] — 2026-05-26

Adds OAuth 2.0 Authorization Code flow (with PKCE) as a second authentication option alongside the existing Personal Access Token (PAT) path. Both paths are first-class and fully supported; OAuth is preferred for fresh installs because it offers rotation, per-user audit trail, and browser-based onboarding instead of admin-issued tokens.

### Added

- **OAuth 2.0 authentication via Public Client Self-registration (RFC 7591).** First-run flow: the MCP dynamically registers itself as a public OAuth client at `POST https://app.productboard.com/oauth2/register` (no manual app registration needed), then opens a browser-based scope chooser (Read only / Read+Write / Full), then runs the standard Productboard authorize-and-consent flow with PKCE. Tokens are persisted to the platform-native cache directory with file perms `0600` and refreshed proactively (5-minute buffer before expiry) and reactively (one retry after a 401). The 60-minute refresh-token grace window in Productboard's OAuth implementation is leveraged to handle multi-process token contention without explicit file locking. The dynamically registered `client_id` is persisted separately to `registration.json` so deleting `tokens.json` to re-authorize does not burn a registration quota slot (PB rate-limits registration to 5/min, 50/day per IP).
- **`PRODUCTBOARD_AUTH_MODE` env var.** Optional. `oauth` forces OAuth even if `PRODUCTBOARD_ACCESS_TOKEN` is set; `pat` requires the env var. Unset → auto (priority tree: PAT env > OAuth tokens.json > setup flow).
- **`PRODUCTBOARD_OAUTH_CLIENT_ID` env var.** Optional advanced override. Pre-register your own custom-branded OAuth app in your PB workspace and set this env var to bypass the self-registration step. Most users don't need it.
- **`PRODUCTBOARD_OAUTH_CALLBACK_PORT` env var.** Optional override of the default `7779` callback port (also re-register the new URL in your PB OAuth app if using your own pre-registered client).
- **`PRODUCTBOARD_OAUTH_TOKEN_PATH` env var.** Optional override of the tokens.json location (Docker volumes, multi-tenant test setups).
- **`PRODUCTBOARD_OAUTH_REGISTRATION_PATH` env var.** Optional override of the registration.json location.
- **`PRODUCTBOARD_OAUTH_SCOPES` env var.** Optional space- or comma-separated list of scopes; bypasses the chooser page.

### Changed

- **`apiRequest` / `v1ApiRequest` are now Bearer-source-agnostic.** They consult an injected `AuthResolution` instead of reading `PRODUCTBOARD_ACCESS_TOKEN` directly. PAT mode preserves the previous behavior byte-for-byte.
- **HTTP 401 now triggers a refresh+retry once** in OAuth mode, or a structured "switch to OAuth" hint in PAT mode (instead of a raw `Bad token` error).
- **Bearer values are now validated client-side** before assembling the Authorization header: leading/trailing whitespace and embedded CR/LF are rejected with a clean error. This prevents the kind of "Productboard PAT label + newline pasted into env" mishap from echoing the token back in an HTTP-header-validation exception.

### Internal

- New `src/auth/` directory: `types.ts`, `token-store.ts`, `oauth-setup.ts`, `oauth-refresh.ts`, `resolver.ts`.
- No new npm dependencies. PKCE uses Node's `crypto`; the callback listener uses Node's `http`; browser launch uses `child_process.spawn`.

### Migration notes for callers

- **Nothing breaks.** Existing deployments with `PRODUCTBOARD_ACCESS_TOKEN` set continue to use PAT auth unchanged.
- **Fresh installs without an env var** will see a browser open at first start. Users complete the scope chooser + authorize once; tokens persist across restarts and refresh automatically.
- **Dr.Max tars users:** the new package version will be picked up by `roles.json`; the OAuth migration happens in tars in a separate phased rollout (see the design spec).

## [2.0.0] — 2026-05-17

Migration release for Productboard's REST API v2. Productboard sunsets v1 on
**2026-07-08**; this release moves the MCP off v1 wherever v2 can serve the
query, and clearly flags the few surfaces with no v2 equivalent.

### Breaking

- **Note response shape changed across all note tools.** v1 returned rich
  top-level fields (`displayUrl`, `followers`, `features[].importance`,
  embedded `comments[]`, `totalResults`); v2 returns a leaner shape with
  fields nested under `fields{...}`, relationships under `relationships{...}`,
  and the web UI URL at `links.html` (replacing top-level `displayUrl`).
  Tools affected: `list_notes`, `list_all_notes`, `get_note`, `get_note_v1`,
  `resolve_note`, and the V2 path of `search_notes`.
- **`list_notes` and `list_all_notes` now hide archived notes by default.**
  Pass `archived: true` to include them. To preserve v1-style behavior
  where archived notes mixed in, set `archived: true` explicitly.
- **`list_notes`: `sourceRecordId` filter is now sent as `metadata[source][recordId]`** (was `source[recordId]` in v1). A new `sourceSystem` filter exposes
  v2's `metadata[source][system]` (v1 equivalent: `source[origin]`). Source
  metadata may be empty during the v1→v2 data transition.
- **`list_all_notes`: response no longer carries `totalResults`** (v2 dropped it).
  Pagination still works via `nextPageCursor`.

### Added

- **Hybrid `search_notes`.** Routes to v2 `POST /notes/search` by default; falls
  back to v1 only when `term` (fulltext) is set, `allTags` has 2+ values, or
  both `allTags` and `anyTag` are present (v2 tag filter is OR-only). Response
  carries `apiVersion` (`"v1"` or `"v2"`) and an optional `_warnings` array so
  callers know which path served the query and why.
- **Auto-translated `last` window.** `search_notes`'s `last` relative-window
  strings (`"6m"`, `"10d"`, `"24h"`, `"1h"`) are now translated to v2
  `updatedAt.from` automatically, so `last` no longer forces v1.
- **`list_notes` / `list_all_notes`: `archived` filter.** New optional boolean
  exposing v2's archived-note filter. Default `false`.
- **Claude Code development scaffold.** `CLAUDE.md` captures architecture,
  conventions, v1 inventory, and migration playbook. `docs/v2-migration/`
  vendors the official Productboard v1→v2 migration guide and v2 intro.

### Deprecated

- **`get_note_v1`** is now a thin alias for `get_note`. Both hit v2
  `GET /notes/{id}`. Kept only for backwards compatibility during the
  transition. Will be removed in the next major.
- **`add_note_comment`** has no v2 equivalent (confirmed against the v2 API
  reference and the 2026-05-06 changelog). The tool will stop working on
  **2026-07-08** and will be removed in the next major.

### Removed (effectively — no v2 equivalent)

- Top-level `note.displayUrl` — use `note.links.html`.
- Top-level `note.followers[]` — no v2 alternative.
- Top-level `note.features[]` inline on note responses — call
  `get_note_relationships` per note if you need them. `features[].importance`
  is permanently removed.
- Embedded `note.comments[]` — see `add_note_comment` deprecation.
- `totalResults` in list responses.

### Internal

- `Note` interface extended with optional `links`, `relationships`, `metadata`
  to reflect the v2 shape.
- V1 helpers (`v1ApiRequest`, `v1PaginatedRequest`, `X-Version: 1` header,
  `V1Note` type) remain in [src/api/client.ts](src/api/client.ts) for the
  narrow `search_notes` v1 fallback and `add_note_comment`. These will be
  deleted in the v2.0.0-cleanup release once v1 sunsets.
- MCP server `version` field bumped to `"2.0.0"` so clients querying server
  capabilities see the published version.
- `search_entities` tool description now warns that the `name` filter is
  currently ignored by Productboard's upstream `POST /entities/search`
  (verified 2026-05). Callers needing name-based search should use
  `list_entities` (its `name` filter works as a partial match).
- Removed unused `PatchOperation` / `SearchFilter` / `MemberActivity`
  interfaces from `src/types.ts`.
- Clarified the `resolve_note` scan: it intentionally omits the `archived`
  parameter because Productboard's v2 default returns both archived and
  non-archived notes (passing `archived=true` would strict-filter to
  archived-only).

### Migration notes for callers

- If you read `note.displayUrl`, switch to `note.links.html`.
- If you read `note.followers` / `note.features[].importance`, accept the loss
  or call relationship endpoints separately.
- If you relied on `totalResults` for "how many notes match?", iterate the
  pages and count, or change the UX to paginate-as-you-go.
- If you were calling `search_notes(term="...")`, that still works via v1
  fallback until 2026-07-08; plan for an alternative (e.g. embeddings index
  on top of `list_all_notes`) before then.
- If you were calling `add_note_comment`, plan to remove that integration
  point before 2026-07-08.
