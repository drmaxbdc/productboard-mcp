import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest, paginatedRequest, v1ApiRequest, v1PaginatedRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";
import type { Note, V1Note } from "../types.js";

export function registerNoteTools(server: McpServer) {
  server.tool(
    "list_notes",
    "List Productboard notes with pagination and optional filters. Sorted by creation date (newest first).",
    {
      archived: z.boolean().optional().describe("Filter by archived status"),
      processed: z.boolean().optional().describe("Filter by processed status"),
      ownerEmail: z.string().optional().describe("Filter by owner email"),
      creatorEmail: z.string().optional().describe("Filter by creator email"),
      createdFrom: z.string().optional().describe("Filter notes created after this ISO 8601 date"),
      createdTo: z.string().optional().describe("Filter notes created before this ISO 8601 date"),
      updatedFrom: z.string().optional().describe("Filter notes updated after this ISO 8601 date"),
      updatedTo: z.string().optional().describe("Filter notes updated before this ISO 8601 date"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(25)
        .describe("Number of results (default 25, max 500)"),
      sourceRecordId: z
        .string()
        .optional()
        .describe("Filter by source record ID"),
      pageCursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    async ({ archived, processed, ownerEmail, creatorEmail, createdFrom, createdTo, updatedFrom, updatedTo, sourceRecordId, limit, pageCursor }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {};
        if (archived !== undefined) params.archived = archived;
        if (processed !== undefined) params.processed = processed;
        if (ownerEmail) params["owner[email]"] = ownerEmail;
        if (creatorEmail) params["creator[email]"] = creatorEmail;
        if (createdFrom) params.createdFrom = createdFrom;
        if (createdTo) params.createdTo = createdTo;
        if (updatedFrom) params.updatedFrom = updatedFrom;
        if (updatedTo) params.updatedTo = updatedTo;
        if (sourceRecordId) params["source[recordId]"] = sourceRecordId;
        if (pageCursor) params.pageCursor = pageCursor;

        const result = await paginatedRequest<Note>("/notes", params, limit);
        return toolResult({
          notes: result.data,
          count: result.data.length,
          nextPageCursor: result.nextPageCursor,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "get_note",
    "Get a single Productboard note by its UUID.",
    {
      id: z.string().describe("Note UUID"),
    },
    async ({ id }) => {
      try {
        const response = await apiRequest<{ data: Note }>("GET", `/notes/${id}`);
        return toolResult(response.data ?? response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "create_note",
    "Create a new Productboard note. Call get_note_configurations first to discover available fields and note types (simple, conversation).",
    {
      type: z
        .enum(["simple", "conversation"])
        .describe("Note type (simple or conversation). Opportunity notes cannot be created via API."),
      fields: z
        .record(z.string(), z.unknown())
        .describe("Note field values. 'name' is required. Use get_note_configurations to discover all fields."),
      relationships: z
        .array(
          z.object({
            type: z.string().describe("Relationship type ('customer' or 'link')"),
            target: z.object({
              id: z.string().describe("Target UUID"),
              type: z.string().optional().describe("Target type (user, company for customer; entity type for link)"),
            }),
          })
        )
        .optional()
        .describe("Optional relationships to create with the note"),
    },
    async ({ type, fields, relationships }) => {
      try {
        const body: Record<string, unknown> = { type, fields };
        if (relationships) body.relationships = relationships;
        const response = await apiRequest<unknown>("POST", "/notes", { data: body });
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "update_note",
    "Update an existing Productboard note. Use 'fields' for simple replacement or 'patch' for granular operations (set, clear, addItems, removeItems).",
    {
      id: z.string().describe("Note UUID to update"),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Fields to replace. Mutually exclusive with patch."),
      patch: z
        .array(
          z.object({
            op: z.enum(["set", "clear", "addItems", "removeItems"]).describe("Patch operation"),
            path: z.string().describe("Field path (e.g. 'owner', 'tags')"),
            value: z.unknown().optional().describe("Value for set/addItems/removeItems"),
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
        const response = await apiRequest<unknown>("PATCH", `/notes/${id}`, { data });
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "delete_note",
    "Permanently delete a Productboard note. This cannot be undone.",
    {
      id: z.string().describe("Note UUID to delete"),
    },
    async ({ id }) => {
      try {
        await apiRequest<void>("DELETE", `/notes/${id}`);
        return toolResult({ deleted: true, id });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "get_note_relationships",
    "Get relationships for a Productboard note (linked customers, entities, etc.).",
    {
      noteId: z.string().describe("Note UUID"),
    },
    async ({ noteId }) => {
      try {
        const response = await apiRequest<unknown>("GET", `/notes/${noteId}/relationships`);
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "create_note_relationship",
    "Link a Productboard note to a customer (user/company) or entity. For customer relationships, this replaces any existing customer link.",
    {
      noteId: z.string().describe("Note UUID"),
      targetId: z.string().describe("Target entity or customer UUID"),
      type: z
        .enum(["customer", "link"])
        .describe("Relationship type: 'customer' (user/company) or 'link' (entity)"),
      targetType: z
        .string()
        .optional()
        .describe("Target type (e.g. 'user', 'company' for customer; entity type for link)"),
    },
    async ({ noteId, targetId, type, targetType }) => {
      try {
        const target: Record<string, string> = { id: targetId };
        if (targetType) target.type = targetType;
        const response = await apiRequest<unknown>(
          "POST",
          `/notes/${noteId}/relationships`,
          { data: { type, target } }
        );
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "set_note_customer",
    "Set or replace the customer relationship on a note. Only accepts user or company targets.",
    {
      noteId: z.string().describe("Note UUID"),
      customerId: z.string().describe("Customer UUID (user or company)"),
      customerType: z.enum(["user", "company"]).describe("Customer type"),
    },
    async ({ noteId, customerId, customerType }) => {
      try {
        const response = await apiRequest<unknown>(
          "PUT",
          `/notes/${noteId}/relationships/customer`,
          { data: { target: { id: customerId, type: customerType } } }
        );
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "delete_note_relationship",
    "Remove a relationship from a Productboard note.",
    {
      noteId: z.string().describe("Note UUID"),
      targetType: z.enum(["customer", "link"]).describe("Relationship type to delete"),
      targetId: z.string().describe("Target UUID"),
    },
    async ({ noteId, targetType, targetId }) => {
      try {
        await apiRequest<void>(
          "DELETE",
          `/notes/${noteId}/relationships/${targetType}/${targetId}`
        );
        return toolResult({ deleted: true, noteId, targetType, targetId });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // ── V1 Note tools (rich response with displayUrl, followers, features) ──

  server.tool(
    "search_notes",
    "Fulltext search across Productboard notes using V1 API. Returns rich response including displayUrl, followers, and linked features. Primary tool for finding notes by content.",
    {
      term: z.string().optional().describe("Fulltext search across note title and content"),
      last: z.string().optional().describe("Time window: '6m', '10d', '24h', '1h'"),
      createdFrom: z.string().optional().describe("ISO 8601 date — notes created after"),
      createdTo: z.string().optional().describe("ISO 8601 date — notes created before"),
      updatedFrom: z.string().optional().describe("ISO 8601 date — notes updated after"),
      updatedTo: z.string().optional().describe("ISO 8601 date — notes updated before"),
      featureId: z.string().optional().describe("Notes linked to this feature UUID"),
      companyId: z.string().optional().describe("Notes linked to this company UUID"),
      ownerEmail: z.string().optional().describe("Filter by owner email"),
      source: z.string().optional().describe("Filter by source origin"),
      anyTag: z.array(z.string()).optional().describe("Notes matching ANY of these tags"),
      allTags: z.array(z.string()).optional().describe("Notes matching ALL of these tags"),
      limit: z.number().min(1).max(2000).default(25).describe("Max results (default 25, max 2000)"),
      pageCursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    async ({ term, last, createdFrom, createdTo, updatedFrom, updatedTo, featureId, companyId, ownerEmail, source, anyTag, allTags, limit, pageCursor }) => {
      try {
        const url = new URL("https://api.productboard.com/notes");
        if (term) url.searchParams.set("term", term);
        if (last) url.searchParams.set("last", last);
        if (createdFrom) url.searchParams.set("createdFrom", createdFrom);
        if (createdTo) url.searchParams.set("createdTo", createdTo);
        if (updatedFrom) url.searchParams.set("updatedFrom", updatedFrom);
        if (updatedTo) url.searchParams.set("updatedTo", updatedTo);
        if (featureId) url.searchParams.set("feature[id]", featureId);
        if (companyId) url.searchParams.set("company[id]", companyId);
        if (ownerEmail) url.searchParams.set("owner[email]", ownerEmail);
        if (source) url.searchParams.set("source[origin]", source);
        if (anyTag?.length) for (const t of anyTag) url.searchParams.append("anyTag", t);
        if (allTags?.length) for (const t of allTags) url.searchParams.append("allTags", t);
        if (pageCursor) url.searchParams.set("pageCursor", pageCursor);

        const result = await v1PaginatedRequest<V1Note>(url.toString(), undefined, limit);
        return toolResult({
          notes: result.data,
          count: result.data.length,
          totalResults: result.totalResults,
          nextPageCursor: result.nextPageCursor,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "list_all_notes",
    "Bulk-fetch all Productboard notes using V1 API with auto-pagination. Returns rich V1 response with displayUrl. Safety limit: 5000 notes max. Use for daily reports or full exports.",
    {
      createdFrom: z.string().optional().describe("ISO 8601 date — notes created after"),
      createdTo: z.string().optional().describe("ISO 8601 date — notes created before"),
      updatedFrom: z.string().optional().describe("ISO 8601 date — notes updated after"),
      updatedTo: z.string().optional().describe("ISO 8601 date — notes updated before"),
      ownerEmail: z.string().optional().describe("Filter by owner email"),
      processed: z.boolean().optional().describe("Filter by processed status"),
      limit: z.number().min(1).max(5000).default(5000).describe("Safety limit (default 5000)"),
    },
    async ({ createdFrom, createdTo, updatedFrom, updatedTo, ownerEmail, processed, limit }) => {
      try {
        const url = new URL("https://api.productboard.com/notes");
        if (createdFrom) url.searchParams.set("createdFrom", createdFrom);
        if (createdTo) url.searchParams.set("createdTo", createdTo);
        if (updatedFrom) url.searchParams.set("updatedFrom", updatedFrom);
        if (updatedTo) url.searchParams.set("updatedTo", updatedTo);
        if (ownerEmail) url.searchParams.set("owner[email]", ownerEmail);
        if (processed !== undefined) url.searchParams.set("state", processed ? "processed" : "unprocessed");

        const result = await v1PaginatedRequest<V1Note>(url.toString(), undefined, limit);
        return toolResult({
          notes: result.data,
          count: result.data.length,
          totalResults: result.totalResults,
          nextPageCursor: result.nextPageCursor,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "get_note_v1",
    "Get a Productboard note with rich V1 response: displayUrl, followers, linked features, full owner info. Use this when you need the display URL or detailed metadata.",
    {
      id: z.string().describe("Note UUID"),
    },
    async ({ id }) => {
      try {
        const response = await v1ApiRequest<{ data: V1Note }>("GET", `/notes/${id}`);
        return toolResult(response.data ?? response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "resolve_note",
    "Resolve a ProductBoard note from any identifier: UUID, numeric ID, display URL, or deep link. Returns the full V1 note with displayUrl. For numeric IDs, scans up to 500 recent notes — may take a few seconds.",
    {
      identifier: z.string().describe("UUID, numeric ID (e.g. '54080737'), display URL, or deep link (?d=notes%2F...)"),
    },
    async ({ identifier }) => {
      try {
        // UUID — direct lookup
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(identifier)) {
          const response = await v1ApiRequest<{ data: V1Note }>("GET", `/notes/${identifier}`);
          return toolResult(response.data ?? response);
        }

        // Extract numeric ID from URL or raw number
        let numericId: string | null = null;

        if (identifier.startsWith("http")) {
          const pathMatch = identifier.match(/\/notes\/(\d+)/);
          if (pathMatch) numericId = pathMatch[1];

          if (!numericId) {
            try {
              const urlObj = new URL(identifier);
              const dParam = urlObj.searchParams.get("d");
              if (dParam) {
                const dMatch = decodeURIComponent(dParam).match(/notes\/(\d+)/);
                if (dMatch) numericId = dMatch[1];
              }
            } catch { /* not a valid URL */ }
          }
        } else if (/^\d+$/.test(identifier)) {
          numericId = identifier;
        }

        if (!numericId) {
          return toolError(new Error(
            `Cannot parse identifier: "${identifier}". Expected UUID, numeric ID, display URL, or deep link.`
          ));
        }

        // Scan pages to find note by numeric ID in displayUrl
        const targetPattern = `/notes/${numericId}`;
        const MAX_PAGES = 5;
        let pageCursor: string | undefined;

        for (let page = 0; page < MAX_PAGES; page++) {
          const url = new URL("https://api.productboard.com/notes");
          url.searchParams.set("pageLimit", "100");
          if (pageCursor) url.searchParams.set("pageCursor", pageCursor);

          const response = await v1ApiRequest<{
            data: V1Note[];
            pageCursor?: string;
          }>("GET", url.toString());

          const match = response.data?.find((n) =>
            n.displayUrl?.includes(targetPattern)
          );
          if (match) {
            return toolResult({ ...match, numericId });
          }

          if (!response.pageCursor) break;
          pageCursor = response.pageCursor;
        }

        return toolError(new Error(
          `Note with numeric ID ${numericId} not found within ${MAX_PAGES * 100} most recent notes. Try using the UUID instead.`
        ));
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
