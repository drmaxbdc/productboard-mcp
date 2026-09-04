import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createAuthError, setupHint } from "./types.js";
import { PRODUCTBOARD_OAUTH_ISSUER } from "./types.js";

const REGISTRATION_URL = `${PRODUCTBOARD_OAUTH_ISSUER}/oauth2/register`;

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

/** Persisted to disk at registration.json. Bump schemaVersion if the shape changes. */
export interface RegistrationFile {
  schemaVersion: 1;
  clientId: string;
  clientName: string;
  redirectUri: string;
  registeredAt: string;  // ISO 8601
  issuer: string;        // "https://app.productboard.com"
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the platform-native cache path for registration.json.
 * Override with PRODUCTBOARD_OAUTH_REGISTRATION_PATH for Docker volumes,
 * multi-tenant tests, etc.
 */
export function getRegistrationPath(): string {
  const override = process.env.PRODUCTBOARD_OAUTH_REGISTRATION_PATH;
  if (override) return override;

  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "productboard-mcp", "registration.json");
    case "win32": {
      const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
      return join(appData, "productboard-mcp", "registration.json");
    }
    default: {
      // Linux + other Unix
      const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
      return join(xdgConfig, "productboard-mcp", "registration.json");
    }
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Read registration.json from disk. Returns null if the file does not exist,
 * is malformed, or has an unsupported schemaVersion.
 * Filesystem errors other than ENOENT throw AuthError.
 */
export async function readRegistration(): Promise<RegistrationFile | null> {
  const path = getRegistrationPath();
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
    // File exists but is corrupt — treat as missing and let registration re-run.
    process.stderr.write(
      `[productboard-mcp] registration.json at ${path} is malformed; ignoring.\n`
    );
    return null;
  }

  // Basic shape check
  const r = parsed as Partial<RegistrationFile>;
  if (
    r?.schemaVersion !== 1 ||
    typeof r.clientId !== "string" ||
    typeof r.clientName !== "string" ||
    typeof r.redirectUri !== "string" ||
    typeof r.registeredAt !== "string" ||
    typeof r.issuer !== "string"
  ) {
    process.stderr.write(
      `[productboard-mcp] registration.json at ${path} has unexpected shape; ignoring.\n`
    );
    return null;
  }

  return r as RegistrationFile;
}

/**
 * Atomic write: stage to registration.json.tmp with 0600 perms, then rename().
 * POSIX rename is atomic — concurrent readers see either the old file or the new, never partial.
 */
export async function writeRegistration(r: RegistrationFile): Promise<void> {
  const path = getRegistrationPath();
  const tmpPath = `${path}.tmp`;
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmpPath, JSON.stringify(r, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, path);
  } catch (err: unknown) {
    // Best-effort cleanup of the staged tmp file; ignore failures since the
    // original error is more important and the tmp file may not exist.
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    const e = err as Error;
    throw createAuthError(
      "filesystem",
      `Cannot persist registration to ${path}: ${e.message}`,
      "set_env_var"
    );
  }
}

/**
 * Remove registration.json (e.g. on workspace change or fresh setup).
 * Idempotent — no error if the file is already absent.
 */
export async function deleteRegistration(): Promise<void> {
  const path = getRegistrationPath();
  try {
    await fs.unlink(path);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw e;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  callbackPort: number;
  clientName: string;
}

/**
 * Registers this MCP installation as a Public OAuth client via RFC 7591
 * Dynamic Client Registration. On success, persists the RegistrationFile and
 * returns it.
 *
 * Retry policy:
 *  - ONE retry on 429 (rate limit) with 2s sleep.
 *  - ONE retry on 5xx with 2s sleep.
 *  - ONE retry on network error with 2s sleep.
 *  - 4xx (non-429): throws immediately with PB's error body included.
 */
export async function registerClient(opts: RegisterOptions): Promise<RegistrationFile> {
  const redirectUri = `http://127.0.0.1:${opts.callbackPort}/callback`;
  const requestBody = JSON.stringify({
    redirect_uris: [redirectUri],
    client_name: opts.clientName,
    token_endpoint_auth_method: "none",
  });

  const MAX_ATTEMPTS = 2; // initial attempt + 1 retry

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(REGISTRATION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: requestBody,
      });
    } catch (netErr: unknown) {
      // Network error
      if (attempt === MAX_ATTEMPTS - 1) {
        throw createAuthError(
          "config_invalid",
          `Network error during OAuth client registration: ${(netErr as Error).message}. ` +
            `Check connectivity to app.productboard.com and retry.`,
          "set_env_var"
        );
      }
      await sleep(2000);
      continue;
    }

    if (response.status === 429) {
      // Rate limited — one retry after 2s
      if (attempt === MAX_ATTEMPTS - 1) {
        throw createAuthError(
          "config_invalid",
          `OAuth client registration rate-limited (HTTP 429) after ${MAX_ATTEMPTS} attempts. ` +
            `Productboard allows 5 registrations/min and 50/day per IP. Try again in a minute.`,
          "set_env_var"
        );
      }
      await sleep(2000);
      continue;
    }

    if (response.status >= 500) {
      // Server error — one retry after 2s
      if (attempt === MAX_ATTEMPTS - 1) {
        let errBody = "(no body)";
        try { errBody = await response.text(); } catch { /* ignore */ }
        throw createAuthError(
          "config_invalid",
          `OAuth client registration failed: HTTP ${response.status} from Productboard. ` +
            `Response: ${errBody}`,
          "set_env_var"
        );
      }
      await sleep(2000);
      continue;
    }

    if (response.status === 404) {
      // Productboard's documented Dynamic Client Registration endpoint is
      // currently unwired upstream. Walk the user through manual registration.
      let rawBody = "";
      try { rawBody = await response.text(); } catch { /* ignore */ }
      throw createAuthError(
        "config_invalid",
        `Productboard's Dynamic Client Registration endpoint returned HTTP 404 ` +
          `(POST ${REGISTRATION_URL}). The endpoint is documented but appears ` +
          `to be currently unavailable in production.\n\n` +
          `Workaround: register your OAuth app manually and provide both the ` +
          `client_id and client_secret via env vars.\n\n` +
          `Manual registration steps:\n` +
          `  1. Open https://app.productboard.com/oauth2/applications in your ` +
          `browser (must be a Productboard admin).\n` +
          `  2. Fill in the form. Required Redirect URI: ` +
          `http://127.0.0.1:${opts.callbackPort}/callback (matches the MCP's ` +
          `callback port; if you set PRODUCTBOARD_OAUTH_CALLBACK_PORT to a ` +
          `different value, use that port instead).\n` +
          `  3. Pick the V2 scopes your team needs (all 8 for full functionality: ` +
          `entities:read/write/delete, notes:read/write/delete, analytics:read, ` +
          `members_pii:read). Leave V1 scopes empty.\n` +
          `  4. After submission, copy the issued client_id AND client_secret. ` +
          `(PB's admin UI issues both for every manual registration — it does ` +
          `not offer a "Public Client" / PKCE-only option.) Export them:\n` +
          `       export PRODUCTBOARD_OAUTH_CLIENT_ID='<your-client-id>'\n` +
          `       export PRODUCTBOARD_OAUTH_CLIENT_SECRET='<your-client-secret>'\n` +
          `  5. Restart this MCP server.\n\n` +
          `Deployments whose setup tooling supplies both values do not need to ` +
          `do this.${setupHint()}\n\n` +
          `Raw upstream response body: ${rawBody || "(empty)"}`,
        "set_env_var"
      );
    }

    if (!response.ok) {
      // 4xx (non-429): configuration or request error — don't retry
      let errBody = "(no body)";
      try { errBody = await response.text(); } catch { /* ignore */ }
      throw createAuthError(
        "config_invalid",
        `OAuth client registration rejected: HTTP ${response.status} from Productboard. ` +
          `Response: ${errBody}`,
        "set_env_var"
      );
    }

    // 201 Created (or 200)
    const body = (await response.json()) as {
      client_id: string;
      client_id_issued_at?: number;
      client_name?: string;
    };

    if (typeof body.client_id !== "string" || !body.client_id) {
      throw createAuthError(
        "config_invalid",
        `OAuth registration response missing client_id. Body: ${JSON.stringify(body)}`,
        "set_env_var"
      );
    }

    const reg: RegistrationFile = {
      schemaVersion: 1,
      clientId: body.client_id,
      clientName: body.client_name ?? opts.clientName,
      redirectUri,
      registeredAt: new Date().toISOString(),
      issuer: PRODUCTBOARD_OAUTH_ISSUER,
    };

    await writeRegistration(reg);
    return reg;
  }

  // Unreachable — the loop always returns or throws.
  throw createAuthError(
    "config_invalid",
    "registerClient exhausted retries (unreachable)",
    "set_env_var"
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
