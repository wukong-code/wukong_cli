import { describe, it, expect, vi } from 'vitest';

import {
    formatDuration,
    formatHeadlessStartFlags,
    formatLoopPlan,
    parseEvery,
    parseMaxIterations,
    validateLoopOptions,
} from '#/cli/sub/loop';
import { createProgram } from '#/cli/commands';
import type { CLIOptions } from '#/cli/options';

vi.mock('@wukong/wukong-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@wukong/wukong-sdk')>();
    return {
        ...actual,
        createWukongHarness: () => ({
            ensureConfigFile: vi.fn(async () => {}),
            getConfig: vi.fn(async () => ({
                defaultModel: 'fast',
                models: {
                    fast: { provider: 'openai', model: 'writer' },
                    slow: { provider: 'review', model: 'reviewer' },
                },
                providers: {
                    openai: { type: 'openai', apiKey: 'test' },
                    review: {
                        type: 'openai',
                        apiKey: 'test-review',
                        baseUrl: 'https://review.example/v1',
                    },
                },
            })),
            close: vi.fn(async () => {}),
        }),
    };
});

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

    it('validateLoopOptions rejects objectives over the V2 contract limit', () => {
        const result = validateLoopOptions({
            objective: 'x'.repeat(8001),
            until: 'proof-pass',
            maxIterations: 3,
        });
        expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('8000') });
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

    it('parseMaxIterations rejects partial and decimal numbers', () => {
        expect(parseMaxIterations('3')).toBe(3);
        expect(parseMaxIterations('3oops')).toBeUndefined();
        expect(parseMaxIterations('3.9')).toBeUndefined();
        expect(parseMaxIterations('0')).toBeUndefined();
    });

    it('validateLoopOptions accepts valid options', () => {
        const result = validateLoopOptions({ objective: 'fix bugs', until: 'proof-pass', maxIterations: 5 });
        expect(result.kind).toBe('ok');
    });

    it('requires one discovered-check decision', () => {
        expect(validateLoopOptions({
            objective: 'fix bugs',
            until: 'proof-pass',
            maxIterations: 5,
            acceptDiscoveredChecks: true,
            onlyExplicitChecks: true,
        })).toMatchObject({ kind: 'error', message: expect.stringContaining('mutually exclusive') });
    });

    it('formatDuration formats cleanly', () => {
        expect(formatDuration(30_000)).toBe('30s');
        expect(formatDuration(300_000)).toBe('5m');
        expect(formatDuration(3_600_000)).toBe('1h');
        expect(formatDuration(86_400_000)).toBe('1d');
        expect(formatDuration(90_000)).toBe('90s');
    });

    it('includes both writer and reviewer models in a dry-run plan', () => {
        const output = formatLoopPlan({
            objective: 'fix tests',
            until: 'proof-pass',
            maxIterations: 3,
            model: 'fast',
            reviewModel: 'slow',
        });
        expect(output).toContain('Writer model: fast');
        expect(output).toContain('Reviewer model: slow');
    });

    it('shows configured writer, reviewer, and token ceilings in the plan', () => {
        const output = formatLoopPlan({
            objective: 'fix tests',
            until: 'proof-pass',
            maxIterations: 3,
            writerProviderCallLimit: 12,
            reviewerProviderCallLimit: 4,
            tokenBudget: 50_000,
        });
        expect(output).toContain('Writer call limit: 12');
        expect(output).toContain('Reviewer call limit: 4');
        expect(output).toContain('Token budget: 50000');
    });

    it('prints the actual short-lived broker challenge and complete required flags', () => {
        const output = formatHeadlessStartFlags({
            proposal: {
                gatePlan: { requiredChecks: [{ source: 'project-inferred' }] },
                gateApproval: {
                    approvalSetDigest: 'sha256:approval',
                    hasExecutableChecks: true,
                },
                finishLineReview: {
                    warnings: [{ id: 'missing-done-when' }],
                    warningSetDigest: 'sha256:warnings',
                },
                noExecutableChecksDecision: {
                    decisionDigest: 'sha256:no-check',
                },
            },
            trustChallenge: 'project.challenge',
            brokerTrustChallenge: 'short-lived.broker-challenge',
            brokerTrustProposal: { trustProposalDigest: 'sha256:not-the-challenge' },
            reviewSubjectConsentProposal: { consentProposalDigest: 'sha256:consent' },
            verificationSelection: undefined,
            verificationCatalog: { catalogDigest: 'sha256:catalog', entries: [] },
        } as never);

        expect(output).toContain('--accept-discovered-checks');
        expect(output).toContain('--approve-gate-plan sha256:approval');
        expect(output).toContain('--ack-finish-line-warnings sha256:warnings');
        expect(output).toContain('--ack-no-executable-checks sha256:no-check');
        expect(output).toContain('--trust-workspace project.challenge');
        expect(output).toContain('--trust-review-subject short-lived.broker-challenge');
        expect(output).not.toContain('sha256:not-the-challenge');
        expect(output).toContain('--ack-review-subject sha256:consent');
    });
});

describe('loop command', () => {
    it('rejects the removed --role option at the command boundary', async () => {
        const program = createProgram('0.0.0', () => {}, () => {});
        let errorOutput = '';
        program.exitOverride();
        program.configureOutput({
            writeOut: () => {},
            writeErr: (chunk) => { errorOutput += chunk; },
        });

        await expect(program.parseAsync([
            'node',
            'wukong',
            'loop',
            'fix tests',
            '--role',
            'tester',
        ])).rejects.toThrow();
        expect(errorOutput).toContain("unknown option '--role'");
    });

    it.each(['3oops', '3.9'])('rejects malformed --max-iterations value %s before running', async (value) => {
        const runs: unknown[] = [];
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync([
            'node',
            'wukong',
            'loop',
            'fix tests',
            '--max-iterations',
            value,
        ]);

        expect(stderr).toHaveBeenCalledWith('error: --max-iterations must be a positive integer.\n');
        expect(exit).toHaveBeenCalledWith(1);
        expect(runs).toHaveLength(0);
        stderr.mockRestore();
        exit.mockRestore();
    });

    it.each([
        ['--writer-call-limit', '2oops'],
        ['--reviewer-call-limit', '0'],
        ['--token-budget', '3.5'],
    ])('rejects malformed %s value %s before running', async (flag, value) => {
        const runs: unknown[] = [];
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync(['node', 'wukong', 'loop', 'fix tests', flag, value]);

        expect(stderr).toHaveBeenCalledWith(`error: ${flag} must be a positive integer.\n`);
        expect(exit).toHaveBeenCalledWith(1);
        expect(runs).toHaveLength(0);
        stderr.mockRestore();
        exit.mockRestore();
    });

    it('prints the inherited writer model in dry-run output', async () => {
        const runs: unknown[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync([
            'node',
            'wukong',
            'loop',
            'fix tests',
            '--dry-run',
            '--model',
            'fast',
            '--writer-call-limit',
            '12',
            '--reviewer-call-limit',
            '4',
            '--token-budget',
            '50000',
            '--review-model',
            'slow',
        ]);

        const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(output).toContain('Writer model: fast');
        expect(output).toContain('Reviewer model: slow');
        expect(runs).toHaveLength(0);
        expect(exit).toHaveBeenCalledWith(0);
        stdout.mockRestore();
        exit.mockRestore();
    });

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
            '--writer-call-limit',
            '12',
            '--reviewer-call-limit',
            '4',
            '--token-budget',
            '50000',
        ]);

        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
            prompt: 'fix failing tests',
            model: 'fast',
            headlessGoal: {
                kind: 'loop',
                objective: 'fix failing tests',
                maxIterations: 3,
                writerProviderCallLimit: 12,
                reviewerProviderCallLimit: 4,
                tokenBudget: 50000,
            },
        });
    });

    it('forwards the complete Finish Line and approval flags to headless mode', async () => {
        const runs: CLIOptions[] = [];
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync([
            'node',
            'wukong',
            'loop',
            'ship safely',
            '--done-when',
            'all checks pass',
            '--constraint',
            'do not weaken tests',
            '--constraint',
            'do not upload source',
            '--check',
            'pnpm test',
            '--only-explicit-checks',
            '--approve-gate-plan',
            'approval-digest',
            '--ack-finish-line-warnings',
            'warning-digest',
            '--ack-no-executable-checks',
            'no-check-digest',
            '--trust-workspace',
            'trust-challenge',
        ]);

        expect(runs[0]?.headlessGoal).toMatchObject({
            kind: 'loop',
            completionCriterion: 'all checks pass',
            constraints: ['do not weaken tests', 'do not upload source'],
            checks: ['pnpm test'],
            discoveredCheckDecision: 'only-explicit',
            approveGatePlanDigest: 'approval-digest',
            acknowledgeWarningSetDigest: 'warning-digest',
            acknowledgeNoExecutableChecksDigest: 'no-check-digest',
            trustWorkspaceChallenge: 'trust-challenge',
        });
    });

    it('forwards global YOLO confirmation into the Loop session', async () => {
        const runs: CLIOptions[] = [];
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync([
            'node',
            'wukong',
            '--yolo',
            '--yes',
            'loop',
            'apply the approved migration',
        ]);

        expect(runs[0]).toMatchObject({
            yolo: true,
            yes: true,
            auto: false,
            prompt: 'apply the approved migration',
            headlessGoal: { kind: 'loop' },
        });
    });

    it('preserves reviewer aliases with spaces without slash-command re-parsing', async () => {
        const runs: CLIOptions[] = [];
        const program = createProgram('0.0.0', (options) => runs.push(options), () => {});

        await program.parseAsync([
            'node',
            'wukong',
            'loop',
            'fix tests',
            '--review-model',
            'my reviewer',
        ]);

        expect(runs[0]?.headlessGoal).toMatchObject({ reviewModel: 'my reviewer' });
        expect(runs[0]?.prompt).toBe('fix tests');
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
                prompt: 'fix tests',
                headlessGoal: { kind: 'loop', stopCondition: 'proof-pass' },
            });
            expect(stderr).toHaveBeenCalledWith(
                expect.stringContaining(`--until ${legacyCondition} is deprecated`),
            );
            stderr.mockRestore();
        },
    );
});
