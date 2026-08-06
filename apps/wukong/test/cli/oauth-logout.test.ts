import { describe, expect, it, vi } from 'vitest';

import type { WukongConfig } from '@wukong/wukong-sdk';
import {
  resolveWukongOAuthKey,
  resolveWukongTokenStorageName,
  type RevokeRefreshTokenResult,
  type TokenInfo,
  type TokenStorage,
} from '@wukong/wukong-oauth';

import {
  formatManagedWukongLogoutMessage,
  logoutManagedWukongAccount,
} from '#/cli/lib/oauth-logout';

const TOKEN: TokenInfo = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 4_102_444_800,
  expiresIn: 3_600,
  scope: 'openid',
  tokenType: 'Bearer',
};
const TEST_BASE_URL = 'https://api.dev.example.test/coding/v1';
const TEST_OAUTH_HOST = 'https://auth.dev.example.test';
const TEST_OAUTH_KEY = resolveWukongOAuthKey({
  baseUrl: TEST_BASE_URL,
  oauthHost: TEST_OAUTH_HOST,
});
const TEST_STORAGE_NAME = resolveWukongTokenStorageName({ oauthKey: TEST_OAUTH_KEY });

class MemoryTokenStorage implements TokenStorage {
  readonly values = new Map<string, TokenInfo>();
  readonly removed: string[] = [];

  async load(name: string): Promise<TokenInfo | undefined> {
    return this.values.get(name);
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.values.set(name, token);
  }

  async remove(name: string): Promise<void> {
    this.removed.push(name);
    this.values.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

function managedConfig(): WukongConfig {
  return {
    providers: {
      'managed:wukong': {
        type: 'wukong',
        baseUrl: TEST_BASE_URL,
        oauth: {
          storage: 'file',
          key: TEST_OAUTH_KEY,
          oauthHost: TEST_OAUTH_HOST,
        },
      },
    },
  };
}

describe('logoutManagedWukongAccount', () => {
  it('revokes the stored refresh token and then clears local auth', async () => {
    const storage = new MemoryTokenStorage();
    storage.values.set(TEST_STORAGE_NAME, TOKEN);
    const logout = vi.fn(async () => ({}));
    const revokeImpl = vi.fn(async (): Promise<RevokeRefreshTokenResult> => ({
      kind: 'confirmed',
    }));

    const result = await logoutManagedWukongAccount(
      { homeDir: '/unused', auth: { logout } },
      { config: managedConfig(), storage, revokeImpl },
    );

    expect(revokeImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthHost: TEST_OAUTH_HOST,
        clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
      }),
      'refresh-token',
    );
    expect(logout).toHaveBeenCalledWith('managed:wukong');
    expect(storage.removed).toEqual([TEST_STORAGE_NAME]);
    expect(result).toEqual({ hadLocalAccount: true, remote: { kind: 'confirmed' } });
  });

  it('always clears local auth when remote revocation throws', async () => {
    const storage = new MemoryTokenStorage();
    storage.values.set(TEST_STORAGE_NAME, TOKEN);
    const logout = vi.fn(async () => ({}));
    const revokeImpl = vi.fn(async () => {
      throw new TypeError('offline');
    });

    const result = await logoutManagedWukongAccount(
      { homeDir: '/unused', auth: { logout } },
      { config: managedConfig(), storage, revokeImpl },
    );

    expect(logout).toHaveBeenCalledWith('managed:wukong');
    expect(storage.values.size).toBe(0);
    expect(result.remote).toEqual({ kind: 'unknown', reason: 'network_or_timeout' });
    expect(formatManagedWukongLogoutMessage(result)).toMatch(
      /remote revocation was not confirmed.*server session may still be active/u,
    );
  });

  it('removes the token file even when managed config cleanup fails', async () => {
    const storage = new MemoryTokenStorage();
    storage.values.set(TEST_STORAGE_NAME, TOKEN);
    const logout = vi.fn(async () => {
      throw new Error('config is read-only');
    });

    await expect(
      logoutManagedWukongAccount(
        { homeDir: '/unused', auth: { logout } },
        {
          config: managedConfig(),
          storage,
          revokeImpl: async () => ({ kind: 'confirmed' }),
        },
      ),
    ).rejects.toThrow(/Could not finish local Wukong logout: config is read-only/u);
    expect(storage.values.size).toBe(0);
  });

  it('is idempotent when no account or token exists', async () => {
    const storage = new MemoryTokenStorage();
    const logout = vi.fn(async () => ({}));
    const revokeImpl = vi.fn();

    const result = await logoutManagedWukongAccount(
      { homeDir: '/unused', auth: { logout } },
      { config: { providers: {} }, storage, revokeImpl },
    );

    expect(revokeImpl).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(storage.removed).toEqual(['wukong']);
    expect(result).toEqual({
      hadLocalAccount: false,
      remote: { kind: 'not_attempted', reason: 'no_refresh_token' },
    });
  });
});
