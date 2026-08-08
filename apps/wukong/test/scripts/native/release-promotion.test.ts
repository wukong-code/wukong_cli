import { describe, expect, it } from 'vitest';

import { assertStablePromotion } from '../../../scripts/native/assert-stable-promotion.mjs';

describe('stable release promotion ordering', () => {
  it.each([
    ['v0.1.0', 'v0.0.22'],
    ['v0.2.0', 'v0.1.99'],
    ['v1.0.0', 'v0.99.99'],
  ])('accepts newer candidate %s over %s', (candidate, current) => {
    expect(() => {
      assertStablePromotion(candidate, current);
    }).not.toThrow();
  });

  it.each([
    ['v0.1.0', 'v0.2.0'],
    ['v0.1.0', 'v0.1.0'],
    ['v0.1.0-rc.1', 'v0.0.22'],
    ['v01.0.0', 'v0.0.22'],
  ])('rejects stale or non-stable candidate %s against %s', (candidate, current) => {
    expect(() => {
      assertStablePromotion(candidate, current);
    }).toThrow();
  });
});
