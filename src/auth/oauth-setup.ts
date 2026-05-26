import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { writeTokensAtomic } from "./token-store.js";
import {
  createAuthError,
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
  /**
   * Confidential-client secret, included in token exchange when set. Required by
   * Productboard for any app registered manually via the admin UI (which always
   * issues a client_secret). Omitted from the request body when undefined so the
   * PKCE-only flow still works for true Public Clients.
   */
  clientSecret?: string;
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
      clientSecret: opts.clientSecret,
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
    // Browsers default to keep-alive on the OAuth callback. server.close() alone
    // would wait for those idle sockets to time out before emitting 'close',
    // hanging the MCP process. closeAllConnections() (Node ≥ 18.2) forces them shut.
    server.closeAllConnections();
    server.close();
  }
}

interface HandlerContext {
  clientId: string;
  clientSecret?: string;
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

  // Exchange code for tokens. client_secret is included when present (Confidential
  // Client, the only kind PB's admin UI issues). For true Public Clients (PKCE-only,
  // future dynamic-registration path), the secret is undefined and the body omits it.
  const exchangeParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: ctx.clientId,
    redirect_uri: ctx.redirectUri,
    code_verifier: ctx.codeVerifier,
  };
  if (ctx.clientSecret) {
    exchangeParams.client_secret = ctx.clientSecret;
  }
  const exchangeBody = new URLSearchParams(exchangeParams).toString();

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
    // Parse OAuth standard error fields only; never log the raw body. PB normally
    // returns {"error":"...","error_description":"..."}, but if anything ever echoes
    // request params (e.g. via a gateway-layer error) the raw body could contain
    // client_secret. Same defensive posture as buildHeaders() for Bearer values.
    const rawBody = await exchangeResponse.text().catch(() => "");
    let safeDetail = "(no parsable detail)";
    try {
      const parsed = JSON.parse(rawBody) as { error?: string; error_description?: string };
      const code = typeof parsed.error === "string" ? parsed.error : "";
      const desc = typeof parsed.error_description === "string" ? parsed.error_description : "";
      const combined = [code, desc].filter(Boolean).join(": ");
      if (combined) safeDetail = combined;
    } catch {
      // Non-JSON body: do not log it (may contain echoed credentials). Length only.
      safeDetail = `(non-JSON body, ${rawBody.length} chars suppressed)`;
    }
    res.statusCode = 500;
    res.end("Token exchange failed. See MCP stderr for details.");
    process.stderr.write(
      `[productboard-mcp] Token exchange failed: HTTP ${exchangeResponse.status} — ${safeDetail}\n`
    );
    ctx.onFailure(
      createAuthError(
        "expired",
        `Token exchange failed: HTTP ${exchangeResponse.status} — ${safeDetail}. This usually means client_id, client_secret, or redirect_uri mismatch. Verify your PB OAuth app config.`,
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
    const msg = (writeErr as Error).message ?? String(writeErr);
    process.stderr.write(`[productboard-mcp] Token persist error: ${msg}\n`);
    ctx.onFailure(
      createAuthError("filesystem", `Could not save tokens: ${msg}`, "restart_mcp")
    );
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

