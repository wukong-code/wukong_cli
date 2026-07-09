/**
 * OAuth error classes.
 *
 * All errors derive from {@link OAuthError}. Distinguishing subclasses let
 * callers react appropriately:
 *  - `OAuthUnauthorizedError`: 401/403 from token endpoint → refresh_token
 *    or credentials are bad; drive user through `/login` again.
 *  - `OAuthConnectionError`: transport-level OAuth request failure; callers
 *    may retry the operation.
 *  - `DeviceCodeExpiredError`: device_code TTL ran out before user approved;
 *    restart the device flow.
 *  - `DeviceCodeTimeoutError`: local 15 min wall-clock budget exhausted
 *    before the user completed approval.
 *  - `RetryableRefreshError`: 429 / 5xx from token endpoint; the refresh
 *    helper retries with exponential backoff before surfacing this.
 */

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export class OAuthUnauthorizedError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthUnauthorizedError';
  }
}

export class OAuthConnectionError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConnectionError';
  }
}

export class DeviceCodeExpiredError extends OAuthError {
  constructor(message = 'Device code expired.') {
    super(message);
    this.name = 'DeviceCodeExpiredError';
  }
}

export class DeviceCodeTimeoutError extends OAuthError {
  constructor(message = 'Device authorization timed out locally.') {
    super(message);
    this.name = 'DeviceCodeTimeoutError';
  }
}

export class RetryableRefreshError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}

/**
 * True when a token/model refresh failed because the user is not logged in
 * (or the stored token was revoked). Callers that refresh catalogs in the
 * background should treat this as an expected skip, not a user-facing warning.
 *
 * Accepts both {@link OAuthUnauthorizedError} and duck-typed public errors
 * (e.g. SDK `WukongError` with `code: 'auth.login_required'`).
 */
export function isOAuthLoginRequiredError(error: unknown): boolean {
  if (error instanceof OAuthUnauthorizedError) return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly name?: unknown }).name === 'OAuthUnauthorizedError'
  ) {
    return true;
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === 'auth.login_required') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /requires login before it can be used/i.test(message) ||
    /Run \/login to authenticate/i.test(message) ||
    /re-login required/i.test(message) ||
    /No token for "/i.test(message)
  );
}
