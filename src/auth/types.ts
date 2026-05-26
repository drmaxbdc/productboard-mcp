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

/**
 * Runtime type guard for AuthError. Use in catch blocks (where the value is `unknown`)
 * before reading `kind` / `remediation` / `setupUrl` / `detail` fields.
 */
export function isAuthError(e: unknown): e is AuthError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as AuthError).authError === true
  );
}

/**
 * Factory for AuthError instances. Use everywhere in the auth/ tree so the
 * brand fields and shape stay consistent.
 */
export function createAuthError(
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
 * Dr.Max-registered OAuth Public Client `client_id`, obtained via manual
 * registration at https://app.productboard.com/oauth2/applications. Used as
 * the default when the consumer does not set PRODUCTBOARD_OAUTH_CLIENT_ID
 * and registration.json does not exist yet.
 *
 * Non-Dr.Max consumers can override with their own OAuth app's client_id
 * via the PRODUCTBOARD_OAUTH_CLIENT_ID env var.
 *
 * Dynamic Client Registration (RFC 7591) at /oauth2/register is documented
 * by Productboard but currently returns 404 in production (Kong gateway
 * has no backend wired). Will be re-checked when PB confirms a fix; the
 * fallback to /oauth2/register in resolver.ts still runs and will start
 * working automatically the day the endpoint comes online.
 */
export const DEFAULT_OAUTH_CLIENT_ID: string = "xVJ-rOhRtGP8-BtqtaEovF8YlR6VMp91PG_mznsUCGE";
