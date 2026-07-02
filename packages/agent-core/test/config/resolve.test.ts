import { describe, expect, it } from 'vitest';

import { parseFloatEnv } from '../../src/config/resolve';
import { WukongError } from '../../src/errors';

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

describe('parseFloatEnv', () => {
  it('returns undefined when unset, empty, or blank', () => {
    expect(parseFloatEnv(undefined, 'WUKONG_MODEL_TEMPERATURE')).toBeUndefined();
    expect(parseFloatEnv('', 'WUKONG_MODEL_TEMPERATURE')).toBeUndefined();
    expect(parseFloatEnv('   ', 'WUKONG_MODEL_TEMPERATURE')).toBeUndefined();
  });

  it('parses valid floats and integers', () => {
    expect(parseFloatEnv('0.3', 'WUKONG_MODEL_TEMPERATURE')).toBe(0.3);
    expect(parseFloatEnv('1', 'WUKONG_MODEL_TEMPERATURE')).toBe(1);
    expect(parseFloatEnv(' 0.95 ', 'WUKONG_MODEL_TOP_P')).toBe(0.95);
    expect(parseFloatEnv('0', 'WUKONG_MODEL_TEMPERATURE')).toBe(0);
  });

  it.each(['abc', '1.2.3', 'NaN', '1,5'])(
    'throws config.invalid for non-numeric value %s',
    (value) => {
      expectConfigInvalid(() => parseFloatEnv(value, 'WUKONG_MODEL_TEMPERATURE'));
    },
  );
});
