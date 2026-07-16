import type { Command } from 'commander';

import { parseLoopDuration } from '#/utils/duration';

export interface LoopCliOptions {
  readonly objective?: string;
  readonly until?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations?: number;
  readonly minIntervalMs?: number;
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly role?: string;
}

export type RunLoopHandler = (options: LoopCliOptions) => void;

export function registerLoopCommand(parent: Command, onRun?: RunLoopHandler): void {
  parent
    .command('loop')
    .description('Run an AI coding Loop until the independent delivery gate passes.')
    .argument('<objective>', 'The objective to iterate toward.')
    .option('--until <condition>', 'Advanced compatibility option. Loop always uses proof-pass.', 'proof-pass')
    .option('--max-iterations <n>', 'Maximum iterations before giving up.', '10')
    .option('--every <duration>', 'Optional minimum interval between iterations (e.g. 5m, 1h).')
    .option('--model <model>', 'Writer model alias for this Loop session.')
    .option('--role <role>', 'Writer role profile for this Loop session.')
    .option('--dry-run', 'Validate arguments and print the planned loop without running it.', false)
    .action(async (objective: string, raw: RawLoopOptions) => {
      const everyResult = parseEvery(raw.every);
      if (everyResult.kind === 'error') {
        process.stderr.write(`error: ${everyResult.message}\n`);
        process.exit(1);
      }

      const until = normalizeLoopStopCondition(raw.until);
      if (raw.until !== undefined && raw.until !== 'proof-pass') {
        process.stderr.write(`warning: --until ${raw.until} is deprecated; using proof-pass.\n`);
      }
      const options: LoopCliOptions = {
        objective,
        until,
        maxIterations: Number.parseInt(raw.maxIterations, 10),
        minIntervalMs: everyResult.ms,
        dryRun: raw.dryRun === true,
        model: raw.model,
        role: raw.role,
      };

      const validated = validateLoopOptions(options);
      if (validated.kind === 'error') {
        process.stderr.write(`error: ${validated.message}\n`);
        process.exit(1);
      }

      if (options.dryRun === true) {
        process.stdout.write('Planned loop:\n');
        process.stdout.write(`  Objective: ${objective}\n`);
        process.stdout.write(`  Stop when: ${options.until}\n`);
        process.stdout.write(`  Max iterations: ${String(options.maxIterations)}\n`);
        if (options.minIntervalMs !== undefined) {
          process.stdout.write(`  Minimum interval: ${formatDuration(options.minIntervalMs)}\n`);
        }
        process.exit(0);
      }

      if (onRun === undefined) {
        process.stderr.write('error: Loop runner is unavailable in this build.\n');
        process.exit(2);
      }
      onRun(options);
    });
}

interface RawLoopOptions {
  readonly until?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations: string;
  readonly every?: string;
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly role?: string;
}

type ValidationResult = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly message: string };
type EveryResult = { readonly kind: 'ok'; readonly ms?: number } | { readonly kind: 'error'; readonly message: string };

export function parseEvery(raw: string | undefined): EveryResult {
  if (raw === undefined) return { kind: 'ok', ms: undefined };
  const result = parseLoopDuration(raw);
  if (result.kind === 'error') return result;
  return { kind: 'ok', ms: result.ms };
}

export function validateLoopOptions(options: LoopCliOptions): ValidationResult {
  if (options.objective === undefined || options.objective.trim().length === 0) {
    return { kind: 'error', message: 'Loop objective is required.' };
  }
  if (
    options.until !== 'proof-pass'
  ) {
    return { kind: 'error', message: '--until must be proof-pass.' };
  }
  if (
    options.maxIterations === undefined ||
    !Number.isFinite(options.maxIterations) ||
    options.maxIterations <= 0
  ) {
    return { kind: 'error', message: '--max-iterations must be a positive integer.' };
  }
  return { kind: 'ok' };
}

function normalizeLoopStopCondition(
  value: RawLoopOptions['until'],
): 'proof-pass' | undefined {
  if (value === undefined) return 'proof-pass';
  if (value === 'proof-pass' || value === 'verify-pass' || value === 'scan-clean' || value === 'judge-pass') {
    return 'proof-pass';
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1_000}s`;
}
