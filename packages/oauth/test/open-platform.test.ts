import { describe, expect, it, vi } from 'vitest';

import {
  applyOpenPlatformConfig,
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  OPEN_PLATFORMS,
  OpenPlatformApiError,
  removeOpenPlatformConfig,
  type ManagedWukongConfigShape,
} from '../src/open-platform';

function makeModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'wukong-k2-0712-preview',
          context_length: 256000,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: true,
          display_name: 'Wukong K2 0712 Preview',
        },
        {
          id: 'wukong-k2-lite',
          context_length: 128000,
          supports_reasoning: false,
          supports_image_in: false,
          supports_video_in: false,
          supports_tool_use: false,
        },
        {
          id: 'non-wukong-model',
          context_length: 1000,
          supports_reasoning: false,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('OPEN_PLATFORMS', () => {
  it('contains wukong.cn and wukong.ai', () => {
    expect(getOpenPlatformById('wukong-cn')).toMatchObject({
      name: 'Wukong Platform (API key · platform.wukong.today)',
      baseUrl: 'https://api.wukong.cn/v1',
      consoleUrl: 'https://platform.wukong.today',
      allowedPrefixes: ['wukong-k'],
    });
    expect(getOpenPlatformById('wukong-ai')).toMatchObject({
      name: 'Wukong Platform (API key · platform.wukong.ai)',
      baseUrl: 'https://api.wukong.ai/v1',
      consoleUrl: 'https://platform.wukong.ai',
      allowedPrefixes: ['wukong-k'],
    });
    expect(getOpenPlatformById('unknown')).toBeUndefined();
  });

  it('isOpenPlatformId works', () => {
    expect(isOpenPlatformId('wukong-cn')).toBe(true);
    expect(isOpenPlatformId('wukong-ai')).toBe(true);
    expect(isOpenPlatformId('wukong')).toBe(false);
  });
});

describe('fetchOpenPlatformModels', () => {
  it('lists and parses models from the platform endpoint', async () => {
    const fetchMock = vi.fn(async () => makeModelsResponse());
    const platform = getOpenPlatformById('wukong-cn')!;

    const models = await fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch);

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 'wukong-k2-0712-preview',
      contextLength: 256000,
      supportsReasoning: true,
      supportsImageIn: true,
      supportsVideoIn: true,
      displayName: 'Wukong K2 0712 Preview',
    });
    expect(models[1]?.supportsToolUse).toBe(false);
    expect(models[2]?.id).toBe('non-wukong-model');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.wukong.cn/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('surfaces API error messages and status on HTTP error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid API key' } }), { status: 401 }),
    );
    const platform = getOpenPlatformById('wukong-cn')!;

    const error = await fetchOpenPlatformModels(
      platform,
      'sk-bad',
      fetchMock as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenPlatformApiError);
    expect((error as OpenPlatformApiError).status).toBe(401);
    expect((error as Error).message).toBe('invalid API key');
  });

  it('throws on unexpected response shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const platform = getOpenPlatformById('wukong-cn')!;

    await expect(
      fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/Unexpected models response/);
  });
});

describe('filterModelsByPrefix', () => {
  it('filters by allowedPrefixes when present', () => {
    const platform = getOpenPlatformById('wukong-cn')!;
    const models = [
      { id: 'wukong-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true },
      { id: 'gpt-4', contextLength: 1000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const filtered = filterModelsByPrefix(models as unknown as import('../src/managed-wukong').ManagedWukongModelInfo[], platform);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('wukong-k2-0712-preview');
  });

  it('returns all models when allowedPrefixes is absent', () => {
    const platform: import('../src/open-platform').OpenPlatformDefinition = {
      id: 'custom',
      name: 'Custom',
      baseUrl: 'https://example.com/v1',
    };
    const models = [
      { id: 'model-a', contextLength: 1000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
      { id: 'model-b', contextLength: 2000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const filtered = filterModelsByPrefix(models as unknown as import('../src/managed-wukong').ManagedWukongModelInfo[], platform);
    expect(filtered).toHaveLength(2);
  });
});

describe('fetchOpenPlatformModels supports_thinking_type', () => {
  it('parses supports_thinking_type from the models endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'wukong-k2-deep',
                context_length: 256000,
                supports_reasoning: true,
                supports_thinking_type: 'only',
              },
              {
                id: 'wukong-k2-lite',
                context_length: 128000,
                supports_reasoning: false,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const platform = getOpenPlatformById('wukong-cn')!;

    const models = await fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch);

    expect(models[0]?.supportsThinkingType).toBe('only');
    expect(models[1]?.supportsThinkingType).toBeUndefined();
  });
});

describe('capabilitiesForModel', () => {
  it("locks thinking on for 'only' models", () => {
    const model = {
      id: 'deep',
      contextLength: 1000,
      supportsReasoning: true,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: false,
      supportsThinkingType: 'only' as const,
    };
    expect(capabilitiesForModel(model)).toEqual(['thinking', 'always_thinking']);
  });

  it("lets 'no' override the legacy supports_reasoning boolean", () => {
    const model = {
      id: 'plain',
      contextLength: 1000,
      supportsReasoning: true,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: false,
      supportsThinkingType: 'no' as const,
    };
    expect(capabilitiesForModel(model)).toBeUndefined();
  });

  it("emits a plain toggleable thinking capability for 'both'", () => {
    const model = {
      id: 'toggle',
      contextLength: 1000,
      supportsReasoning: false,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: false,
      supportsThinkingType: 'both' as const,
    };
    expect(capabilitiesForModel(model)).toEqual(['thinking']);
  });

  it('returns undefined for a model with no capabilities', () => {
    const model = {
      id: 'plain',
      contextLength: 1000,
      supportsReasoning: false,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: false,
    };
    expect(capabilitiesForModel(model)).toBeUndefined();
  });

  it('returns all caps for a full-featured model', () => {
    const model = {
      id: 'full',
      contextLength: 1000,
      supportsReasoning: true,
      supportsImageIn: true,
      supportsVideoIn: true,
      supportsToolUse: true,
    };
    expect(capabilitiesForModel(model)).toEqual(['thinking', 'image_in', 'video_in', 'tool_use']);
  });
});

describe('applyOpenPlatformConfig', () => {
  it('writes provider, models, and defaults', () => {
    const config: ManagedWukongConfigShape = {
      providers: {},
    };
    const platform = getOpenPlatformById('wukong-cn')!;
    const models = [
      { id: 'wukong-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true, displayName: 'Wukong K2' },
      { id: 'wukong-k2-lite', contextLength: 128000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const result = applyOpenPlatformConfig(config, {
      platform,
      models,
      selectedModel: models[0]!,
      thinking: true,
      apiKey: 'sk-test',
    });

    expect(result).toEqual({
      defaultModel: 'wukong-cn/wukong-k2-0712-preview',
      defaultThinking: true,
    });

    expect(config.providers['wukong-cn']).toMatchObject({
      type: 'wukong',
      baseUrl: 'https://api.wukong.cn/v1',
      apiKey: 'sk-test',
    });
    expect(config.models?.['wukong-cn/wukong-k2-0712-preview']).toMatchObject({
      provider: 'wukong-cn',
      model: 'wukong-k2-0712-preview',
      maxContextSize: 256000,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Wukong K2',
    });
    expect(config.defaultModel).toBe('wukong-cn/wukong-k2-0712-preview');
    expect(config.defaultThinking).toBe(true);
    expect(config.services).toBeUndefined();
  });

  it('clears stale models for the same provider', () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        'wukong-cn': { type: 'wukong', baseUrl: 'https://api.wukong.cn/v1', apiKey: 'sk-old' },
      },
      models: {
        'wukong-cn/stale': { provider: 'wukong-cn', model: 'stale', maxContextSize: 1000 },
        'other/model': { provider: 'other', model: 'other-model', maxContextSize: 1000 },
      },
    };
    const platform = getOpenPlatformById('wukong-cn')!;
    const models = [
      { id: 'wukong-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true },
    ];

    applyOpenPlatformConfig(config, {
      platform,
      models,
      selectedModel: models[0]!,
      thinking: false,
      apiKey: 'sk-new',
    });

    expect(config.models?.['wukong-cn/stale']).toBeUndefined();
    expect(config.models?.['other/model']).toBeDefined();
  });
});

describe('removeOpenPlatformConfig', () => {
  it('removes provider, its models, and defaultModel when matched', () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        'wukong-cn': { type: 'wukong', baseUrl: 'https://api.wukong.cn/v1', apiKey: 'sk-test' },
        'other': { type: 'wukong', baseUrl: 'https://other.test/v1', apiKey: 'sk-other' },
      },
      models: {
        'wukong-cn/wukong-k2': { provider: 'wukong-cn', model: 'wukong-k2', maxContextSize: 256000 },
        'other/model': { provider: 'other', model: 'other-model', maxContextSize: 1000 },
      },
      defaultModel: 'wukong-cn/wukong-k2',
    };

    removeOpenPlatformConfig(config, 'wukong-cn');

    expect(config.providers['wukong-cn']).toBeUndefined();
    expect(config.providers['other']).toBeDefined();
    expect(config.models?.['wukong-cn/wukong-k2']).toBeUndefined();
    expect(config.models?.['other/model']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
  });

  it('leaves defaultModel intact when it belongs to another provider', () => {
    const config: ManagedWukongConfigShape = {
      providers: {
        'wukong-cn': { type: 'wukong', baseUrl: 'https://api.wukong.cn/v1', apiKey: 'sk-test' },
      },
      models: {
        'wukong-cn/wukong-k2': { provider: 'wukong-cn', model: 'wukong-k2', maxContextSize: 256000 },
      },
      defaultModel: 'other/model',
    };

    removeOpenPlatformConfig(config, 'wukong-cn');

    expect(config.defaultModel).toBe('other/model');
  });
});
