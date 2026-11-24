import { ErrorCodes, type WukongConfig } from '@wukong/agent-core';
import { describe, expect, it, vi } from 'vitest';

const createProviderMock = vi.fn();
const generateMock = vi.fn();

vi.mock('@wukong/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wukong/kosong')>();
  return {
    ...actual,
    createProvider: (...args: unknown[]) => createProviderMock(...args),
    generate: (...args: unknown[]) => generateMock(...args),
  };
});

import { runIsolatedReviewCompletion } from '../src/isolated-review';

function baseConfig(overrides: Partial<WukongConfig> = {}): WukongConfig {
  return {
    providers: {
      openai: {
        type: 'openai',
        apiKey: 'YOUR_API_KEY',
        baseUrl: 'https://api.example.test/v1',
      },
    },
    models: {
      default: {
        provider: 'openai',
        model: 'gpt-test',
        maxContextSize: 128_000,
      },
    },
    defaultProvider: 'openai',
    defaultModel: 'default',
    ...overrides,
  };
}

describe('runIsolatedReviewCompletion', () => {
  it('throws CONFIG_INVALID when no model alias or defaultModel is configured', async () => {
    await expect(
      runIsolatedReviewCompletion({
        config: baseConfig({ defaultModel: undefined }),
        systemPrompt: 'system',
        userPrompt: 'user',
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    });
  });

  it('invokes isolated zero-tool generation and returns extracted text and usage', async () => {
    const fakeProvider = { name: 'openai', modelName: 'gpt-test', thinkingEffort: null };
    createProviderMock.mockReturnValue(fakeProvider);
    generateMock.mockResolvedValue({
      id: 'resp-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Looks good","findings":[],"uncoveredItems":[]}' }],
        toolCalls: [],
      },
      usage: {
        inputOther: 100,
        inputCacheRead: 20,
        inputCacheCreation: 5,
        output: 30,
      },
      finishReason: 'completed',
      rawFinishReason: 'stop',
    });

    const result = await runIsolatedReviewCompletion({
      config: baseConfig(),
      systemPrompt: 'review system',
      userPrompt: 'review prompt',
    });

    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'openai',
        model: 'gpt-test',
        apiKey: 'YOUR_API_KEY',
      }),
    );
    expect(generateMock).toHaveBeenCalledWith(
      fakeProvider,
      'review system',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'review prompt' }], toolCalls: [] }],
      undefined,
      expect.objectContaining({ auth: undefined }),
    );
    expect(result).toEqual({
      modelAlias: 'default',
      providerId: 'openai',
      text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Looks good","findings":[],"uncoveredItems":[]}',
      finishReason: 'completed',
      usage: {
        inputTokens: 125,
        outputTokens: 30,
      },
    });
  });

  it('resolves OAuth auth token and passes it to generate', async () => {
    const fakeProvider = { name: 'wukong', modelName: 'wukong-for-coding', thinkingEffort: null };
    createProviderMock.mockReturnValue(fakeProvider);
    generateMock.mockResolvedValue({
      id: 'resp-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
      usage: null,
      finishReason: 'completed',
      rawFinishReason: 'stop',
    });

    const getAccessToken = vi.fn().mockResolvedValue('oauth-token-123');
    const resolveOAuthTokenProvider = vi.fn(() => ({ getAccessToken }));

    const result = await runIsolatedReviewCompletion({
      config: baseConfig({
        providers: {
          managed: {
            type: 'wukong',
            baseUrl: 'https://api.example.test/v1',
            oauth: { storage: 'file', key: 'wukong-code' },
          },
        },
        models: {
          managedModel: {
            provider: 'managed',
            model: 'wukong-for-coding',
            maxContextSize: 128_000,
          },
        },
        defaultModel: 'managedModel',
      }),
      resolveOAuthTokenProvider,
      systemPrompt: 'sys',
      userPrompt: 'usr',
    });

    expect(resolveOAuthTokenProvider).toHaveBeenCalledWith('managed', {
      storage: 'file',
      key: 'wukong-code',
    });
    expect(getAccessToken).toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledWith(
      fakeProvider,
      'sys',
      [],
      expect.any(Array),
      undefined,
      expect.objectContaining({ auth: { apiKey: 'oauth-token-123' } }),
    );
    expect(result.usage).toBeUndefined();
  });

  it('propagates external abort signal and handles WukongError cleanly', async () => {
    const controller = new AbortController();
    createProviderMock.mockReturnValue({ name: 'openai', modelName: 'gpt-test', thinkingEffort: null });
    generateMock.mockImplementation((_p: unknown, _s: unknown, _t: unknown, _h: unknown, _cb: unknown, opts?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = runIsolatedReviewCompletion({
      config: baseConfig(),
      systemPrompt: 'sys',
      userPrompt: 'usr',
      signal: controller.signal,
    });
    controller.abort(new Error('aborted'));

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
