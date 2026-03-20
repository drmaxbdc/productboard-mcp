import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest } from "./api/client.js";
import { toolResult, toolError } from "./utils.js";
import { registerConfigurationTools } from "./tools/configuration-tools.js";
import { registerEntityTools } from "./tools/entity-tools.js";
import { registerRelationshipTools } from "./tools/relationship-tools.js";
import { registerNoteTools } from "./tools/note-tools.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "productboard",
    version: "1.0.0",
  });

  // Register all tool groups
  registerConfigurationTools(server);
  registerEntityTools(server);
  registerRelationshipTools(server);
  registerNoteTools(server);

  // Analytics tool — GET /analytics/member-activities
  server.tool(
    "get_member_activities",
    "Retrieve member activity metrics from Productboard. Returns daily activity data per member including feature/note/board creation counts.",
    {
      dateFrom: z
        .string()
        .optional()
        .describe("Start date filter (ISO 8601, e.g. '2025-10-01')"),
      dateTo: z
        .string()
        .optional()
        .describe("End date filter (ISO 8601, e.g. '2025-10-31')"),
      limit: z
        .number()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Number of results (default 100, max 1000)"),
      pageCursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    async ({ dateFrom, dateTo, limit, pageCursor }) => {
      try {
        const params = new URLSearchParams();
        if (dateFrom) params.set("dateFrom", dateFrom);
        if (dateTo) params.set("dateTo", dateTo);
        params.set("limit", String(limit));
        if (pageCursor) params.set("pageCursor", pageCursor);
        const query = params.toString();
        const response = await apiRequest<unknown>("GET", `/analytics/member-activities?${query}`);
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}
