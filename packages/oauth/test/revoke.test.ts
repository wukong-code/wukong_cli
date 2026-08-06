import { describe, expect, it, vi } from 'vitest';

import { revokeRefreshToken } from '../src/revoke';
import type { OAuthFlowConfig } from '../src/types';

const CONFIG: OAuthFlowConfig = {
  name: 'wukong',
  oauthHost: 'https://auth.example.test/',
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};

describe('revokeRefreshToken', () => {
  it('posts the refresh token, hint, and fixed client id as form data', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await expect(
      revokeRefreshToken(CONFIG, 'refresh +/token', { fetchImpl }),
    ).resolves.toEqual({ kind: 'confirmed' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://auth.example.test/api/oauth/revoke');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      token: 'refresh +/token',
      token_type_hint: 'refresh_token',
      client_id: '17e5f671-d194-4dfb-9706-5516cb48c098',
    });
  });

  it.each([
    [429, 'rate_limited'],
    [503, 'server_error'],
    [400, 'request_rejected'],
    [204, 'unexpected_status'],
  ] as const)('keeps remote state unknown for HTTP %i', async (status, reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status }));

    await expect(revokeRefreshToken(CONFIG, 'refresh-token', { fetchImpl })).resolves.toEqual({
      kind: 'unknown',
      reason,
      status,
    });
  });

  it('keeps remote state unknown when the request cannot be sent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline');
    });

    await expect(revokeRefreshToken(CONFIG, 'refresh-token', { fetchImpl })).resolves.toEqual({
      kind: 'unknown',
      reason: 'network_or_timeout',
    });
  });
});
