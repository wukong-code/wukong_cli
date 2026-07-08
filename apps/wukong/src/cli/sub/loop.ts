import type { Command } from 'commander';

export interface LoopCliOptions {
  readonly objective?: string;
  readonly until?: 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations?: number;
  readonly every?: string;
  readonly dryRun?: boolean;
}

export function registerLoopCommand(parent: Command): void {
  parent
    .command('loop')
    .description('Start a local iteration loop with a verification gate.')
    .argument('<objective>', 'The objective to iterate toward.')
    .requiredOption('--until <condition>', 'Stop condition: verify-pass, scan-clean, or judge-pass.')
    .option('--max-iterations <n>', 'Maximum iterations before giving up.', '10')
    .option('--every <duration>', 'Optional minimum interval between iterations (not yet implemented as a throttle).')
    .option('--dry-run', 'Validate arguments and print the planned loop without running it.', false)
    .action(async (objective: string, raw: RawLoopOptions) => {
      const options: LoopCliOptions = {
        objective,
        until: raw.until,
        maxIterations: Number.parseInt(raw.maxIterations, 10),
        every: raw.every,
        dryRun: raw.dryRun === true,
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
        if (options.every !== undefined) {
          process.stdout.write(`  Minimum interval: ${options.every}\n`);
        }
        process.exit(0);
      }

      process.stdout.write(
        'The `wukong loop` non-interactive driver is not yet implemented. Use `/loop` in the TUI instead.\n',
      );
      process.exit(1);
    });
}

interface RawLoopOptions {
  readonly until?: 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations: string;
  readonly every?: string;
  readonly dryRun?: boolean;
}

type ValidationResult = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly message: string };

function validateLoopOptions(options: LoopCliOptions): ValidationResult {
  if (options.objective === undefined || options.objective.trim().length === 0) {
    return { kind: 'error', message: 'Loop objective is required.' };
  }
  if (
    options.until !== 'verify-pass' &&
    options.until !== 'scan-clean' &&
    options.until !== 'judge-pass'
  ) {
    return { kind: 'error', message: '--until must be verify-pass, scan-clean, or judge-pass.' };
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
