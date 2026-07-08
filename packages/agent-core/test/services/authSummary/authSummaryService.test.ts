import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WukongConfig } from '../../../src/config';
import {
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
} from '../../../src/services/authSummary/authSummary';
import { AuthSummaryService } from '../../../src/services/authSummary/authSummaryService';
import type { ICoreProcessService } from '../../../src/services/coreProcess/coreProcess';
import type { IEnvironmentService } from '../../../src/services/environment/environment';

const mockGetCachedAccessToken = vi.hoisted(() => vi.fn(async () => undefined as string | undefined));

vi.mock('../../../src/services/auth/managedAuth', () => ({
  createManagedAuthFacade: vi.fn(() => ({
    getCachedAccessToken: mockGetCachedAccessToken,
  })),
}));

const env: IEnvironmentService = {
  _serviceBrand: undefined,
  homeDir: '/tmp/wukong-auth-summary',
  configPath: '/tmp/wukong-auth-summary/config.toml',
};

function makeCore(config: WukongConfig): ICoreProcessService {
  return {
    _serviceBrand: undefined,
    rpc: {
      getWukongConfig: vi.fn(async () => config),
    },
  } as unknown as ICoreProcessService;
}

beforeEach(() => {
  mockGetCachedAccessToken.mockReset();
  mockGetCachedAccessToken.mockResolvedValue(undefined);
});

describe('AuthSummaryService.get', () => {
  it('reports no providers', async () => {
    const svc = new AuthSummaryService(env, makeCore({ providers: {} }));
    await expect(svc.get()).resolves.toEqual({
      ready: false,
      providers_count: 0,
      default_model: null,
      managed_provider: null,
    });
  });

  it('reports a provider without managed OAuth', async () => {
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { openai: { type: 'openai', apiKey: 'sk-openai' } },
        defaultModel: 'openai/gpt-4',
      }),
    );
    const summary = await svc.get();
    expect(summary.ready).toBe(true);
    expect(summary.providers_count).toBe(1);
    expect(summary.default_model).toBe('openai/gpt-4');
    expect(summary.managed_provider).toBeNull();
  });

  it('reports managed provider as authenticated when token is cached', async () => {
    mockGetCachedAccessToken.mockResolvedValue('cached-token');
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { 'managed:wukong': { type: 'wukong' } },
        defaultModel: 'wukong/k2',
      }),
    );
    const summary = await svc.get();
    expect(summary.managed_provider).toEqual({
      name: 'managed:wukong',
      status: 'authenticated',
    });
  });

  it('reports managed provider as unauthenticated when no token is cached', async () => {
    mockGetCachedAccessToken.mockResolvedValue(undefined);
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { 'managed:wukong': { type: 'wukong' } },
        defaultModel: 'wukong/k2',
      }),
    );
    const summary = await svc.get();
    expect(summary.managed_provider).toEqual({
      name: 'managed:wukong',
      status: 'unauthenticated',
    });
  });
});

describe('AuthSummaryService.ensureReady', () => {
  it('throws AuthProvisioningRequiredError when there are no providers', async () => {
    const svc = new AuthSummaryService(env, makeCore({ providers: {} }));
    await expect(svc.ensureReady()).rejects.toThrow(AuthProvisioningRequiredError);
  });

  it('throws AuthModelNotResolvedError when default model is missing', async () => {
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { openai: { type: 'openai', apiKey: 'sk-openai' } },
      }),
    );
    await expect(svc.ensureReady()).rejects.toThrow(
      expect.objectContaining({
        name: 'AuthModelNotResolvedError',
        modelId: undefined,
      }),
    );
  });

  it('throws AuthModelNotResolvedError when model alias is missing', async () => {
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { openai: { type: 'openai', apiKey: 'sk-openai' } },
        defaultModel: 'openai/gpt-4',
      }),
    );
    await expect(svc.ensureReady()).rejects.toThrow(
      expect.objectContaining({
        name: 'AuthModelNotResolvedError',
        modelId: 'openai/gpt-4',
      }),
    );
  });

  it('throws AuthModelNotResolvedError when provider is not configured', async () => {
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { openai: { type: 'openai', apiKey: 'sk-openai' } },
        defaultModel: 'anthropic/claude',
        models: {
          'anthropic/claude': {
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            maxContextSize: 200_000,
          },
        },
      }),
    );
    await expect(svc.ensureReady()).rejects.toThrow(
      expect.objectContaining({
        name: 'AuthModelNotResolvedError',
        modelId: 'anthropic/claude',
        providerId: 'anthropic',
      }),
    );
  });

  it('returns when api_key is present', async () => {
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { openai: { type: 'openai', apiKey: 'sk-openai' } },
        defaultModel: 'openai/gpt-4',
        models: {
          'openai/gpt-4': {
            provider: 'openai',
            model: 'gpt-4',
            maxContextSize: 128_000,
          },
        },
      }),
    );
    await expect(svc.ensureReady()).resolves.toBeUndefined();
  });

  it('returns when oauth provider has a cached token', async () => {
    mockGetCachedAccessToken.mockResolvedValue('cached-token');
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: {
          'managed:wukong': {
            type: 'wukong',
            oauth: { storage: 'file', key: 'wukong-token' },
          },
        },
        defaultModel: 'wukong/k2',
        models: {
          'wukong/k2': {
            provider: 'managed:wukong',
            model: 'k2',
            maxContextSize: 256_000,
          },
        },
      }),
    );
    await expect(svc.ensureReady()).resolves.toBeUndefined();
  });

  it('throws AuthTokenMissingError when oauth provider has no cached token', async () => {
    mockGetCachedAccessToken.mockResolvedValue(undefined);
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: {
          'managed:wukong': {
            type: 'wukong',
            oauth: { storage: 'file', key: 'wukong-token' },
          },
        },
        defaultModel: 'wukong/k2',
        models: {
          'wukong/k2': {
            provider: 'managed:wukong',
            model: 'k2',
            maxContextSize: 256_000,
          },
        },
      }),
    );
    await expect(svc.ensureReady()).rejects.toThrow(
      expect.objectContaining({
        name: 'AuthTokenMissingError',
        providerId: 'managed:wukong',
      }),
    );
  });

  it('throws AuthTokenMissingError when provider has neither api_key nor oauth', async () => {
    const svc = new AuthSummaryService(
      env,
      makeCore({
        providers: { openai: { type: 'openai' } },
        defaultModel: 'openai/gpt-4',
        models: {
          'openai/gpt-4': {
            provider: 'openai',
            model: 'gpt-4',
            maxContextSize: 128_000,
          },
        },
      }),
    );
    await expect(svc.ensureReady()).rejects.toThrow(
      expect.objectContaining({
        name: 'AuthTokenMissingError',
        providerId: 'openai',
      }),
    );
  });
});
