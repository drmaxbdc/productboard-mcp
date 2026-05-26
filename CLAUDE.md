# @drmaxbdc/productboard-mcp

## Project Overview

MCP (Model Context Protocol) server for the [Productboard](https://www.productboard.com/) API. Exposes ~30 tools covering entities, notes, relationships, configurations, members, and analytics. Today the server is **hybrid V1 + V2**: V2 for CRUD, V1 retained for rich note search (`displayUrl`, followers, features, fulltext, comments).

**Active migration:** Productboard API v1 is deprecated and will be **sunset on 2026-07-08**. Every v1 call must be moved to v2 (or explicitly accepted as a parity gap) before then. See [Productboard v2 migration](#productboard-api-v2-migration-active) below.

## Stack

- Language: TypeScript (ESM, `"type": "module"`)
- Runtime: Node.js >= 18
- SDK: `@modelcontextprotocol/sdk` ^1.12.1
- Validation: `zod` ^3.24.2
- Build: `tsc` → `build/`
- Distribution: npm package `@drmaxbdc/productboard-mcp`, run via `npx -y @drmaxbdc/productboard-mcp`

No test framework, linter, or CI workflow is configured.

## Development

### Build

```bash
npm run build      # tsc → build/
```

### Run locally

```bash
PRODUCTBOARD_ACCESS_TOKEN=... npm start
```

### Publish

```bash
npm publish        # prepublishOnly → build
```

## Architecture

Entry point [src/index.ts](src/index.ts) bootstraps the MCP server from [src/server.ts](src/server.ts) over stdio.

```text
src/
  index.ts                       # npm bin entry (#!/usr/bin/env node)
  server.ts                      # creates McpServer, registers tool groups
  types.ts                       # shared types: V1Note, PaginatedResponse, etc.
  utils.ts                       # toolResult / toolError / ProductboardApiError
  api/
    client.ts                    # HTTP layer — both V2 and V1 callers live here
  tools/
    configuration-tools.ts       # /entities/configurations, /notes/configurations
    entity-tools.ts              # /entities CRUD + search
    relationship-tools.ts        # /entities/{id}/relationships, set_entity_parent
    note-tools.ts                # /notes CRUD (V2) + rich search/comments (V1)
    member-tools.ts              # /members, /teams
```

**HTTP layer ([src/api/client.ts](src/api/client.ts)).** Single file owning four exports:

- `apiRequest` — V2 calls against `https://api.productboard.com/v2`, JSON body, bearer auth.
- `paginatedRequest` — V2 cursor pagination via `links.next` (no `pageSize` control; ~100/page).
- `v1ApiRequest` — V1 calls against `https://api.productboard.com` with `X-Version: 1` header.
- `v1PaginatedRequest` — V1 `pageCursor` pagination with explicit `pageLimit`.

Both clients share the same retry-on-429 logic with `Retry-After` honoring and the same error shape (`ProductboardApiError`). V2 error bodies have the form `{errors:[{code,title,detail}]}`; V1 uses `{message}` / `{error}`. `handleResponse` normalizes both.

**Tool modules.** Each `tools/*.ts` file exports a single `registerXTools(server)` function that calls `server.tool(name, description, zodSchema, handler)` for each tool. Handlers wrap calls in `try/catch` and return `toolResult(data)` or `toolError(err)`. New tools should follow this same shape; do not invent new error formats.

**Analytics tool.** `get_member_activities` is registered inline in [src/server.ts](src/server.ts) rather than its own file — fine for a single endpoint, but if a second analytics tool is added, extract `analytics-tools.ts`.

**Naming.** `verb_object` (e.g. `list_notes`, `create_entity`, `resolve_note`). Tools that exist only because of a V1 capability gap are suffixed `_v1` (`get_note_v1`). These are the primary migration targets — see the inventory below.

### V1 call-site inventory (migration targets)

All remaining V1 calls live in [src/tools/note-tools.ts](src/tools/note-tools.ts):

| Tool               | V1 endpoint                                              | Status                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_all_notes`   | ~~`GET /notes` (bulk)~~                                  | **Migrated** — uses v2 `listnotes` via `paginatedRequest`. Lost: `followers[]`, `comments[]`, `totalResults`, `features[].importance`, top-level `displayUrl` (use `links.html`). New: default `archived=false`, `metadata.source.system`/`recordId` filter (may be empty during transition).         |
| `get_note_v1`      | ~~`GET /notes/{id}` (rich)~~                             | **Migrated as deprecated alias** — now calls v2 `getnote` (same as `get_note`). Lost: `followers[]`, embedded `comments[]`, `features[].importance`. `displayUrl` available at `links.html`. Slated for removal in v2.0.0.            |
| `resolve_note`     | ~~Scans v1 `/notes` for `displayUrl` match~~             | **Migrated** — scans v2 `listnotes` matching `links.html`. Same 500-note search horizon. Surfaces v2 shape.                                                                                                                            |
| `search_notes`     | Hybrid                                                   | **Migrated as hybrid** — routes to v2 `POST /notes/search` by default. Falls back to v1 only when `term` (fulltext) is set or `allTags` has 2+ tags (v2 supports neither). `last` relative-window strings are translated to v2 `updatedAt.from`. v1 fallback dies at sunset; if those two filters aren't used at sunset, the v1 helpers can be deleted. Response includes `apiVersion` (`"v1"` or `"v2"`) so callers know which shape they got. |
| `add_note_comment` | `POST /notes/{id}/comments`                              | **Deprecated, no v2 path** — confirmed no v2 comments endpoint via 404 probes + changelog audit (2026-05-06). Tool description warns of 2026-07-08 hard cutoff. Will be removed in v2.0.0 cleanup commit.                              |

## Authentication

The MCP supports two auth modes. They share the same `apiRequest()` entry point but resolve Bearer tokens differently.

**PAT mode** (`PRODUCTBOARD_ACCESS_TOKEN` env var set, OR `PRODUCTBOARD_AUTH_MODE=pat`): Sync env-var read, no refresh, no recovery on 401 — surface a structured "switch to OAuth" hint instead.

**OAuth mode** (default when no PAT env var, OR `PRODUCTBOARD_AUTH_MODE=oauth`): On first start, the MCP self-registers as a Productboard Public Client (RFC 7591) via `POST /oauth2/register`, persists the resulting `client_id` to `registration.json`, then opens a browser to a local scope chooser at `http://127.0.0.1:7779/`, runs the PB authorize-and-consent flow, and exchanges the returned code for tokens. Both `tokens.json` and `registration.json` persist to `~/Library/Application Support/productboard-mcp/` (macOS path; see [src/auth/token-store.ts](src/auth/token-store.ts) and [src/auth/oauth-register.ts](src/auth/oauth-register.ts) for Linux/Windows). Refresh happens proactively 5 minutes before expiry and reactively on 401.

**Priority tree** (in [src/auth/resolver.ts](src/auth/resolver.ts)):

1. `PRODUCTBOARD_AUTH_MODE=oauth` → OAuth (ignore PAT env)
2. `PRODUCTBOARD_AUTH_MODE=pat` → PAT (require env var)
3. Otherwise: `PRODUCTBOARD_ACCESS_TOKEN` set → PAT; `tokens.json` exists → OAuth; neither → resolve-or-register OAuth client_id (via env override, stored `registration.json`, or fresh `POST /oauth2/register`), then trigger OAuth setup

**Code organization:**

- [src/auth/types.ts](src/auth/types.ts) — types, scope presets, constants (timeouts, default port, PB endpoints, placeholder client_id)
- [src/auth/token-store.ts](src/auth/token-store.ts) — read/atomic-write of tokens.json with `0600` perms
- [src/auth/oauth-refresh.ts](src/auth/oauth-refresh.ts) — proactive + reactive refresh, retry/backoff, `invalid_grant` hard error
- [src/auth/oauth-setup.ts](src/auth/oauth-setup.ts) — PKCE, local HTTP listener with `/`, `/start`, `/callback` routes, scope chooser HTML, browser launch
- [src/auth/oauth-register.ts](src/auth/oauth-register.ts) — RFC 7591 Dynamic Client Registration. `registerClient()` POSTs to PB's `/oauth2/register`; `readRegistration()` / `writeRegistration()` for the per-install `registration.json` persistence
- [src/auth/resolver.ts](src/auth/resolver.ts) — priority tree, env-var validation, exposes `createAuthResolution()`
- [src/api/client.ts](src/api/client.ts) — calls `requireResolution().getBearer()` instead of reading env directly; 401 handler does forceRefresh + retry-once in OAuth mode

**Bearer validation.** All Bearer values are cleaned of CR/LF and trimmed in `buildHeaders()` before assembly. This prevents the "PAT label + newline" mishap (which once leaked a token into an HTTP-header-validation error response). If a token contains illegal chars, the server throws a clear error before making the request — the token does not appear in any log.

**Don't.**

- Don't reach for `process.env.PRODUCTBOARD_ACCESS_TOKEN` outside the resolver. Always go through `requireResolution().getBearer()`.
- Don't log Bearer values. The cleanup in `buildHeaders()` is defense-in-depth, not a license to log freely.
- Don't add a synchronous "block until OAuth setup completes" path in `getBearer()`. The MCP initialize handshake must complete in sub-second; if setup is pending, return the structured "pending" error and let the caller retry.

## Conventions

**Commits.** Short imperative subject, version bump suffixed in parens when releasing (e.g. `Fix fields param, teams addItems workaround, add note comments (v1.0.3)`). Body optional; not Conventional Commits.

**Versioning.** Bump `package.json` `version` in the same commit as the user-visible change. No tagging automation. `npm publish` is manual.

**Branching.** Work directly on `main` is fine for small fixes. Use a feature branch for the v2 migration (`v2-migration` or per-tool branches), since changes will touch the public MCP tool surface.

**Tool schemas.** Zod schemas with `.describe()` on every field — those descriptions are surfaced to MCP clients. Keep them terse and accurate; LLM callers depend on them.

**Tool descriptions.** First sentence is what the tool does; second sentence is when to pick it over a similar tool. Mention "V1" or "V2" explicitly when relevant so the model can reason about parity gaps.

**Error handling.** Throw `ProductboardApiError` for HTTP failures (already done by `handleResponse`); wrap tool handlers in `try/catch` that returns `toolError(err)`. Don't swallow errors silently.

**Don't.**

- Don't introduce a test framework, linter, or CI workflow as part of the v2 migration — keep the diff focused. We'll add those as a separate workstream.
- Don't add tools or fields that aren't directly requested — the surface is already broad.
- Don't break tool names without a version bump and a note in [README.md](README.md).
- Don't put secrets in the repo. `PRODUCTBOARD_ACCESS_TOKEN` only comes from env.

## Productboard API v2 migration (active)

**Deadline: 2026-07-08.** After that date v1 endpoints return errors.

**Study material (already vendored — read these before changing the client):**

- [docs/v2-migration/migration-guide.md](docs/v2-migration/migration-guide.md) — full v1→v2 migration guide
- [docs/v2-migration/introduction.md](docs/v2-migration/introduction.md) — v2 overview, endpoint groups, concepts

**Fetching more docs.** Append `.md` to any page on `https://developer.productboard.com/reference/` for an agent-friendly markdown version (e.g. `.../reference/createnote.md`). Always prefer the `.md` variant when reading v2 docs.

**Key v1→v2 behavior changes to design for (from the migration guide):**

1. **No `X-Version` header on v2** — already correct in `apiRequest`.
2. **Cascading deletes** — v2 deletes children of features / release groups automatically. If a tool wraps a destructive op, add a pre-delete child check before issuing the DELETE.
3. **No user/company auto-creation on note create** — v2 returns 404 if the user doesn't exist. Update `create_note` to: try → on 404 create the user via `/entities` → retry.
4. **Minimal create/update responses** — v2 returns `{id, type, links.self}` only. Tools that read fields off the response (e.g. to echo back the full entity) must GET `links.self` afterward, or accept the lean response.
5. **Leaner note responses** — v2 `listnotes` / `getnote` drop `followers[]`, `comments[]`, `totalResults`, `features[].importance`. Verify each note tool's response shape against this.
6. **`keyResult.progress` no longer pre-computed** — compute client-side: `(currentValue − startValue) / (targetValue − startValue) × 100`, guard divide-by-zero.
7. **Note search parity gap** — v2 has no `term` / `anyTag` / `allTags` yet. Plan: keep `search_notes` on v1 until v2 ships these, then switch and mark this migration item done.
8. **Custom field management gap** — v2 cannot create/update/delete company custom field definitions. Reading/writing values to existing fields still works via `/entities`.

**Suggested migration order** (lowest risk first):

1. Rewrite `list_all_notes` against v2 `listnotes` — straight replacement, drop deleted fields.
2. Rewrite `get_note_v1` against v2 `getnote`, rename to `get_note` (already exists?) or fold them. Decide based on whether downstream callers need `displayUrl`.
3. Investigate v2 equivalent for `add_note_comment` (fetch `https://developer.productboard.com/reference/createnotecomment.md` or similar).
4. Verify whether v2 exposes `displayUrl`; if yes, port `resolve_note`. If no, document the loss.
5. Last: `search_notes` — wait for v2 fulltext/tag parity, then port. Keep on v1 until then.
6. Delete v1 helpers (`v1ApiRequest`, `v1PaginatedRequest`, `X-Version` header) once nothing imports them.
7. Update [README.md](README.md) — drop "hybrid V1+V2" wording, drop `_v1` tool names from feature list.

## Notes for Claude

- When editing the HTTP client, watch the auth header. V2 needs only `Authorization: Bearer`; V1 also needs `X-Version: 1`.
- Prefer editing existing tool modules over creating new ones. Every domain already has a slot.
- Before writing v2 code from training data, fetch the relevant `.md` doc page — Productboard explicitly recommends this and our training cutoff predates v2 GA.
- Treat the [docs/v2-migration/](docs/v2-migration/) folder as canonical for migration decisions. If it disagrees with this CLAUDE.md, the docs win and CLAUDE.md needs updating.
