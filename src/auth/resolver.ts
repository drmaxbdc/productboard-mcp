import { readTokens } from "./token-store.js";
import { performOAuthSetup, type SetupOptions } from "./oauth-setup.js";
import { refreshIfNeeded, forceRefresh } from "./oauth-refresh.js";
import { readRegistration, registerClient, writeRegistration } from "./oauth-register.js";
import {
  createAuthError,
  DEFAULT_CALLBACK_PORT,
  isAuthError,
  type AuthError,
  type AuthMode,
  type AuthResolution,
  type TokenFile,
} from "./types.js";

/**
 * Parse PRODUCTBOARD_AUTH_MODE env var. Returns "auto" if unset.
 * Throws AuthError on unknown values (fast-fail at startup).
 */
export function resolveAuthMode(): AuthMode {
  const raw = process.env.PRODUCTBOARD_AUTH_MODE?.trim();
  if (!raw || raw === "auto") return "auto";
  if (raw === "oauth" || raw === "pat") return raw;
  throw createAuthError(
    "config_invalid",
    `PRODUCTBOARD_AUTH_MODE has unknown value "${raw}". Allowed: auto, oauth, pat.`,
    "set_env_var"
  );
}

/**
 * Parse and validate PRODUCTBOARD_OAUTH_CALLBACK_PORT. Defaults to DEFAULT_CALLBACK_PORT.
 * Throws AuthError if set to a non-integer or out-of-range value.
 */
export function resolveCallbackPort(): number {
  const raw = process.env.PRODUCTBOARD_OAUTH_CALLBACK_PORT?.trim();
  if (!raw) return DEFAULT_CALLBACK_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw createAuthError(
      "config_invalid",
      `PRODUCTBOARD_OAUTH_CALLBACK_PORT must be an integer between 1024 and 65535, got "${raw}".`,
      "set_env_var"
    );
  }
  return n;
}

async function resolveOrRegisterClient(callbackPort: number): Promise<string> {
  // 1. Explicit override (advanced path: org pre-registered its own OAuth app)
  const override = process.env.PRODUCTBOARD_OAUTH_CLIENT_ID?.trim();
  if (override) return override;

  // 2. Already self-registered? Reuse the persisted client_id.
  const existing = await readRegistration();
  if (existing) return existing.clientId;

  // 3. Recovery path: registration.json is missing but tokens.json may carry a
  // valid clientId from a previous run (e.g., registration.json lost to a
  // Docker volume mismatch). Reuse that clientId to avoid burning a PB
  // registration quota slot AND forcing re-auth.
  const tokens = await readTokens();
  if (tokens?.clientId) {
    process.stderr.write(
      `[productboard-mcp] registration.json missing but tokens.json has clientId=${tokens.clientId}. ` +
        `Reusing existing registration (no new POST /oauth2/register).\n`
    );
    // Reconstruct registration.json so future runs skip this dance.
    try {
      await writeRegistration({
        schemaVersion: 1,
        clientId: tokens.clientId,
        clientName: "Productboard MCP (recovered)",
        redirectUri: `http://127.0.0.1:${callbackPort}/callback`,
        registeredAt: tokens.createdAt,
        issuer: tokens.issuer,
      });
    } catch (writeErr) {
      // Recovery failed — log but continue with the reused clientId.
      process.stderr.write(
        `[productboard-mcp] Could not reconstruct registration.json: ${(writeErr as Error).message}\n`
      );
    }
    return tokens.clientId;
  }

  // 4. Otherwise, register a fresh public client with PB.
  process.stderr.write(
    `[productboard-mcp] No registration.json found. Self-registering OAuth public client with Productboard…\n`
  );
  const registered = await registerClient({
    callbackPort,
    clientName: "Productboard MCP",
  });
  process.stderr.write(
    `[productboard-mcp] Registered as public client_id=${registered.clientId}.\n`
  );
  return registered.clientId;
}

function resolveFixedScopes(): string[] | undefined {
  const raw = process.env.PRODUCTBOARD_OAUTH_SCOPES?.trim();
  if (!raw) return undefined;
  // Accept space- or comma-separated.
  return raw.split(/[\s,]+/).filter(Boolean);
}

/**
 * Build the AuthResolution that the rest of the codebase uses to fetch Bearer tokens.
 * Runs the priority tree once at startup. Side effects:
 *   - May validate env vars and throw AuthError synchronously.
 *   - May kick off OAuth setup as a background task (does NOT block initialize).
 */
export function createAuthResolution(): AuthResolution {
  const mode = resolveAuthMode();
  const patToken = process.env.PRODUCTBOARD_ACCESS_TOKEN?.trim();

  // PAT path: either AUTH_MODE=pat (require env var) or AUTH_MODE=auto with env var set.
  if (mode === "pat" || (mode === "auto" && patToken)) {
    if (!patToken) {
      throw createAuthError(
        "config_invalid",
        "PRODUCTBOARD_AUTH_MODE=pat requires PRODUCTBOARD_ACCESS_TOKEN to be set.",
        "set_env_var"
      );
    }
    return makePatResolution(patToken);
  }

  // OAuth path: AUTH_MODE=oauth, or AUTH_MODE=auto with no PAT env var.
  return makeOauthResolution();
}

function makePatResolution(token: string): AuthResolution {
  return {
    mode: "pat",
    async getBearer() {
      return token;
    },
    async handleUnauthorized() {
      // PAT cannot recover — the caller should propagate the 401 with a switch hint.
      return null;
    },
  };
}

function makeOauthResolution(): AuthResolution {
  const callbackPort = resolveCallbackPort();
  const fixedScopes = resolveFixedScopes();

  let clientId: string | null = null;  // resolved inside the IIFE
  let tokens: TokenFile | null = null;
  let setupPromise: Promise<TokenFile> | null = null;
  let setupError: AuthError | null = null;

  // Synchronously schedule the load-or-setup work. We don't await here so
  // the MCP initialize handshake can complete fast.
  void (async () => {
    try {
      // Resolve (or self-register) the OAuth client_id before any token work.
      clientId = await resolveOrRegisterClient(callbackPort);

      const loaded = await readTokens();
      if (loaded) {
        // If client_id changed (override added/removed/different app/re-registered), invalidate.
        if (loaded.clientId !== clientId) {
          process.stderr.write(
            `[productboard-mcp] tokens.json client_id mismatch (file: ${loaded.clientId}, expected: ${clientId}). Triggering fresh OAuth setup.\n`
          );
          await beginSetup();
          return;
        }
        tokens = loaded;
        return;
      }
      await beginSetup();
    } catch (err) {
      setupError = toAuthError(err);
    }
  })();

  async function beginSetup(): Promise<void> {
    if (!clientId) {
      // Defensive — should never happen because we resolve clientId before calling beginSetup.
      throw createAuthError(
        "config_invalid",
        "Internal error: clientId not resolved before OAuth setup. Restart MCP.",
        "restart_mcp"
      );
    }
    const opts: SetupOptions = { clientId, callbackPort, fixedScopes };
    setupPromise = performOAuthSetup(opts);
    try {
      tokens = await setupPromise;
    } catch (err) {
      setupError = toAuthError(err);
    } finally {
      setupPromise = null;
    }
  }

  return {
    mode: "oauth",
    async getBearer() {
      if (setupError) throw setupError;

      if (!tokens) {
        // Setup still in progress (or not yet started). Return a structured "pending" error
        // so the caller knows to retry.
        throw createAuthError(
          "pending",
          `Productboard MCP is finishing OAuth setup. A browser should have opened on http://127.0.0.1:${callbackPort}/ — please complete the authorization there. The MCP server will pick up the new tokens automatically; retry this tool call in a few seconds.\n\nIf no browser opened: open the URL above manually.`,
          "manual_url_open"
        );
      }

      tokens = await refreshIfNeeded(tokens);
      return tokens.accessToken;
    },
    async handleUnauthorized() {
      if (!tokens) return null;
      try {
        tokens = await forceRefresh(tokens);
        return tokens.accessToken;
      } catch (err) {
        setupError = toAuthError(err);
        throw err;
      }
    },
  };
}

function toAuthError(err: unknown): AuthError {
  if (isAuthError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return createAuthError("config_invalid", `Unexpected non-AuthError thrown from auth path: ${message}`, "restart_mcp");
}
