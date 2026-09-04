// Auth-related shared types, constants, and small cross-module runtime helpers.
// Runtime helpers (isAuthError, createAuthError, resolveClientSecret) live here
// so other auth modules can import them without creating import cycles —
// notably oauth-refresh.ts reading client_secret without depending on resolver.ts.

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

/**
 * Normalize a pasted client_secret.
 *
 * Users copy this value from an internal wiki page where it is presented as
 * part of a JSON fragment, so tolerate the shapes people actually paste:
 *   - surrounding whitespace and CR/LF (as before)
 *   - a leading variable name followed by `=` or `:`
 *   - wrapping single or double quotes
 *   - a trailing comma left over from a JSON fragment
 *
 * Returns undefined when nothing usable remains, so an empty or
 * quotes-only value is treated the same as an unset variable.
 *
 * Exported separately from resolveClientSecret() so it can be unit tested
 * without touching process.env.
 */
export function sanitizeClientSecret(raw: string): string | undefined {
  let s = raw.replace(/[\r\n]/g, "").trim();
  // Leading variable name, e.g. `KEY=`, `KEY: `, or `"KEY": ` from JSON.
  s = s.replace(/^["']?PRODUCTBOARD_OAUTH_CLIENT_SECRET["']?\s*[:=]\s*/i, "");
  // Trailing comma from a JSON fragment.
  s = s.replace(/,\s*$/, "");
  // Matched wrapping quotes.
  s = s.replace(/^(["'])([\s\S]*)\1$/, "$2");
  s = s.trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Read PRODUCTBOARD_OAUTH_CLIENT_SECRET from env. Required when the OAuth app
 * is a Confidential Client — Productboard's admin UI issues a client_secret for
 * every manually-registered app and offers no "Public Client" option. Optional
 * for true Public Clients (dynamic registration via /oauth2/register), which
 * use a PKCE-only flow without a secret.
 *
 * The value is distributed to Dr.Max users through their setup tooling, which
 * points them at an internal wiki page; see sanitizeClientSecret() for why
 * paste hygiene is handled here rather than assumed.
 *
 * Lives here, not in resolver.ts, so oauth-refresh.ts can read it at refresh
 * time without creating a resolver <-> refresh import cycle.
 */
export function resolveClientSecret(): string | undefined {
  const raw = process.env.PRODUCTBOARD_OAUTH_CLIENT_SECRET;
  if (!raw) return undefined;
  return sanitizeClientSecret(raw);
}

/**
 * True when the resolved OAuth client is the embedded, organization-registered
 * confidential client but no client_secret is available.
 *
 * Productboard's admin UI only issues confidential clients, so a token exchange
 * for this client_id without a secret is guaranteed to fail. Detecting it before
 * the browser opens avoids walking the user through a consent screen that cannot
 * succeed.
 *
 * Gated on the embedded client_id specifically: consumers who registered their
 * own true public client (PKCE, no secret) have a different client_id and are
 * unaffected.
 */
export function isMissingRequiredClientSecret(
  clientId: string,
  clientSecret: string | undefined
): boolean {
  return clientId === DEFAULT_OAUTH_CLIENT_ID && !clientSecret;
}

/**
 * Optional deployment-specific remediation text, appended to credential errors.
 *
 * This package is published publicly, so it must not hardcode any one
 * organization's tooling, wiki URLs, or command names. Deployments inject their
 * own instruction via PRODUCTBOARD_SETUP_HINT and it is echoed verbatim.
 *
 * Newlines are collapsed to spaces so an injected hint cannot break the framing
 * of a single-line stderr record.
 */
export function setupHint(): string {
  const hint = process.env.PRODUCTBOARD_SETUP_HINT?.replace(/[\r\n]+/g, " ").trim();
  return hint ? ` ${hint}` : "";
}
