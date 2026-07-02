import { describe, expect, it, vi } from 'vitest';
import { emptyUsage } from '@wukong/kosong';

import { ProviderManager } from '../../src/session/provider-manager';
import { testAgent } from './harness';

describe('ConfigState model capabilities', () => {
  it('computes provider and model capabilities from ProviderManager metadata', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            wukong: {
              type: 'wukong',
              apiKey: 'test-key',
            },
          },
          models: {
            'wukong/wukong-for-coding': {
              provider: 'wukong',
              model: 'wukong-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['image_in', 'video_in', 'thinking', 'tool_use'],
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'wukong/wukong-for-coding' });

    expect(config.model).toBe('wukong/wukong-for-coding');
    expect(config.providerConfig.model).toBe('wukong-for-coding');
    expect(config.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('does not infer Wukong capabilities from the provider catalogue', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            wukong: {
              type: 'wukong',
              apiKey: 'test-key',
            },
          },
          models: {
            'wukong': {
              provider: 'wukong',
              model: 'wukong',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'wukong' });

    expect(config.modelCapabilities).toMatchObject({
      image_in: false,
      video_in: false,
      audio_in: false,
      max_context_tokens: 128_000,
    });
  });

  it('clamps the LLM completion cap to 128k for openai-compatible providers', async () => {
    let requestMaxTokens: unknown;
    const ctx = testAgent({
      generate: async (provider) => {
        requestMaxTokens = (
          provider as unknown as { readonly modelParameters: Record<string, unknown> }
        ).modelParameters['max_tokens'];
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
      providerManager: new ProviderManager({
        config: {
          providers: {
            deepseek: {
              type: 'openai',
              apiKey: 'test-key',
              baseUrl: 'https://api.deepseek.example/v1',
            },
          },
          models: {
            'deepseek/deepseek-v4-flash': {
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
              maxContextSize: 1_000_000,
              maxOutputSize: 384000,
            },
          },
        },
      }),
    });

    ctx.agent.config.update({
      modelAlias: 'deepseek/deepseek-v4-flash',
      systemPrompt: 'system',
      thinkingLevel: 'off',
    });
    await ctx.agent.llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    // maxOutputSize (384000) is clamped to the 128k ceiling applied to
    // non-Wukong chat-completions providers.
    expect(requestMaxTokens).toBe(131072);
  });

  it('uses session id as a provider prompt cache hint without storing it on Agent', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        promptCacheKey: 'session-test',
        config: {
          providers: {
            wukong: {
              type: 'wukong',
              apiKey: 'test-key',
            },
          },
          models: {
            'wukong': {
              provider: 'wukong',
              model: 'wukong',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'wukong' });

    expect(config.providerConfig).toMatchObject({
      type: 'wukong',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
    expect('sessionId' in ctx.agent).toBe(false);
  });
});

describe('ConfigState thinking clamp for always-thinking models', () => {
  function alwaysThinkingAgent() {
    return testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: { wukong: { type: 'wukong', apiKey: 'test-key' } },
          models: {
            'wukong/deep': {
              provider: 'wukong',
              model: 'wukong-deep-coder',
              maxContextSize: 128_000,
              capabilities: ['thinking', 'always_thinking', 'tool_use'],
            },
            'wukong/toggle': {
              provider: 'wukong',
              model: 'wukong-for-coding',
              maxContextSize: 128_000,
              capabilities: ['thinking'],
            },
          },
        },
      }),
    });
  }

  it('clamps thinkingLevel off to the configured effort', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'wukong/deep', thinkingLevel: 'off' });

    expect(ctx.agent.config.thinkingLevel).toBe('high');
  });

  it('builds the provider with thinking enabled even after thinking was set off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'wukong/deep', thinkingLevel: 'off' });

    const provider = ctx.agent.config.provider;
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { type?: unknown } };
    };
    expect(gen.extra_body?.thinking?.type).toBe('enabled');
  });

  it('keeps thinking off working for toggleable models', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'wukong/toggle', thinkingLevel: 'off' });

    expect(ctx.agent.config.thinkingLevel).toBe('off');
  });

  it('re-clamps when switching to an always-on model after thinking was off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'wukong/toggle', thinkingLevel: 'off' });
    expect(ctx.agent.config.thinkingLevel).toBe('off');

    ctx.agent.config.update({ modelAlias: 'wukong/deep' });
    expect(ctx.agent.config.thinkingLevel).toBe('high');
  });
});

describe('ConfigState.provider applies global WUKONG_MODEL_* request config', () => {
  function wukongAgent() {
    return testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: { wukong: { type: 'wukong', apiKey: 'test-key' } },
          models: {
            'wukong': { provider: 'wukong', model: 'wukong', maxContextSize: 128_000 },
          },
        },
      }),
    });
  }

  it('injects WUKONG_MODEL_TEMPERATURE into config.provider (the provider compaction also uses)', () => {
    vi.stubEnv('WUKONG_MODEL_TEMPERATURE', '0.3');
    try {
      const ctx = wukongAgent();
      ctx.agent.config.update({ modelAlias: 'wukong' });

      const provider = ctx.agent.config.provider;
      expect(Reflect.get(provider as object, '_generationKwargs')).toMatchObject({
        temperature: 0.3,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('injects WUKONG_MODEL_THINKING_KEEP into config.provider when thinking is on (so compaction keeps it)', () => {
    vi.stubEnv('WUKONG_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = wukongAgent();
      ctx.agent.config.update({ modelAlias: 'wukong', thinkingLevel: 'high' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBe('all');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does NOT inject thinking.keep into config.provider when thinking is off', () => {
    vi.stubEnv('WUKONG_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = wukongAgent();
      ctx.agent.config.update({ modelAlias: 'wukong', thinkingLevel: 'off' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
