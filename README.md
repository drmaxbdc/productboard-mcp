# @drmaxbdc/productboard-mcp

MCP server for the [Productboard](https://www.productboard.com/) API v2. Provides 30 tools covering entities, notes, relationships, configurations, members, and analytics via the Model Context Protocol.

> **V1 sunset on 2026-07-08.** This package is migrating off Productboard API v1. As of this release `list_notes`, `list_all_notes`, `get_note`, `get_note_v1`, `resolve_note`, and most filters on `search_notes` use v2. The only remaining v1 surfaces are: (a) `search_notes` fulltext (`term`) and multi-tag AND filters — auto-fallback only when used, since v2 has no equivalent; (b) `add_note_comment` — v2 has no note-comments endpoint. Both will stop working on the sunset date and will be removed in the v2.0.0 cleanup.

## Features

- **V2-first** — all CRUD plus list/get/search/resolve on notes and entities run on Productboard API v2; v1 used only as a fallback for two specific filters
- **30 tools** — entities CRUD+search, notes CRUD+search+relationships, configurations, members, analytics
- **`search_notes`** — hybrid v2/v1 search. v2 by default; falls back to v1 only when fulltext `term` or multi-tag AND (`allTags`) is requested. `last` relative windows translate automatically to v2 `updatedAt.from`. Response carries `apiVersion` so callers know which shape they got.
- **`resolve_note`** — resolve numeric ID, web UI URL, or deep link to a v2 note
- **`list_all_notes`** — bulk fetch with auto-pagination via v2 (max 5000)
- **`list_members`** / **`get_member`** — workspace member lookup

## Installation

```bash
npx -y @drmaxbdc/productboard-mcp
```

## Configuration

Set the `PRODUCTBOARD_ACCESS_TOKEN` environment variable to your Productboard Personal Access Token.

Generate a token at: Settings > Integrations > Public API in your Productboard workspace.

### Claude Code (claude.json)

```json
{
  "mcpServers": {
    "productboard": {
      "command": "npx",
      "args": ["-y", "@drmaxbdc/productboard-mcp"],
      "env": {
        "PRODUCTBOARD_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Tools

### Notes (V2)

- `list_notes` — list with filters (owner, creator, date range, archived, processed, source). Hides archived notes by default; pass `archived=true` to include.
- `get_note` — get by UUID
- `get_note_v1` — **DEPRECATED** alias for `get_note`. Will be removed in v2.0.0.
- `search_notes` — hybrid v2/v1 search (see Features). Returns `apiVersion` ("v1" or "v2") in the response.
- `resolve_note` — resolve any identifier (UUID, numeric ID, web UI URL, deep link) to a v2 note. Web UI URL lives at `note.links.html`.
- `list_all_notes` — bulk fetch via v2 with auto-pagination (max 5000)
- `create_note` / `update_note` / `delete_note` — CRUD operations
- `get_note_relationships` / `create_note_relationship` / `delete_note_relationship` — note links
- `set_note_customer` — set customer relationship on a note
- `add_note_comment` — **DEPRECATED** (v1-only). V2 has no comments endpoint; this tool stops working on 2026-07-08.

### Entities (features, objectives, initiatives, etc.)
- `list_entities` / `get_entity` / `search_entities` — read with filters
- `create_entity` / `update_entity` / `delete_entity` — CRUD
- `get_entity_relationships` / `create_entity_relationship` / `delete_entity_relationship` — links
- `set_entity_parent` — set parent relationship

### Configuration
- `get_entity_configurations` — discover entity types and fields
- `get_note_configurations` — discover note types and fields

### Members
- `list_members` — list workspace members with optional role filter
- `get_member` — get member by UUID

### Analytics
- `get_member_activities` — member activity metrics

## License

MIT — see [LICENSE.md](LICENSE.md)
