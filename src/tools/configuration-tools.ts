import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";

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

export function registerConfigurationTools(server: McpServer) {
  server.tool(
    "get_entity_configurations",
    "Discover available entity types and their fields (field names, types, options, lifecycle operations). Call this before creating or updating entities to learn what fields are available. Optionally filter by entityType.",
    {
      entityType: z
        .enum(ENTITY_TYPES)
        .optional()
        .describe("Filter to a specific entity type. If omitted, returns all configurations."),
    },
    async ({ entityType }) => {
      try {
        const path = entityType
          ? `/entities/configurations/${entityType}`
          : "/entities/configurations";
        const response = await apiRequest<unknown>("GET", path);
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "get_note_configurations",
    "Discover available note types (simple, conversation, opportunity) and their fields. Call this before creating or updating notes.",
    {
      noteType: z
        .enum(["simple", "conversation", "opportunity"])
        .optional()
        .describe("Filter to a specific note type. If omitted, returns all configurations."),
    },
    async ({ noteType }) => {
      try {
        const path = noteType
          ? `/notes/configurations/${noteType}`
          : "/notes/configurations";
        const response = await apiRequest<unknown>("GET", path);
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
