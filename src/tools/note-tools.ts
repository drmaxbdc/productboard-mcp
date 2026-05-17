import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest, paginatedRequest, v1ApiRequest, v1PaginatedRequest } from "../api/client.js";
import { toolResult, toolError } from "../utils.js";
import type { Note, V1Note } from "../types.js";

export function registerNoteTools(server: McpServer) {
  server.tool(
    "list_notes",
    "List Productboard notes (also known as insights) with pagination and optional filters. Sorted by creation date (newest first). DEFAULT: returns processed + unprocessed notes that are NOT archived. To include archived notes set archived=true; to fetch only archived notes set archived=true and omit processed (v2 quirk: archived notes always report processed=false).",
    {
      archived: z.boolean().optional().describe("Filter by archived status. Default: false (archived notes are hidden). Set true to include or to fetch only archived notes."),
      processed: z.boolean().optional().describe("Filter by processed status (true=processed, false=unprocessed). Default: both."),
      ownerEmail: z.string().optional().describe("Filter by owner email. Requires members:pii:read scope on the access token."),
      creatorEmail: z.string().optional().describe("Filter by creator email. Requires members:pii:read scope on the access token."),
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
      sourceSystem: z
        .string()
        .optional()
        .describe("Filter by metadata.source.system (v2 equivalent of v1 source.origin)."),
      sourceRecordId: z
        .string()
        .optional()
        .describe("Filter by metadata.source.recordId"),
      pageCursor: z
        .string()
        .optional()
        .describe("Pagination cursor from previous response"),
    },
    async ({ archived, processed, ownerEmail, creatorEmail, createdFrom, createdTo, updatedFrom, updatedTo, sourceSystem, sourceRecordId, limit, pageCursor }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {};
        // Default: hide archived notes unless caller explicitly opts in.
        params.archived = archived ?? false;
        if (processed !== undefined) params.processed = processed;
        if (ownerEmail) params["owner[email]"] = ownerEmail;
        if (creatorEmail) params["creator[email]"] = creatorEmail;
        if (createdFrom) params.createdFrom = createdFrom;
        if (createdTo) params.createdTo = createdTo;
        if (updatedFrom) params.updatedFrom = updatedFrom;
        if (updatedTo) params.updatedTo = updatedTo;
        if (sourceSystem) params["metadata[source][system]"] = sourceSystem;
        if (sourceRecordId) params["metadata[source][recordId]"] = sourceRecordId;
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
    "Create a new Productboard note (insight). Call get_note_configurations first to discover available fields and note types (simple, conversation).",
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

  server.tool(
    "add_note_comment",
    "DEPRECATED — will stop working on 2026-07-08 when Productboard sunsets API V1. V2 has no equivalent note-comments endpoint as of 2026-05 (last confirmed via API changelog). No workaround available; the comment feature will be removed in v2.0.0 alongside the V1 client cleanup. Continue using only if comments are critical AND you have a contingency for sunset.",
    {
      noteId: z.string().describe("Note UUID"),
      content: z.string().describe("Comment text"),
    },
    async ({ noteId, content }) => {
      try {
        const response = await v1ApiRequest<{ data: { id: string } }>(
          "POST",
          `/notes/${noteId}/comments`,
          { content }
        );
        return toolResult(response);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // ── Hybrid search: v2 by default, v1 fallback only for fulltext / multi-tag-AND ──

  // Translate v1 `last` relative-window strings ("6m", "10d", "24h", "1h") to an
  // ISO-8601 absolute date suitable for v2 `updatedAt.from`. v1 `last` filters
  // notes created OR updated in the window; since updatedAt >= createdAt always,
  // `updatedAt.from` captures a tight superset.
  function relativeWindowToIso(spec: string): string | null {
    const match = spec.match(/^(\d+)([mdh])$/);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date();
    switch (match[2]) {
      case "m": d.setMonth(d.getMonth() - n); break;
      case "d": d.setDate(d.getDate() - n); break;
      case "h": d.setHours(d.getHours() - n); break;
      default: return null;
    }
    return d.toISOString();
  }

  server.tool(
    "search_notes",
    "Search Productboard notes (insights). Routes to V2 POST /notes/search by default; falls back to V1 GET /notes only when term (fulltext) is set or allTags has 2+ values (V2 supports neither). The `last` relative time window (e.g. '6m', '10d') is translated to V2 updatedAt.from automatically, so `last` alone no longer forces V1. V1 fallback path will break on 2026-07-08 (V1 sunset). The response shape differs by path: V1 returns rich objects with top-level displayUrl, followers, features; V2 returns {id, type, links{self,html}, fields{...}, relationships{...}}. Check the apiVersion field in the result, or whether returned notes have top-level `displayUrl` (v1) vs `links.html` (v2). DEFAULT: hides archived notes — set archived=true to include.",
    {
      term: z.string().optional().describe("Fulltext search across note title and content. V1 ONLY — forces V1 fallback path (breaks 2026-07-08)."),
      last: z.string().optional().describe("Relative time window: '6m', '10d', '24h', '1h'. Translated to V2 updatedAt.from automatically. If you also pass updatedFrom, the explicit updatedFrom wins."),
      createdFrom: z.string().optional().describe("ISO 8601 date-time — notes created on/after"),
      createdTo: z.string().optional().describe("ISO 8601 date-time — notes created on/before"),
      updatedFrom: z.string().optional().describe("ISO 8601 date-time — notes updated on/after"),
      updatedTo: z.string().optional().describe("ISO 8601 date-time — notes updated on/before"),
      featureId: z.string().optional().describe("Notes linked to this feature UUID"),
      companyId: z.string().optional().describe("Notes linked to this company (user/company) UUID"),
      ownerEmail: z.string().optional().describe("Filter by owner email. Requires members:pii:read scope."),
      source: z.string().optional().describe("Filter by source system (v1 source.origin / v2 metadata.source.system)"),
      anyTag: z.array(z.string()).optional().describe("Notes matching ANY of these tags (OR logic, works in both V1 and V2)"),
      allTags: z.array(z.string()).optional().describe("Notes matching ALL of these tags (AND logic). V1 ONLY when 2+ tags — V2 has only OR; multi-tag AND forces V1 fallback path (breaks 2026-07-08)."),
      archived: z.boolean().optional().describe("Filter by archived status. Default: false (archived notes hidden). Only honored on V2 path; ignored on V1 fallback."),
      processed: z.boolean().optional().describe("Filter by processed status. Only honored on V2 path; on V1 fallback use the underlying note state."),
      limit: z.number().min(1).max(2000).default(25).describe("Max results (default 25, max 2000)"),
      pageCursor: z.string().optional().describe("Pagination cursor from previous response (path-specific — do not mix V1 and V2 cursors)"),
    },
    async ({ term, last, createdFrom, createdTo, updatedFrom, updatedTo, featureId, companyId, ownerEmail, source, anyTag, allTags, archived, processed, limit, pageCursor }) => {
      try {
        const translatedLast = last ? relativeWindowToIso(last) : null;
        // V1 fallback only when v2 truly cannot serve the query.
        // `last` is no longer a fallback trigger if we successfully translated it.
        const useV1 =
          !!term ||
          (last && !translatedLast) ||
          (allTags?.length ?? 0) > 1;

        if (useV1) {
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
          const v1Warnings: string[] = [
            "V1 API path used — V1 sunsets on 2026-07-08.",
          ];
          if (term) v1Warnings.push("Fulltext `term` is V1-only; V2 has no equivalent yet.");
          if ((allTags?.length ?? 0) > 1) v1Warnings.push("Multi-tag `allTags` (AND logic) is V1-only; V2 supports OR only.");
          if (last && !relativeWindowToIso(last)) {
            v1Warnings.push(`\`last\` value '${last}' did not match the expected format (e.g. '6m', '10d'); pass updatedFrom directly to stay on V2.`);
          }
          return toolResult({
            apiVersion: "v1",
            notes: result.data,
            count: result.data.length,
            totalResults: result.totalResults,
            nextPageCursor: result.nextPageCursor,
            _warnings: v1Warnings,
          });
        }

        // V2 path — POST /notes/search with structured filter
        const filter: Record<string, unknown> = {};
        if (createdFrom || createdTo) {
          filter.createdAt = {
            ...(createdFrom ? { from: createdFrom } : {}),
            ...(createdTo ? { to: createdTo } : {}),
          };
        }
        // Use explicit updatedFrom if given; otherwise fall back to translated `last` window.
        const effectiveUpdatedFrom = updatedFrom ?? translatedLast ?? undefined;
        if (effectiveUpdatedFrom || updatedTo) {
          filter.updatedAt = {
            ...(effectiveUpdatedFrom ? { from: effectiveUpdatedFrom } : {}),
            ...(updatedTo ? { to: updatedTo } : {}),
          };
        }
        const fields: Record<string, unknown> = {};
        if (ownerEmail) fields.owner = [{ email: ownerEmail }];
        // anyTag and single-element allTags both map to OR tag filter in v2
        const tags = [...(anyTag ?? []), ...(allTags ?? [])];
        if (tags.length) fields.tag = tags.map((name) => ({ name }));
        // Default archived=false unless caller explicitly opts in.
        fields.archived = archived ?? false;
        if (processed !== undefined) fields.processed = processed;
        if (Object.keys(fields).length) filter.fields = fields;

        if (source) filter.metadata = { source: [{ system: source }] };

        const relationships: Record<string, unknown> = {};
        if (companyId) relationships.customer = [{ id: companyId }];
        if (featureId) relationships.link = [{ id: featureId }];
        if (Object.keys(relationships).length) filter.relationships = relationships;

        const body = { data: { filter } };

        // Auto-paginate v2 POST /notes/search up to `limit`
        const maxItems = limit;
        const allItems: Note[] = [];
        let currentPath: string =
          "/notes/search" + (pageCursor ? `?pageCursor=${encodeURIComponent(pageCursor)}` : "");
        let lastNext: string | undefined;

        while (allItems.length < maxItems) {
          const resp = await apiRequest<{ data: Note[]; links?: { next?: string } }>(
            "POST",
            currentPath,
            body
          );
          if (resp.data?.length) allItems.push(...resp.data);
          lastNext = resp.links?.next;
          if (!lastNext || allItems.length >= maxItems) break;
          currentPath = lastNext;
        }

        const trimmed = allItems.slice(0, maxItems);
        let nextCursor: string | undefined;
        if (lastNext && allItems.length >= maxItems) {
          try {
            nextCursor = new URL(lastNext).searchParams.get("pageCursor") ?? undefined;
          } catch { /* ignore */ }
        }

        const v2Warnings: string[] = [];
        if (translatedLast && !updatedFrom) {
          v2Warnings.push(
            `\`last\`='${last}' was translated to updatedFrom='${translatedLast}'. ` +
              `Prefer passing updatedFrom directly — the V1-style 'last' parameter is being phased out and goes away when V1 sunsets on 2026-07-08.`
          );
        }

        return toolResult({
          apiVersion: "v2",
          notes: trimmed,
          count: trimmed.length,
          nextPageCursor: nextCursor,
          ...(v2Warnings.length ? { _warnings: v2Warnings } : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.tool(
    "list_all_notes",
    "Bulk-fetch Productboard notes via V2 API with auto-pagination (~100/page). Safety limit: 5000 notes max. DEFAULT: returns processed + unprocessed notes that are NOT archived. To include archived notes set archived=true. V2 response shape: each note has top-level {id, type, links{self,html}, fields{...}, relationships{...}, createdAt, updatedAt, metadata}. NOTE: v2 no longer returns followers[], embedded comments, totalResults, or features[].importance. Use links.html in place of v1 displayUrl. Linked features are now under /notes/{id}/relationships (not inline) — use get_note_relationships per note if you need them.",
    {
      createdFrom: z.string().optional().describe("ISO 8601 date-time — notes created on/after (inclusive)"),
      createdTo: z.string().optional().describe("ISO 8601 date-time — notes created on/before (inclusive)"),
      updatedFrom: z.string().optional().describe("ISO 8601 date-time — notes updated on/after (inclusive)"),
      updatedTo: z.string().optional().describe("ISO 8601 date-time — notes updated on/before (inclusive)"),
      ownerEmail: z.string().optional().describe("Filter by owner email. Requires members:pii:read scope on the access token."),
      processed: z
        .boolean()
        .optional()
        .describe("Filter by processed status (true=processed, false=unprocessed). Default: both."),
      archived: z.boolean().optional().describe("Filter by archived status. Default: false (archived notes are hidden). Set true to include or to fetch only archived notes."),
      sourceSystem: z
        .string()
        .optional()
        .describe("Filter by metadata.source.system (v2 equivalent of v1 source.origin). NOTE: source metadata may be empty during the v1→v2 transition; use only if you've verified data is populated for your workspace."),
      sourceRecordId: z.string().optional().describe("Filter by metadata.source.recordId."),
      limit: z.number().min(1).max(5000).default(5000).describe("Safety limit (default 5000)"),
    },
    async ({ createdFrom, createdTo, updatedFrom, updatedTo, ownerEmail, processed, archived, sourceSystem, sourceRecordId, limit }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {};
        if (createdFrom) params.createdFrom = createdFrom;
        if (createdTo) params.createdTo = createdTo;
        if (updatedFrom) params.updatedFrom = updatedFrom;
        if (updatedTo) params.updatedTo = updatedTo;
        if (ownerEmail) params["owner[email]"] = ownerEmail;
        if (sourceSystem) params["metadata[source][system]"] = sourceSystem;
        if (sourceRecordId) params["metadata[source][recordId]"] = sourceRecordId;

        // Default: hide archived notes unless caller explicitly opts in.
        params.archived = archived ?? false;
        if (processed !== undefined) params.processed = processed;

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
    "get_note_v1",
    "DEPRECATED: use get_note instead. Kept as an alias for backwards compatibility during the V1→V2 migration. Now calls v2 GET /notes/{id} (same as get_note). V1-only fields no longer available: followers[], embedded comments[], features[].importance. The v1 displayUrl is now exposed as links.html on the returned note. This tool will be removed in v2.0.0.",
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
    "resolve_note",
    "Resolve a Productboard note from any identifier: UUID, numeric ID, web UI URL, or deep link. Returns the v2 note (with links.html — the web UI URL, equivalent to v1 displayUrl). For numeric IDs, scans up to 500 most-recent notes (~5 pages) matching against links.html. Includes archived notes in the scan.",
    {
      identifier: z.string().describe("UUID, numeric ID (e.g. '54080737'), web UI URL, or deep link (?d=notes%2F...)"),
    },
    async ({ identifier }) => {
      try {
        // UUID — direct v2 lookup
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(identifier)) {
          const response = await apiRequest<{ data: Note }>("GET", `/notes/${identifier}`);
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
            `Cannot parse identifier: "${identifier}". Expected UUID, numeric ID, web UI URL, or deep link.`
          ));
        }

        // Scan v2 listnotes for a note whose links.html contains /notes/{numericId}.
        // v2 has no direct URL/numeric-ID filter, so scan recent pages. Don't filter
        // archived — the caller may be trying to resolve an archived note.
        const targetPattern = `/notes/${numericId}`;
        const MAX_NOTES = 500;
        const scan = await paginatedRequest<Note>("/notes", undefined, MAX_NOTES);
        const match = scan.data.find((n) => n.links?.html?.includes(targetPattern));
        if (match) {
          return toolResult({ ...match, numericId });
        }

        return toolError(new Error(
          `Note with numeric ID ${numericId} not found within ${MAX_NOTES} most recent notes. Try using the UUID instead.`
        ));
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
