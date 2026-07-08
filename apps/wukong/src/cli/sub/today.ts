import type { Command } from 'commander';

import {
  buildTodayBriefing,
  clearTodayFocus,
  localDateString,
  readTodayFocus,
  writeTodayFocus,
  type BuildTodayBriefingOptions,
  type TodayBriefing,
} from '#/utils/stats';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface TodayCliOptions {
  readonly focus?: string;
  readonly clearFocus?: boolean;
  readonly workspace?: string;
  readonly json?: boolean;
}

export interface TodayDeps {
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly localDate: () => string;
  readonly buildBriefing: (options: BuildTodayBriefingOptions) => Promise<TodayBriefing>;
  readonly readFocus: () => ReturnType<typeof readTodayFocus>;
  readonly writeFocus: (focus: { readonly text: string; readonly setAt: string; readonly workspace: string }) => void;
  readonly clearFocus: () => void;
}

export async function handleToday(deps: TodayDeps, options: TodayCliOptions): Promise<number> {
  try {
    const cwd = options.workspace ?? deps.cwd();

    if (options.clearFocus === true) {
      deps.clearFocus();
    } else if (options.focus !== undefined && options.focus.trim().length > 0) {
      deps.writeFocus({
        text: options.focus.trim(),
        setAt: new Date().toISOString(),
        workspace: cwd,
      });
    }

    const briefing = await deps.buildBriefing({ cwd, date: deps.localDate() });
    deps.stdout.write(options.json === true ? `${JSON.stringify(briefing, null, 2)}\n` : formatToday(briefing));
    return 0;
  } catch (error) {
    deps.stderr.write(`wukong today failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerTodayCommand(parent: Command, deps?: Partial<TodayDeps>): void {
  parent
    .command('today')
    .description("Show today's Daily Proof Briefing and manage today's focus.")
    .argument('[focus...]', 'Set the focus for today. Use quotes for multi-word focus.')
    .option('--clear-focus', 'Clear the current focus.')
    .option('--workspace <path>', 'Use this workspace directory instead of the current directory.')
    .option('--json', 'Print the structured briefing as JSON.')
    .action(async (focusTokens: string[] | undefined, raw: RawTodayOptions) => {
      const code = await handleToday(resolveDeps(deps), {
        focus: focusTokens?.join(' '),
        clearFocus: raw.clearFocus === true,
        workspace: raw.workspace,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawTodayOptions {
  readonly clearFocus?: boolean;
  readonly workspace?: string;
  readonly json?: boolean;
}

function resolveDeps(deps: Partial<TodayDeps> | undefined): TodayDeps {
  return {
    cwd: deps?.cwd ?? (() => process.cwd()),
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    localDate: deps?.localDate ?? localDateString,
    buildBriefing: deps?.buildBriefing ?? buildTodayBriefing,
    readFocus: deps?.readFocus ?? readTodayFocus,
    writeFocus: deps?.writeFocus ?? writeTodayFocus,
    clearFocus: deps?.clearFocus ?? clearTodayFocus,
  };
}

function formatToday(briefing: TodayBriefing): string {
  const lines = [
    `Wukong Today — ${briefing.date}`,
    '',
    `Focus: ${briefing.focus ?? '(not set) — wukong today "<your goal>"'}`,
    '',
    `Workspace: ${briefing.workspace.cwd} (${String(briefing.workspace.changedFiles)} changed)`,
    `Today: verify ${String(briefing.today.verify.runs)} (${String(briefing.today.verify.passed)}✓ ${String(briefing.today.verify.failed)}✗) · scan ${String(briefing.today.scan.runs)} · proof ${String(briefing.today.proof.runs)} ${briefing.today.proof.lastStatus ?? ''}`.trimEnd(),
    `Streak: ${String(briefing.streak)} day${briefing.streak === 1 ? '' : 's'} with at least 1 clean verify`,
  ];

  if (briefing.lastProof !== undefined) {
    lines.push(`Last proof: ${briefing.lastProof.status.toUpperCase()} — ${briefing.lastProof.summary}`);
  }

  if (briefing.next.length > 0) {
    lines.push('', 'Next');
    for (const suggestion of briefing.next) {
      lines.push(`  → ${suggestion}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
