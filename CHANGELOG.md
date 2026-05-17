# Changelog

All notable changes to `@drmaxbdc/productboard-mcp` are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
