import { readTokens, writeTokensAtomic } from "./token-store.js";
import {
  PRODUCTBOARD_OAUTH_TOKEN_URL,
  REFRESH_BUFFER_MS,
  type TokenFile,
  type AuthError,
} from "./types.js";

/**
 * Returns true if the access token expires within REFRESH_BUFFER_MS.
 * Used by the proactive-refresh path.
 */
export function needsRefresh(tokens: TokenFile): boolean {
  const expiresAt = new Date(tokens.accessTokenExpiresAt).getTime();
  return expiresAt - Date.now() < REFRESH_BUFFER_MS;
}

/**
 * If the access token is still fresh, return the tokens unchanged.
 * If it's near expiry: re-read the file first (concurrency mitigation),
 * then refresh, atomically write the result, and return the new tokens.
 *
 * Throws AuthError on hard failures (refresh_token expired/revoked, network
 * errors after retries exhausted, etc.).
 */
export async function refreshIfNeeded(current: TokenFile): Promise<TokenFile> {
  if (!needsRefresh(current)) return current;

  // Concurrent-access mitigation: peer process may have already refreshed.
  const onDisk = await readTokens();
  if (
    onDisk &&
    new Date(onDisk.accessTokenExpiresAt).getTime() >
      new Date(current.accessTokenExpiresAt).getTime() &&
    !needsRefresh(onDisk)
  ) {
    return onDisk;
  }

  // We do need to refresh ourselves.
  return performRefresh(onDisk ?? current);
}

/**
 * Force a refresh regardless of expiry. Called from the reactive path
 * after a 401 to handle server-side token revocation.
 */
export async function forceRefresh(current: TokenFile): Promise<TokenFile> {
  const onDisk = (await readTokens()) ?? current;
  return performRefresh(onDisk);
}

async function performRefresh(current: TokenFile): Promise<TokenFile> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: current.clientId,
  }).toString();

  const MAX_ATTEMPTS = 3;
  const backoffMs = [1000, 4000, 16000];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(PRODUCTBOARD_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      });
    } catch (netErr: unknown) {
      // Network error — backoff and retry
      if (attempt === MAX_ATTEMPTS - 1) {
        throw createAuthError(
          "expired",
          `Network error during refresh after ${MAX_ATTEMPTS} attempts: ${(netErr as Error).message}`,
          "restart_mcp"
        );
      }
      await sleep(backoffMs[attempt]);
      continue;
    }

    if (response.status === 400) {
      // invalid_grant or similar — refresh token is no longer valid
      let detail = "";
      try {
        const errBody = (await response.json()) as { error?: string; error_description?: string };
        detail = errBody.error_description || errBody.error || "(no detail)";
      } catch {
        detail = await response.text().catch(() => "(no body)");
      }
      throw createAuthError(
        "expired",
        `OAuth refresh token has expired or was revoked. ${detail}\n\n` +
          `To recover:\n` +
          `  1. Restart this MCP server (in Claude Code: /mcp → reconnect)\n` +
          `  2. A new browser-based authorization flow will start automatically\n` +
          `  3. After you authorize, tools will work again\n\n` +
          `If this happens unexpectedly, your tokens may have been revoked by a workspace admin.`,
        "restart_mcp"
      );
    }

    if (!response.ok) {
      // 5xx or other transient — backoff and retry
      if (attempt === MAX_ATTEMPTS - 1) {
        throw createAuthError(
          "expired",
          `Refresh failed: HTTP ${response.status} after ${MAX_ATTEMPTS} attempts.`,
          "restart_mcp"
        );
      }
      await sleep(backoffMs[attempt]);
      continue;
    }

    // Success
    const tokenBody = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
      scope?: string;
    };

    const now = new Date();
    const updated: TokenFile = {
      ...current,
      updatedAt: now.toISOString(),
      accessToken: tokenBody.access_token,
      accessTokenExpiresAt: new Date(now.getTime() + tokenBody.expires_in * 1000).toISOString(),
      refreshToken: tokenBody.refresh_token,
      refreshTokenExpiresAt: new Date(
        now.getTime() + tokenBody.refresh_token_expires_in * 1000
      ).toISOString(),
      scope: tokenBody.scope ?? current.scope,
    };

    try {
      await writeTokensAtomic(updated);
    } catch (writeErr: unknown) {
      // Refreshed OK on PB side, but disk write failed. In-memory tokens are still valid;
      // log to stderr so the user knows persistence broke.
      process.stderr.write(
        `[productboard-mcp] Refresh succeeded but tokens could not be persisted: ${(writeErr as Error).message}\n` +
          `Restart MCP and you will need to re-authorize.\n`
      );
    }

    return updated;
  }

  // Unreachable — the loop always returns or throws.
  throw createAuthError("expired", "Refresh exhausted retries (unreachable)", "restart_mcp");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAuthError(
  kind: AuthError["kind"],
  message: string,
  remediation: AuthError["remediation"]
): AuthError {
  const err = new Error(message) as AuthError;
  err.authError = true;
  err.kind = kind;
  err.remediation = remediation;
  return err;
}
