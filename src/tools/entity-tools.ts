import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest, paginatedRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";
import type { Entity } from "../types.js";

const ENTITY_TYPES = [
  "product",
  "component",
  "feature",
  "subfeature",
  "initiative",
  "objective",
  "keyResult",
  "release",
  "releaseGroup",
] as const;

export function registerEntityTools(server: McpServer) {
  server.tool(
    "list_entities",
    "List Productboard entities of a given type. Supports filtering by name, owner, status, archived, parent. Returns paginated results — use pageCursor from response to get next page.",
    {
      type: z
        .enum(ENTITY_TYPES)
        .describe("Entity type (required). E.g. 'feature', 'initiative', 'objective'."),
      name: z
        .string()
        .optional()
        .describe("Filter by entity name (partial match)"),
      archived: z
        .boolean()
        .optional()
        .describe("Filter by archived status"),
      ownerEmail: z
        .string()
        .optional()
        .describe("Filter by owner email"),
      statusName: z
        .string()
        .optional()
        .describe("Filter by status name"),
      parentId: z
        .string()
        .optional()
        .describe("Filter by parent entity UUID"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(25)
        .describe("Number of results to return (default 25, max 500)"),
      pageCursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
      fields: z
        .string()
        .optional()
        .describe("Control returned fields: 'all', 'default', or comma-separated field names"),
    },
    async ({ type, name, archived, ownerEmail, statusName, parentId, limit, pageCursor, fields }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {
          "type[]": type,
        };
        if (name) params.name = name;
        if (archived !== undefined) params.archived = archived;
        if (ownerEmail) params["owner[email]"] = ownerEmail;
        if (statusName) params["status[name]"] = statusName;
        if (parentId) params["parent[id]"] = parentId;
        if (pageCursor) params.pageCursor = pageCursor;
        if (fields) params.fields = fields;

        const result = await paginatedRequest<Entity>("/entities", params, limit);
        return toolResult({
          entities: result.data,
          count: result.data.length,
          nextPageCursor: result.nextPageCursor,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "get_entity",
    "Get a single Productboard entity by its UUID. Returns full entity data including fields and relationships.",
    {
      id: z.string().describe("Entity UUID"),
      fields: z
        .string()
        .optional()
        .describe("Control returned fields: 'all', 'default', or comma-separated field names"),
    },
    async ({ id, fields }) => {
      try {
        let path = `/entities/${id}`;
        if (fields) {
          const url = new URL(path, "https://api.productboard.com/v2");
          url.searchParams.set("fields", fields);
          path = url.pathname + url.search;
        }
        const response = await apiRequest<{ data: Entity }>("GET", path);
        return toolResult(response.data ?? response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "create_entity",
    "Create a new Productboard entity. Call get_entity_configurations first to discover available fields for the entity type. The fields object should match the field schemas from configuration.",
    {
      type: z.enum(ENTITY_TYPES).describe("Entity type to create"),
      fields: z
        .record(z.string(), z.unknown())
        .describe("Field values as JSON object. Use get_entity_configurations to discover available fields."),
      relationships: z
        .array(
          z.object({
            type: z.string().describe("Relationship type (parent, child, link, isBlockedBy, isBlocking)"),
            target: z.object({
              id: z.string().describe("Target entity UUID"),
            }),
          })
        )
        .optional()
        .describe("Optional relationships to create along with the entity"),
    },
    async ({ type, fields, relationships }) => {
      try {
        const body: Record<string, unknown> = { type, fields };
        if (relationships) body.relationships = relationships;
        const response = await apiRequest<unknown>("POST", "/entities", { data: body });
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "update_entity",
    "Update an existing Productboard entity. Use 'fields' for simple field replacement, or 'patch' for granular operations (set, addItems, removeItems, clear). These are mutually exclusive.",
    {
      id: z.string().describe("Entity UUID to update"),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Fields to replace (simple update). Mutually exclusive with patch."),
      patch: z
        .array(
          z.object({
            op: z.enum(["set", "addItems", "removeItems", "clear"]).describe("Patch operation"),
            path: z.string().describe("Field path to patch (e.g. 'status', 'tags', 'owner')"),
            value: z.unknown().optional().describe("Value for set/addItems/removeItems ops"),
          })
        )
        .optional()
        .describe("Granular patch operations. Mutually exclusive with fields."),
    },
    async ({ id, fields, patch }) => {
      try {
        let data: unknown;
        if (patch) {
          data = { patch };
        } else if (fields) {
          data = { fields };
        } else {
          return toolError(new Error("Provide either 'fields' or 'patch' to update"));
        }

        const response = await apiRequest<unknown>("PATCH", `/entities/${id}`, { data });
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "delete_entity",
    "Permanently delete a Productboard entity. This cascades to all child entities and cannot be undone.",
    {
      id: z.string().describe("Entity UUID to delete"),
    },
    async ({ id }) => {
      try {
        await apiRequest<void>("DELETE", `/entities/${id}`);
        return toolResult({ deleted: true, id });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "search_entities",
    "Search Productboard entities using POST with complex filters. Supports filtering by types, name, statuses, owners, parent, archived, and specific IDs. More powerful than list_entities for complex queries.",
    {
      types: z
        .array(z.enum(ENTITY_TYPES))
        .optional()
        .describe("Entity types to search within (can specify multiple)"),
      name: z
        .string()
        .optional()
        .describe("Filter by entity name"),
      archived: z
        .boolean()
        .optional()
        .describe("Filter by archived status"),
      ids: z
        .array(z.string())
        .optional()
        .describe("Search by specific entity UUIDs (no type required when using IDs)"),
      statuses: z
        .array(z.union([
          z.object({ id: z.string() }),
          z.object({ name: z.string() }),
        ]))
        .optional()
        .describe("Filter by statuses (by id or name)"),
      owners: z
        .array(z.union([
          z.object({ id: z.string() }),
          z.object({ email: z.string() }),
        ]))
        .optional()
        .describe("Filter by owners (by id or email)"),
      parentId: z
        .string()
        .optional()
        .describe("Filter by parent entity UUID"),
      fields: z
        .string()
        .optional()
        .describe("Control returned fields: 'all', 'default', or comma-separated field names"),
      pageCursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    async ({ types, name, archived, ids, statuses, owners, parentId, fields, pageCursor }) => {
      try {
        const data: Record<string, unknown> = {};
        if (types) data.types = types;
        if (name) data.name = name;
        if (archived !== undefined) data.archived = archived;
        if (ids) data.ids = ids;
        if (statuses) data.statuses = statuses;
        if (owners) data.owners = owners;
        if (parentId) data.parent = { id: parentId };
        if (fields) data.fields = fields;

        const queryParams = pageCursor ? `?pageCursor=${encodeURIComponent(pageCursor)}` : "";

        const response = await apiRequest<{
          data: Entity[];
          links?: { next?: string };
        }>("POST", `/entities/search${queryParams}`, { data });

        let nextPageCursor: string | undefined;
        if (response.links?.next) {
          try {
            nextPageCursor = new URL(response.links.next).searchParams.get("pageCursor") || undefined;
          } catch { /* ignore malformed URL */ }
        }

        return toolResult({
          entities: response.data,
          count: response.data?.length ?? 0,
          nextPageCursor,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
