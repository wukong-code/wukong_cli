import { describe, expect, it } from 'vitest';

import { parseLoopDuration } from '#/utils/duration';

describe('parseLoopDuration', () => {
  it('parses seconds, minutes, hours, and days', () => {
    expect(parseLoopDuration('30s')).toEqual({ kind: 'ok', ms: 60_000 });
    expect(parseLoopDuration('5m')).toEqual({ kind: 'ok', ms: 300_000 });
    expect(parseLoopDuration('2h')).toEqual({ kind: 'ok', ms: 7_200_000 });
    expect(parseLoopDuration('1d')).toEqual({ kind: 'ok', ms: 86_400_000 });
  });

  it('allows whitespace around the value', () => {
    expect(parseLoopDuration('  5m  ')).toEqual({ kind: 'ok', ms: 300_000 });
  });

  it('enforces a 1-minute minimum', () => {
    expect(parseLoopDuration('1s')).toEqual({ kind: 'ok', ms: 60_000 });
    expect(parseLoopDuration('59s')).toEqual({ kind: 'ok', ms: 60_000 });
  });

  it('rejects invalid durations', () => {
    expect(parseLoopDuration('')).toMatchObject({ kind: 'error' });
    expect(parseLoopDuration('5')).toMatchObject({ kind: 'error' });
    expect(parseLoopDuration('m')).toMatchObject({ kind: 'error' });
    expect(parseLoopDuration('5x')).toMatchObject({ kind: 'error' });
    expect(parseLoopDuration('1.5m')).toMatchObject({ kind: 'error' });
  });
});
