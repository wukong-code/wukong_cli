import {
  APIConnectionError,
  APIStatusError,
  emptyUsage,
  isRetryableGenerateError,
} from '@wukong/kosong';
import { describe, expect, it } from 'vitest';

import type { WukongConfig } from '#/config';
import { ErrorCodes, WukongError } from '#/errors';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { chatWithRetry } from '#/loop/retry';
import { ProviderManager } from '#/session/provider-manager';

function okResponse(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeInput(
  llm: LLM,
  signal: AbortSignal,
  events: Array<Record<string, unknown>> = [],
): Parameters<typeof chatWithRetry>[0] {
  return {
    llm,
    params: { messages: [], tools: [], signal },
    dispatchEvent: async (event) => { events.push(event as unknown as Record<string, unknown>); },
    turnId: 't',
    currentStep: 1,
    stepUuid: 'u',
  };
}

describe('chatWithRetry: terminated stream drops', () => {
  it('does not retry an outcome-unknown connection drop', async () => {
    let calls = 0;
    const events: Array<Record<string, unknown>> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(
      llm,
      new AbortController().signal,
      events,
    ))).rejects.toThrow('terminated');

    expect(calls).toBe(1);
    expect(events.map((event) => event['state'])).toEqual(['started', 'outcome_unknown']);
    expect(events[0]?.['idempotencyKey']).toBe('wukong-u');
    expect(events[1]?.['idempotencyKey']).toBe('wukong-u');
  });

  it('retries a known HTTP failure with the same idempotency key', async () => {
    let calls = 0;
    const keys: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(params): Promise<LLMChatResponse> {
        calls += 1;
        keys.push(params.idempotencyKey ?? '<missing>');
        if (calls === 1) throw new APIStatusError(503, 'Unavailable');
        return okResponse();
      },
    };

    await expect(chatWithRetry(makeInput(llm, new AbortController().signal, events)))
      .resolves.toEqual(okResponse());
    expect(calls).toBe(2);
    expect(new Set(keys)).toEqual(new Set(['wukong-u']));
    expect(events.map((event) => event['state'])).toEqual([
      'started',
      'failed',
      undefined,
      'started',
      'succeeded',
    ]);
  });

  it('does not retry a status failure after streamed output was observed', async () => {
    let calls = 0;
    const events: Array<Record<string, unknown>> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(params): Promise<LLMChatResponse> {
        calls += 1;
        params.onTextDelta?.('partial');
        throw new APIStatusError(503, 'Stream terminated');
      },
    };
    const input = makeInput(llm, new AbortController().signal, events);
    input.params.onTextDelta = () => {};

    await expect(chatWithRetry(input)).rejects.toThrow('Stream terminated');
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ state: 'outcome_unknown', outputObserved: true });
  });

  it('does NOT retry when the signal is aborted (user ESC), surfacing a clean AbortError', async () => {
    // A request cancelled before dispatch must never reach the provider.
    let calls = 0;
    const ac = new AbortController();
    ac.abort();

    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(llm, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(0);
  });

  it('does not retry OAuth token fetch connection errors (already retried internally)', async () => {
    let tokenCalls = 0;
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          tokenCalls += 1;
          throw new WukongError(
            ErrorCodes.PROVIDER_CONNECTION_ERROR,
            'OAuth provider "managed:wukong" failed to fetch an access token: fetch failed',
          );
        },
      }),
    });
    const resolveAuth = manager.resolveAuth('wukong/wukong-for-coding');
    if (resolveAuth === undefined) throw new Error('expected OAuth auth resolver');

    let chatCalls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        chatCalls += 1;
        return resolveAuth(async () => okResponse());
      },
    };

    await expect(chatWithRetry(makeInput(llm, new AbortController().signal))).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
    });
    expect(chatCalls).toBe(1);
    expect(tokenCalls).toBe(1);
  });
});

function oauthConfig(): WukongConfig {
  return {
    defaultModel: 'wukong/wukong-for-coding',
    providers: {
      'managed:wukong': {
        type: 'wukong',
        apiKey: '',
        baseUrl: 'https://api.example/v1',
        oauth: { storage: 'file', key: 'oauth/wukong' },
      },
    },
    models: {
      'wukong/wukong-for-coding': {
        provider: 'managed:wukong',
        model: 'wukong-for-coding',
        maxContextSize: 1_000_000,
      },
    },
  };
}
