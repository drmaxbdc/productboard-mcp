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

## Authentication

This MCP supports two auth paths. **OAuth (default)** is recommended for fresh installs; **PAT (fallback)** is fully supported for back-compat and headless / CI use.

### OAuth 2.0 (recommended)

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

Until Productboard's Dynamic Client Registration endpoint comes online, every OAuth app must be registered manually via PB admin UI. Note that PB's UI does not offer a Public Client / PKCE-only option — every manually-registered app is a Confidential Client with a `client_secret`, so both env vars below are required.

1. Sign in to Productboard as an admin and open [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications).
2. Click **New OAuth application**.
3. Fill in the form. Critical fields:
   - **Redirect URI:** `http://127.0.0.1:7779/callback`. If you change `PRODUCTBOARD_OAUTH_CALLBACK_PORT`, also re-register the matching URL here.
   - **API V2 Scopes:** check whichever subset your team needs. For the full MCP tool surface check all 8: `entities:read`, `entities:write`, `entities:delete`, `notes:read`, `notes:write`, `notes:delete`, `analytics:read`, `members_pii:read`.
   - **API V1 Scopes:** leave empty (V1 sunsets 2026-07-08; OAuth was never wired to V1).
4. Save and copy both the issued `client_id` and `client_secret` (PB only shows the secret once).
5. Set both env vars and restart:

   ```bash
   export PRODUCTBOARD_OAUTH_CLIENT_ID='paste-your-client-id-here'
   export PRODUCTBOARD_OAUTH_CLIENT_SECRET='paste-your-client-secret-here'
   ```

The MCP sends `client_secret` in every `POST /oauth2/token` call (initial code-for-tokens exchange and every refresh). It is never persisted to `tokens.json` — read from env at each request so it stays in whatever store you chose for it.

#### Optional env vars

| Env var | Default | Purpose |
| --- | --- | --- |
| `PRODUCTBOARD_AUTH_MODE` | (unset = auto) | Set to `oauth` to force OAuth even if `PRODUCTBOARD_ACCESS_TOKEN` is set; set to `pat` to require PAT (good for CI). |
| `PRODUCTBOARD_OAUTH_CLIENT_ID` | (embedded Dr.Max) | Your own OAuth app's client_id. Required for non-Dr.Max consumers until Productboard's dynamic registration endpoint works. |
| `PRODUCTBOARD_OAUTH_CLIENT_SECRET` | (unset) | Required when using a Confidential Client (i.e. anything registered via PB's admin UI). Dr.Max users on tars get this from `roles.json`. Without it, token exchange returns HTTP 400. |
| `PRODUCTBOARD_OAUTH_CALLBACK_PORT` | `7779` | Override the callback port. Re-register the matching `http://127.0.0.1:<port>/callback` URI in your OAuth app. |
| `PRODUCTBOARD_OAUTH_TOKEN_PATH` | (platform-native, see above) | Override the tokens.json location (e.g. for Docker volumes). |
| `PRODUCTBOARD_OAUTH_REGISTRATION_PATH` | (platform-native, see above) | Override the registration.json location. |
| `PRODUCTBOARD_OAUTH_SCOPES` | (chooser shown) | Space- or comma-separated scopes. Set this to bypass the chooser page. |

### Personal Access Token (PAT, fallback)

Generate a PAT in Productboard at Settings → Integrations → Public API. Then set:

```bash
export PRODUCTBOARD_ACCESS_TOKEN='your-pat-here'
```

When this env var is set, the MCP uses PAT auth and does not run the OAuth flow. PAT is the right choice for:

- Headless environments (CI, Docker containers without a browser, SSH-only servers)
- Backwards compatibility with existing deployments that already provision the env var
- Quick local development / debugging

PATs do not expire on their own but can be revoked by your PB admin at any time. If your PAT stops working mid-session, the MCP surfaces a structured "switch to OAuth" hint so you know how to recover.

## Configuration

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
