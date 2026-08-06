import type { OAuthFlowConfig } from './types';

const DEFAULT_REVOKE_TIMEOUT_MS = 10_000;

export type RevokeRefreshTokenResult =
  | { readonly kind: 'confirmed' }
  | {
      readonly kind: 'unknown';
      readonly reason:
        | 'network_or_timeout'
        | 'rate_limited'
        | 'server_error'
        | 'request_rejected'
        | 'unexpected_status';
      readonly status?: number | undefined;
    };

export interface RevokeRefreshTokenOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Revoke a refresh token using the Wukong OAuth RFC 7009-style endpoint.
 *
 * This helper never throws for transport or HTTP failures: logout callers
 * must continue with local credential cleanup even when the server cannot
 * confirm revocation. Redirects are rejected so a refresh token can never be
 * forwarded to a different origin by a server response.
 */
export async function revokeRefreshToken(
  config: OAuthFlowConfig,
  refreshToken: string,
  options: RevokeRefreshTokenOptions = {},
): Promise<RevokeRefreshTokenResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
  const url = `${config.oauthHost.replace(/\/+$/, '')}/api/oauth/revoke`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: config.clientId,
      }),
      redirect: 'error',
      signal,
    });
  } catch {
    return { kind: 'unknown', reason: 'network_or_timeout' };
  }

  if (response.status === 200) return { kind: 'confirmed' };
  if (response.status === 429) {
    return { kind: 'unknown', reason: 'rate_limited', status: response.status };
  }
  if (response.status >= 500) {
    return { kind: 'unknown', reason: 'server_error', status: response.status };
  }
  if (response.status >= 400) {
    return { kind: 'unknown', reason: 'request_rejected', status: response.status };
  }
  return { kind: 'unknown', reason: 'unexpected_status', status: response.status };
}
