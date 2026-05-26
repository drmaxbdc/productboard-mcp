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
    typeof t.clientId !== "string" ||
    typeof t.createdAt !== "string" ||
    typeof t.updatedAt !== "string" ||
    typeof t.issuer !== "string"
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
    // Best-effort cleanup of the staged tmp file; ignore failures since the
    // original error is more important and the tmp file may not exist.
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
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
