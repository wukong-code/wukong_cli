import { describe, expect, it, vi } from 'vitest';

import { OAuthUnauthorizedError } from '../src/errors';
import { WUKONG_CODE_PROVIDER_NAME } from '../src/managed-wukong';
import { refreshProviderModels, type RefreshProviderHost } from '../src/refreshProviderModels';

function makeHost(overrides: Partial<RefreshProviderHost> = {}): RefreshProviderHost {
  const config = {
    providers: {
      [WUKONG_CODE_PROVIDER_NAME]: {
        type: 'wukong',
        apiKey: '',
        baseUrl: 'https://wukong.today/api/v1',
        oauth: { storage: 'file' as const, key: 'oauth/wukong', oauthHost: 'https://wukong.today' },
      },
    },
    models: {},
  };
  return {
    getConfig: vi.fn(async () => structuredClone(config)),
    removeProvider: vi.fn(async () => structuredClone(config)),
    setConfig: vi.fn(async (patch) => ({ ...structuredClone(config), ...patch })),
    resolveOAuthToken: vi.fn(async () => {
      throw new OAuthUnauthorizedError('No token for "managed:wukong". Run /login to authenticate.');
    }),
    ...overrides,
  };
}

describe('refreshProviderModels', () => {
  it('treats managed:wukong login-required as an expected skip, not a failure', async () => {
    const host = makeHost();

    const result = await refreshProviderModels(host);

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([WUKONG_CODE_PROVIDER_NAME]);
    expect(result.changed).toEqual([]);
  });

  it('still reports non-auth managed:wukong refresh failures', async () => {
    const host = makeHost({
      resolveOAuthToken: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    const result = await refreshProviderModels(host);

    expect(result.unchanged).toEqual([]);
    expect(result.failed).toEqual([
      { provider: WUKONG_CODE_PROVIDER_NAME, reason: 'network down' },
    ]);
  });

  it('treats duck-typed auth.login_required as an expected skip', async () => {
    const host = makeHost({
      resolveOAuthToken: vi.fn(async () => {
        throw Object.assign(
          new Error('OAuth provider "managed:wukong" requires login before it can be used.'),
          { code: 'auth.login_required' },
        );
      }),
    });

    const result = await refreshProviderModels(host);

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([WUKONG_CODE_PROVIDER_NAME]);
  });
});
