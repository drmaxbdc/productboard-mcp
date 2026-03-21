import { ProductboardApiError } from "../utils.js";
import type { PaginatedResponse } from "../types.js";

const BASE_URL = "https://api.productboard.com/v2";
const V1_BASE_URL = "https://api.productboard.com";
const MAX_RETRIES = 3;

function getToken(): string {
  const token = process.env.PRODUCTBOARD_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "PRODUCTBOARD_ACCESS_TOKEN environment variable is not set. " +
        "Set it to your Productboard Personal Access Token."
    );
  }
  return token;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
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

  let message = `HTTP ${response.status}`;
  let details: unknown;
  try {
    const body = await response.json();
    // V2 API returns errors as {errors: [{code, title, detail}]}
    if (body.errors?.length) {
      message = body.errors.map((e: { title?: string; detail?: string }) => e.detail || e.title).join("; ");
    } else {
      message = body.message || body.error || message;
    }
    details = body;
  } catch {
    // body wasn't JSON
  }

  throw new ProductboardApiError({ status: response.status, message, details });
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
      });
      return await handleResponse<T>(response);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 429 &&
        attempt < MAX_RETRIES
      ) {
        const retryAfter = (error as { retryAfter?: string }).retryAfter;
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 2000;
        console.error(`Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(waitMs);
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

// ── V1 API helpers ──────────────────────────────────────────────────────

function v1Headers(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Version": "1",
    ...extra,
  };
}

export async function v1ApiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = path.startsWith("http") ? path : `${V1_BASE_URL}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: v1Headers(),
        body: body ? JSON.stringify(body) : undefined,
      });
      return await handleResponse<T>(response);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 429 &&
        attempt < MAX_RETRIES
      ) {
        const retryAfter = (error as { retryAfter?: string }).retryAfter;
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 2000;
        console.error(`Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(waitMs);
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

/**
 * V1 paginated GET. Uses pageCursor query param and pageLimit for page size.
 * Accepts relative path or absolute URL (for pre-built URLs with array params).
 */
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

// ── V2 pagination ───────────────────────────────────────────────────────

/**
 * Paginated GET request. The V2 API uses cursor-based pagination via `links.next`.
 * The API returns ~100 items per page (no pageSize control).
 * We auto-paginate until we reach `limit` items.
 */
export async function paginatedRequest<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  limit?: number
): Promise<{ data: T[]; nextPageCursor?: string }> {
  const maxItems = limit ?? 25;
  const allItems: T[] = [];
  let lastNextUrl: string | null = null;

  // Build initial URL with query params
  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
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

  // Trim to exact limit
  const trimmed = allItems.slice(0, maxItems);

  // Extract cursor for next page if more results exist
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
