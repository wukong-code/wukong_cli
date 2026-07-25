import { ChatProviderError } from './errors';

export interface ProviderRequestPolicy {
  /**
   * Exact origin approved for this request. Paths may vary, but scheme, host,
   * and effective port must remain identical.
   */
  readonly expectedOrigin: string;
  /** Redirects are rejected by the transport before a second request is sent. */
  readonly redirect: 'error';
}

export function providerRequestOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ChatProviderError('Provider request policy contains an invalid endpoint.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username.length > 0
    || url.password.length > 0
  ) {
    throw new ChatProviderError('Provider request policy requires an HTTP(S) origin.');
  }
  return url.origin;
}

/**
 * Wrap the platform fetch with an exact-origin and no-redirect transport gate.
 *
 * `redirect: "error"` is deliberately stronger than allowing same-origin
 * redirects: no provider response can cause fetch to replay a prompt or API
 * key to a second URL. A direct request whose origin drifts is rejected before
 * invoking the underlying fetch at all.
 */
export function createOriginLockedFetch(
  policy: ProviderRequestPolicy,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  const expectedOrigin = providerRequestOrigin(policy.expectedOrigin);
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const requestUrl = input instanceof Request ? input.url : input.toString();
    if (providerRequestOrigin(requestUrl) !== expectedOrigin) {
      throw new ChatProviderError(
        `Provider request origin changed before send: expected ${expectedOrigin}.`,
      );
    }
    const response = await fetchImpl(input, {
      ...init,
      redirect: 'error',
    });
    if (response.url.length > 0 && providerRequestOrigin(response.url) !== expectedOrigin) {
      throw new ChatProviderError(
        `Provider response origin changed: expected ${expectedOrigin}.`,
      );
    }
    return response;
  };
}
