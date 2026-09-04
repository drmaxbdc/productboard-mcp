import { readTokens, writeTokensAtomic } from "./token-store.js";
import {
  createAuthError,
  describeTokenExchangeFailure,
  PRODUCTBOARD_OAUTH_TOKEN_URL,
  REFRESH_BUFFER_MS,
  resolveClientSecret,
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
  // Re-read client_secret from env at refresh time. Not persisted to tokens.json.
  // Confidential clients (the only kind PB's admin UI issues) must send the secret
  // here; true Public Clients leave it undefined.
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: current.clientId,
  };
  const clientSecret = resolveClientSecret();
  if (clientSecret) {
    params.client_secret = clientSecret;
  }
  const body = new URLSearchParams(params).toString();

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
          `Network error during OAuth refresh after ${MAX_ATTEMPTS} attempts: ${(netErr as Error).message}. ` +
            `Check connectivity to app.productboard.com; if reachable, restart MCP to retry. ` +
            `(Restarting does NOT fix a network outage — wait for it to clear first.)`,
          "restart_mcp"
        );
      }
      await sleep(backoffMs[attempt]);
      continue;
    }

    if (response.status === 400) {
      // A 400 is usually invalid_grant (dead refresh token), but invalid_client
      // means the client_secret itself is wrong or rotated — a completely
      // different fix, and re-authorizing would fail the same way.
      //
      // Read body as text first; if it parses as JSON with our expected shape, use that.
      // We must NOT call response.json() then response.text() — the body stream is
      // single-use and the second call always fails ("body used already").
      let rawBody = "";
      try { rawBody = await response.text(); } catch { /* ignore */ }
      let detail = "(no body)";
      let code = "";
      try {
        const errBody = JSON.parse(rawBody) as { error?: string; error_description?: string };
        code = typeof errBody.error === "string" ? errBody.error : "";
        detail = errBody.error_description || errBody.error || "(no detail)";
      } catch {
        detail = rawBody || "(no body)";
      }

      if (code === "invalid_client") {
        throw createAuthError(
          "config_invalid",
          describeTokenExchangeFailure(response.status, code, detail),
          "set_env_var"
        );
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

