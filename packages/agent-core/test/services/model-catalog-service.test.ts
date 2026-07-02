import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CoreRPC,
  GetWukongConfigPayload,
  WukongConfig,
  WukongConfigPatch,
  SetWukongConfigPayload,
} from '../../src';
import { WUKONG_CODE_PROVIDER_NAME } from '@wukong/wukong-oauth';

import {
  type ICoreProcessService,
  type IEnvironmentService,
  ModelCatalogService,
  ModelNotFoundError,
  ProviderNotFoundError,
  toProtocolModel,
  toProtocolProvider,
} from '../../src/services';
import type { ServicesAuthFacade } from '../../src/services/auth/managedAuth';
import type { IEventService } from '../../src/services/event/event';
import type { Event as ProtocolEvent } from '@wukong/protocol';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeEnv(): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir: '/tmp/wukong-model-catalog-test',
    configPath: '/tmp/wukong-model-catalog-test/config.toml',
  };
}

function makeCore(configRef: { current: WukongConfig }): {
  core: ICoreProcessService;
  getCalls: GetWukongConfigPayload[];
  setCalls: WukongConfigPatch[];
  removeCalls: string[];
} {
  const getCalls: GetWukongConfigPayload[] = [];
  const setCalls: WukongConfigPatch[] = [];
  const removeCalls: string[] = [];
  const rpc: Partial<CoreRPC> = {
    getWukongConfig: vi.fn(async (payload: GetWukongConfigPayload) => {
      getCalls.push(payload);
      return configRef.current;
    }),
    setWukongConfig: vi.fn(async (payload: SetWukongConfigPayload) => {
      setCalls.push(payload);
      const next: WukongConfig = { ...configRef.current };
      if (payload.providers !== undefined) {
        next.providers = payload.providers as WukongConfig['providers'];
      }
      if (payload.models !== undefined) {
        next.models = payload.models as WukongConfig['models'];
      }
      if (payload.defaultModel !== undefined) next.defaultModel = payload.defaultModel;
      if (payload.defaultThinking !== undefined) next.defaultThinking = payload.defaultThinking;
      configRef.current = next;
      return configRef.current;
    }),
    removeWukongProvider: vi.fn(async ({ providerId }) => {
      removeCalls.push(providerId);
      const providers = { ...configRef.current.providers };
      delete providers[providerId];
      const models = Object.fromEntries(
        Object.entries(configRef.current.models ?? {}).filter(([, model]) => model.provider !== providerId),
      ) as WukongConfig['models'];
      configRef.current = {
        ...configRef.current,
        providers,
        models,
        defaultModel: undefined,
      };
      return configRef.current;
    }),
  };
  return {
    core: {
      _serviceBrand: undefined,
      rpc: rpc as CoreRPC,
      ready: async () => undefined,
      dispose: () => undefined,
    },
    getCalls,
    setCalls,
    removeCalls,
  };
}

function authFacade(accessToken = 'token-test'): ServicesAuthFacade {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    getCachedAccessToken: vi.fn(async () => accessToken),
    resolveOAuthTokenProvider: vi.fn(() => ({
      getAccessToken: vi.fn(async () => accessToken),
    })),
  };
}

function makeEventService(): { svc: IEventService; published: ProtocolEvent[] } {
  const published: ProtocolEvent[] = [];
  const svc: IEventService = {
    _serviceBrand: undefined,
    onDidPublish: () => ({ dispose: () => undefined }),
    publish: (event) => {
      published.push(event);
    },
  };
  return { svc, published };
}

function catalogConfig(): WukongConfig {
  return {
    providers: {
      wukong: {
        type: 'wukong',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.test/v1',
      },
      openai: { type: 'openai' },
    },
    defaultModel: 'k2',
    models: {
      k2: {
        provider: 'wukong',
        model: 'wukong-k2',
        maxContextSize: 131072,
        displayName: 'Wukong K2',
        capabilities: ['thinking'],
      },
      turbo: {
        provider: 'wukong',
        model: 'wukong-turbo',
        maxContextSize: 32768,
      },
      gpt4o: {
        provider: 'openai',
        model: 'gpt-4o',
        maxContextSize: 128000,
      },
    },
  };
}

describe('model catalog adapters', () => {
  it('maps model aliases to selectable wire ids', () => {
    const alias = catalogConfig().models!['k2']!;
    expect(toProtocolModel('k2', alias)).toEqual({
      provider: 'wukong',
      model: 'k2',
      display_name: 'Wukong K2',
      max_context_size: 131072,
      capabilities: ['thinking'],
    });
  });

  it('uses the provider model name as display fallback', () => {
    const alias = catalogConfig().models!['turbo']!;
    expect(toProtocolModel('turbo', alias).display_name).toBe('wukong-turbo');
  });

  it('maps provider model ids and global default', () => {
    const config = catalogConfig();
    expect(
      toProtocolProvider('wukong', config.providers['wukong']!, config, {
        hasApiKey: true,
        hasOAuthToken: false,
      }),
    ).toEqual({
      id: 'wukong',
      type: 'wukong',
      base_url: 'https://api.example.test/v1',
      default_model: 'k2',
      has_api_key: true,
      status: 'connected',
      models: ['k2', 'turbo'],
    });
  });
});

describe('ModelCatalogService', () => {
  it('lists models and providers from live config', async () => {
    const configRef = { current: catalogConfig() };
    const { core, getCalls } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    expect(await svc.listModels()).toHaveLength(3);
    expect(await svc.listProviders()).toHaveLength(2);
    expect(getCalls).toEqual([{ reload: true }, { reload: true }]);
  });

  it('gets one provider or throws ProviderNotFoundError', async () => {
    const configRef = { current: catalogConfig() };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    await expect(svc.getProvider('wukong')).resolves.toMatchObject({ id: 'wukong' });
    await expect(svc.getProvider('missing')).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
  });

  it('sets defaultModel through core config patch', async () => {
    const configRef = { current: catalogConfig() };
    const { core, setCalls } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    await expect(svc.setDefaultModel('turbo')).resolves.toEqual({
      default_model: 'turbo',
      model: {
        provider: 'wukong',
        model: 'turbo',
        display_name: 'wukong-turbo',
        max_context_size: 32768,
      },
    });
    expect(setCalls).toEqual([{ defaultModel: 'turbo' }]);
  });

  it('rejects unknown model ids', async () => {
    const configRef = { current: catalogConfig() };
    const { core } = makeCore(configRef);
    const svc = new ModelCatalogService(makeEnv(), core, makeEventService().svc);

    await expect(svc.setDefaultModel('missing')).rejects.toBeInstanceOf(
      ModelNotFoundError,
    );
  });

  it('refreshes managed OAuth models and preserves always-thinking defaults', async () => {
    const configRef: { current: WukongConfig } = {
      current: {
        providers: {
          [WUKONG_CODE_PROVIDER_NAME]: {
            type: 'wukong',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/wukong' },
          },
        },
        defaultModel: 'wukong/wukong-for-coding',
        defaultThinking: false,
        models: {
          'wukong/wukong-for-coding': {
            provider: WUKONG_CODE_PROVIDER_NAME,
            model: 'wukong-for-coding',
            maxContextSize: 131_072,
            capabilities: ['thinking'],
          },
        },
      },
    };
    const { core, removeCalls, setCalls } = makeCore(configRef);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'wukong-for-coding',
          context_length: 262_144,
          supports_reasoning: true,
          supports_thinking_type: 'only',
          supports_image_in: false,
          supports_video_in: false,
        },
      ],
    })));
    vi.stubGlobal('fetch', fetchMock);
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade());

    await expect(svc.refreshOAuthProviderModels()).resolves.toMatchObject({
      changed: [{ provider_id: WUKONG_CODE_PROVIDER_NAME, added: 0, removed: 0 }],
      failed: [],
    });

    expect(removeCalls).toEqual([WUKONG_CODE_PROVIDER_NAME]);
    expect(setCalls.at(-1)).toMatchObject({
      defaultModel: 'wukong/wukong-for-coding',
      defaultThinking: true,
      models: {
        'wukong/wukong-for-coding': {
          capabilities: ['thinking', 'always_thinking', 'tool_use'],
          maxContextSize: 262_144,
        },
      },
    });
  });

  it('keeps the wukong provider on the REST base and records the model protocol when anthropic', async () => {
    const configRef: { current: WukongConfig } = {
      current: {
        providers: {
          [WUKONG_CODE_PROVIDER_NAME]: {
            type: 'wukong',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/wukong' },
          },
        },
        defaultModel: 'wukong/wukong-for-coding',
        models: {
          'wukong/wukong-for-coding': {
            provider: WUKONG_CODE_PROVIDER_NAME,
            model: 'wukong-for-coding',
            maxContextSize: 200_000,
          },
        },
      },
    };
    const { core, setCalls } = makeCore(configRef);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'wukong-for-coding',
                context_length: 200_000,
                protocol: 'anthropic',
              },
            ],
          }),
        ),
      ),
    );
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade());

    await svc.refreshOAuthProviderModels();

    const last = setCalls.at(-1) as Record<string, unknown>;
    const providers = last['providers'] as Record<string, { type: string; baseUrl: string }>;
    const models = last['models'] as Record<string, { provider: string; protocol?: string }>;
    // Provider type/baseUrl stay on the wukong wire + REST base; the anthropic
    // transport is carried on the model alias for per-model resolution.
    expect(providers[WUKONG_CODE_PROVIDER_NAME]?.type).toBe('wukong');
    expect(providers[WUKONG_CODE_PROVIDER_NAME]?.baseUrl).toBe('https://api.example.test/coding/v1');
    expect(models['wukong/wukong-for-coding']?.provider).toBe(WUKONG_CODE_PROVIDER_NAME);
    expect(models['wukong/wukong-for-coding']?.protocol).toBe('anthropic');
  });

  it('publishes event.model_catalog.changed when a broad refresh changes the catalog', async () => {
    const configRef: { current: WukongConfig } = {
      current: {
        providers: {
          [WUKONG_CODE_PROVIDER_NAME]: {
            type: 'wukong',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/wukong' },
          },
        },
        defaultModel: 'wukong/wukong-for-coding',
        models: {
          'wukong/wukong-for-coding': {
            provider: WUKONG_CODE_PROVIDER_NAME,
            model: 'wukong-for-coding',
            maxContextSize: 131_072,
            capabilities: ['thinking'],
          },
        },
      },
    };
    const { core } = makeCore(configRef);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'wukong-for-coding', context_length: 262_144, supports_reasoning: true }],
            }),
          ),
      ),
    );
    const { svc: eventService, published } = makeEventService();
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade(), eventService);

    const result = await svc.refreshProviderModels();

    expect(result.changed).toEqual([
      { provider_id: WUKONG_CODE_PROVIDER_NAME, provider_name: 'Wukong', added: 0, removed: 0 },
    ]);
    expect(published).toEqual([
      {
        type: 'event.model_catalog.changed',
        agentId: 'main',
        sessionId: '__global__',
        changed: result.changed,
        unchanged: result.unchanged,
        failed: [],
      },
    ]);
  });

  it('does not publish an event when the refresh is a no-op', async () => {
    const configRef: { current: WukongConfig } = {
      current: {
        providers: {
          [WUKONG_CODE_PROVIDER_NAME]: {
            type: 'wukong',
            apiKey: '',
            baseUrl: 'https://api.example.test/coding/v1',
            oauth: { storage: 'file', key: 'oauth/wukong' },
          },
        },
        models: {
          'wukong/wukong-for-coding': {
            provider: WUKONG_CODE_PROVIDER_NAME,
            model: 'wukong-for-coding',
            maxContextSize: 262_144,
            capabilities: ['thinking', 'tool_use'],
          },
        },
      },
    };
    const { core } = makeCore(configRef);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'wukong-for-coding', context_length: 262_144, supports_reasoning: true }],
            }),
          ),
      ),
    );
    const { svc: eventService, published } = makeEventService();
    const svc = ModelCatalogService._createForTest(makeEnv(), core, authFacade(), eventService);

    const result = await svc.refreshProviderModels();

    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([WUKONG_CODE_PROVIDER_NAME]);
    expect(published).toEqual([]);
  });
});
