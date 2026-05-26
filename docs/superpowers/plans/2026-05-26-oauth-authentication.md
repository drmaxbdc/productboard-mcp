# OAuth 2.0 Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OAuth 2.0 Authorization Code flow (with PKCE) as a second auth path alongside the existing PAT, shipping as `@drmaxbdc/productboard-mcp@2.1.0`. Full design lives at [docs/superpowers/specs/2026-05-26-oauth-authentication-design.md](../specs/2026-05-26-oauth-authentication-design.md).

**Architecture:** New `src/auth/` directory holds the auth resolver, OAuth setup flow (PKCE + local HTTP listener + browser launch), refresh logic, and token store. `src/api/client.ts` is refactored to consult the resolver instead of reading the env var directly. PAT path remains fully back-compat; OAuth becomes the default only when nothing is configured.

**Tech Stack:** TypeScript (ESM, Node ≥ 18), Node built-ins only (`http`, `crypto`, `child_process`, `fs/promises`, `os`, `path`, `url`). No new npm dependencies.

**Out of scope for this plan** (per spec): tars-side `roles.json` bump and prompt severity change. That ships in a separate PR against the tars repo after this is published.

**Out of scope per CLAUDE.md project policy:** Test framework, linter, CI. Verification per task is `npm run build` (TypeScript compilation) + manual smoke test at the end of the plan.

---

## File structure

| Path | Status | Responsibility |
|---|---|---|
| [src/auth/types.ts](../../src/auth/types.ts) | new | Shared TypeScript types: `AuthMode`, `ScopePreset`, `TokenFile`, `AuthResolution`, `AuthErrorKind`. Scope preset constants. No runtime logic. |
| [src/auth/token-store.ts](../../src/auth/token-store.ts) | new | `tokens.json` path resolution (platform-native cache dir + env var override). Read + atomic write with `0600` perms. |
| [src/auth/oauth-refresh.ts](../../src/auth/oauth-refresh.ts) | new | Proactive expiry check (5-min buffer), POST to `/oauth2/token` with `grant_type=refresh_token`, retry/backoff, concurrent-access mitigation (re-read disk before refreshing), `invalid_grant` hard error. |
| [src/auth/oauth-setup.ts](../../src/auth/oauth-setup.ts) | new | PKCE pair + state nonce generation, local HTTP listener with `/`, `/start`, `/callback` routes, scope chooser HTML, browser launch via `child_process.spawn`, token exchange, 10-min timeout. |
| [src/auth/resolver.ts](../../src/auth/resolver.ts) | new | Priority tree: `AUTH_MODE` override → PAT env var → `tokens.json` → setup flow. Exports `createAuthResolution()` returning a `{mode, getBearer()}` object. Validates env vars at startup. |
| [src/api/client.ts](../../src/api/client.ts) | modify | Replace inline `getToken()` (sync env-var read) with async resolver call. Add 401 handler: reactive refresh + retry once (OAuth mode), structured "switch to OAuth" hint (PAT mode). Redact secrets from `Headers.append` errors. |
| [src/server.ts](../../src/server.ts) | modify | Bump server `version` from `"2.0.0"` to `"2.1.0"`. Initialize auth resolution at server creation. |
| [src/index.ts](../../src/index.ts) | modify | Pass auth resolution into server creation (or use module-level singleton). |
| [package.json](../../package.json) | modify | Bump `version` from `2.0.0` to `2.1.0`. |
| [README.md](../../README.md) | modify | Add "Authentication" section: OAuth (default, recommended) + PAT (fallback, back-compat). |
| [CHANGELOG.md](../../CHANGELOG.md) | modify | Add `## [2.1.0]` block describing the new auth surface. |
| [CLAUDE.md](../../CLAUDE.md) | modify | Update Authentication section with OAuth flow architecture, env vars, edge cases. |

---

## Task 1 — Auth types module

**Files:**
- Create: `src/auth/types.ts`

- [ ] **Step 1: Create directory and file**

Run: `mkdir -p src/auth`

- [ ] **Step 2: Write the types module**

Create [src/auth/types.ts](../../src/auth/types.ts) with this content:

```ts
// Auth-related shared types. No runtime logic; purely declarative.

export type AuthMode = "auto" | "oauth" | "pat";

export type ScopePreset = "read" | "readwrite" | "full";

/** Persisted to disk at tokens.json. Bump schemaVersion if the shape changes. */
export interface TokenFile {
  schemaVersion: 1;
  createdAt: string;             // ISO-8601 timestamp of first authorize
  updatedAt: string;             // ISO-8601 timestamp of last refresh/write
  accessToken: string;
  accessTokenExpiresAt: string;  // ISO-8601; computed from expires_in + now
  refreshToken: string;
  refreshTokenExpiresAt: string; // ISO-8601; from refresh_token_expires_in (180d)
  scope: string;                 // space-separated scopes granted
  clientId: string;              // the OAuth client_id used; invalidates on mismatch
  issuer: string;                // "https://app.productboard.com"
}

export type AuthErrorKind =
  | "pending"             // OAuth setup is still running
  | "expired"             // refresh token expired/revoked; need new authorize
  | "denied"              // user refused consent
  | "config_invalid"      // bad env var value
  | "scope_insufficient"  // PB returned 403; granted scope too narrow
  | "port_in_use"
  | "filesystem";

export interface AuthError extends Error {
  authError: true;
  kind: AuthErrorKind;
  remediation: "restart_mcp" | "set_env_var" | "manual_url_open" | "rerun_setup";
  setupUrl?: string;   // populated on "pending" if a URL exists
  detail?: string;     // extra context for log
}

/** Returned by createAuthResolution(); the rest of the codebase uses this. */
export interface AuthResolution {
  mode: "pat" | "oauth";
  /** Return a valid Bearer token, refreshing if needed. Throws AuthError on failure. */
  getBearer(): Promise<string>;
  /**
   * Called by client.ts after a 401 from PB API. In OAuth mode, forces a refresh
   * once and returns the new token. In PAT mode, returns null to indicate "no recovery
   * possible, propagate the 401 with a switch-to-OAuth hint".
   */
  handleUnauthorized(): Promise<string | null>;
}

/** Productboard's eight OAuth scopes mapped to our three presets. */
export const SCOPE_PRESETS: Record<ScopePreset, readonly string[]> = {
  read: [
    "entities:read",
    "notes:read",
    "analytics:read",
    "members_pii:read",
  ],
  readwrite: [
    "entities:read",
    "entities:write",
    "notes:read",
    "notes:write",
    "analytics:read",
    "members_pii:read",
  ],
  full: [
    "entities:read",
    "entities:write",
    "entities:delete",
    "notes:read",
    "notes:write",
    "notes:delete",
    "analytics:read",
    "members_pii:read",
  ],
} as const;

export const PRODUCTBOARD_OAUTH_ISSUER = "https://app.productboard.com";
export const PRODUCTBOARD_OAUTH_AUTHORIZE_URL = `${PRODUCTBOARD_OAUTH_ISSUER}/oauth2/authorize`;
export const PRODUCTBOARD_OAUTH_TOKEN_URL = `${PRODUCTBOARD_OAUTH_ISSUER}/oauth2/token`;

/** Default callback port. Override via PRODUCTBOARD_OAUTH_CALLBACK_PORT. */
export const DEFAULT_CALLBACK_PORT = 7779;

/** OAuth setup timeout. Listener shuts down if no callback within this window. */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

/** Proactive refresh window: refresh if accessToken expires within this many ms. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Placeholder for the Dr.Max-registered OAuth client_id. Replace before publishing
 * 2.1.0 (after registering the OAuth app at https://app.productboard.com/oauth2/applications).
 * Users on non-Dr.Max workspaces override via PRODUCTBOARD_OAUTH_CLIENT_ID.
 *
 * The resolver checks for empty/placeholder values and fails fast with a clear error.
 */
export const DEFAULT_OAUTH_CLIENT_ID = "";
```

- [ ] **Step 3: Build to verify TypeScript compiles**

Run: `npm run build`
Expected: clean build, no errors. The `build/auth/types.js` file should now exist.

- [ ] **Step 4: Commit**

```bash
git add src/auth/types.ts
git commit -m "$(cat <<'EOF'
Add auth/types.ts — shared OAuth types and scope presets

Pure-types module that the rest of the new src/auth/ tree will import.
Defines AuthMode, ScopePreset, TokenFile, AuthResolution, AuthError, plus
the three scope preset arrays and constants for PB OAuth endpoints,
default callback port (7779), 10-min setup timeout, and 5-min refresh
buffer. No runtime logic yet.

DEFAULT_OAUTH_CLIENT_ID is intentionally empty — the Dr.Max OAuth app
still needs to be registered. The resolver will fail fast with a clear
error if it's empty AND no PRODUCTBOARD_OAUTH_CLIENT_ID override is set.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Token store

**Files:**
- Create: `src/auth/token-store.ts`

- [ ] **Step 1: Write token-store.ts**

Create [src/auth/token-store.ts](../../src/auth/token-store.ts) with this content:

```ts
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TokenFile, AuthError } from "./types.js";

/**
 * Resolves the platform-native cache path for tokens.json.
 * Override with PRODUCTBOARD_OAUTH_TOKEN_PATH for Docker volumes, multi-tenant tests, etc.
 */
export function getTokenPath(): string {
  const override = process.env.PRODUCTBOARD_OAUTH_TOKEN_PATH;
  if (override) return override;

  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "productboard-mcp", "tokens.json");
    case "win32": {
      const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
      return join(appData, "productboard-mcp", "tokens.json");
    }
    default: {
      // Linux + other Unix
      const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
      return join(xdgConfig, "productboard-mcp", "tokens.json");
    }
  }
}

/**
 * Read tokens.json from disk. Returns null if the file does not exist,
 * is malformed, or has an unsupported schemaVersion.
 * Filesystem errors other than ENOENT throw AuthError.
 */
export async function readTokens(): Promise<TokenFile | null> {
  const path = getTokenPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw createAuthError("filesystem", `Cannot read ${path}: ${e.message}`, "set_env_var");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // File exists but is corrupt — treat as missing and let setup re-run.
    process.stderr.write(`[productboard-mcp] tokens.json at ${path} is malformed; ignoring.\n`);
    return null;
  }

  // Basic shape check
  const t = parsed as Partial<TokenFile>;
  if (
    t?.schemaVersion !== 1 ||
    typeof t.accessToken !== "string" ||
    typeof t.refreshToken !== "string" ||
    typeof t.accessTokenExpiresAt !== "string" ||
    typeof t.refreshTokenExpiresAt !== "string" ||
    typeof t.scope !== "string" ||
    typeof t.clientId !== "string"
  ) {
    process.stderr.write(`[productboard-mcp] tokens.json at ${path} has unexpected shape; ignoring.\n`);
    return null;
  }

  return t as TokenFile;
}

/**
 * Atomic write: stage to tokens.json.tmp with 0600 perms, then rename().
 * POSIX rename is atomic — concurrent readers see either the old file or the new, never partial.
 */
export async function writeTokensAtomic(tokens: TokenFile): Promise<void> {
  const path = getTokenPath();
  const tmpPath = `${path}.tmp`;
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmpPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, path);
  } catch (err: unknown) {
    const e = err as Error;
    throw createAuthError(
      "filesystem",
      `Cannot persist tokens to ${path}: ${e.message}`,
      "set_env_var"
    );
  }
}

/**
 * Remove tokens.json (used when client_id changes invalidate the stored grant).
 * Idempotent — no error if the file is already absent.
 */
export async function deleteTokens(): Promise<void> {
  const path = getTokenPath();
  try {
    await fs.unlink(path);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw e;
  }
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
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/auth/token-store.ts
git commit -m "$(cat <<'EOF'
Add auth/token-store.ts — read/atomic-write of tokens.json

Platform-native path resolution (macOS Library/Application Support, Linux
XDG_CONFIG_HOME, Windows APPDATA), override via PRODUCTBOARD_OAUTH_TOKEN_PATH.
File perms 0600 on POSIX (best-effort on Windows). Atomic write via tmp +
rename so concurrent readers always see a complete file.

Read returns null for missing/malformed/unknown-schema files, with a clear
stderr note. Filesystem errors other than ENOENT throw structured AuthError
so callers can produce actionable messages.

deleteTokens() is included for the future "force re-auth" flow; not wired
in yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — OAuth refresh logic

**Files:**
- Create: `src/auth/oauth-refresh.ts`

- [ ] **Step 1: Write oauth-refresh.ts**

Create [src/auth/oauth-refresh.ts](../../src/auth/oauth-refresh.ts) with this content:

```ts
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
        const body = (await response.json()) as { error?: string; error_description?: string };
        detail = body.error_description || body.error || "(no detail)";
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
    const body = (await response.json()) as {
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
      accessToken: body.access_token,
      accessTokenExpiresAt: new Date(now.getTime() + body.expires_in * 1000).toISOString(),
      refreshToken: body.refresh_token,
      refreshTokenExpiresAt: new Date(
        now.getTime() + body.refresh_token_expires_in * 1000
      ).toISOString(),
      scope: body.scope ?? current.scope,
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
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/auth/oauth-refresh.ts
git commit -m "$(cat <<'EOF'
Add auth/oauth-refresh.ts — proactive + reactive refresh

Implements the refresh logic described in the design spec:

- needsRefresh(): proactive check against accessTokenExpiresAt (5-min buffer).
- refreshIfNeeded(): re-reads tokens.json from disk first (concurrent-access
  mitigation — a peer MCP instance may have already refreshed), then performs
  the refresh if still needed.
- forceRefresh(): used by the reactive path after a 401, ignores expiry check.
- performRefresh(): POSTs to /oauth2/token with grant_type=refresh_token,
  retries network errors with exponential backoff (~1s/4s/16s, 3 attempts),
  handles invalid_grant as a hard error with a recovery message, atomically
  writes the rotated refresh_token to disk.

If the PB call succeeds but the disk write fails, the in-memory tokens
remain valid for the current session and stderr logs the persistence failure
— the user is told to restart + re-authorize when convenient.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — OAuth setup flow (PKCE + HTTP listener + chooser)

**Files:**
- Create: `src/auth/oauth-setup.ts`

This is the largest single task — about 250 lines. Bundled together because the listener, chooser HTML, browser launch, and code exchange are all tightly coupled to the same in-memory state machine.

- [ ] **Step 1: Write oauth-setup.ts**

Create [src/auth/oauth-setup.ts](../../src/auth/oauth-setup.ts) with this content:

```ts
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { writeTokensAtomic } from "./token-store.js";
import {
  DEFAULT_CALLBACK_PORT,
  PRODUCTBOARD_OAUTH_AUTHORIZE_URL,
  PRODUCTBOARD_OAUTH_ISSUER,
  PRODUCTBOARD_OAUTH_TOKEN_URL,
  SCOPE_PRESETS,
  SETUP_TIMEOUT_MS,
  type AuthError,
  type ScopePreset,
  type TokenFile,
} from "./types.js";

export interface SetupOptions {
  clientId: string;
  callbackPort?: number;
  /**
   * If provided, the chooser page is skipped and these scopes are requested verbatim.
   * Sourced from PRODUCTBOARD_OAUTH_SCOPES env var (space-separated).
   */
  fixedScopes?: string[];
  timeoutMs?: number;
}

/**
 * Run the full first-run OAuth setup flow: bind a local listener, open the user's
 * browser to the scope chooser (or directly to PB if scopes are pre-configured),
 * exchange the returned code for tokens, persist them, return them.
 *
 * Throws AuthError if the flow cannot complete.
 */
export async function performOAuthSetup(opts: SetupOptions): Promise<TokenFile> {
  const port = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const timeoutMs = opts.timeoutMs ?? SETUP_TIMEOUT_MS;
  const fixedScopes = opts.fixedScopes;

  const codeVerifier = generatePkceVerifier();
  const codeChallenge = base64UrlSha256(codeVerifier);
  const state = randomBytes(24).toString("base64url");
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Build a promise that resolves with the TokenFile or rejects with AuthError.
  // The HTTP listener fulfills/rejects this promise from its request handlers.
  let resolveFlow!: (tokens: TokenFile) => void;
  let rejectFlow!: (err: AuthError) => void;
  const flowPromise = new Promise<TokenFile>((resolve, reject) => {
    resolveFlow = resolve;
    rejectFlow = reject;
  });

  const server: Server = createServer((req, res) =>
    handleRequest(req, res, {
      clientId: opts.clientId,
      redirectUri,
      codeVerifier,
      codeChallenge,
      state,
      fixedScopes,
      onSuccess: (tokens) => resolveFlow(tokens),
      onFailure: (err) => rejectFlow(err),
    })
  );

  // Bind listener
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      throw createAuthError(
        "port_in_use",
        `OAuth callback port ${port} is in use. Free it or set PRODUCTBOARD_OAUTH_CALLBACK_PORT=<n> ` +
          `(and add http://127.0.0.1:<n>/callback to your PB OAuth app's redirect URIs).`,
        "set_env_var"
      );
    }
    throw createAuthError("filesystem", `Cannot bind callback listener: ${e.message}`, "set_env_var");
  }

  // Open browser. If fixedScopes set, go straight to PB authorize URL. Otherwise show chooser.
  const initialUrl = fixedScopes
    ? buildAuthorizeUrl({
        clientId: opts.clientId,
        redirectUri,
        scopes: fixedScopes,
        state,
        codeChallenge,
      })
    : `http://127.0.0.1:${port}/`;

  const browserOpened = await tryOpenBrowser(initialUrl);
  if (!browserOpened) {
    process.stderr.write(
      `[productboard-mcp] Could not auto-open browser. Open this URL manually to complete OAuth setup:\n${initialUrl}\n`
    );
  } else {
    process.stderr.write(`[productboard-mcp] Browser opened for OAuth setup: ${initialUrl}\n`);
  }

  // Set up timeout
  const timeoutHandle = setTimeout(() => {
    rejectFlow(
      createAuthError(
        "denied",
        `OAuth flow timed out after ${Math.round(timeoutMs / 60000)} minutes. Restart MCP to retry.`,
        "restart_mcp"
      )
    );
  }, timeoutMs);

  try {
    const tokens = await flowPromise;
    return tokens;
  } finally {
    clearTimeout(timeoutHandle);
    server.close();
  }
}

interface HandlerContext {
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  fixedScopes?: string[];
  onSuccess: (tokens: TokenFile) => void;
  onFailure: (err: AuthError) => void;
}

function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerContext): void {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (req.method === "GET" && url.pathname === "/") {
    serveChooserPage(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/start") {
    void handleStartPost(req, res, ctx);
    return;
  }

  if (req.method === "GET" && url.pathname === "/callback") {
    void handleCallback(req, res, url, ctx);
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not found");
}

function serveChooserPage(res: ServerResponse): void {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Productboard MCP — Choose access level</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 4em auto; padding: 0 1em; color: #222; }
    h1 { font-size: 1.4em; }
    fieldset { border: 1px solid #ddd; border-radius: 6px; padding: 1em 1.5em; margin: 1em 0; }
    legend { font-weight: 600; padding: 0 0.5em; }
    label { display: block; margin: 0.6em 0; }
    label small { display: block; color: #666; margin-left: 1.7em; }
    button { background: #1f6feb; color: white; border: 0; padding: 0.7em 1.4em; border-radius: 6px; font-size: 1em; cursor: pointer; }
    button:hover { background: #1a5fce; }
    .note { color: #666; font-size: 0.9em; margin-top: 1.5em; }
  </style>
</head>
<body>
  <h1>Choose access level</h1>
  <form method="POST" action="/start">
    <fieldset>
      <legend>Productboard OAuth scope</legend>
      <label>
        <input type="radio" name="level" value="read">
        Read only
        <small>Browse and search. Cannot create or modify anything.</small>
      </label>
      <label>
        <input type="radio" name="level" value="readwrite">
        Read + Write
        <small>Browse, search, create, update. Cannot delete.</small>
      </label>
      <label>
        <input type="radio" name="level" value="full" checked>
        Full access (recommended)
        <small>Includes delete operations. Required for the full MCP tool surface (delete_entity, delete_note).</small>
      </label>
    </fieldset>
    <button type="submit">Authorize with Productboard →</button>
  </form>
  <p class="note">Note: you can re-run setup later to change scope. Tokens are stored locally with file permissions 0600.</p>
</body>
</html>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

async function handleStartPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext
): Promise<void> {
  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  const levelRaw = params.get("level") ?? "full";
  const level: ScopePreset =
    levelRaw === "read" || levelRaw === "readwrite" || levelRaw === "full" ? levelRaw : "full";
  const scopes = [...SCOPE_PRESETS[level]];

  const authorizeUrl = buildAuthorizeUrl({
    clientId: ctx.clientId,
    redirectUri: ctx.redirectUri,
    scopes,
    state: ctx.state,
    codeChallenge: ctx.codeChallenge,
  });

  res.statusCode = 302;
  res.setHeader("Location", authorizeUrl);
  res.end();
}

async function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HandlerContext
): Promise<void> {
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? "(no description)";
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<h1>Authorization failed</h1><p>${escapeHtml(error)}: ${escapeHtml(description)}</p>`);
    ctx.onFailure(
      createAuthError(
        error === "access_denied" ? "denied" : "expired",
        `Productboard returned authorization error: ${error}. ${description}. Restart MCP to retry.`,
        "restart_mcp"
      )
    );
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    res.statusCode = 400;
    res.end("Missing code or state in callback.");
    ctx.onFailure(
      createAuthError("expired", "Callback missing code or state", "restart_mcp")
    );
    return;
  }

  if (state !== ctx.state) {
    res.statusCode = 400;
    res.end("Authorization state mismatch — possible CSRF. Aborting.");
    ctx.onFailure(
      createAuthError(
        "expired",
        "OAuth state nonce did not match — possible CSRF attempt. Restart MCP to retry.",
        "restart_mcp"
      )
    );
    return;
  }

  // Exchange code for tokens
  const exchangeBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: ctx.clientId,
    redirect_uri: ctx.redirectUri,
    code_verifier: ctx.codeVerifier,
  }).toString();

  let exchangeResponse: Response;
  try {
    exchangeResponse = await fetch(PRODUCTBOARD_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: exchangeBody,
    });
  } catch (netErr: unknown) {
    res.statusCode = 500;
    res.end("Token exchange failed (network error). Restart MCP to retry.");
    ctx.onFailure(
      createAuthError(
        "expired",
        `Token exchange network error: ${(netErr as Error).message}`,
        "restart_mcp"
      )
    );
    return;
  }

  if (!exchangeResponse.ok) {
    const bodyText = await exchangeResponse.text().catch(() => "");
    res.statusCode = 500;
    res.end("Token exchange failed. See MCP stderr for details.");
    process.stderr.write(
      `[productboard-mcp] Token exchange failed: HTTP ${exchangeResponse.status}\n${bodyText}\n`
    );
    ctx.onFailure(
      createAuthError(
        "expired",
        `Token exchange failed: HTTP ${exchangeResponse.status}. This usually means client_id or redirect_uri mismatch. Verify your PB OAuth app config.`,
        "restart_mcp"
      )
    );
    return;
  }

  const tokenResponse = (await exchangeResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
    scope: string;
  };

  const now = new Date();
  const tokens: TokenFile = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    accessToken: tokenResponse.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + tokenResponse.expires_in * 1000).toISOString(),
    refreshToken: tokenResponse.refresh_token,
    refreshTokenExpiresAt: new Date(
      now.getTime() + tokenResponse.refresh_token_expires_in * 1000
    ).toISOString(),
    scope: tokenResponse.scope,
    clientId: ctx.clientId,
    issuer: PRODUCTBOARD_OAUTH_ISSUER,
  };

  try {
    await writeTokensAtomic(tokens);
  } catch (writeErr) {
    res.statusCode = 500;
    res.end("Authorization succeeded but tokens could not be persisted. See MCP stderr.");
    ctx.onFailure(writeErr as AuthError);
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html><body style="font-family: system-ui; text-align: center; margin: 4em auto; max-width: 480px;">` +
      `<h1>Authorization complete ✓</h1>` +
      `<p>You can close this tab and return to your MCP client.</p>` +
      `</body></html>`
  );

  ctx.onSuccess(tokens);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface AuthorizeUrlArgs {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    scope: args.scopes.join(" "),
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${PRODUCTBOARD_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function generatePkceVerifier(): string {
  // RFC 7636: 43-128 chars from [A-Z a-z 0-9 - . _ ~]. Use base64url of 32 random bytes (= 43 chars).
  return randomBytes(32).toString("base64url");
}

function base64UrlSha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  // Pick platform-native opener. Return false if we cannot spawn it.
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      // 'start' is a shell builtin, so we go via cmd.exe. Empty title arg is intentional.
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }

  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
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
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: clean build. The setup module is now compiled at `build/auth/oauth-setup.js`.

- [ ] **Step 3: Commit**

```bash
git add src/auth/oauth-setup.ts
git commit -m "$(cat <<'EOF'
Add auth/oauth-setup.ts — PKCE flow with chooser page

Drives the entire first-run OAuth flow as designed:

- PKCE verifier (base64url of 32 random bytes = 43 chars) + S256 challenge.
- 24-byte state nonce for CSRF protection.
- Local HTTP listener on 127.0.0.1:7779 (configurable) with three routes:
  GET /         — scope chooser HTML (Read / Read+Write / Full)
  POST /start   — builds PB authorize URL with chosen scopes, 302 redirects
  GET /callback — verifies state, exchanges code for tokens, persists,
                  serves "Authorization complete" page, signals success.
- Browser launch via child_process.spawn — open/xdg-open/cmd start.
  Fallback: URL printed to stderr.
- 10-minute timeout on the whole flow; listener shuts down on timeout
  or completion.
- All error paths produce structured AuthError with actionable remediation.
- HTML responses escape user-controlled strings to defend against XSS in
  the rare case PB echoes back attacker-controlled values.

When fixedScopes is set (from PRODUCTBOARD_OAUTH_SCOPES env), the chooser
is skipped and the browser opens directly at the PB authorize URL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Auth resolver

**Files:**
- Create: `src/auth/resolver.ts`

- [ ] **Step 1: Write resolver.ts**

Create [src/auth/resolver.ts](../../src/auth/resolver.ts) with this content:

```ts
import { readTokens } from "./token-store.js";
import { performOAuthSetup, type SetupOptions } from "./oauth-setup.js";
import { refreshIfNeeded, forceRefresh } from "./oauth-refresh.js";
import {
  DEFAULT_CALLBACK_PORT,
  DEFAULT_OAUTH_CLIENT_ID,
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

function resolveClientId(): string {
  const override = process.env.PRODUCTBOARD_OAUTH_CLIENT_ID?.trim();
  if (override) return override;
  if (!DEFAULT_OAUTH_CLIENT_ID) {
    throw createAuthError(
      "config_invalid",
      "OAuth client_id is not configured. Either:\n" +
        "  • Set PRODUCTBOARD_OAUTH_CLIENT_ID to your registered OAuth app's client_id, or\n" +
        "  • Use PAT auth instead by setting PRODUCTBOARD_ACCESS_TOKEN.\n\n" +
        "To register an OAuth app: https://app.productboard.com/oauth2/applications",
      "set_env_var"
    );
  }
  return DEFAULT_OAUTH_CLIENT_ID;
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
  const clientId = resolveClientId();
  const callbackPort = resolveCallbackPort();
  const fixedScopes = resolveFixedScopes();

  let tokens: TokenFile | null = null;
  let setupPromise: Promise<TokenFile> | null = null;
  let setupError: AuthError | null = null;

  // Synchronously schedule the load-or-setup work. We don't await here so
  // the MCP initialize handshake can complete fast.
  void (async () => {
    try {
      const loaded = await readTokens();
      if (loaded) {
        // If client_id changed (override added/removed/different app), invalidate.
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
      setupError = err as AuthError;
    }
  })();

  async function beginSetup(): Promise<void> {
    const opts: SetupOptions = { clientId, callbackPort, fixedScopes };
    setupPromise = performOAuthSetup(opts);
    try {
      tokens = await setupPromise;
    } catch (err) {
      setupError = err as AuthError;
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
        setupError = err as AuthError;
        throw err;
      }
    },
  };
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
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/auth/resolver.ts
git commit -m "$(cat <<'EOF'
Add auth/resolver.ts — priority tree + startup validation

Implements the priority tree from the design spec:
  AUTH_MODE override → PAT env var → tokens.json → setup flow

createAuthResolution() runs once at server startup:
- For PAT mode: returns a trivial resolution with the env-var Bearer.
- For OAuth mode: kicks off readTokens()-or-performOAuthSetup() in the
  background so the MCP initialize handshake isn't blocked.

The returned AuthResolution has:
- getBearer() — returns current valid token, refreshing proactively if
  within 5 min of expiry. Throws structured "pending" error if setup is
  still running, structured "expired" if refresh failed unrecoverably.
- handleUnauthorized() — called by client.ts after a 401 from PB. OAuth
  mode does a forced refresh + returns the new token; PAT mode returns
  null (no recovery possible — caller adds the switch-to-OAuth hint).

Env-var validation is fail-fast at startup: unknown AUTH_MODE values, bad
callback ports, missing client_id without override all throw AuthError so
the MCP client sees "server failed to start" instead of a runtime crash.

client_id mismatch in stored tokens.json (e.g. user changed
PRODUCTBOARD_OAUTH_CLIENT_ID) triggers a fresh setup automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Wire resolver into api/client.ts

**Files:**
- Modify: `src/api/client.ts`
- Modify: `src/index.ts` (to initialize resolver before server registers tools)

- [ ] **Step 1: Read current client.ts to confirm starting line numbers**

The file is at [src/api/client.ts](../../src/api/client.ts). Key targets:
- `getToken()` at L8-17 — to be removed.
- `headers()` at L19-26 — becomes async, takes a Bearer arg.
- `v1Headers()` at L103-111 — same treatment.
- `apiRequest()` at L62-99 — wrap fetch with await on resolver + 401 handler.
- `v1ApiRequest()` at L113-150 — same treatment.

- [ ] **Step 2: Rewrite src/api/client.ts**

Replace the entire contents of [src/api/client.ts](../../src/api/client.ts) with:

```ts
import { ProductboardApiError } from "../utils.js";
import type { PaginatedResponse } from "../types.js";
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
        "  3. Complete the browser-based authorization flow that opens\n\n" +
        "For Dr.Max users on tars: rerun tars-setup.sh to refresh config.",
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
```

- [ ] **Step 3: Update src/index.ts to initialize the resolver before the server starts**

Read [src/index.ts](../../src/index.ts) first to see current shape, then replace its contents with the version below. (If it differs significantly from this assumption, adapt the resolver-init insertion while keeping the rest verbatim.)

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { setAuthResolution } from "./api/client.js";
import { createAuthResolution } from "./auth/resolver.js";

async function main(): Promise<void> {
  // Initialize auth BEFORE creating the MCP server so the resolver's startup
  // validation (env var sanity, etc.) is the first thing that runs. OAuth
  // setup, if needed, kicks off in the background and does NOT block here.
  try {
    setAuthResolution(createAuthResolution());
  } catch (err: unknown) {
    process.stderr.write(`[productboard-mcp] Startup failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[productboard-mcp] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: clean build. Check that `build/api/client.js`, `build/index.js`, and all `build/auth/*.js` files exist.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts src/index.ts
git commit -m "$(cat <<'EOF'
Wire auth resolver into api/client.ts and index.ts

api/client.ts:
- New setAuthResolution()/requireResolution() module-level state.
- buildHeaders() awaits the resolver for a Bearer; rejects values with
  CR/LF or wrapping whitespace so we never repeat the PAT-leak-into-
  HTTP-header-error incident.
- performRequest() handles 401 reactively: in OAuth mode it asks the
  resolver to forceRefresh and retries once; in PAT mode it converts
  the 401 into a structured "switch to OAuth" hint.
- The existing 429 retry-with-Retry-After logic is preserved verbatim.
- V1 and V2 paths share the new performRequest helper.
- paginatedRequest and v1PaginatedRequest are unchanged.

index.ts:
- Initializes the auth resolver synchronously (env-var validation,
  fast-fail on bad config) before the MCP server is created. OAuth
  setup, when needed, runs as a background task — does NOT block the
  MCP initialize handshake.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — Bump version

**Files:**
- Modify: `package.json`
- Modify: `src/server.ts`

- [ ] **Step 1: Bump package.json version**

Read [package.json](../../package.json) and change `"version": "2.0.0"` to `"version": "2.1.0"`. No other fields change.

- [ ] **Step 2: Bump server.ts version**

In [src/server.ts](../../src/server.ts), find this line:

```ts
    version: "2.0.0",
```

Replace with:

```ts
    version: "2.1.0",
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Commit (do not push yet — README/CHANGELOG/CLAUDE.md changes go in same release)**

```bash
git add package.json src/server.ts
git commit -m "Bump version to 2.1.0 for OAuth release

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read current CHANGELOG.md**

Read [CHANGELOG.md](../../CHANGELOG.md). The 2.0.0 entry should be at the top after the file header.

- [ ] **Step 2: Insert 2.1.0 block above the 2.0.0 block**

Add this content immediately after the `# Changelog` / opening paragraph, before the existing `## [2.0.0] — 2026-05-17` heading:

```markdown
## [2.1.0] — <release-date-yyyy-mm-dd>

Adds OAuth 2.0 Authorization Code flow (with PKCE) as a second authentication option alongside the existing Personal Access Token (PAT) path. Both paths are first-class and fully supported; OAuth is preferred for fresh installs because it offers rotation, per-user audit trail, and browser-based onboarding instead of admin-issued tokens.

### Added

- **OAuth 2.0 authentication.** First-run setup opens a browser-based scope chooser (Read only / Read+Write / Full), then the standard Productboard authorize-and-consent flow. Tokens are persisted to the platform-native cache directory with file perms `0600` and refreshed proactively (5-minute buffer before expiry) and reactively (one retry after a 401). The 60-minute refresh-token grace window in Productboard's OAuth implementation is leveraged to handle multi-process token contention without explicit file locking.
- **`PRODUCTBOARD_AUTH_MODE` env var.** Optional. `oauth` forces OAuth even if `PRODUCTBOARD_ACCESS_TOKEN` is set; `pat` requires the env var. Unset → auto (priority tree: PAT env > OAuth tokens.json > setup flow).
- **`PRODUCTBOARD_OAUTH_CLIENT_ID` env var.** Optional override of the embedded Dr.Max OAuth client_id (for non-Dr.Max consumers who register their own OAuth app).
- **`PRODUCTBOARD_OAUTH_CALLBACK_PORT` env var.** Optional override of the default `7779` callback port (also re-register the new URL in your PB OAuth app).
- **`PRODUCTBOARD_OAUTH_TOKEN_PATH` env var.** Optional override of the tokens.json location (Docker volumes, multi-tenant test setups).
- **`PRODUCTBOARD_OAUTH_SCOPES` env var.** Optional space- or comma-separated list of scopes; bypasses the chooser page.

### Changed

- **`apiRequest` / `v1ApiRequest` are now Bearer-source-agnostic.** They consult an injected `AuthResolution` instead of reading `PRODUCTBOARD_ACCESS_TOKEN` directly. PAT mode preserves the previous behavior byte-for-byte.
- **HTTP 401 now triggers a refresh+retry once** in OAuth mode, or a structured "switch to OAuth" hint in PAT mode (instead of a raw `Bad token` error).
- **Bearer values are now validated client-side** before assembling the Authorization header: leading/trailing whitespace and embedded CR/LF are rejected with a clean error. This prevents the kind of "Productboard PAT label + newline pasted into env" mishap from echoing the token back in an HTTP-header-validation exception.

### Internal

- New `src/auth/` directory: `types.ts`, `token-store.ts`, `oauth-setup.ts`, `oauth-refresh.ts`, `resolver.ts`.
- No new npm dependencies. PKCE uses Node's `crypto`; the callback listener uses Node's `http`; browser launch uses `child_process.spawn`.

### Migration notes for callers

- **Nothing breaks.** Existing deployments with `PRODUCTBOARD_ACCESS_TOKEN` set continue to use PAT auth unchanged.
- **Fresh installs without an env var** will see a browser open at first start. Users complete the scope chooser + authorize once; tokens persist across restarts and refresh automatically.
- **Dr.Max tars users:** the new package version will be picked up by `roles.json`; the OAuth migration happens in tars in a separate phased rollout (see the design spec).

```

- [ ] **Step 3: Replace `<release-date-yyyy-mm-dd>` placeholder**

When you're ready to release, replace `<release-date-yyyy-mm-dd>` with the actual ISO date.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "Document 2.1.0 OAuth release in CHANGELOG

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README.md to find the Authentication / Setup section**

Read [README.md](../../README.md). Find the section that documents `PRODUCTBOARD_ACCESS_TOKEN` setup (likely titled "Setup" or "Configuration" or "Authentication"). We're going to keep that content and add OAuth above it.

- [ ] **Step 2: Replace / extend the Authentication section**

Replace the existing authentication setup section with this consolidated version. (Adjust heading level — `##` or `###` — to match existing README structure.)

```markdown
## Authentication

This MCP supports two auth paths. **OAuth (default)** is recommended for fresh installs; **PAT (fallback)** is fully supported for back-compat and headless / CI use.

### OAuth 2.0 (recommended)

When neither `PRODUCTBOARD_ACCESS_TOKEN` nor `tokens.json` exists, the MCP server opens a browser on first start to a local scope-chooser page (Read only / Read + Write / Full access), redirects to Productboard for consent, and persists the resulting access + refresh tokens to a platform-native cache directory:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/productboard-mcp/tokens.json` |
| Linux | `${XDG_CONFIG_HOME:-$HOME/.config}/productboard-mcp/tokens.json` |
| Windows | `%APPDATA%\productboard-mcp\tokens.json` |

Tokens are written with permissions `0600` (POSIX). Refresh is automatic — access tokens are renewed 5 minutes before expiry, and refresh tokens (180-day validity) rotate on every use. The refresh-token grace window in PB's OAuth implementation handles multi-process token contention safely.

If you need to start setup over (change scope, switch to a different PB workspace, etc.), delete `tokens.json` and restart the MCP.

#### Optional env vars

| Env var | Default | Purpose |
|---|---|---|
| `PRODUCTBOARD_AUTH_MODE` | (unset = auto) | Set to `oauth` to force OAuth even if `PRODUCTBOARD_ACCESS_TOKEN` is set; set to `pat` to require PAT (good for CI). |
| `PRODUCTBOARD_OAUTH_CLIENT_ID` | (Dr.Max embedded) | Override with your own OAuth app's client_id if you're outside the Dr.Max Productboard workspace. Register an app at [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications). |
| `PRODUCTBOARD_OAUTH_CALLBACK_PORT` | `7779` | Override the callback port. Also re-register the matching `http://127.0.0.1:<port>/callback` URI in your OAuth app. |
| `PRODUCTBOARD_OAUTH_TOKEN_PATH` | (platform-native, see above) | Override the tokens.json location (e.g. for Docker volumes). |
| `PRODUCTBOARD_OAUTH_SCOPES` | (chooser shown) | Space- or comma-separated scopes. Set this to bypass the chooser page. |

### Personal Access Token (PAT, fallback)

Generate a PAT in Productboard at Settings → Integrations → Public API. Then set:

```bash
export PRODUCTBOARD_ACCESS_TOKEN='your-pat-here'
```

When this env var is set, the MCP uses PAT auth and does not run the OAuth flow. PAT is the right choice for:

- Headless environments (CI, Docker containers without a browser, SSH-only servers)
- Backwards compatibility with existing deployments that already provision the env var
- Quick local development / debugging

PATs do not expire on their own but can be revoked by your PB admin at any time. If your PAT stops working mid-session, the MCP surfaces a structured "switch to OAuth" hint so you know how to recover.
```

- [ ] **Step 3: Build to verify (README has no compile step, but `npm run build` is harmless and catches anything else stale)**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document OAuth + PAT auth paths in README

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read CLAUDE.md to find the existing Authentication / Conventions section**

Read [CLAUDE.md](../../CLAUDE.md). The Authentication-related content is currently embedded in conventions and notes — we'll add a dedicated section.

- [ ] **Step 2: Add a new "Authentication" section after the Architecture section**

Insert this between the existing "Architecture" section and "Conventions" section (or place wherever fits the existing flow — adjust heading depth to match):

```markdown
## Authentication

The MCP supports two auth modes. They share the same `apiRequest()` entry point but resolve Bearer tokens differently.

**PAT mode** (`PRODUCTBOARD_ACCESS_TOKEN` env var set, OR `PRODUCTBOARD_AUTH_MODE=pat`): Sync env-var read, no refresh, no recovery on 401 — surface a structured "switch to OAuth" hint instead.

**OAuth mode** (default when no PAT env var, OR `PRODUCTBOARD_AUTH_MODE=oauth`): On first start, opens a browser to a local scope chooser at `http://127.0.0.1:7779/`, then PB authorize, then exchanges the returned code for tokens. Tokens persist to `~/Library/Application Support/productboard-mcp/tokens.json` (macOS path; see [src/auth/token-store.ts](src/auth/token-store.ts) for Linux/Windows). Refresh happens proactively 5 minutes before expiry and reactively on 401.

**Priority tree** (in [src/auth/resolver.ts](src/auth/resolver.ts)):

1. `PRODUCTBOARD_AUTH_MODE=oauth` → OAuth (ignore PAT env)
2. `PRODUCTBOARD_AUTH_MODE=pat` → PAT (require env var)
3. Otherwise: `PRODUCTBOARD_ACCESS_TOKEN` set → PAT; `tokens.json` exists → OAuth; neither → trigger OAuth setup

**Code organization:**

- [src/auth/types.ts](src/auth/types.ts) — types, scope presets, constants (timeouts, default port, PB endpoints, placeholder client_id)
- [src/auth/token-store.ts](src/auth/token-store.ts) — read/atomic-write of tokens.json with `0600` perms
- [src/auth/oauth-refresh.ts](src/auth/oauth-refresh.ts) — proactive + reactive refresh, retry/backoff, `invalid_grant` hard error
- [src/auth/oauth-setup.ts](src/auth/oauth-setup.ts) — PKCE, local HTTP listener with `/`, `/start`, `/callback` routes, scope chooser HTML, browser launch
- [src/auth/resolver.ts](src/auth/resolver.ts) — priority tree, env-var validation, exposes `createAuthResolution()`
- [src/api/client.ts](src/api/client.ts) — calls `requireResolution().getBearer()` instead of reading env directly; 401 handler does forceRefresh + retry-once in OAuth mode

**Bearer validation.** All Bearer values are cleaned of CR/LF and trimmed in `buildHeaders()` before assembly. This prevents the "PAT label + newline" mishap (which once leaked a token into an HTTP-header-validation error response). If a token contains illegal chars, the server throws a clear error before making the request — the token does not appear in any log.

**Don't.**

- Don't reach for `process.env.PRODUCTBOARD_ACCESS_TOKEN` outside the resolver. Always go through `requireResolution().getBearer()`.
- Don't log Bearer values. The cleanup in `buildHeaders()` is defense-in-depth, not a license to log freely.
- Don't add a synchronous "block until OAuth setup completes" path in `getBearer()`. The MCP initialize handshake must complete in sub-second; if setup is pending, return the structured "pending" error and let the caller retry.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document Authentication in CLAUDE.md (PAT + OAuth)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 — Manual smoke test before publish

This is not a code change — it's a checklist the implementer runs against a freshly-built `2.1.0` to validate the auth surface against the live Productboard workspace.

**Pre-requisites:**

1. Register an OAuth app at [https://app.productboard.com/oauth2/applications](https://app.productboard.com/oauth2/applications) (Dr.Max workspace).
2. Add redirect URI: `http://127.0.0.1:7779/callback` (exact match).
3. Copy the `client_id`. Either:
   - Hard-code it as `DEFAULT_OAUTH_CLIENT_ID` in [src/auth/types.ts](../../src/auth/types.ts) and rebuild (then commit the change before publish), OR
   - Set it as `PRODUCTBOARD_OAUTH_CLIENT_ID` env var for testing without committing.

- [ ] **Step 1: Backup the existing token state**

```bash
# Save existing PAT for later restoration
echo "PRODUCTBOARD_ACCESS_TOKEN snapshot: ${PRODUCTBOARD_ACCESS_TOKEN:0:8}..."
# Note the snapshot value somewhere safe; we'll restore it after PAT-path testing.

# Move any prior OAuth tokens out of the way
TOKENS=~/Library/Application\ Support/productboard-mcp/tokens.json
if [ -f "$TOKENS" ]; then mv "$TOKENS" "$TOKENS.bak"; fi
```

- [ ] **Step 2: Test PAT path is still working (back-compat)**

Restart Claude Code with `PRODUCTBOARD_ACCESS_TOKEN` set. In the MCP client:

```
list_notes(limit=1)
```

Expected: returns one note in v2 shape (`fields{}`, `links.html`, `relationships{}`). No browser opens.

- [ ] **Step 3: Test OAuth fresh-install path**

Unset the PAT env var, restart Claude Code (so the MCP server is respawned with the cleared env):

```bash
unset PRODUCTBOARD_ACCESS_TOKEN
# Set the OAuth client_id override if you didn't hard-code it
export PRODUCTBOARD_OAUTH_CLIENT_ID='<your-registered-client-id>'
```

Make any tool call from the MCP client (e.g., `list_notes`).

Expected sequence:

1. The MCP client receives an immediate "auth pending" error from the tool call with the localhost setup URL.
2. A browser opens at `http://127.0.0.1:7779/` and shows the scope chooser.
3. Select "Full access (recommended)" and click "Authorize with Productboard →".
4. Productboard's consent page loads. Click Authorize.
5. Browser shows "Authorization complete ✓" page.
6. Retry the tool call from the MCP client — it returns a normal v2 response.

Verify `tokens.json` exists:

```bash
ls -la ~/Library/Application\ Support/productboard-mcp/tokens.json
# Expect file with mode 600 (-rw-------).
```

- [ ] **Step 4: Test refresh path (proactive)**

Edit the `accessTokenExpiresAt` field in `tokens.json` to a timestamp 1 minute in the future. Save. Make another tool call — the proactive 5-min buffer should trigger a refresh, the call should succeed, and the file should be updated with a new `accessTokenExpiresAt` ~1 hour from now.

```bash
# Verify the file was updated
python3 -c "import json; t = json.load(open('$HOME/Library/Application Support/productboard-mcp/tokens.json')); print(t['accessTokenExpiresAt'])"
```

- [ ] **Step 5: Test scope chooser — read-only path**

Remove `tokens.json` (delete or move it). Restart Claude Code. Make a tool call.

In the browser chooser, select **Read only**. Click Authorize.

After consent, run `list_notes(limit=1)` — should succeed. Then run `create_note(...)` — should fail with a structured "scope_insufficient" error mentioning that the granted scope was Read only.

- [ ] **Step 6: Test PAT 401 hint (PAT mode error path)**

Restore the PAT env var with a deliberately broken value:

```bash
export PRODUCTBOARD_ACCESS_TOKEN='this-is-not-a-valid-token'
```

Restart Claude Code. Make a tool call.

Expected: a `ProductboardApiError` with status 401 whose message contains:

```
Productboard API rejected your PAT (HTTP 401). Possible causes: ...
To switch to OAuth authentication instead: ...
```

- [ ] **Step 7: Restore working state**

```bash
# Restore the working PAT (back to your original snapshot value)
export PRODUCTBOARD_ACCESS_TOKEN='<your-snapshot>'

# Optionally restore the OAuth backup or remove it
if [ -f "$HOME/Library/Application Support/productboard-mcp/tokens.json.bak" ]; then
  mv "$HOME/Library/Application Support/productboard-mcp/tokens.json.bak" \
     "$HOME/Library/Application Support/productboard-mcp/tokens.json"
fi
```

Restart Claude Code. Verify the MCP works in your default config.

- [ ] **Step 8: If all steps passed, push and publish**

```bash
git push origin main
git tag -a v2.1.0 -m "Release 2.1.0 — OAuth 2.0 authentication"
git push origin v2.1.0
npm publish
gh release create v2.1.0 --title "v2.1.0 — OAuth 2.0 authentication" --notes-file <(awk '/^## \[2.1.0\]/,/^## \[2.0.0\]/' CHANGELOG.md | sed '$d')
```

- [ ] **Step 9: Final ADO comment on story #220497**

After publish, add a comment to ADO story #220497 noting the 2.1.0 release ships OAuth and pointing at the design spec + CHANGELOG entry for caller-facing notes.

---

## Self-review

After writing the full plan, run a final check against the spec:

| Spec section | Plan task(s) | Notes |
|---|---|---|
| Goal / Drivers | Implicit (no code) | Captured in plan header |
| Critical constraint (no Client Credentials) | Implicit | Plan only implements Authorization Code |
| Architecture overview | Task 1-5 (file structure) | Auth resolver as choke point ✓ |
| Auth source resolution priority tree | Task 5 | `createAuthResolution()` ✓ |
| `PRODUCTBOARD_AUTH_MODE` semantics | Task 5 | `resolveAuthMode()` ✓ |
| Hard cutover 401 → "switch to OAuth" hint | Task 6 | `convertUnauthorizedToError()` ✓ |
| First-run setup flow (T+0 to T+N) | Task 4 | `performOAuthSetup` orchestrates ✓ |
| Scope presets (read/readwrite/full) | Task 1 + Task 4 | `SCOPE_PRESETS` + chooser HTML ✓ |
| 10-min timeout | Task 4 | `SETUP_TIMEOUT_MS` + setTimeout ✓ |
| Configurable params (5 env vars) | Task 5 | `resolveCallbackPort`/`resolveClientId`/etc ✓ |
| Tokens.json storage path (per OS) | Task 2 | `getTokenPath()` ✓ |
| Tokens.json schema | Task 1 + Task 2 | `TokenFile` interface ✓ |
| File perms 0600 + atomic write | Task 2 | `writeTokensAtomic()` ✓ |
| Proactive + reactive refresh | Task 3 | `refreshIfNeeded` + `forceRefresh` ✓ |
| Refresh details (rotation, backoff) | Task 3 | `performRefresh` ✓ |
| Hard error on invalid_grant | Task 3 | 400 handler ✓ |
| Concurrent access (two MCP instances) | Task 3 | Re-read disk before refresh ✓ |
| Error handling table (setup-time) | Task 4 | All paths in `handleRequest` + listener bind ✓ |
| Error handling table (runtime) | Task 3 + Task 6 | refresh hard error + 401 handler ✓ |
| Configuration errors | Task 5 | `resolveAuthMode`/`resolveCallbackPort`/etc ✓ |
| Structured error response shape | Task 1 + Task 5 | `AuthError` interface ✓ |
| Insufficient scope error | Task 6 (via PB 403 propagation) | Existing `handleResponse` surfaces 403 ✓ |
| Scopes (full table) | Task 1 | `SCOPE_PRESETS` ✓ |
| Code organization | Task 1-6 | Five new files in `src/auth/` ✓ |
| Version impact (minor 2.1.0) | Task 7 | `package.json` + `server.ts` ✓ |
| No new npm deps | Throughout | Only Node built-ins used ✓ |
| Tars integration (separate workstream) | N/A — explicitly out of scope | Documented in plan header ✓ |
| Out of scope items (keychain, file locking, etc.) | N/A — not implemented in v1 | Documented in spec ✓ |
| Security considerations (token-at-rest, CSRF, PKCE, loopback bind, stderr leak hardening) | Task 2 (0600), Task 4 (state nonce, PKCE, 127.0.0.1 only), Task 6 (Bearer validation) | All covered ✓ |
| Manual smoke test | Task 11 | Full 8-step checklist ✓ |

**No placeholders.** Every step has actual code or actual commands. The only intentional placeholder is the `DEFAULT_OAUTH_CLIENT_ID` (empty string) in `types.ts`, which is filled in during Task 11 prerequisites after the user registers the OAuth app — that is also documented inline in the code with a comment.

**Type consistency.** `TokenFile`, `AuthResolution`, `AuthError`, `ScopePreset`, and `SCOPE_PRESETS` are defined once in `types.ts` and used consistently in all dependent tasks. Method signatures (`getBearer()`, `handleUnauthorized()`, `readTokens()`, `writeTokensAtomic()`, `performOAuthSetup()`, `refreshIfNeeded()`, `forceRefresh()`, `createAuthResolution()`) match between definition and usage.

---

## Execution

This plan is intentionally task-granular but each task is a single logical chunk (not micro-step splits). The total work is roughly:

- Tasks 1-5: new code in `src/auth/` — ~700 LOC total, ~3-4 hours focused work
- Task 6: refactor `client.ts` and `index.ts` — ~1-1.5 hours
- Task 7: version bumps — minutes
- Tasks 8-10: documentation — ~30-45 minutes total
- Task 11: manual smoke test + publish — ~1 hour including OAuth app registration

End-state after Task 11: `@drmaxbdc/productboard-mcp@2.1.0` published to npm, GitHub Release tagged, ADO story commented.
