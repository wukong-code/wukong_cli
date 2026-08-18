import { describe, expect, it } from 'vitest';

import type { Catalog } from '@wukong/wukong-sdk';

import { formatCost, parseModelAlias, summarizeCost } from '#/utils/cost';

const CATALOG: Catalog = {
  anthropic: {
    id: 'anthropic',
    models: {
      claude: {
        id: 'claude',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  openai: {
    id: 'openai',
    models: {
      // No pricing: lookups against this model mark the summary partial.
      gpt: { id: 'gpt' },
    },
  },
};

describe('parseModelAlias', () => {
  it('splits at the first slash', () => {
    expect(parseModelAlias('anthropic/claude')).toEqual({ provider: 'anthropic', model: 'claude' });
    expect(parseModelAlias('openrouter/a/b')).toEqual({ provider: 'openrouter', model: 'a/b' });
  });

  it('returns undefined without a slash', () => {
    expect(parseModelAlias('claude')).toBeUndefined();
    expect(parseModelAlias('')).toBeUndefined();
  });
});

describe('summarizeCost', () => {
  it('returns undefined without usage or with empty usage', () => {
    expect(summarizeCost(undefined, CATALOG)).toBeUndefined();
    expect(summarizeCost({}, CATALOG)).toBeUndefined();
  });

  it('sums the USD estimate across priced models', () => {
    const summary = summarizeCost({
      'anthropic/claude': {
        inputOther: 1_000_000,
        output: 100_000,
        inputCacheRead: 1_000_000,
        inputCacheCreation: 0,
      },
    }, CATALOG);
    // 1M*3 + 0.1M*15 + 1M*0.3 = 3 + 1.5 + 0.3
    expect(summary).toEqual({ usd: 4.8, partial: false });
  });

  it('flags models without catalog pricing as partial', () => {
    const summary = summarizeCost({
      'anthropic/claude': {
        inputOther: 1_000_000,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      'openai/gpt': {
        inputOther: 1_000_000,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      unknown: {
        inputOther: 1_000_000,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    }, CATALOG);
    expect(summary).toEqual({ usd: 3, partial: true });
  });

  it('returns undefined when no alias matched any pricing', () => {
    expect(summarizeCost({
      'openai/gpt': {
        inputOther: 1_000_000,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    }, CATALOG)).toBeUndefined();
    expect(summarizeCost({
      'anthropic/claude': {
        inputOther: 1_000_000,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    }, undefined)).toBeUndefined();
  });
});

describe('formatCost', () => {
  it('renders unavailable without a summary', () => {
    expect(formatCost(undefined)).toBe('unavailable');
  });

  it('formats cents above one cent and fractions below', () => {
    expect(formatCost({ usd: 4.8, partial: false })).toBe('~$4.80');
    expect(formatCost({ usd: 0.0012, partial: false })).toBe('~$0.0012');
  });

  it('appends + for partial summaries', () => {
    expect(formatCost({ usd: 3, partial: true })).toBe('~$3.00+');
  });
});
