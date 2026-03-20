import type { ApiError } from "./types.js";

export function formatError(error: unknown): string {
  if (error instanceof ProductboardApiError) {
    return `Productboard API Error (${error.status}): ${error.message}${error.details ? `\nDetails: ${JSON.stringify(error.details, null, 2)}` : ""}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class ProductboardApiError extends Error {
  status: number;
  details?: unknown;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = "ProductboardApiError";
    this.status = apiError.status;
    this.details = apiError.details;
  }
}

export function toolResult(content: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof content === "string" ? content : JSON.stringify(content, null, 2),
      },
    ],
  };
}

export function toolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [
      {
        type: "text" as const,
        text: formatError(error),
      },
    ],
    isError: true,
  };
}
