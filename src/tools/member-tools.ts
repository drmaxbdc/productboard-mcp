import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest, paginatedRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";
import type { Member } from "../types.js";

export function registerMemberTools(server: McpServer) {
  server.tool(
    "list_members",
    "List Productboard workspace members. Optionally filter by role.",
    {
      role: z
        .enum(["admin", "maker", "contributor"])
        .optional()
        .describe("Filter by member role"),
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
    async ({ role, limit, pageCursor }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {};
        if (role) params.role = role;
        if (pageCursor) params.pageCursor = pageCursor;

        const result = await paginatedRequest<Member>("/members", params, limit);
        return toolResult({
          members: result.data,
          count: result.data.length,
          nextPageCursor: result.nextPageCursor,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "get_member",
    "Get a single Productboard workspace member by UUID.",
    {
      id: z.string().describe("Member UUID"),
    },
    async ({ id }) => {
      try {
        const response = await apiRequest<{ data: Member }>("GET", `/members/${id}`);
        return toolResult(response.data ?? response);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
