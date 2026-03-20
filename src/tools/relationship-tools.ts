import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";

export function registerRelationshipTools(server: McpServer) {
  server.tool(
    "get_entity_relationships",
    "Get all relationships for a Productboard entity (parent, children, links, blocking, etc.). Can optionally filter by relationship type or target.",
    {
      entityId: z.string().describe("Entity UUID"),
      type: z
        .string()
        .optional()
        .describe("Filter by relationship type (parent, child, link, isBlockedBy, isBlocking)"),
      targetId: z
        .string()
        .optional()
        .describe("Filter by target entity UUID"),
    },
    async ({ entityId, type, targetId }) => {
      try {
        const params = new URLSearchParams();
        if (type) params.set("type", type);
        if (targetId) params.set("targetId", targetId);
        const query = params.toString();
        const path = `/entities/${entityId}/relationships${query ? `?${query}` : ""}`;
        const response = await apiRequest<unknown>("GET", path);
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "create_entity_relationship",
    "Create a relationship between two Productboard entities.",
    {
      entityId: z.string().describe("Source entity UUID"),
      targetId: z.string().describe("Target entity UUID"),
      type: z
        .string()
        .describe("Relationship type: 'parent', 'child', 'link', 'isBlockedBy', 'isBlocking'"),
    },
    async ({ entityId, targetId, type }) => {
      try {
        const response = await apiRequest<unknown>(
          "POST",
          `/entities/${entityId}/relationships`,
          { data: { type, target: { id: targetId } } }
        );
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "set_entity_parent",
    "Set or replace the parent of a Productboard entity. Uses PUT to replace any existing parent relationship.",
    {
      entityId: z.string().describe("Child entity UUID"),
      parentId: z.string().describe("New parent entity UUID"),
    },
    async ({ entityId, parentId }) => {
      try {
        const response = await apiRequest<unknown>(
          "PUT",
          `/entities/${entityId}/relationships/parent`,
          { data: { target: { id: parentId } } }
        );
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "delete_entity_relationship",
    "Remove a relationship from a Productboard entity. Requires the relationship type and target entity ID.",
    {
      entityId: z.string().describe("Source entity UUID"),
      type: z.string().describe("Relationship type (parent, child, link, isBlockedBy, isBlocking)"),
      targetId: z.string().describe("Target entity UUID"),
    },
    async ({ entityId, type, targetId }) => {
      try {
        await apiRequest<void>(
          "DELETE",
          `/entities/${entityId}/relationships/${type}/${targetId}`
        );
        return toolResult({ deleted: true, entityId, type, targetId });
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
