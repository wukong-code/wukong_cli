import { resolve } from 'node:path';

import { inspectGit } from '@wukong/verification';
import { resolveWukongHome } from '@wukong/wukong-sdk';
import type { Command } from 'commander';

import {
  runClaudeStopHook,
  type ClaudeStopHookDeps,
} from '#/cli/lib/claude-stop-hook';
import {
  INTEGRATE_TARGETS,
  inspectIntegrationsStatus,
  installIntegrations,
  removeIntegrations,
  type IntegrateHookMode,
  type IntegrateInstallOptions,
  type IntegrateRemoveOptions,
  type IntegrateStatusEntry,
  type IntegrateTarget,
  type IntegrateTargetOrAll,
  type IntegrateTargetResult,
} from '#/cli/lib/integrate';
import type { CheckDeps } from '#/cli/sub/check';
import {
  parseGateReviewerBackend,
  type GateDeps,
  type GateReviewerBackend,
} from '#/cli/sub/gate';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface IntegrateCommandDeps {
  readonly cwd: () => string;
  readonly homeDir: () => string | undefined;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly inspectGit: typeof inspectGit;
  readonly checkDeps?: Partial<CheckDeps>;
  readonly gateDeps?: Partial<GateDeps>;
}

interface RawInstallOptions {
  readonly mode?: string;
  readonly reviewer?: string;
  readonly strict?: boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

interface RawBasicTargetOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

interface RawStatusOptions {
  readonly json?: boolean;
}

interface RawClaudeStopHookOptions {
  readonly cwd?: string;
  readonly mode?: string;
  readonly reviewer?: string;
  readonly strict?: boolean;
  readonly always?: boolean;
}

export async function handleIntegrateInstall(
  deps: IntegrateCommandDeps,
  targetOrAll: IntegrateTargetOrAll,
  options: IntegrateInstallOptions & { readonly cwd?: string; readonly json?: boolean } = {},
): Promise<number> {
  try {
    const cwd = resolve(options.cwd ?? deps.cwd());
    const results = await installIntegrations(cwd, targetOrAll, options);
    const hasError = results.some((item) => item.status === 'error');

    if (options.json === true) {
      deps.stdout.write(`${JSON.stringify({ ok: !hasError, results }, null, 2)}\n`);
    } else {
      deps.stdout.write(formatTargetResults(results));
    }
    return hasError ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong integrate failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

export async function handleIntegrateStatus(
  deps: IntegrateCommandDeps,
  targetOrAll: IntegrateTargetOrAll,
  options: { readonly cwd?: string; readonly json?: boolean } = {},
): Promise<number> {
  try {
    const cwd = resolve(options.cwd ?? deps.cwd());
    const entries = await inspectIntegrationsStatus(cwd, targetOrAll);
    const unhealthy = entries.some(
      (entry) => entry.status === 'partial' || entry.status === 'invalid',
    );

    if (options.json === true) {
      deps.stdout.write(`${JSON.stringify({ ok: !unhealthy, targets: entries }, null, 2)}\n`);
    } else {
      deps.stdout.write(formatStatusEntries(entries));
    }
    return unhealthy ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong integrate status failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

export async function handleIntegrateRemove(
  deps: IntegrateCommandDeps,
  targetOrAll: IntegrateTargetOrAll,
  options: IntegrateRemoveOptions & { readonly cwd?: string; readonly json?: boolean } = {},
): Promise<number> {
  try {
    const cwd = resolve(options.cwd ?? deps.cwd());
    const results = await removeIntegrations(cwd, targetOrAll, options);
    const hasError = results.some((item) => item.status === 'error');

    if (options.json === true) {
      deps.stdout.write(`${JSON.stringify({ ok: !hasError, results }, null, 2)}\n`);
    } else {
      deps.stdout.write(formatTargetResults(results));
    }
    return hasError ? 1 : 0;
  } catch (error) {
    deps.stderr.write(`wukong integrate remove failed: ${errorMessage(error)}\n`);
    return 1;
  }
}

export function registerIntegrateCommand(
  parent: Command,
  deps?: Partial<IntegrateCommandDeps>,
): void {
  const integrateCmd = parent
    .command('integrate')
    .description(
      'Configure, verify, or remove Wukong integrations for Claude Code, Cursor, and Codex.',
    );

  integrateCmd
    .command('claude')
    .description('Install Wukong Stop Hook into .claude/settings.json.')
    .option('--mode <mode>', 'Hook verification mode: gate or check. Defaults to gate.')
    .option(
      '--reviewer <backend>',
      'Reviewer backend for gate mode: auto, provider, claude, codex, or gemini.',
    )
    .option('--strict', 'Treat any risk as blocking in the hook.', false)
    .option('--force', 'Overwrite unmanaged conflicting Wukong settings.', false)
    .option('--dry-run', 'Preview changes without writing files.', false)
    .option('--json', 'Print structured JSON result.', false)
    .action(async (raw: RawInstallOptions) => {
      const resolved = resolveDeps(deps);
      const parsed = validateInstallOptions(raw, resolved.stderr);
      if (parsed === undefined) {
        process.exitCode = 1;
        return;
      }
      const code = await handleIntegrateInstall(resolved, 'claude', parsed);
      if (code !== 0) process.exitCode = code;
    });

  integrateCmd
    .command('cursor')
    .description('Configure .cursor/mcp.json and .cursor/rules/wukong-gate.mdc for Cursor.')
    .option('--force', 'Overwrite unmanaged conflicting Cursor configuration files.', false)
    .option('--dry-run', 'Preview changes without writing files.', false)
    .option('--json', 'Print structured JSON result.', false)
    .action(async (raw: RawBasicTargetOptions) => {
      const resolved = resolveDeps(deps);
      const code = await handleIntegrateInstall(resolved, 'cursor', {
        force: raw.force === true,
        dryRun: raw.dryRun === true,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });

  integrateCmd
    .command('codex')
    .description('Configure .codex/config.toml and managed AGENTS.md guidance for Codex.')
    .option('--force', 'Overwrite unmanaged conflicting Codex MCP entry.', false)
    .option('--dry-run', 'Preview changes without writing files.', false)
    .option('--json', 'Print structured JSON result.', false)
    .action(async (raw: RawBasicTargetOptions) => {
      const resolved = resolveDeps(deps);
      const code = await handleIntegrateInstall(resolved, 'codex', {
        force: raw.force === true,
        dryRun: raw.dryRun === true,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });

  integrateCmd
    .command('all')
    .description('Configure Wukong integrations for Claude Code, Cursor, and Codex.')
    .option('--mode <mode>', 'Claude hook verification mode: gate or check. Defaults to gate.')
    .option(
      '--reviewer <backend>',
      'Reviewer backend for Claude gate hook: auto, provider, claude, codex, or gemini.',
    )
    .option('--strict', 'Treat any risk as blocking in the Claude hook.', false)
    .option('--force', 'Overwrite unmanaged conflicting configuration entries.', false)
    .option('--dry-run', 'Preview changes without writing files.', false)
    .option('--json', 'Print structured JSON result.', false)
    .action(async (raw: RawInstallOptions) => {
      const resolved = resolveDeps(deps);
      const parsed = validateInstallOptions(raw, resolved.stderr);
      if (parsed === undefined) {
        process.exitCode = 1;
        return;
      }
      const code = await handleIntegrateInstall(resolved, 'all', parsed);
      if (code !== 0) process.exitCode = code;
    });

  integrateCmd
    .command('status')
    .description('Inspect Wukong integration status across agent targets.')
    .argument('[target]', 'Optional target: claude, cursor, codex, or all. Defaults to all.')
    .option('--json', 'Print structured JSON status.', false)
    .action(async (rawTarget: string | undefined, raw: RawStatusOptions) => {
      const resolved = resolveDeps(deps);
      const target = rawTarget === undefined ? 'all' : parseTargetOrAll(rawTarget);
      if (target === undefined) {
        resolved.stderr.write('error: target must be one of: claude, cursor, codex, all.\n');
        process.exitCode = 1;
        return;
      }
      const code = await handleIntegrateStatus(resolved, target, {
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });

  integrateCmd
    .command('remove')
    .description('Remove Wukong-managed integration configuration from a target.')
    .argument('<target>', 'Target to clean: claude, cursor, codex, or all.')
    .option('--force', 'Also remove unmanaged conflicting Wukong entries.', false)
    .option('--dry-run', 'Preview removals without modifying files.', false)
    .option('--json', 'Print structured JSON result.', false)
    .action(async (rawTarget: string, raw: RawBasicTargetOptions) => {
      const resolved = resolveDeps(deps);
      const target = parseTargetOrAll(rawTarget);
      if (target === undefined) {
        resolved.stderr.write('error: target must be one of: claude, cursor, codex, all.\n');
        process.exitCode = 1;
        return;
      }
      const code = await handleIntegrateRemove(resolved, target, {
        force: raw.force === true,
        dryRun: raw.dryRun === true,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });

  const hookCmd = integrateCmd
    .command('hook', { hidden: true })
    .description('Internal runtime hooks invoked by external coding agents.');

  hookCmd
    .command('claude-stop')
    .description('Execute the Claude Code Stop Hook gate/check validation.')
    .option('--cwd <dir>', 'Override workspace directory if stdin omits cwd.')
    .option('--mode <mode>', 'Validation mode: gate or check. Defaults to gate.')
    .option('--reviewer <backend>', 'Reviewer backend: auto, provider, claude, codex, or gemini.')
    .option('--strict', 'Block on any risk, including medium and low.', false)
    .option('--always', 'Run validation even when git reports a clean working tree.', false)
    .action(async (raw: RawClaudeStopHookOptions) => {
      const resolved = resolveDeps(deps);
      let mode: IntegrateHookMode | undefined;
      if (raw.mode !== undefined) {
        mode = parseHookMode(raw.mode);
        if (mode === undefined) {
          resolved.stderr.write('error: --mode must be one of: gate, check.\n');
          process.exitCode = 1;
          return;
        }
      }
      let reviewer: GateReviewerBackend | undefined;
      if (raw.reviewer !== undefined) {
        reviewer = parseGateReviewerBackend(raw.reviewer);
        if (reviewer === undefined) {
          resolved.stderr.write(
            'error: --reviewer must be one of: auto, provider, claude, codex, gemini.\n',
          );
          process.exitCode = 1;
          return;
        }
      }

      const hookDeps: ClaudeStopHookDeps = {
        cwd: resolved.cwd,
        homeDir: resolved.homeDir,
        stdin: resolved.stdin,
        stdout: resolved.stdout,
        stderr: resolved.stderr,
        inspectGit: resolved.inspectGit,
        checkDeps: resolved.checkDeps,
        gateDeps: resolved.gateDeps,
      };
      const code = await runClaudeStopHook(hookDeps, {
        cwd: raw.cwd,
        mode,
        reviewer,
        strict: raw.strict === true,
        always: raw.always === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

function validateInstallOptions(
  raw: RawInstallOptions,
  stderr: WritableLike,
): (IntegrateInstallOptions & { readonly json: boolean }) | undefined {
  let mode: IntegrateHookMode | undefined;
  if (raw.mode !== undefined) {
    mode = parseHookMode(raw.mode);
    if (mode === undefined) {
      stderr.write('error: --mode must be one of: gate, check.\n');
      return undefined;
    }
  }

  let reviewer: GateReviewerBackend | undefined;
  if (raw.reviewer !== undefined) {
    reviewer = parseGateReviewerBackend(raw.reviewer);
    if (reviewer === undefined) {
      stderr.write('error: --reviewer must be one of: auto, provider, claude, codex, gemini.\n');
      return undefined;
    }
  }

  return {
    mode,
    reviewer,
    strict: raw.strict === true,
    force: raw.force === true,
    dryRun: raw.dryRun === true,
    json: raw.json === true,
  };
}

function parseHookMode(value: string): IntegrateHookMode | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized === 'gate' || normalized === 'check' ? normalized : undefined;
}

function parseTargetOrAll(value: string): IntegrateTargetOrAll | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') return 'all';
  return (INTEGRATE_TARGETS as readonly string[]).includes(normalized)
    ? (normalized as IntegrateTarget)
    : undefined;
}

function resolveDeps(overrides: Partial<IntegrateCommandDeps> = {}): IntegrateCommandDeps {
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    homeDir: overrides.homeDir ?? (() => resolveWukongHome()),
    stdin: overrides.stdin ?? process.stdin,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    inspectGit: overrides.inspectGit ?? inspectGit,
    checkDeps: overrides.checkDeps,
    gateDeps: overrides.gateDeps,
  };
}

function formatTargetResults(results: readonly IntegrateTargetResult[]): string {
  const lines: string[] = ['Wukong integrate', ''];
  for (const result of results) {
    const label = result.dryRun ? `${result.target} (${result.operation}, dry-run)` : result.target;
    lines.push(`${label}: ${result.status}`);
    for (const file of result.files) {
      const detail = file.detail === undefined ? '' : ` — ${file.detail}`;
      lines.push(`  - ${file.path}: ${file.action}${detail}`);
    }
    for (const note of result.notes) {
      lines.push(`  Note: ${note}`);
    }
    if (result.error !== undefined) {
      lines.push(`  Error: ${result.error}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function formatStatusEntries(entries: readonly IntegrateStatusEntry[]): string {
  const lines: string[] = ['Wukong integrate status', ''];
  for (const entry of entries) {
    lines.push(`${entry.target}: ${entry.status}`);
    for (const file of entry.files) {
      const detail = file.detail === undefined ? '' : ` — ${file.detail}`;
      lines.push(`  - ${file.path}: ${file.state}${detail}`);
    }
    for (const note of entry.notes) {
      lines.push(`  Note: ${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
