import { ProductboardApiError } from "../utils.js";
import type { PaginatedResponse } from "../types.js";
import { setupHint } from "../auth/types.js";
import type { AuthError, AuthResolution } from "../auth/types.js";

const BASE_URL = "https://api.productboard.com/v2";
const V1_BASE_URL = "https://api.productboard.com";
const MAX_RETRIES = 3;

let resolution: AuthResolution | null = null;

/**
 * Initialize the auth resolver. Must be called once at startup, before any apiRequest.
 * Idempotent — calling twice replaces the prior resolution (used in tests / rebuilds).
 */
export function setAuthResolution(r: AuthResolution): void {
  resolution = r;
}

function requireResolution(): AuthResolution {
  if (!resolution) {
    throw new Error(
      "Auth resolution not initialized. setAuthResolution() must run before apiRequest(). " +
        "This is a packaging bug — please report it."
    );
  }
  return resolution;
}

async function buildHeaders(v1: boolean): Promise<Record<string, string>> {
  const bearer = await requireResolution().getBearer();
  // Defense-in-depth: tokens MUST NOT contain CR/LF or leading/trailing whitespace.
  // Productboard's API echoes malformed Authorization values back in error messages,
  // which leaks credentials into logs.
  const cleanBearer = bearer.replace(/[\r\n]/g, "").trim();
  if (cleanBearer !== bearer || !cleanBearer) {
    throw new Error(
      "PRODUCTBOARD_ACCESS_TOKEN or OAuth access_token contains illegal characters (whitespace or CR/LF). " +
        "Check the value for accidentally-included label text or trailing newlines."
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cleanBearer}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (v1) headers["X-Version"] = "1";
  return headers;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  if (response.status === 429) {
    throw { status: 429, retryAfter: response.headers.get("Retry-After") };
  }

  if (response.status === 401) {
    throw { status: 401 };
  }

  let message = `HTTP ${response.status}`;
  let details: unknown;
  try {
    const body = await response.json();
    if (body.errors?.length) {
      message = body.errors
        .map((e: { title?: string; detail?: string }) => e.detail || e.title)
        .join("; ");
    } else {
      message = body.message || body.error || message;
    }
    details = body;
  } catch {
    // body wasn't JSON
  }

  throw new ProductboardApiError({ status: response.status, message, details });
}

/**
 * Make an authenticated request to the Productboard V2 API. Auto-retries 429s
 * (Retry-After or exponential backoff) and, in OAuth mode, refreshes-and-retries
 * once on 401.
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  return performRequest<T>(method, path, body, false);
}

/** V1-equivalent of apiRequest — adds X-Version: 1 header, uses V1_BASE_URL. */
export async function v1ApiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  return performRequest<T>(method, path, body, true);
}

async function performRequest<T>(
  method: string,
  path: string,
  body: unknown,
  v1: boolean
): Promise<T> {
  const base = v1 ? V1_BASE_URL : BASE_URL;
  const url = path.startsWith("http") ? path : `${base}${path}`;
  let refreshed401 = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: await buildHeaders(v1),
        body: body ? JSON.stringify(body) : undefined,
      });
      return await handleResponse<T>(response);
    } catch (error: unknown) {
      // 429 — retry with Retry-After or backoff
      if (isStatusError(error, 429) && attempt < MAX_RETRIES) {
        const retryAfter = (error as { retryAfter?: string }).retryAfter;
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 2000;
        process.stderr.write(
          `[productboard-mcp] Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})\n`
        );
        await sleep(waitMs);
        continue;
      }

      // 401 — try reactive refresh once (OAuth) or convert to switch-to-OAuth hint (PAT)
      if (isStatusError(error, 401)) {
        if (refreshed401) {
          // We already refreshed once and still got 401 — surface as hard error.
          throw convertUnauthorizedToError(v1);
        }
        const newBearer = await requireResolution().handleUnauthorized();
        if (newBearer === null) {
          // PAT mode (no recovery) — surface the switch hint.
          throw convertUnauthorizedToError(v1);
        }
        // OAuth: we have a refreshed token. Retry the original request once.
        refreshed401 = true;
        continue;
      }

      throw error;
    }
  }

  throw new ProductboardApiError({
    status: 429,
    message: "Rate limit exceeded after maximum retries",
  });
}

function isStatusError(error: unknown, status: number): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status: number }).status === status
  );
}

function convertUnauthorizedToError(v1: boolean): Error {
  const r = resolution;
  if (r?.mode === "pat") {
    return new ProductboardApiError({
      status: 401,
      message:
        "Productboard API rejected your PAT (HTTP 401). Possible causes:\n" +
        "  • The token was revoked (check with your PB admin).\n" +
        "  • The token was rotated and the new value is not in your env.\n\n" +
        "To switch to OAuth authentication instead:\n" +
        "  1. Unset PRODUCTBOARD_ACCESS_TOKEN in your environment / config\n" +
        "  2. Restart this MCP server\n" +
        "  3. Complete the browser-based authorization flow that opens" +
        setupHint(),
    });
  }
  return new ProductboardApiError({
    status: 401,
    message: `OAuth refresh failed twice on a ${v1 ? "V1" : "V2"} request. Restart MCP to re-authorize.`,
  });
}

// ── V2 pagination (unchanged from prior version) ───────────────────────

export async function paginatedRequest<T>(
  path: string,
  params?: Record<string, string | number | boolean | string[] | undefined>,
  limit?: number
): Promise<{ data: T[]; nextPageCursor?: string }> {
  const maxItems = limit ?? 25;
  const allItems: T[] = [];
  let lastNextUrl: string | null = null;

  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  let currentUrl = url.toString();

  while (allItems.length < maxItems) {
    const response = await apiRequest<PaginatedResponse<T>>("GET", currentUrl);
    if (response.data) {
      allItems.push(...response.data);
    }

    if (!response.links?.next || allItems.length >= maxItems) {
      lastNextUrl = response.links?.next ?? null;
      break;
    }

    currentUrl = response.links.next;
  }

  const trimmed = allItems.slice(0, maxItems);

  let nextPageCursor: string | undefined;
  if (lastNextUrl && allItems.length >= maxItems) {
    try {
      const nextUrl = new URL(lastNextUrl);
      nextPageCursor = nextUrl.searchParams.get("pageCursor") || undefined;
    } catch {
      // ignore
    }
  }

  return { data: trimmed, nextPageCursor };
}

// ── V1 pagination (unchanged from prior version) ───────────────────────

export async function v1PaginatedRequest<T>(
  pathOrUrl: string,
  params?: Record<string, string | number | boolean | undefined>,
  limit?: number
): Promise<{ data: T[]; nextPageCursor?: string; totalResults?: number }> {
  const maxItems = limit ?? 25;
  const allItems: T[] = [];
  let totalResults: number | undefined;
  let lastCursor: string | undefined;

  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${V1_BASE_URL}${pathOrUrl}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  if (!url.searchParams.has("pageLimit")) {
    url.searchParams.set("pageLimit", String(Math.min(maxItems, 100)));
  }

  let currentUrl = url.toString();

  while (allItems.length < maxItems) {
    const response = await v1ApiRequest<{
      data: T[];
      pageCursor?: string;
      totalResults?: number;
    }>("GET", currentUrl);

    if (response.totalResults !== undefined) totalResults = response.totalResults;
    if (response.data) allItems.push(...response.data);
    lastCursor = response.pageCursor;

    if (!response.pageCursor || allItems.length >= maxItems) break;

    const nextUrl = new URL(currentUrl);
    nextUrl.searchParams.set("pageCursor", response.pageCursor);
    currentUrl = nextUrl.toString();
  }

  return {
    data: allItems.slice(0, maxItems),
    nextPageCursor: lastCursor,
    totalResults,
  };
}
