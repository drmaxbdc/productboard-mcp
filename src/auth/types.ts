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
