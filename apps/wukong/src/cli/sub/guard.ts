import {
  getGuardStats,
  getGuardStatus,
  runGuardedCommand,
  setGuardEnabled,
  type GuardRunResult,
  type GuardStats,
  type GuardStatus,
} from '@wukong/verification';
import type { Command } from 'commander';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface GuardCliOptions {
  readonly enable?: boolean;
  readonly disable?: boolean;
  readonly status?: boolean;
  readonly stats?: boolean;
  readonly yes?: boolean;
  readonly command?: readonly string[];
}

export interface GuardDeps {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly getGuardStatus: () => Promise<GuardStatus>;
  readonly getGuardStats: () => Promise<GuardStats>;
  readonly setGuardEnabled: (enabled: boolean) => Promise<GuardStatus>;
  readonly runGuardedCommand: (command: readonly string[], options: { readonly allowHighRisk?: boolean }) => Promise<GuardRunResult>;
}

export async function handleGuard(deps: GuardDeps, options: GuardCliOptions): Promise<number> {
  try {
    if (options.enable === true) {
      deps.stdout.write(formatStatus(await deps.setGuardEnabled(true)));
      return 0;
    }
    if (options.disable === true) {
      deps.stdout.write(formatStatus(await deps.setGuardEnabled(false)));
      return 0;
    }
    if (options.stats === true) {
      deps.stdout.write(formatStats(await deps.getGuardStats()));
      return 0;
    }
    if (options.command !== undefined && options.command.length > 0) {
      const result = await deps.runGuardedCommand(options.command, { allowHighRisk: options.yes === true });
      if (result.blocked) deps.stderr.write(`${result.message}\n`);
      else deps.stdout.write(`${result.message}\n`);
      return result.exitCode;
    }
    deps.stdout.write(formatStatus(await deps.getGuardStatus()));
    return 0;
  } catch (error) {
    deps.stderr.write(`wukong guard failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerGuardCommand(parent: Command, deps?: Partial<GuardDeps>): void {
  parent
    .command('guard')
    .description('Inspect or run the best-effort command risk guard.')
    .allowUnknownOption(true)
    .option('--enable', 'Enable local guard state.')
    .option('--disable', 'Disable local guard state.')
    .option('--status', 'Show guard status.')
    .option('--stats', 'Show local guard event statistics.')
    .option('-y, --yes', 'Allow a high-risk command after classification.')
    .argument('[command...]', 'Command to classify and run after --.')
    .action(async (command: string[] | undefined, raw: RawGuardOptions) => {
      const code = await handleGuard(resolveDeps(deps), {
        enable: raw.enable === true,
        disable: raw.disable === true,
        status: raw.status === true,
        stats: raw.stats === true,
        yes: raw.yes === true,
        command,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawGuardOptions {
  readonly enable?: boolean;
  readonly disable?: boolean;
  readonly status?: boolean;
  readonly stats?: boolean;
  readonly yes?: boolean;
}

function resolveDeps(deps: Partial<GuardDeps> | undefined): GuardDeps {
  return {
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    getGuardStatus: deps?.getGuardStatus ?? getGuardStatus,
    getGuardStats: deps?.getGuardStats ?? getGuardStats,
    setGuardEnabled: deps?.setGuardEnabled ?? setGuardEnabled,
    runGuardedCommand: deps?.runGuardedCommand ?? runGuardedCommand,
  };
}

function formatStatus(status: GuardStatus): string {
  return [
    'Wukong guard',
    '',
    `Enabled: ${status.enabled ? 'yes' : 'no'}`,
    `Config: ${status.configPath}`,
    `Events: ${status.eventsPath}`,
    '',
  ].join('\n');
}

function formatStats(stats: GuardStats): string {
  return [
    'Wukong guard stats',
    '',
    `Total: ${String(stats.total)}`,
    `Blocked: ${String(stats.blocked)}`,
    `Allowed: ${String(stats.allowed)}`,
    ...(stats.lastEventAt === undefined ? [] : [`Last event: ${stats.lastEventAt}`]),
    '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
