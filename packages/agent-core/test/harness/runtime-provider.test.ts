import { describe, expect, it } from 'vitest';

import type { WukongConfig } from '../../src/config';
import { ErrorCodes, WukongError } from '../../src/errors';
import { ProviderManager } from '../../src/session/provider-manager';
import { resolveThinkingLevel } from '../../src/agent/config/thinking';

// Thin wrapper that adapts the legacy `resolveRuntimeProvider(input)` shape to
// the current ProviderManager API. Kept local so the existing test bodies do
// not need to change.
function resolveRuntimeProvider(input: {
  readonly config: WukongConfig;
  readonly model?: string;
  readonly wukongRequestHeaders?: Record<string, string>;
  readonly promptCacheKey?: string;
}): ReturnType<ProviderManager['resolveProviderConfig']> {
  const manager = new ProviderManager({
    config: input.config,
    wukongRequestHeaders: input.wukongRequestHeaders,
    promptCacheKey: input.promptCacheKey,
  });
  const model = input.model ?? input.config.defaultModel;
  if (model === undefined) {
    throw new WukongError(
      ErrorCodes.CONFIG_INVALID,
      'No model is selected. Set default_model in config.toml or pass a configured model alias.',
    );
  }
  return manager.resolveProviderConfig(model);
}

const BASE_CONFIG: WukongConfig = {
  defaultModel: 'wukong/wukong-for-coding',
  providers: {
    'managed:wukong': {
      type: 'wukong',
      apiKey: 'test-key',
      baseUrl: 'https://api.example/v1',
    },
  },
  models: {
    'wukong/wukong-for-coding': {
      provider: 'managed:wukong',
      model: 'wukong-for-coding',
      maxContextSize: 1_000_000,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
    },
  },
};

const TEST_WUKONG_HEADERS = {
  'User-Agent': 'wukong-cli/0.0.0-test',
  'X-Wukong-Platform': 'wukong_cli',
  'X-Wukong-Version': '0.0.0-test',
};

describe('resolveRuntimeProvider model metadata', () => {
  it('uses config model metadata as the source of truth', () => {
    const resolved = resolveRuntimeProvider({
      config: BASE_CONFIG,
    });

    expect(resolved.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
    expect(resolved.provider.model).toBe('wukong-for-coding');
  });

  it('resolves requested aliases to the configured provider and provider model', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
            baseUrl: 'https://openai.example/v1',
          },
        },
        models: {
          ...BASE_CONFIG.models!,
          'gpt-alias': {
            provider: 'openai',
            model: 'gpt-runtime',
            maxContextSize: 200000,
            capabilities: ['tool_use'],
          },
        },
      },
      model: 'gpt-alias',
    });

    expect(resolved.providerName).toBe('openai');
    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-runtime',
      apiKey: 'sk-openai',
      baseUrl: 'https://openai.example/v1',
    });
    expect(resolved.modelCapabilities).toMatchObject({
      tool_use: true,
      max_context_tokens: 200000,
    });
  });

  it('uses config Wukong capabilities without requiring an api key during OAuth setup', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          'managed:wukong': {
            type: 'wukong',
            apiKey: '',
            baseUrl: 'https://api.example/v1',
            oauth: { storage: 'file', key: 'oauth/wukong' },
          },
        },
      },
    });

    expect(resolved.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('does not infer Wukong capabilities from the provider model name', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        models: {
          'wukong/wukong-for-coding': {
            provider: 'managed:wukong',
            model: 'wukong-for-coding',
            maxContextSize: 1_000_000,
          },
        },
      },
    });

    expect(resolved.modelCapabilities).toMatchObject({
      image_in: false,
      video_in: false,
      thinking: false,
      tool_use: false,
      max_context_tokens: 1_000_000,
    });
  });

  it('rejects provider model names that are not configured aliases', () => {
    expect(() =>
      resolveRuntimeProvider({
        config: BASE_CONFIG,
        model: 'wukong-for-coding',
      }),
    ).toThrow(/not configured in config.toml/);
  });

  it('throws when no model is selected', () => {
    expect(() =>
      resolveRuntimeProvider({
        config: {
          providers: {},
        },
      }),
    ).toThrow(/No model is selected/);
  });

  it('throws when the selected model is not configured as an alias', () => {
    expect(() =>
      resolveRuntimeProvider({
        config: BASE_CONFIG,
        model: 'wukong',
      }),
    ).toThrow(WukongError);
  });

  it('allows vertexai providers without an apiKey', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          vertex: {
            type: 'vertexai',
          },
        },
        models: {
          gemini: {
            provider: 'vertex',
            model: 'gemini-1.5-pro',
            maxContextSize: 1_000_000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({ type: 'vertexai' });
  });

  it('throws when the selected model alias has no maxContextSize', () => {
    const config = {
      ...BASE_CONFIG,
      models: {
        broken: {
          provider: 'managed:wukong',
          model: 'wukong-for-coding',
          capabilities: ['thinking'],
        },
      },
    } as unknown as WukongConfig;

    expect(() =>
      resolveRuntimeProvider({
        config,
        model: 'broken',
      }),
    ).toThrow(/max_context_size/);
  });
});

describe('resolveRuntimeProvider maxOutputSize forwarding', () => {
  it('returns alias.maxOutputSize for request completion budgeting', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
            baseUrl: 'https://openai.example/v1',
          },
        },
        models: {
          ...BASE_CONFIG.models!,
          'deepseek-alias': {
            provider: 'openai',
            model: 'deepseek-v4-flash',
            maxContextSize: 1_000_000,
            maxOutputSize: 384000,
          },
        },
      },
      model: 'deepseek-alias',
    });

    expect(resolved.maxOutputSize).toBe(384000);
  });

  it('forwards alias.maxOutputSize to the anthropic provider config as defaultMaxTokens', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'opus-alias': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
            maxOutputSize: 24000,
          },
        },
      },
      model: 'opus-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'claude-opus-4-7',
      defaultMaxTokens: 24000,
    });
  });

  it('omits defaultMaxTokens when alias.maxOutputSize is unset', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'opus-alias': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
          },
        },
      },
      model: 'opus-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'claude-opus-4-7',
    });
    expect('defaultMaxTokens' in resolved.provider).toBe(false);
  });

  it('forwards alias.adaptiveThinking to the anthropic provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'okapi-alias': {
            provider: 'anthropic',
            model: 'coding-model-okapi-0527-vibe',
            maxContextSize: 200000,
            adaptiveThinking: true,
          },
        },
      },
      model: 'okapi-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'coding-model-okapi-0527-vibe',
      adaptiveThinking: true,
    });
  });

  it('forwards alias.betaApi to the anthropic provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'wukong-alias': {
            provider: 'anthropic',
            model: 'wukong-for-coding',
            maxContextSize: 200000,
            protocol: 'anthropic',
            betaApi: true,
          },
        },
      },
      model: 'wukong-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'wukong-for-coding',
      betaApi: true,
    });
  });

  it('omits adaptiveThinking when alias.adaptiveThinking is unset', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'opus-alias': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
          },
        },
      },
      model: 'opus-alias',
    });

    expect('adaptiveThinking' in resolved.provider).toBe(false);
  });
});

describe('resolveRuntimeProvider Wukong request headers', () => {
  it('does not set defaultHeaders when no wukongRequestHeaders or customHeaders exist', () => {
    const resolved = resolveRuntimeProvider({ config: BASE_CONFIG });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      model: 'wukong-for-coding',
    });
    expect('defaultHeaders' in resolved.provider).toBe(false);
  });

  it('uses only customHeaders when wukongRequestHeaders are missing', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          'managed:wukong': {
            type: 'wukong',
            apiKey: 'test-key',
            baseUrl: 'https://api.example/v1',
            customHeaders: {
              'User-Agent': 'Custom/1',
            },
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      defaultHeaders: {
        'User-Agent': 'Custom/1',
      },
    });
  });

  it('passes wukongRequestHeaders through to Wukong provider defaultHeaders', () => {
    const resolved = resolveRuntimeProvider({
      config: BASE_CONFIG,
      wukongRequestHeaders: TEST_WUKONG_HEADERS,
    });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      defaultHeaders: TEST_WUKONG_HEADERS,
    });
  });

  it('passes the prompt cache key to Wukong generation kwargs', () => {
    const resolved = resolveRuntimeProvider({
      config: BASE_CONFIG,
      promptCacheKey: 'session-test',
    });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
  });

  it('lets provider customHeaders override wukongRequestHeaders', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          'managed:wukong': {
            type: 'wukong',
            apiKey: 'test-key',
            baseUrl: 'https://api.example/v1',
            customHeaders: {
              'User-Agent': 'Custom/1',
              'X-Wukong-Version': 'override-version',
            },
          },
        },
      },
      wukongRequestHeaders: TEST_WUKONG_HEADERS,
    });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      defaultHeaders: {
        'User-Agent': 'Custom/1',
        'X-Wukong-Platform': 'wukong_cli',
        'X-Wukong-Version': 'override-version',
      },
    });
  });

  it('applies only the User-Agent from wukongRequestHeaders to non-Wukong providers', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gpt-alias',
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
          },
        },
        models: {
          'gpt-alias': {
            provider: 'openai',
            model: 'gpt-runtime',
            maxContextSize: 200000,
          },
        },
      },
      wukongRequestHeaders: TEST_WUKONG_HEADERS,
      promptCacheKey: 'session-test',
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-runtime',
      apiKey: 'sk-openai',
      defaultHeaders: {
        'User-Agent': TEST_WUKONG_HEADERS['User-Agent'],
      },
    });
    // Device identity headers (`X-Wukong-*`) stay Wukong-only — they must not leak
    // to third-party providers.
    const headers = (resolved.provider as { defaultHeaders?: Record<string, string> })
      .defaultHeaders;
    expect(headers).toBeDefined();
    expect('X-Wukong-Platform' in headers!).toBe(false);
    expect('generationKwargs' in resolved.provider).toBe(false);
  });
});

describe('resolveRuntimeProvider customHeaders propagation', () => {
  it('forwards customHeaders to an anthropic provider', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude-alias',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
            customHeaders: { 'X-Custom': 'value' },
          },
        },
        models: {
          'claude-alias': { provider: 'anthropic', model: 'claude-runtime', maxContextSize: 200000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      defaultHeaders: { 'X-Custom': 'value' },
    });
  });

  it('passes the prompt cache key to Anthropic metadata.user_id', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude-alias',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
          },
        },
        models: {
          'claude-alias': { provider: 'anthropic', model: 'claude-runtime', maxContextSize: 200000 },
        },
      },
      promptCacheKey: 'session-test',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      metadata: { user_id: 'session-test' },
    });
  });

  it('omits Anthropic metadata when no prompt cache key is set', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude-alias',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
          },
        },
        models: {
          'claude-alias': { provider: 'anthropic', model: 'claude-runtime', maxContextSize: 200000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({ type: 'anthropic' });
    expect('metadata' in resolved.provider).toBe(false);
  });

  it('forwards customHeaders to an openai provider', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gpt-alias',
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
            customHeaders: { 'X-Custom': 'value' },
          },
        },
        models: {
          'gpt-alias': { provider: 'openai', model: 'gpt-runtime', maxContextSize: 200000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      defaultHeaders: { 'X-Custom': 'value' },
    });
  });

  it('forwards customHeaders to an openai_responses provider', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'resp-alias',
        providers: {
          openai_responses: {
            type: 'openai_responses',
            apiKey: 'sk-openai',
            customHeaders: { 'X-Custom': 'value' },
          },
        },
        models: {
          'resp-alias': {
            provider: 'openai_responses',
            model: 'gpt-runtime',
            maxContextSize: 200000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai_responses',
      defaultHeaders: { 'X-Custom': 'value' },
    });
  });

  it('keeps customHeaders isolated between resolved provider instances', () => {
    const config: WukongConfig = {
      defaultModel: 'gpt-alias',
      providers: {
        openai: {
          type: 'openai',
          apiKey: 'sk-openai',
          customHeaders: { 'X-Custom': 'original' },
        },
      },
      models: {
        'gpt-alias': { provider: 'openai', model: 'gpt-runtime', maxContextSize: 200000 },
      },
    };

    const first = resolveRuntimeProvider({ config });
    const second = resolveRuntimeProvider({ config });
    const firstHeaders = (first.provider as { defaultHeaders?: Record<string, string> })
      .defaultHeaders;
    expect(firstHeaders).toEqual({ 'X-Custom': 'original' });

    firstHeaders!['X-Custom'] = 'mutated';

    expect(
      (second.provider as { defaultHeaders?: Record<string, string> }).defaultHeaders,
    ).toEqual({ 'X-Custom': 'original' });
    expect(config.providers['openai']?.customHeaders).toEqual({ 'X-Custom': 'original' });
  });
});

describe('ProviderManager prompt cache key', () => {
  it('applies a prompt cache key to Wukong providers', () => {
    const manager = new ProviderManager({
      config: BASE_CONFIG,
      promptCacheKey: 'session-test',
    });
    const resolved = manager.resolveProviderConfig('wukong/wukong-for-coding');

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
  });

  it('does not add generation kwargs to non-Wukong providers', () => {
    const manager = new ProviderManager({
      promptCacheKey: 'session-test',
      config: {
        defaultModel: 'gpt-alias',
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
          },
        },
        models: {
          'gpt-alias': {
            provider: 'openai',
            model: 'gpt-runtime',
            maxContextSize: 200000,
          },
        },
      },
    });
    const resolved = manager.resolveProviderConfig('gpt-alias');

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-runtime',
    });
    expect('generationKwargs' in resolved.provider).toBe(false);
  });

  it('reads the current config when constructed with a function', () => {
    let sharedConfig: WukongConfig = { providers: {} };
    const manager = new ProviderManager({
      config: () => sharedConfig,
      promptCacheKey: 'session-test',
    });

    sharedConfig = BASE_CONFIG;

    const resolved = manager.resolveProviderConfig('wukong/wukong-for-coding');
    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
  });
});

describe('ProviderManager OAuth auth', () => {
  function oauthConfig(): WukongConfig {
    return {
      ...BASE_CONFIG,
      providers: {
        'managed:wukong': {
          type: 'wukong',
          apiKey: '',
          baseUrl: 'https://api.example/v1',
          oauth: { storage: 'file', key: 'oauth/wukong' },
        },
      },
    };
  }

  it('preserves non-Wukong token fetch failures instead of guessing their category', async () => {
    const tokenError = new Error('token storage permission denied');
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          throw tokenError;
        },
      }),
    });

    const resolveAuth = manager.resolveAuth('wukong/wukong-for-coding');
    expect(resolveAuth).toBeDefined();

    await expect(resolveAuth!(async () => 'ok')).rejects.toBe(tokenError);
  });

  it('keeps explicit login-required token failures as login-required errors', async () => {
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          throw new WukongError(ErrorCodes.AUTH_LOGIN_REQUIRED, 'not logged in');
        },
      }),
    });

    const resolveAuth = manager.resolveAuth('wukong/wukong-for-coding');
    expect(resolveAuth).toBeDefined();

    await expect(resolveAuth!(async () => 'ok')).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });
});

describe('resolveThinkingLevel', () => {
  it('normalizes requested thinking into a concrete effort', () => {
    expect(
      resolveThinkingLevel('on', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('medium');
    expect(
      resolveThinkingLevel('off', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('low', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('low');
    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('   ', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');

    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('medium');
    expect(
      resolveThinkingLevel('   ', {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('medium');

    expect(
      resolveThinkingLevel('on', {
        defaultThinking: true,
        thinking: { mode: 'auto' },
      }),
    ).toBe('high');
    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: true,
        thinking: { mode: 'auto' },
      }),
    ).toBe('high');

    expect(
      resolveThinkingLevel(undefined, {
        thinking: { mode: 'off' },
      }),
    ).toBe('off');

    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'off' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('   ', {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'off' },
      }),
    ).toBe('off');

    expect(resolveThinkingLevel(undefined, {})).toBe('high');
  });
});

describe('per-model protocol routing', () => {
  it('routes a protocol:anthropic model on a wukong provider through the anthropic transport with the REST base stripped of /v1', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        models: {
          'wukong/wukong-for-coding': {
            ...BASE_CONFIG.models!['wukong/wukong-for-coding']!,
            protocol: 'anthropic',
          },
        },
      },
    });

    expect(resolved.providerName).toBe('managed:wukong');
    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'wukong-for-coding',
      baseUrl: 'https://api.example',
    });
  });

  it('keeps a model without protocol on the provider wire type and leaves the REST base intact', () => {
    const resolved = resolveRuntimeProvider({ config: BASE_CONFIG });

    expect(resolved.provider).toMatchObject({
      type: 'wukong',
      model: 'wukong-for-coding',
      baseUrl: 'https://api.example/v1',
    });
  });

  it('does not strip the baseUrl of a provider that is itself typed anthropic', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
            baseUrl: 'https://api.anthropic.example/v1',
          },
        },
        models: {
          claude: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            maxContextSize: 200_000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.example/v1',
    });
  });
});
