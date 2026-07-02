import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WukongOAuthToolkit,
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from '@wukong/wukong-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes, WukongError, WukongProvider } from '#/index';

import { TEST_IDENTITY } from './test-identity';

describe('WukongProvider OAuth error mapping', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'wukong-for-coding-provider-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  function resolveAuth() {
    const provider = new WukongProvider({ homeDir, ...TEST_IDENTITY });
    return provider.resolveAuth('wukong-for-coding');
  }

  it('maps unauthorized token failures to auth.login_required', async () => {
    vi.spyOn(WukongOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(
      new OAuthUnauthorizedError('No token for "wukong". Run /login to authenticate.'),
    );

    const auth = resolveAuth();
    await expect(auth(async () => 'ok')).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });

  it('maps transient token failures to provider.connection_error', async () => {
    const tokenErrors = [
      new OAuthConnectionError('OAuth request to https://example.test failed: fetch failed'),
      new RetryableRefreshError('Token refresh failed (HTTP 503).'),
    ];

    for (const tokenError of tokenErrors) {
      vi.spyOn(WukongOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(tokenError);

      const auth = resolveAuth();
      const caught = await auth(async () => 'ok').catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(WukongError);
      expect(caught).toMatchObject({
        code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
        message: expect.stringContaining(tokenError.message),
        cause: tokenError,
      });

      vi.restoreAllMocks();
    }
  });

  it('rethrows unrecognized OAuth errors raw instead of guessing a category', async () => {
    const oauthError = new OAuthError('Token refresh failed (HTTP 400).');
    vi.spyOn(WukongOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(oauthError);

    const auth = resolveAuth();
    await expect(auth(async () => 'ok')).rejects.toBe(oauthError);
  });
});
