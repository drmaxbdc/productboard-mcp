import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest, paginatedRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";
import type { Note } from "../types.js";

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
      pageCursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    async ({ archived, processed, ownerEmail, creatorEmail, createdFrom, createdTo, updatedFrom, updatedTo, limit, pageCursor }) => {
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
}
