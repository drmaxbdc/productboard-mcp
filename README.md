# @drmaxbdc/productboard-mcp

MCP server for the [Productboard](https://www.productboard.com/) API. Provides 29 tools covering entities, notes, relationships, configurations, members, and analytics via the Model Context Protocol.

## Features

- **Hybrid V1+V2 API** — V1 for rich note search (displayUrl, followers, features), V2 for CRUD operations
- **29 tools** — entities CRUD+search, notes CRUD+search+relationships, configurations, members, analytics
- **`search_notes`** — fulltext search with rich response including display URLs and linked features
- **`resolve_note`** — resolve numeric ID, display URL, or deep link to UUID
- **`get_note_v1`** — rich note detail with followers, features, owner info
- **`list_all_notes`** — bulk fetch with auto-pagination for reports
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

### Notes (V2 CRUD + V1 search)
- `list_notes` — list with filters (owner, creator, date range, processed status)
- `get_note` — get by UUID (V2)
- `get_note_v1` — get by UUID with rich metadata (V1: displayUrl, followers, features)
- `search_notes` — fulltext search with time windows, tags, company, feature filters
- `resolve_note` — resolve any identifier (UUID, numeric ID, URL, deep link) to full note
- `list_all_notes` — bulk fetch with auto-pagination (max 5000)
- `create_note` / `update_note` / `delete_note` — CRUD operations
- `get_note_relationships` / `create_note_relationship` / `delete_note_relationship` — note links
- `set_note_customer` — set customer relationship on a note

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
