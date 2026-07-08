import { describe, it, expect } from 'vitest';

import { parseEvery, validateLoopOptions, formatDuration } from '#/cli/sub/loop';

describe('loop pure helpers', () => {
    it('parseEvery accepts undefined', () => {
        expect(parseEvery(undefined)).toEqual({ kind: 'ok', ms: undefined });
    });

    it('parseEvery converts valid durations', () => {
        expect(parseEvery('5m')).toEqual({ kind: 'ok', ms: 300_000 });
        expect(parseEvery('1h')).toEqual({ kind: 'ok', ms: 3_600_000 });
        expect(parseEvery('90s')).toEqual({ kind: 'ok', ms: 90_000 });
    });

    it('parseEvery returns error for invalid durations', () => {
        const result = parseEvery('abc');
        expect(result.kind).toBe('error');
    });

    it('validateLoopOptions rejects missing objective', () => {
        const result = validateLoopOptions({ objective: '', until: 'verify-pass', maxIterations: 5 });
        expect(result.kind).toBe('error');
        expect((result as { message: string }).message).toContain('objective');
    });

    it('validateLoopOptions rejects invalid until condition', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'done' as any, maxIterations: 5 });
        expect(result.kind).toBe('error');
        expect((result as { message: string }).message).toContain('--until');
    });

    it('validateLoopOptions rejects non-positive max iterations', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'verify-pass', maxIterations: 0 });
        expect(result.kind).toBe('error');
        expect((result as { message: string }).message).toContain('--max-iterations');
    });

    it('validateLoopOptions accepts valid options', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'verify-pass', maxIterations: 5 });
        expect(result.kind).toBe('ok');
    });

    it('formatDuration formats cleanly', () => {
        expect(formatDuration(30_000)).toBe('30s');
        expect(formatDuration(300_000)).toBe('5m');
        expect(formatDuration(3_600_000)).toBe('1h');
        expect(formatDuration(86_400_000)).toBe('1d');
        expect(formatDuration(90_000)).toBe('90s');
    });
});
