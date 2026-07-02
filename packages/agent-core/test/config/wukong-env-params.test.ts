import { type ChatProvider, WukongChatProvider } from '@wukong/kosong';
import { describe, expect, it } from 'vitest';

import { applyWukongEnvSamplingParams, applyWukongEnvThinkingKeep } from '../../src/config/wukong-env-params';
import { WukongError } from '../../src/errors';

function wukong(): WukongChatProvider {
  return new WukongChatProvider({ model: 'wukong-k2', apiKey: 'k' });
}

interface WukongGenerationState {
  temperature?: number;
  top_p?: number;
  extra_body?: { thinking?: { keep?: unknown } };
}

function genState(provider: ChatProvider): WukongGenerationState {
  return Reflect.get(provider as object, '_generationKwargs') as WukongGenerationState;
}

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WukongError);
    expect((error as WukongError).code).toBe('config.invalid');
    return;
  }
  throw new Error('expected function to throw');
}

describe('applyWukongEnvSamplingParams', () => {
  it('returns the same provider when no env vars are set', () => {
    const provider = wukong();
    expect(applyWukongEnvSamplingParams(provider, {})).toBe(provider);
  });

  it('injects temperature and top_p for a wukong provider', () => {
    const out = applyWukongEnvSamplingParams(wukong(), {
      WUKONG_MODEL_TEMPERATURE: '0.3',
      WUKONG_MODEL_TOP_P: '0.95',
    });
    const state = genState(out);
    expect(state.temperature).toBe(0.3);
    expect(state.top_p).toBe(0.95);
  });

  it('leaves non-wukong providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(applyWukongEnvSamplingParams(stub, { WUKONG_MODEL_TEMPERATURE: '0.3' })).toBe(stub);
  });

  it('throws config.invalid for an invalid temperature', () => {
    expectConfigInvalid(() =>
      applyWukongEnvSamplingParams(wukong(), { WUKONG_MODEL_TEMPERATURE: 'abc' }),
    );
  });
});

describe('applyWukongEnvThinkingKeep', () => {
  it('injects thinking.keep when thinking is on', () => {
    const out = applyWukongEnvThinkingKeep(wukong(), 'high', { WUKONG_MODEL_THINKING_KEEP: 'all' });
    expect(genState(out).extra_body?.thinking?.keep).toBe('all');
  });

  it('does NOT inject thinking.keep when thinking is off', () => {
    const out = applyWukongEnvThinkingKeep(wukong(), 'off', { WUKONG_MODEL_THINKING_KEEP: 'all' });
    expect(genState(out).extra_body).toBeUndefined();
  });

  it('returns the same provider when keep is unset', () => {
    const provider = wukong();
    expect(applyWukongEnvThinkingKeep(provider, 'high', {})).toBe(provider);
  });

  it('leaves non-wukong providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(applyWukongEnvThinkingKeep(stub, 'high', { WUKONG_MODEL_THINKING_KEEP: 'all' })).toBe(stub);
  });
});
