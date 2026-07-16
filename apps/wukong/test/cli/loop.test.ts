import { describe, it, expect, vi } from 'vitest';

import { parseEvery, validateLoopOptions, formatDuration } from '#/cli/sub/loop';
import { createProgram } from '#/cli/commands';

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
        const result = validateLoopOptions({ objective: '', until: 'proof-pass', maxIterations: 5 });
        expect(result.kind).toBe('error');
        expect((result as { message: string }).message).toContain('objective');
    });

    it('validateLoopOptions rejects invalid until condition', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'done' as any, maxIterations: 5 });
        expect(result.kind).toBe('error');
        expect((result as { message: string }).message).toContain('--until');
    });

    it('validateLoopOptions rejects non-positive max iterations', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'proof-pass', maxIterations: 0 });
        expect(result.kind).toBe('error');
        expect((result as { message: string }).message).toContain('--max-iterations');
    });

    it('validateLoopOptions accepts valid options', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'proof-pass', maxIterations: 5 });
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

describe('loop command', () => {
    it('routes a non-interactive Loop through headless goal mode', async () => {
        const runs: unknown[] = [];
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync([
            'node',
            'wukong',
            'loop',
            'fix failing tests',
            '--max-iterations',
            '3',
            '--model',
            'fast',
            '--role',
            'tester',
        ]);

        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            prompt: '/loop --max-iterations 3 -- fix failing tests',
            model: 'fast',
            role: 'tester',
        });
    });

    it.each(['verify-pass', 'scan-clean', 'judge-pass'])(
        'accepts legacy --until %s and emits a deprecation warning',
        async (legacyCondition) => {
            const runs: unknown[] = [];
            const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

            await program.parseAsync([
                'node',
                'wukong',
                'loop',
                'fix tests',
                '--until',
                legacyCondition,
            ]);

            expect(runs[0]).toMatchObject({
                prompt: '/loop --max-iterations 10 -- fix tests',
            });
            expect(stderr).toHaveBeenCalledWith(
                expect.stringContaining(`--until ${legacyCondition} is deprecated`),
            );
            stderr.mockRestore();
        },
    );
});
