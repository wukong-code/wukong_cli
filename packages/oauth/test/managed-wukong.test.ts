import { describe, expect, it, vi } from 'vitest';

import {
  applyManagedWukongLogoutConfig,
  applyManagedWukongConfig,
  clearManagedWukongConfig,
  fetchManagedWukongModels,
  WUKONG_CODE_OAUTH_KEY,
  WUKONG_CODE_PROVIDER_NAME,
  ManagedWukongModelsAuthError,
  provisionManagedWukongConfig,
  resolveWukongLoginAuth,
  resolveWukongOAuthKey,
  resolveWukongOAuthRef,
  resolveWukongRuntimeAuth,
  type ManagedWukongModelInfo,
  type ManagedWukongConfigShape,
} from '../src/managed-wukong';
import { OAuthUnauthorizedError } from '../src/errors';

function makeModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'wukong-for-coding',
          context_length: 262144,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: true,
          display_name: 'Wukong for Coding',
        },
        {
          id: 'wukong-k2.5',
          context_length: 250000,
          supports_reasoning: false,
          supports_image_in: false,
          supports_video_in: false,
          supports_tool_use: false,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('provisionManagedWukongConfig', () => {
  it('keeps the legacy credential key for the default production environment', () => {
    expect(
      resolveWukongOAuthKey({
        oauthHost: 'https://auth.wukong.today/',
        baseUrl: 'https://api.wukong.today/coding/v1/',
      }),
    ).toBe(WUKONG_CODE_OAUTH_KEY);
  });

  it('scopes credential keys for non-default OAuth hosts and API base URLs', () => {
    const devKey = resolveWukongOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });

    expect(devKey).not.toBe(WUKONG_CODE_OAUTH_KEY);
    expect(devKey).toMatch(/^oauth\.wukong-env-[a-f0-9]{16}$/);
    expect(
      resolveWukongOAuthKey({
        oauthHost: 'https://auth.dev.example.test/',
        baseUrl: 'https://api.dev.example.test/coding/v1/',
      }),
    ).toBe(devKey);
  });

  it('derives a full OAuth ref whose key and persisted host stay in sync', () => {
    // Default environment collapses to the legacy ref (no persisted host), so
    // existing production credentials keep resolving to `wukong.json`.
    expect(
      resolveWukongOAuthRef({
        oauthHost: 'https://auth.wukong.today/',
        baseUrl: 'https://api.wukong.today/coding/v1/',
      }),
    ).toEqual({ storage: 'file', key: WUKONG_CODE_OAUTH_KEY, oauthHost: undefined });

    const defaultAuthCustomApiRef = resolveWukongOAuthRef({
      baseUrl: 'https://api.example.test/coding/v1',
    });
    expect(defaultAuthCustomApiRef).toEqual({
      storage: 'file',
      key: resolveWukongOAuthKey({
        oauthHost: 'https://auth.wukong.today',
        baseUrl: 'https://api.example.test/coding/v1',
      }),
      oauthHost: 'https://auth.wukong.today',
    });

    // A non-default environment yields a scoped key AND the normalized host,
    // both derived from the same input — login and runtime cannot drift apart.
    const devRef = resolveWukongOAuthRef({
      oauthHost: 'https://auth.dev.example.test/',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    expect(devRef).toEqual({
      storage: 'file',
      key: resolveWukongOAuthKey({
        oauthHost: 'https://auth.dev.example.test',
        baseUrl: 'https://api.dev.example.test/coding/v1',
      }),
      oauthHost: 'https://auth.dev.example.test',
    });
  });

  it('resolves runtime auth from environment overrides over persisted config', () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const envBaseUrl = 'https://api.env.example.test/coding/v1/';
    const envOauthHost = 'https://auth.env.example.test/';
    const configuredOAuthRef = resolveWukongOAuthRef({
      baseUrl: configuredBaseUrl,
    });

    const auth = resolveWukongRuntimeAuth({
      configuredBaseUrl,
      configuredOAuthRef,
      env: {
        WUKONG_CODE_BASE_URL: envBaseUrl,
        WUKONG_CODE_OAUTH_HOST: envOauthHost,
      },
    });

    expect(auth.baseUrl).toBe('https://api.env.example.test/coding/v1');
    expect(auth.oauthRef).toEqual({
      storage: 'file',
      key: resolveWukongOAuthKey({
        oauthHost: 'https://auth.env.example.test',
        baseUrl: 'https://api.env.example.test/coding/v1',
      }),
      oauthHost: 'https://auth.env.example.test',
    });
  });

  it('preserves a matching configured runtime OAuth ref when env is not overridden', () => {
    const baseUrl = 'https://api.dev.example.test/coding/v1';
    const configuredOAuthRef = {
      storage: 'keyring' as const,
      key: resolveWukongOAuthKey({
        oauthHost: 'https://auth.dev.example.test',
        baseUrl,
      }),
      oauthHost: 'https://auth.dev.example.test',
    };

    expect(
      resolveWukongRuntimeAuth({
        configuredBaseUrl: baseUrl,
        configuredOAuthRef,
        env: {},
      }),
    ).toEqual({
      baseUrl,
      oauthRef: configuredOAuthRef,
    });
  });

  it('resolves login auth without reusing persisted refs under explicit or env overrides', () => {
    const configuredBaseUrl = 'https://api.configured.example.test/coding/v1';
    const configuredOAuthRef = resolveWukongOAuthRef({ baseUrl: configuredBaseUrl });

    expect(
      resolveWukongLoginAuth({
        configuredBaseUrl,
        configuredOAuthRef,
        requestedBaseUrl: 'https://api.requested.example.test/coding/v1/',
        env: {},
      }),
    ).toEqual({
      baseUrl: 'https://api.requested.example.test/coding/v1',
      oauthHost: undefined,
    });

    expect(
      resolveWukongLoginAuth({
        configuredBaseUrl,
        configuredOAuthRef,
        env: {},
      }),
    ).toEqual({
      baseUrl: configuredBaseUrl,
      oauthHost: undefined,
      oauthRef: configuredOAuthRef,
    });
  });

  it('writes the managed provider, models, services, and default model through an adapter', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
          baseUrl: 'https://example.test/v1',
        },
      },
      models: {
        'wukong/stale': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'stale',
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
        },
      },
    };
    const write = vi.fn();
    const fetchMock = vi.fn(async () => makeModelsResponse());

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
      adapter: {
        configPath: '/tmp/config.toml',
        read: () => config,
        write,
        apply: applyManagedWukongConfig,
      },
    });

    expect(result).toMatchObject({
      providerName: WUKONG_CODE_PROVIDER_NAME,
      defaultModel: 'wukong/wukong-for-coding',
      defaultThinking: true,
      configPath: '/tmp/config.toml',
    });
    expect(result.models[0]?.supportsToolUse).toBe(true);
    expect(result.models[1]?.supportsToolUse).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.wukong.today/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
          Accept: 'application/json',
        }),
      }),
    );
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const init = calls[0]?.[1] ?? {};
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-wukong-platform')).toBeNull();
    expect(write).toHaveBeenCalledWith(config);

    expect(config.providers['custom']).toMatchObject({
      apiKey: 'sk-existing',
    });
    expect(config.models?.['custom-default']?.provider).toBe('custom');
    expect(config.models?.['wukong/stale']).toBeUndefined();
    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'wukong',
      baseUrl: 'https://api.wukong.today/coding/v1',
      apiKey: '',
      oauth: { storage: 'file', key: WUKONG_CODE_OAUTH_KEY },
    });
    expect(config.models?.['wukong/wukong-for-coding']).toMatchObject({
      provider: WUKONG_CODE_PROVIDER_NAME,
      model: 'wukong-for-coding',
      maxContextSize: 262144,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Wukong for Coding',
    });
    expect(config.models?.['wukong/wukong-k2.5']?.capabilities).toBeUndefined();
    expect(config.services?.wukongSearch).toMatchObject({
      baseUrl: 'https://api.wukong.today/coding/v1/search',
      apiKey: '',
      oauth: { storage: 'file', key: WUKONG_CODE_OAUTH_KEY },
    });
    expect(Object.keys(config.services ?? {})).toEqual(['wukongSearch', 'wukongFetch']);
  });

  it('writes scoped OAuth refs when provisioning against a non-default environment', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {},
    };
    const oauthKey = resolveWukongOAuthKey({
      oauthHost: 'https://auth.dev.example.test',
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });

    await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      baseUrl: 'https://api.dev.example.test/coding/v1',
      oauthKey,
      oauthHost: 'https://auth.dev.example.test',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl: 'https://api.dev.example.test/coding/v1',
      oauth: {
        storage: 'file',
        key: oauthKey,
        oauthHost: 'https://auth.dev.example.test',
      },
    });
    expect(config.services?.wukongSearch?.oauth).toEqual({
      storage: 'file',
      key: oauthKey,
      oauthHost: 'https://auth.dev.example.test',
    });
    expect(config.services?.wukongFetch?.oauth).toEqual({
      storage: 'file',
      key: oauthKey,
      oauthHost: 'https://auth.dev.example.test',
    });
  });

  it('persists the default OAuth host when only the API base URL is scoped', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {},
    };
    const baseUrl = 'https://api.example.test/coding/v1';
    const oauthKey = resolveWukongOAuthKey({ baseUrl });

    await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      baseUrl,
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toMatchObject({
      baseUrl,
      oauth: {
        storage: 'file',
        key: oauthKey,
        oauthHost: 'https://auth.wukong.today',
      },
    });
  });

  it('preserves an existing valid default model during refresh', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
          baseUrl: 'https://example.test/v1',
        },
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: false,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
        'wukong/stale': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'stale',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultModel).toBe('custom-default');
    expect(config.defaultThinking).toBe(false);
    expect(config.models?.['wukong/stale']).toBeUndefined();
    expect(config.models?.['wukong/wukong-for-coding']?.displayName).toBe('Wukong for Coding');
  });

  it('infers default_thinking from fresh managed model capabilities', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
        },
      },
      defaultModel: 'wukong/wukong-for-coding',
      models: {
        'wukong/wukong-for-coding': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'wukong-for-coding',
          maxContextSize: 1000,
          capabilities: [],
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('wukong/wukong-for-coding');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('preserves explicit default_thinking when preserving a custom default without capabilities', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: true,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('defaults default_thinking to false when a preserved custom default has no signal', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('does not infer default_thinking from preserved custom default capabilities', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
          capabilities: [],
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('keeps default_thinking off even when preserved custom default has thinking capability', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
          capabilities: ['thinking'],
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('falls back to the first fetched model when the preserved default was removed', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
        },
      },
      defaultModel: 'wukong/stale',
      defaultThinking: false,
      models: {
        'wukong/stale': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'stale',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('wukong/wukong-for-coding');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultModel).toBe('wukong/wukong-for-coding');
    expect(config.defaultThinking).toBe(false);
  });

  it('removes managed provider, models, services, and default model on logout', () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
        },
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'wukong/wukong-for-coding',
      defaultThinking: true,
      models: {
        'wukong/wukong-for-coding': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'wukong-for-coding',
          maxContextSize: 262144,
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
      services: {
        wukongSearch: { baseUrl: 'https://api.wukong.today/coding/v1/search' },
        wukongFetch: { baseUrl: 'https://api.wukong.today/coding/v1/fetch' },
        customService: { baseUrl: 'https://service.example.test' },
      },
      raw: {
        default_model: 'wukong/wukong-for-coding',
        providers: {
          [WUKONG_CODE_PROVIDER_NAME]: { type: 'wukong' },
          custom: { type: 'wukong' },
        },
        models: {
          'wukong/wukong-for-coding': {
            provider: WUKONG_CODE_PROVIDER_NAME,
            model: 'wukong-for-coding',
          },
          'custom-default': {
            provider: 'custom',
            model: 'custom-model',
          },
        },
        services: {
          wukong_search: { base_url: 'https://api.wukong.today/coding/v1/search' },
          wukong_fetch: { base_url: 'https://api.wukong.today/coding/v1/fetch' },
        },
      },
    };

    applyManagedWukongLogoutConfig(config);

    expect(config.defaultModel).toBeUndefined();
    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toBeDefined();
    expect(config.models?.['wukong/wukong-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toBeDefined();
    expect(config.services?.wukongSearch).toBeUndefined();
    expect(config.services?.wukongFetch).toBeUndefined();
    expect(config.services?.['customService']).toEqual({
      baseUrl: 'https://service.example.test',
    });
  });

  it('rejects managed models that do not include a positive context_length', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'wukong-for-coding', supports_reasoning: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedWukongModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/positive context_length/);
  });

  it('surfaces API error messages from model listing failures', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedWukongModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toThrow('quota exceeded');
  });

  it('classifies model listing 401 responses as OAuth unauthorized', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'The API Key appears to be invalid or may have expired.' },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(
      fetchManagedWukongModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
  });

  it('classifies membership-check 402 responses as OAuth unauthorized', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
            },
          }),
          {
            status: 402,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;

    const promise = fetchManagedWukongModels({
      accessToken: 'oauth-access-token',
      baseUrl: 'https://api.dev.example.test/coding/v1',
      fetchImpl,
    });

    await expect(promise).rejects.toThrow(
      "Wukong models endpoint https://api.dev.example.test/coding/v1 rejected OAuth credentials: We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
    );
    await expect(
      fetchManagedWukongModels({
        accessToken: 'oauth-access-token',
        baseUrl: 'https://api.dev.example.test/coding/v1',
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 402,
      baseUrl: 'https://api.dev.example.test/coding/v1',
    });
    await expect(
      fetchManagedWukongModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    await expect(
      fetchManagedWukongModels({
        accessToken: 'oauth-access-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ManagedWukongModelsAuthError);
  });

  it('clears managed provider, models, default model, and services on logout', () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
          oauth: { storage: 'file', key: WUKONG_CODE_OAUTH_KEY },
        },
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'wukong/wukong-for-coding',
      models: {
        'wukong/wukong-for-coding': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'wukong-for-coding',
          maxContextSize: 262144,
        },
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 128000,
        },
      },
      services: {
        wukongSearch: {
          baseUrl: 'https://api.wukong.today/coding/v1/search',
          apiKey: '',
          oauth: { storage: 'file', key: WUKONG_CODE_OAUTH_KEY },
        },
        wukongFetch: {
          baseUrl: 'https://api.wukong.today/coding/v1/fetch',
          apiKey: '',
          oauth: { storage: 'file', key: WUKONG_CODE_OAUTH_KEY },
        },
        otherService: { baseUrl: 'https://service.example.test' },
      },
    };

    const result = clearManagedWukongConfig(config);

    expect(result).toMatchObject({
      providerName: WUKONG_CODE_PROVIDER_NAME,
      removedProvider: true,
      removedModels: ['wukong/wukong-for-coding'],
      defaultModelCleared: true,
      removedServices: ['wukongSearch', 'wukongFetch'],
    });
    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toMatchObject({ apiKey: 'sk-existing' });
    expect(config.defaultModel).toBeUndefined();
    expect(config.models?.['wukong/wukong-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toMatchObject({ provider: 'custom' });
    expect(config.services?.wukongSearch).toBeUndefined();
    expect(config.services?.wukongFetch).toBeUndefined();
    expect(config.services?.['otherService']).toMatchObject({
      baseUrl: 'https://service.example.test',
    });
  });
});

describe('supports_thinking_type', () => {
  function makeThinkingTypeModelsResponse(): Response {
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'wukong-for-coding',
            context_length: 262144,
            supports_reasoning: true,
            supports_image_in: true,
            supports_video_in: true,
            supports_thinking_type: 'only',
            display_name: 'Wukong',
          },
          {
            // 'no' is the authoritative declaration and overrides the legacy
            // supports_reasoning boolean.
            id: 'wukong-plain',
            context_length: 128000,
            supports_reasoning: true,
            supports_thinking_type: 'no',
          },
          {
            id: 'wukong-toggle',
            context_length: 128000,
            supports_reasoning: true,
            supports_thinking_type: 'both',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('parses supports_thinking_type from the models endpoint', async () => {
    const models = await fetchManagedWukongModels({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeThinkingTypeModelsResponse()) as unknown as typeof fetch,
    });

    expect(models[0]?.supportsThinkingType).toBe('only');
    expect(models[1]?.supportsThinkingType).toBe('no');
    expect(models[2]?.supportsThinkingType).toBe('both');
  });

  it('leaves supportsThinkingType undefined when the field is absent or invalid', async () => {
    const absent = await fetchManagedWukongModels({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeModelsResponse()) as unknown as typeof fetch,
    });
    expect(absent[0]?.supportsThinkingType).toBeUndefined();

    const invalid = await fetchManagedWukongModels({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'wukong-for-coding',
                  context_length: 262144,
                  supports_reasoning: true,
                  supports_thinking_type: 'maybe',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ) as unknown as typeof fetch,
    });
    expect(invalid[0]?.supportsThinkingType).toBeUndefined();
  });

  it('maps the three states onto capabilities, overriding supports_reasoning', async () => {
    const config: ManagedWukongConfigShape = { providers: {} };

    await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeThinkingTypeModelsResponse()) as unknown as typeof fetch,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    // 'only' → thinking locked on.
    expect(config.models?.['wukong/wukong-for-coding']?.capabilities).toEqual([
      'thinking',
      'always_thinking',
      'image_in',
      'video_in',
      'tool_use',
    ]);
    // 'no' → no thinking capability despite supports_reasoning=true.
    expect(config.models?.['wukong/wukong-plain']?.capabilities).toEqual(['tool_use']);
    // 'both' → plain toggleable thinking.
    expect(config.models?.['wukong/wukong-toggle']?.capabilities).toEqual([
      'thinking',
      'tool_use',
    ]);
  });

  it('forces default thinking on when the selected default model is thinking-only', async () => {
    const config: ManagedWukongConfigShape = { providers: {}, defaultThinking: false };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeThinkingTypeModelsResponse()) as unknown as typeof fetch,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('wukong/wukong-for-coding');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('forces default thinking on when preserving a thinking-only managed default', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
        },
      },
      defaultModel: 'wukong/wukong-for-coding',
      defaultThinking: false,
      models: {
        'wukong/wukong-for-coding': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'wukong-for-coding',
          maxContextSize: 262144,
          capabilities: ['thinking'],
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeThinkingTypeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('wukong/wukong-for-coding');
    expect(result.defaultThinking).toBe(true);
    expect(config.defaultThinking).toBe(true);
  });

  it('forces default thinking off when preserving a no-thinking managed default', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        [WUKONG_CODE_PROVIDER_NAME]: {
          type: 'wukong',
          apiKey: '',
        },
      },
      defaultModel: 'wukong/wukong-plain',
      defaultThinking: true,
      models: {
        'wukong/wukong-plain': {
          provider: WUKONG_CODE_PROVIDER_NAME,
          model: 'wukong-plain',
          maxContextSize: 128000,
          capabilities: ['thinking'],
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeThinkingTypeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('wukong/wukong-plain');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });

  it('keeps a preserved non-managed default thinking selection untouched', async () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        custom: {
          type: 'wukong',
          apiKey: 'sk-existing',
        },
      },
      defaultModel: 'custom-default',
      defaultThinking: false,
      models: {
        'custom-default': {
          provider: 'custom',
          model: 'custom-model',
          maxContextSize: 1000,
        },
      },
    };

    const result = await provisionManagedWukongConfig({
      accessToken: 'oauth-access-token',
      fetchImpl: vi.fn(async () => makeThinkingTypeModelsResponse()) as unknown as typeof fetch,
      preserveDefaultModel: true,
      adapter: {
        read: () => config,
        write: vi.fn(),
        apply: applyManagedWukongConfig,
      },
    });

    expect(result.defaultModel).toBe('custom-default');
    expect(result.defaultThinking).toBe(false);
    expect(config.defaultThinking).toBe(false);
  });
});

function makeModelInfo(
  id: string,
  overrides: Partial<ManagedWukongModelInfo> = {},
): ManagedWukongModelInfo {
  return {
    id,
    contextLength: 200000,
    supportsReasoning: false,
    supportsImageIn: false,
    supportsVideoIn: false,
    ...overrides,
  };
}

const WUKONG_BASE_URL = 'https://api.wukong.today/coding/v1';

describe('managed protocol routing', () => {
  it('reads protocol from the /models response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'wukong-for-coding', context_length: 262144, protocol: 'anthropic' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const models = await fetchManagedWukongModels({ accessToken: 't', fetchImpl });
    expect(models).toHaveLength(1);
    expect(models[0]?.protocol).toBe('anthropic');
  });

  it('keeps the provider on the wukong REST base and records the model protocol when anthropic', () => {
    const config: ManagedWukongConfigShape = { providers: {} };
    applyManagedWukongConfig(config, {
      baseUrl: WUKONG_BASE_URL,
      models: [makeModelInfo('wukong-for-coding', { protocol: 'anthropic' })],
    });

    // The provider stays on the wukong wire + REST base; the anthropic transport
    // is resolved per-model at runtime, not baked into the provider config, so
    // the REST base keeps flowing to OAuth key derivation and plugin env.
    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'wukong',
      baseUrl: WUKONG_BASE_URL,
      apiKey: '',
    });
    expect(config.models?.['wukong/wukong-for-coding']).toMatchObject({
      provider: WUKONG_CODE_PROVIDER_NAME,
      protocol: 'anthropic',
      betaApi: true,
    });
  });

  it('keeps the wukong protocol and baseUrl when the model has no anthropic protocol', () => {
    const config: ManagedWukongConfigShape = { providers: {} };
    applyManagedWukongConfig(config, {
      baseUrl: WUKONG_BASE_URL,
      models: [makeModelInfo('wukong-for-coding')],
    });

    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'wukong',
      baseUrl: WUKONG_BASE_URL,
      apiKey: '',
    });
    expect(config.models?.['wukong/wukong-for-coding']?.provider).toBe(WUKONG_CODE_PROVIDER_NAME);
    expect(config.models?.['wukong/wukong-for-coding']?.protocol).toBeUndefined();
  });

  it('drops the model protocol on refresh when the server stops declaring anthropic', () => {
    const config: ManagedWukongConfigShape = { providers: {} };
    applyManagedWukongConfig(config, {
      baseUrl: WUKONG_BASE_URL,
      models: [makeModelInfo('wukong-for-coding', { protocol: 'anthropic' })],
    });
    expect(config.models?.['wukong/wukong-for-coding']?.protocol).toBe('anthropic');

    applyManagedWukongConfig(config, {
      baseUrl: WUKONG_BASE_URL,
      models: [makeModelInfo('wukong-for-coding')],
    });
    // The provider never leaves the wukong wire / REST base across refreshes —
    // only the per-model protocol annotation changes.
    expect(config.providers[WUKONG_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'wukong',
      baseUrl: WUKONG_BASE_URL,
    });
    expect(config.models?.['wukong/wukong-for-coding']?.protocol).toBeUndefined();
  });
});
