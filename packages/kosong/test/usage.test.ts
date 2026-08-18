import type { TokenUsage } from '#/usage';
import { addUsage, emptyUsage, estimateUsageCost, grandTotal, inputTotal } from '#/usage';
import { describe, expect, it } from 'vitest';

describe('emptyUsage', () => {
  it('returns all zeros', () => {
    const usage = emptyUsage();
    expect(usage.inputOther).toBe(0);
    expect(usage.output).toBe(0);
    expect(usage.inputCacheRead).toBe(0);
    expect(usage.inputCacheCreation).toBe(0);
  });
});

describe('inputTotal', () => {
  it('sums all input fields', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 30,
    };
    expect(inputTotal(usage)).toBe(330);
  });

  it('returns 0 for empty usage', () => {
    expect(inputTotal(emptyUsage())).toBe(0);
  });
});

describe('grandTotal', () => {
  it('sums input total and output', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 30,
    };
    expect(grandTotal(usage)).toBe(380);
  });

  it('returns 0 for empty usage', () => {
    expect(grandTotal(emptyUsage())).toBe(0);
  });
});

describe('addUsage', () => {
  it('sums two usage values', () => {
    const a: TokenUsage = {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    };
    const b: TokenUsage = {
      inputOther: 5,
      output: 15,
      inputCacheRead: 25,
      inputCacheCreation: 35,
    };
    const result = addUsage(a, b);
    expect(result.inputOther).toBe(15);
    expect(result.output).toBe(35);
    expect(result.inputCacheRead).toBe(55);
    expect(result.inputCacheCreation).toBe(75);
  });

  it('adding empty usage returns the other', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    };
    const result = addUsage(usage, emptyUsage());
    expect(result).toEqual(usage);
  });
});

describe('estimateUsageCost', () => {
  it('computes USD from per-1M pricing across all usage fields', () => {
    const usage: TokenUsage = {
      inputOther: 1_000_000,
      output: 500_000,
      inputCacheRead: 2_000_000,
      inputCacheCreation: 100_000,
    };
    const cost = estimateUsageCost(usage, {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    });
    // 1M*3 + 0.5M*15 + 2M*0.3 + 0.1M*3.75 = 3 + 7.5 + 0.6 + 0.375
    expect(cost).toBeCloseTo(11.475, 10);
  });

  it('treats missing price fields as zero', () => {
    const usage: TokenUsage = {
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 1_000_000,
      inputCacheCreation: 1_000_000,
    };
    expect(estimateUsageCost(usage, { input: 2 })).toBeCloseTo(2, 10);
    expect(estimateUsageCost(usage, {})).toBe(0);
  });

  it('returns 0 for empty usage', () => {
    expect(estimateUsageCost(emptyUsage(), { input: 3, output: 15 })).toBe(0);
  });
});
