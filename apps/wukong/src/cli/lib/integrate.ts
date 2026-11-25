import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { GateReviewerBackend } from '#/cli/sub/gate';

export const INTEGRATE_TARGETS = ['claude', 'cursor', 'codex'] as const;

export type IntegrateTarget = (typeof INTEGRATE_TARGETS)[number];
export type IntegrateTargetOrAll = IntegrateTarget | 'all';
export type IntegrateHookMode = 'gate' | 'check';
export type IntegrateStatusKind = 'configured' | 'partial' | 'not_configured' | 'invalid';

export interface IntegrateFileAction {
  readonly path: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'removed' | 'skipped';
  readonly detail?: string;
}

export interface IntegrateTargetResult {
  readonly target: IntegrateTarget;
  readonly operation: 'install' | 'remove';
  readonly status: 'ok' | 'unchanged' | 'error';
  readonly dryRun: boolean;
  readonly files: readonly IntegrateFileAction[];
  readonly notes: readonly string[];
  readonly error?: string;
}

export interface IntegrateStatusEntry {
  readonly target: IntegrateTarget;
  readonly status: IntegrateStatusKind;
  readonly files: readonly {
    readonly path: string;
    readonly state: 'configured' | 'missing' | 'unmanaged' | 'invalid';
    readonly detail?: string;
  }[];
  readonly notes: readonly string[];
}

export interface IntegrateInstallOptions {
  readonly mode?: IntegrateHookMode;
  readonly reviewer?: GateReviewerBackend;
  readonly strict?: boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface IntegrateRemoveOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export const CLAUDE_STOP_HOOK_PREFIX = 'wukong integrate hook claude-stop';
export const CURSOR_RULE_MARKER = '<!-- wukong:managed:cursor-rule:v1 -->';
export const CODEX_TOML_START = '# BEGIN WUKONG MANAGED CODEX CONFIG';
export const CODEX_TOML_END = '# END WUKONG MANAGED CODEX CONFIG';
export const CODEX_AGENTS_START = '<!-- wukong:managed:codex-rules:start -->';
export const CODEX_AGENTS_END = '<!-- wukong:managed:codex-rules:end -->';

const CLAUDE_SETTINGS_REL = '.claude/settings.json';
const CURSOR_MCP_REL = '.cursor/mcp.json';
const CURSOR_RULE_REL = '.cursor/rules/wukong-gate.mdc';
const CODEX_CONFIG_REL = '.codex/config.toml';
const CODEX_AGENTS_REL = 'AGENTS.md';

const CLAUDE_MCP_TIP =
  'Optional MCP tip: run `claude mcp add wukong -- wukong mcp` to expose wukong_check / wukong_gate / wukong_summary tools in Claude Code.';

const MANAGED_CURSOR_RULE_CONTENT = [
  '---',
  'description: "Run Wukong verification gates (wukong_check / wukong_gate) before finalizing code changes."',
  'alwaysApply: true',
  '---',
  CURSOR_RULE_MARKER,
  '',
  '# Wukong Verification Gate',
  '',
  'Before claiming a coding task is complete or ready to merge:',
  '',
  '1. Run `wukong_check` (or `wukong check`) to verify deterministic project checks and scan for risks.',
  '2. Never report a task as Gate `PASS` from `wukong_check` alone (`wukong_check` always marks `reviewer: "not_run"`).',
  '3. Run `wukong_gate` (or `wukong gate`) for independent review whenever model review is configured, and attach `wukong_summary` output when summarizing delivery readiness.',
  '',
].join('\n');

const MANAGED_CODEX_TOML_BLOCK = [
  CODEX_TOML_START,
  '[mcp_servers.wukong]',
  'command = "wukong"',
  'args = ["mcp"]',
  'enabled = true',
  CODEX_TOML_END,
].join('\n');

const MANAGED_CODEX_AGENTS_BLOCK = [
  CODEX_AGENTS_START,
  '## Wukong Delivery Verification',
  '',
  '- Before declaring coding changes done, run `wukong check` (or MCP tool `wukong_check`) to confirm deterministic checks pass.',
  '- Never claim a full Gate `PASS` from `wukong check` alone; run `wukong gate` (or MCP tool `wukong_gate`) when independent review is needed and summarize readiness with `wukong summary`.',
  CODEX_AGENTS_END,
].join('\n');

export function resolveTargets(target: IntegrateTargetOrAll): readonly IntegrateTarget[] {
  return target === 'all' ? [...INTEGRATE_TARGETS] : [target];
}

export function buildClaudeStopHookCommand(options?: {
  readonly mode?: IntegrateHookMode;
  readonly reviewer?: GateReviewerBackend;
  readonly strict?: boolean;
}): string {
  const parts: string[] = ['wukong', 'integrate', 'hook', 'claude-stop'];
  if (options?.mode === 'check') {
    parts.push('--mode', 'check');
  }
  if (options?.reviewer !== undefined && options.reviewer !== 'auto') {
    parts.push('--reviewer', options.reviewer);
  }
  if (options?.strict === true) {
    parts.push('--strict');
  }
  return parts.join(' ');
}

export function isManagedClaudeStopHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  return trimmed === CLAUDE_STOP_HOOK_PREFIX || trimmed.startsWith(`${CLAUDE_STOP_HOOK_PREFIX} `);
}

export async function installIntegrations(
  cwd: string,
  targetOrAll: IntegrateTargetOrAll,
  options: IntegrateInstallOptions = {},
): Promise<IntegrateTargetResult[]> {
  const results: IntegrateTargetResult[] = [];
  for (const target of resolveTargets(targetOrAll)) {
    if (target === 'claude') {
      results.push(await installClaudeIntegration(cwd, options));
    } else if (target === 'cursor') {
      results.push(await installCursorIntegration(cwd, options));
    } else {
      results.push(await installCodexIntegration(cwd, options));
    }
  }
  return results;
}

export async function inspectIntegrationsStatus(
  cwd: string,
  targetOrAll: IntegrateTargetOrAll,
): Promise<IntegrateStatusEntry[]> {
  const entries: IntegrateStatusEntry[] = [];
  for (const target of resolveTargets(targetOrAll)) {
    if (target === 'claude') {
      entries.push(await inspectClaudeStatus(cwd));
    } else if (target === 'cursor') {
      entries.push(await inspectCursorStatus(cwd));
    } else {
      entries.push(await inspectCodexStatus(cwd));
    }
  }
  return entries;
}

export async function removeIntegrations(
  cwd: string,
  targetOrAll: IntegrateTargetOrAll,
  options: IntegrateRemoveOptions = {},
): Promise<IntegrateTargetResult[]> {
  const results: IntegrateTargetResult[] = [];
  for (const target of resolveTargets(targetOrAll)) {
    if (target === 'claude') {
      results.push(await removeClaudeIntegration(cwd, options));
    } else if (target === 'cursor') {
      results.push(await removeCursorIntegration(cwd, options));
    } else {
      results.push(await removeCodexIntegration(cwd, options));
    }
  }
  return results;
}

async function installClaudeIntegration(
  cwd: string,
  options: IntegrateInstallOptions,
): Promise<IntegrateTargetResult> {
  const dryRun = options.dryRun === true;
  const filePath = join(cwd, CLAUDE_SETTINGS_REL);
  const existed = existsSync(filePath);

  let root: Record<string, unknown> = {};
  if (existed) {
    const parsed = await readJsonObject(filePath, CLAUDE_SETTINGS_REL);
    if (!parsed.ok) {
      return {
        target: 'claude',
        operation: 'install',
        status: 'error',
        dryRun,
        files: [{ path: CLAUDE_SETTINGS_REL, action: 'skipped', detail: parsed.error }],
        notes: [CLAUDE_MCP_TIP],
        error: parsed.error,
      };
    }
    root = parsed.value;
  }

  const rawHooks = root['hooks'];
  if (rawHooks !== undefined && !isPlainObject(rawHooks)) {
    const error = `${CLAUDE_SETTINGS_REL} has non-object "hooks" field.`;
    return {
      target: 'claude',
      operation: 'install',
      status: 'error',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'skipped', detail: error }],
      notes: [CLAUDE_MCP_TIP],
      error,
    };
  }

  const hooksObj: Record<string, unknown> = isPlainObject(rawHooks) ? { ...rawHooks } : {};
  const rawStop = hooksObj['Stop'];
  if (rawStop !== undefined && !Array.isArray(rawStop)) {
    const error = `${CLAUDE_SETTINGS_REL} has non-array "hooks.Stop" field.`;
    return {
      target: 'claude',
      operation: 'install',
      status: 'error',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'skipped', detail: error }],
      notes: [CLAUDE_MCP_TIP],
      error,
    };
  }

  const desiredCommand = buildClaudeStopHookCommand({
    mode: options.mode,
    reviewer: options.reviewer,
    strict: options.strict,
  });

  const stopGroups = Array.isArray(rawStop) ? [...rawStop] : [];
  let foundManaged = false;
  let changed = false;

  const updatedGroups = stopGroups.map((group) => {
    if (!isPlainObject(group) || !Array.isArray(group['hooks'])) {
      return group;
    }
    const innerHooks = [...group['hooks']];
    const nextInnerHooks: unknown[] = [];
    for (const entry of innerHooks) {
      if (isPlainObject(entry) && isManagedClaudeStopHookCommand(entry['command'])) {
        if (!foundManaged) {
          foundManaged = true;
          if (entry['type'] === 'command' && entry['command'] === desiredCommand) {
            nextInnerHooks.push(entry);
          } else {
            changed = true;
            nextInnerHooks.push({ ...entry, type: 'command', command: desiredCommand });
          }
        } else {
          changed = true;
        }
      } else {
        nextInnerHooks.push(entry);
      }
    }
    return { ...group, hooks: nextInnerHooks };
  });

  if (!foundManaged) {
    changed = true;
    updatedGroups.push({
      hooks: [{ type: 'command', command: desiredCommand }],
    });
  }

  if (!changed && existed) {
    return {
      target: 'claude',
      operation: 'install',
      status: 'unchanged',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'unchanged', detail: desiredCommand }],
      notes: [CLAUDE_MCP_TIP],
    };
  }

  const nextRoot: Record<string, unknown> = {
    ...root,
    hooks: {
      ...hooksObj,
      Stop: updatedGroups,
    },
  };

  if (!dryRun) {
    await writeTextAtomic(filePath, `${JSON.stringify(nextRoot, null, 2)}\n`);
  }

  return {
    target: 'claude',
    operation: 'install',
    status: 'ok',
    dryRun,
    files: [
      {
        path: CLAUDE_SETTINGS_REL,
        action: existed ? 'updated' : 'created',
        detail: desiredCommand,
      },
    ],
    notes: [CLAUDE_MCP_TIP],
  };
}

async function inspectClaudeStatus(cwd: string): Promise<IntegrateStatusEntry> {
  const filePath = join(cwd, CLAUDE_SETTINGS_REL);
  if (!existsSync(filePath)) {
    return {
      target: 'claude',
      status: 'not_configured',
      files: [{ path: CLAUDE_SETTINGS_REL, state: 'missing' }],
      notes: [CLAUDE_MCP_TIP],
    };
  }

  const parsed = await readJsonObject(filePath, CLAUDE_SETTINGS_REL);
  if (!parsed.ok) {
    return {
      target: 'claude',
      status: 'invalid',
      files: [{ path: CLAUDE_SETTINGS_REL, state: 'invalid', detail: parsed.error }],
      notes: [CLAUDE_MCP_TIP],
    };
  }

  const rawHooks = parsed.value['hooks'];
  if (rawHooks !== undefined && !isPlainObject(rawHooks)) {
    return {
      target: 'claude',
      status: 'invalid',
      files: [{ path: CLAUDE_SETTINGS_REL, state: 'invalid', detail: 'Non-object hooks field.' }],
      notes: [CLAUDE_MCP_TIP],
    };
  }

  const rawStop = isPlainObject(rawHooks) ? rawHooks['Stop'] : undefined;
  if (rawStop !== undefined && !Array.isArray(rawStop)) {
    return {
      target: 'claude',
      status: 'invalid',
      files: [{ path: CLAUDE_SETTINGS_REL, state: 'invalid', detail: 'Non-array hooks.Stop field.' }],
      notes: [CLAUDE_MCP_TIP],
    };
  }

  const foundCommand = findManagedClaudeStopCommand(rawStop);
  if (foundCommand !== undefined) {
    return {
      target: 'claude',
      status: 'configured',
      files: [{ path: CLAUDE_SETTINGS_REL, state: 'configured', detail: foundCommand }],
      notes: [CLAUDE_MCP_TIP],
    };
  }

  return {
    target: 'claude',
    status: 'not_configured',
    files: [{ path: CLAUDE_SETTINGS_REL, state: 'unmanaged' }],
    notes: [CLAUDE_MCP_TIP],
  };
}

async function removeClaudeIntegration(
  cwd: string,
  options: IntegrateRemoveOptions,
): Promise<IntegrateTargetResult> {
  const dryRun = options.dryRun === true;
  const filePath = join(cwd, CLAUDE_SETTINGS_REL);
  if (!existsSync(filePath)) {
    return {
      target: 'claude',
      operation: 'remove',
      status: 'unchanged',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'skipped', detail: 'File not present.' }],
      notes: [],
    };
  }

  const parsed = await readJsonObject(filePath, CLAUDE_SETTINGS_REL);
  if (!parsed.ok) {
    return {
      target: 'claude',
      operation: 'remove',
      status: 'error',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'skipped', detail: parsed.error }],
      notes: [],
      error: parsed.error,
    };
  }

  const root = { ...parsed.value };
  const rawHooks = root['hooks'];
  if (!isPlainObject(rawHooks) || !Array.isArray(rawHooks['Stop'])) {
    return {
      target: 'claude',
      operation: 'remove',
      status: 'unchanged',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'unchanged' }],
      notes: [],
    };
  }

  let removedAny = false;
  const nextStopGroups: unknown[] = [];

  for (const group of rawHooks['Stop']) {
    if (!isPlainObject(group) || !Array.isArray(group['hooks'])) {
      nextStopGroups.push(group);
      continue;
    }
    const filteredHooks: unknown[] = [];
    let groupHadManaged = false;
    for (const entry of group['hooks']) {
      if (isPlainObject(entry) && isManagedClaudeStopHookCommand(entry['command'])) {
        removedAny = true;
        groupHadManaged = true;
      } else {
        filteredHooks.push(entry);
      }
    }
    if (
      groupHadManaged
      && filteredHooks.length === 0
      && Object.keys(group).length === 1
    ) {
      continue;
    }
    nextStopGroups.push({ ...group, hooks: filteredHooks });
  }

  if (!removedAny) {
    return {
      target: 'claude',
      operation: 'remove',
      status: 'unchanged',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'unchanged' }],
      notes: [],
    };
  }

  const nextHooks: Record<string, unknown> = { ...rawHooks };
  if (nextStopGroups.length === 0) {
    delete nextHooks['Stop'];
  } else {
    nextHooks['Stop'] = nextStopGroups;
  }

  if (Object.keys(nextHooks).length === 0) {
    delete root['hooks'];
  } else {
    root['hooks'] = nextHooks;
  }

  if (Object.keys(root).length === 0) {
    if (!dryRun) {
      await unlink(filePath);
    }
    return {
      target: 'claude',
      operation: 'remove',
      status: 'ok',
      dryRun,
      files: [{ path: CLAUDE_SETTINGS_REL, action: 'removed' }],
      notes: [],
    };
  }

  if (!dryRun) {
    await writeTextAtomic(filePath, `${JSON.stringify(root, null, 2)}\n`);
  }

  return {
    target: 'claude',
    operation: 'remove',
    status: 'ok',
    dryRun,
    files: [{ path: CLAUDE_SETTINGS_REL, action: 'updated' }],
    notes: [],
  };
}

function findManagedClaudeStopCommand(rawStop: unknown): string | undefined {
  if (!Array.isArray(rawStop)) return undefined;
  for (const group of rawStop) {
    if (!isPlainObject(group) || !Array.isArray(group['hooks'])) continue;
    for (const entry of group['hooks']) {
      if (
        isPlainObject(entry)
        && entry['type'] === 'command'
        && isManagedClaudeStopHookCommand(entry['command'])
        && typeof entry['command'] === 'string'
      ) {
        return entry['command'].trim();
      }
    }
  }
  return undefined;
}

async function installCursorIntegration(
  cwd: string,
  options: IntegrateInstallOptions,
): Promise<IntegrateTargetResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const mcpPlan = await planCursorMcpInstall(join(cwd, CURSOR_MCP_REL), force);
  const rulePlan = await planCursorRuleInstall(join(cwd, CURSOR_RULE_REL), force);

  const errors = [mcpPlan.error, rulePlan.error].filter((item): item is string => item !== undefined);
  if (errors.length > 0) {
    return {
      target: 'cursor',
      operation: 'install',
      status: 'error',
      dryRun,
      files: [mcpPlan.file, rulePlan.file],
      notes: [],
      error: errors.join(' '),
    };
  }

  if (!dryRun) {
    if (mcpPlan.content !== undefined) {
      await writeTextAtomic(join(cwd, CURSOR_MCP_REL), mcpPlan.content);
    }
    if (rulePlan.content !== undefined) {
      await writeTextAtomic(join(cwd, CURSOR_RULE_REL), rulePlan.content);
    }
  }

  const anyChanged =
    mcpPlan.file.action === 'created'
    || mcpPlan.file.action === 'updated'
    || rulePlan.file.action === 'created'
    || rulePlan.file.action === 'updated';

  return {
    target: 'cursor',
    operation: 'install',
    status: anyChanged ? 'ok' : 'unchanged',
    dryRun,
    files: [mcpPlan.file, rulePlan.file],
    notes: [],
  };
}

interface PlannedTextWrite {
  readonly file: IntegrateFileAction;
  readonly content?: string;
  readonly error?: string;
}

async function planCursorMcpInstall(
  filePath: string,
  force: boolean,
): Promise<PlannedTextWrite> {
  const existed = existsSync(filePath);
  let root: Record<string, unknown> = {};

  if (existed) {
    const parsed = await readJsonObject(filePath, CURSOR_MCP_REL);
    if (!parsed.ok) {
      return {
        file: { path: CURSOR_MCP_REL, action: 'skipped', detail: parsed.error },
        error: parsed.error,
      };
    }
    root = parsed.value;
  }

  const rawServers = root['mcpServers'];
  if (rawServers !== undefined && !isPlainObject(rawServers)) {
    const error = `${CURSOR_MCP_REL} has non-object "mcpServers" field.`;
    return {
      file: { path: CURSOR_MCP_REL, action: 'skipped', detail: error },
      error,
    };
  }

  const servers: Record<string, unknown> = isPlainObject(rawServers) ? { ...rawServers } : {};
  const existingEntry = servers['wukong'];
  if (existingEntry !== undefined) {
    if (isExactManagedMcpServer(existingEntry)) {
      return {
        file: { path: CURSOR_MCP_REL, action: 'unchanged' },
      };
    }
    if (!force) {
      const error = `${CURSOR_MCP_REL} already defines an unmanaged "mcpServers.wukong" entry; pass --force to overwrite.`;
      return {
        file: { path: CURSOR_MCP_REL, action: 'skipped', detail: error },
        error,
      };
    }
  }

  const nextRoot: Record<string, unknown> = {
    ...root,
    mcpServers: {
      ...servers,
      wukong: {
        command: 'wukong',
        args: ['mcp'],
      },
    },
  };

  return {
    file: { path: CURSOR_MCP_REL, action: existed ? 'updated' : 'created' },
    content: `${JSON.stringify(nextRoot, null, 2)}\n`,
  };
}

async function planCursorRuleInstall(
  filePath: string,
  force: boolean,
): Promise<PlannedTextWrite> {
  if (!existsSync(filePath)) {
    return {
      file: { path: CURSOR_RULE_REL, action: 'created' },
      content: MANAGED_CURSOR_RULE_CONTENT,
    };
  }

  const current = await readFile(filePath, 'utf8');
  if (current === MANAGED_CURSOR_RULE_CONTENT) {
    return {
      file: { path: CURSOR_RULE_REL, action: 'unchanged' },
    };
  }

  if (!current.includes(CURSOR_RULE_MARKER) && !force) {
    const error = `${CURSOR_RULE_REL} exists without the Wukong managed marker; pass --force to overwrite.`;
    return {
      file: { path: CURSOR_RULE_REL, action: 'skipped', detail: error },
      error,
    };
  }

  return {
    file: { path: CURSOR_RULE_REL, action: 'updated' },
    content: MANAGED_CURSOR_RULE_CONTENT,
  };
}

async function inspectCursorStatus(cwd: string): Promise<IntegrateStatusEntry> {
  const mcpPath = join(cwd, CURSOR_MCP_REL);
  let mcpFile: IntegrateStatusEntry['files'][number];

  if (!existsSync(mcpPath)) {
    mcpFile = { path: CURSOR_MCP_REL, state: 'missing' };
  } else {
    const parsed = await readJsonObject(mcpPath, CURSOR_MCP_REL);
    if (!parsed.ok) {
      mcpFile = { path: CURSOR_MCP_REL, state: 'invalid', detail: parsed.error };
    } else {
      const rawServers = parsed.value['mcpServers'];
      if (rawServers !== undefined && !isPlainObject(rawServers)) {
        mcpFile = {
          path: CURSOR_MCP_REL,
          state: 'invalid',
          detail: 'Non-object mcpServers field.',
        };
      } else if (isPlainObject(rawServers) && isConfiguredCursorMcpEntry(rawServers['wukong'])) {
        mcpFile = { path: CURSOR_MCP_REL, state: 'configured', detail: 'wukong mcp' };
      } else {
        mcpFile = { path: CURSOR_MCP_REL, state: 'unmanaged' };
      }
    }
  }

  const rulePath = join(cwd, CURSOR_RULE_REL);
  let ruleFile: IntegrateStatusEntry['files'][number];
  if (!existsSync(rulePath)) {
    ruleFile = { path: CURSOR_RULE_REL, state: 'missing' };
  } else {
    const content = await readFile(rulePath, 'utf8');
    ruleFile = content.includes(CURSOR_RULE_MARKER)
      ? { path: CURSOR_RULE_REL, state: 'configured' }
      : { path: CURSOR_RULE_REL, state: 'unmanaged' };
  }

  return {
    target: 'cursor',
    status: aggregateStatus([mcpFile, ruleFile]),
    files: [mcpFile, ruleFile],
    notes: [],
  };
}

async function removeCursorIntegration(
  cwd: string,
  options: IntegrateRemoveOptions,
): Promise<IntegrateTargetResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const mcpOutcome = await planCursorMcpRemove(join(cwd, CURSOR_MCP_REL), force);
  const ruleOutcome = await planCursorRuleRemove(join(cwd, CURSOR_RULE_REL), force);

  const errors = [mcpOutcome.error, ruleOutcome.error].filter(
    (item): item is string => item !== undefined,
  );
  if (errors.length > 0) {
    return {
      target: 'cursor',
      operation: 'remove',
      status: 'error',
      dryRun,
      files: [mcpOutcome.file, ruleOutcome.file],
      notes: [],
      error: errors.join(' '),
    };
  }

  if (!dryRun) {
    await applyRemovalPlan(join(cwd, CURSOR_MCP_REL), mcpOutcome);
    await applyRemovalPlan(join(cwd, CURSOR_RULE_REL), ruleOutcome);
  }

  const anyChanged =
    mcpOutcome.file.action === 'removed'
    || mcpOutcome.file.action === 'updated'
    || ruleOutcome.file.action === 'removed'
    || ruleOutcome.file.action === 'updated';

  return {
    target: 'cursor',
    operation: 'remove',
    status: anyChanged ? 'ok' : 'unchanged',
    dryRun,
    files: [mcpOutcome.file, ruleOutcome.file],
    notes: [],
  };
}

interface PlannedRemoval {
  readonly file: IntegrateFileAction;
  readonly deleteFile?: boolean;
  readonly nextContent?: string;
  readonly error?: string;
}

async function planCursorMcpRemove(filePath: string, force: boolean): Promise<PlannedRemoval> {
  if (!existsSync(filePath)) {
    return {
      file: { path: CURSOR_MCP_REL, action: 'skipped', detail: 'File not present.' },
    };
  }

  const parsed = await readJsonObject(filePath, CURSOR_MCP_REL);
  if (!parsed.ok) {
    return {
      file: { path: CURSOR_MCP_REL, action: 'skipped', detail: parsed.error },
      error: parsed.error,
    };
  }

  const root = { ...parsed.value };
  const rawServers = root['mcpServers'];
  if (!isPlainObject(rawServers) || !('wukong' in rawServers)) {
    return {
      file: { path: CURSOR_MCP_REL, action: 'unchanged' },
    };
  }

  const entry = rawServers['wukong'];
  if (!isConfiguredCursorMcpEntry(entry) && !force) {
    return {
      file: {
        path: CURSOR_MCP_REL,
        action: 'skipped',
        detail: 'Preserved unmanaged mcpServers.wukong entry (pass --force to remove).',
      },
    };
  }

  const nextServers: Record<string, unknown> = { ...rawServers };
  delete nextServers['wukong'];
  if (Object.keys(nextServers).length === 0) {
    delete root['mcpServers'];
  } else {
    root['mcpServers'] = nextServers;
  }

  if (Object.keys(root).length === 0) {
    return {
      file: { path: CURSOR_MCP_REL, action: 'removed' },
      deleteFile: true,
    };
  }

  return {
    file: { path: CURSOR_MCP_REL, action: 'updated' },
    nextContent: `${JSON.stringify(root, null, 2)}\n`,
  };
}

async function planCursorRuleRemove(filePath: string, force: boolean): Promise<PlannedRemoval> {
  if (!existsSync(filePath)) {
    return {
      file: { path: CURSOR_RULE_REL, action: 'skipped', detail: 'File not present.' },
    };
  }

  const current = await readFile(filePath, 'utf8');
  if (current.includes(CURSOR_RULE_MARKER) || force) {
    return {
      file: { path: CURSOR_RULE_REL, action: 'removed' },
      deleteFile: true,
    };
  }

  return {
    file: {
      path: CURSOR_RULE_REL,
      action: 'skipped',
      detail: 'Preserved unmanaged user rule file (pass --force to remove).',
    },
  };
}

async function installCodexIntegration(
  cwd: string,
  options: IntegrateInstallOptions,
): Promise<IntegrateTargetResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const tomlPlan = await planCodexTomlInstall(join(cwd, CODEX_CONFIG_REL), force);
  const agentsPlan = await planCodexAgentsInstall(join(cwd, CODEX_AGENTS_REL));

  const errors = [tomlPlan.error, agentsPlan.error].filter(
    (item): item is string => item !== undefined,
  );
  if (errors.length > 0) {
    return {
      target: 'codex',
      operation: 'install',
      status: 'error',
      dryRun,
      files: [tomlPlan.file, agentsPlan.file],
      notes: [],
      error: errors.join(' '),
    };
  }

  if (!dryRun) {
    if (tomlPlan.content !== undefined) {
      await writeTextAtomic(join(cwd, CODEX_CONFIG_REL), tomlPlan.content);
    }
    if (agentsPlan.content !== undefined) {
      await writeTextAtomic(join(cwd, CODEX_AGENTS_REL), agentsPlan.content);
    }
  }

  const anyChanged =
    tomlPlan.file.action === 'created'
    || tomlPlan.file.action === 'updated'
    || agentsPlan.file.action === 'created'
    || agentsPlan.file.action === 'updated';

  return {
    target: 'codex',
    operation: 'install',
    status: anyChanged ? 'ok' : 'unchanged',
    dryRun,
    files: [tomlPlan.file, agentsPlan.file],
    notes: [],
  };
}

async function planCodexTomlInstall(filePath: string, force: boolean): Promise<PlannedTextWrite> {
  if (!existsSync(filePath)) {
    const content = `${MANAGED_CODEX_TOML_BLOCK}\n`;
    parseToml(content);
    return {
      file: { path: CODEX_CONFIG_REL, action: 'created' },
      content,
    };
  }

  const raw = await readFile(filePath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (error) {
    const msg = `${CODEX_CONFIG_REL} is not valid TOML: ${errorMessage(error)}`;
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  const marked = extractMarkedRange(raw, CODEX_TOML_START, CODEX_TOML_END);
  if (marked.kind === 'malformed') {
    const msg = `${CODEX_CONFIG_REL} has malformed Wukong managed block markers.`;
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  if (marked.kind === 'found') {
    if (marked.block === MANAGED_CODEX_TOML_BLOCK) {
      return {
        file: { path: CODEX_CONFIG_REL, action: 'unchanged' },
      };
    }
    const nextContent = `${marked.before}${MANAGED_CODEX_TOML_BLOCK}${marked.after}`;
    try {
      parseToml(nextContent);
    } catch (error) {
      const msg = `Updating ${CODEX_CONFIG_REL} produced invalid TOML: ${errorMessage(error)}`;
      return {
        file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
        error: msg,
      };
    }
    return {
      file: { path: CODEX_CONFIG_REL, action: 'updated' },
      content: nextContent,
    };
  }

  const rawServers = parsed['mcp_servers'];
  if (rawServers !== undefined && !isPlainObject(rawServers)) {
    const msg = `${CODEX_CONFIG_REL} has non-table "mcp_servers" entry.`;
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  if (isPlainObject(rawServers) && 'wukong' in rawServers) {
    const existingEntry = rawServers['wukong'];
    if (isConfiguredCodexMcpEntry(existingEntry)) {
      return {
        file: { path: CODEX_CONFIG_REL, action: 'unchanged' },
      };
    }
    if (!force) {
      const msg = `${CODEX_CONFIG_REL} already defines an unmanaged [mcp_servers.wukong] table; pass --force to overwrite.`;
      return {
        file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
        error: msg,
      };
    }
    const nextDoc: Record<string, unknown> = {
      ...parsed,
      mcp_servers: {
        ...rawServers,
        wukong: {
          command: 'wukong',
          args: ['mcp'],
          enabled: true,
        },
      },
    };
    const nextContent = `${stringifyToml(nextDoc).trimEnd()}\n`;
    parseToml(nextContent);
    return {
      file: { path: CODEX_CONFIG_REL, action: 'updated' },
      content: nextContent,
    };
  }

  const trimmed = raw.trimEnd();
  const nextContent =
    trimmed.length === 0
      ? `${MANAGED_CODEX_TOML_BLOCK}\n`
      : `${trimmed}\n\n${MANAGED_CODEX_TOML_BLOCK}\n`;
  try {
    parseToml(nextContent);
  } catch (error) {
    const msg = `Appending Wukong MCP server to ${CODEX_CONFIG_REL} produced invalid TOML: ${errorMessage(error)}`;
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  return {
    file: { path: CODEX_CONFIG_REL, action: 'updated' },
    content: nextContent,
  };
}

async function planCodexAgentsInstall(filePath: string): Promise<PlannedTextWrite> {
  if (!existsSync(filePath)) {
    return {
      file: { path: CODEX_AGENTS_REL, action: 'created' },
      content: `${MANAGED_CODEX_AGENTS_BLOCK}\n`,
    };
  }

  const raw = await readFile(filePath, 'utf8');
  const marked = extractMarkedRange(raw, CODEX_AGENTS_START, CODEX_AGENTS_END);
  if (marked.kind === 'malformed') {
    const msg = `${CODEX_AGENTS_REL} has malformed Wukong managed section markers.`;
    return {
      file: { path: CODEX_AGENTS_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  if (marked.kind === 'found') {
    if (marked.block === MANAGED_CODEX_AGENTS_BLOCK) {
      return {
        file: { path: CODEX_AGENTS_REL, action: 'unchanged' },
      };
    }
    return {
      file: { path: CODEX_AGENTS_REL, action: 'updated' },
      content: `${marked.before}${MANAGED_CODEX_AGENTS_BLOCK}${marked.after}`,
    };
  }

  const trimmed = raw.trimEnd();
  const nextContent =
    trimmed.length === 0
      ? `${MANAGED_CODEX_AGENTS_BLOCK}\n`
      : `${trimmed}\n\n${MANAGED_CODEX_AGENTS_BLOCK}\n`;

  return {
    file: { path: CODEX_AGENTS_REL, action: 'updated' },
    content: nextContent,
  };
}

async function inspectCodexStatus(cwd: string): Promise<IntegrateStatusEntry> {
  const tomlPath = join(cwd, CODEX_CONFIG_REL);
  let tomlFile: IntegrateStatusEntry['files'][number];

  if (!existsSync(tomlPath)) {
    tomlFile = { path: CODEX_CONFIG_REL, state: 'missing' };
  } else {
    const raw = await readFile(tomlPath, 'utf8');
    try {
      const parsed = parseToml(raw) as Record<string, unknown>;
      const rawServers = parsed['mcp_servers'];
      if (rawServers !== undefined && !isPlainObject(rawServers)) {
        tomlFile = {
          path: CODEX_CONFIG_REL,
          state: 'invalid',
          detail: 'Non-table mcp_servers field.',
        };
      } else if (isPlainObject(rawServers) && isConfiguredCodexMcpEntry(rawServers['wukong'])) {
        tomlFile = { path: CODEX_CONFIG_REL, state: 'configured', detail: 'wukong mcp' };
      } else {
        tomlFile = { path: CODEX_CONFIG_REL, state: 'unmanaged' };
      }
    } catch (error) {
      tomlFile = {
        path: CODEX_CONFIG_REL,
        state: 'invalid',
        detail: errorMessage(error),
      };
    }
  }

  const agentsPath = join(cwd, CODEX_AGENTS_REL);
  let agentsFile: IntegrateStatusEntry['files'][number];
  if (!existsSync(agentsPath)) {
    agentsFile = { path: CODEX_AGENTS_REL, state: 'missing' };
  } else {
    const raw = await readFile(agentsPath, 'utf8');
    const marked = extractMarkedRange(raw, CODEX_AGENTS_START, CODEX_AGENTS_END);
    if (marked.kind === 'found') {
      agentsFile = { path: CODEX_AGENTS_REL, state: 'configured' };
    } else if (marked.kind === 'malformed') {
      agentsFile = {
        path: CODEX_AGENTS_REL,
        state: 'invalid',
        detail: 'Malformed Wukong managed section markers.',
      };
    } else {
      agentsFile = { path: CODEX_AGENTS_REL, state: 'unmanaged' };
    }
  }

  return {
    target: 'codex',
    status: aggregateStatus([tomlFile, agentsFile]),
    files: [tomlFile, agentsFile],
    notes: [],
  };
}

async function removeCodexIntegration(
  cwd: string,
  options: IntegrateRemoveOptions,
): Promise<IntegrateTargetResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const tomlOutcome = await planCodexTomlRemove(join(cwd, CODEX_CONFIG_REL), force);
  const agentsOutcome = await planCodexAgentsRemove(join(cwd, CODEX_AGENTS_REL));

  const errors = [tomlOutcome.error, agentsOutcome.error].filter(
    (item): item is string => item !== undefined,
  );
  if (errors.length > 0) {
    return {
      target: 'codex',
      operation: 'remove',
      status: 'error',
      dryRun,
      files: [tomlOutcome.file, agentsOutcome.file],
      notes: [],
      error: errors.join(' '),
    };
  }

  if (!dryRun) {
    await applyRemovalPlan(join(cwd, CODEX_CONFIG_REL), tomlOutcome);
    await applyRemovalPlan(join(cwd, CODEX_AGENTS_REL), agentsOutcome);
  }

  const anyChanged =
    tomlOutcome.file.action === 'removed'
    || tomlOutcome.file.action === 'updated'
    || agentsOutcome.file.action === 'removed'
    || agentsOutcome.file.action === 'updated';

  return {
    target: 'codex',
    operation: 'remove',
    status: anyChanged ? 'ok' : 'unchanged',
    dryRun,
    files: [tomlOutcome.file, agentsOutcome.file],
    notes: [],
  };
}

async function planCodexTomlRemove(filePath: string, force: boolean): Promise<PlannedRemoval> {
  if (!existsSync(filePath)) {
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: 'File not present.' },
    };
  }

  const raw = await readFile(filePath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (error) {
    const msg = `${CODEX_CONFIG_REL} is not valid TOML: ${errorMessage(error)}`;
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  const marked = extractMarkedRange(raw, CODEX_TOML_START, CODEX_TOML_END);
  if (marked.kind === 'malformed') {
    const msg = `${CODEX_CONFIG_REL} has malformed Wukong managed block markers.`;
    return {
      file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  if (marked.kind === 'found') {
    const remaining = stitchRemovedSection(marked.before, marked.after);
    if (remaining === '') {
      return {
        file: { path: CODEX_CONFIG_REL, action: 'removed' },
        deleteFile: true,
      };
    }
    try {
      parseToml(remaining);
    } catch (error) {
      const msg = `Removing managed block from ${CODEX_CONFIG_REL} produced invalid TOML: ${errorMessage(error)}`;
      return {
        file: { path: CODEX_CONFIG_REL, action: 'skipped', detail: msg },
        error: msg,
      };
    }
    return {
      file: { path: CODEX_CONFIG_REL, action: 'updated' },
      nextContent: remaining,
    };
  }

  const rawServers = parsed['mcp_servers'];
  if (!isPlainObject(rawServers) || !('wukong' in rawServers)) {
    return {
      file: { path: CODEX_CONFIG_REL, action: 'unchanged' },
    };
  }

  if (!isConfiguredCodexMcpEntry(rawServers['wukong']) && !force) {
    return {
      file: {
        path: CODEX_CONFIG_REL,
        action: 'skipped',
        detail: 'Preserved unmanaged [mcp_servers.wukong] table (pass --force to remove).',
      },
    };
  }

  const nextServers: Record<string, unknown> = { ...rawServers };
  delete nextServers['wukong'];
  const nextDoc: Record<string, unknown> = { ...parsed };
  if (Object.keys(nextServers).length === 0) {
    delete nextDoc['mcp_servers'];
  } else {
    nextDoc['mcp_servers'] = nextServers;
  }

  if (Object.keys(nextDoc).length === 0) {
    return {
      file: { path: CODEX_CONFIG_REL, action: 'removed' },
      deleteFile: true,
    };
  }

  return {
    file: { path: CODEX_CONFIG_REL, action: 'updated' },
    nextContent: `${stringifyToml(nextDoc).trimEnd()}\n`,
  };
}

async function planCodexAgentsRemove(filePath: string): Promise<PlannedRemoval> {
  if (!existsSync(filePath)) {
    return {
      file: { path: CODEX_AGENTS_REL, action: 'skipped', detail: 'File not present.' },
    };
  }

  const raw = await readFile(filePath, 'utf8');
  const marked = extractMarkedRange(raw, CODEX_AGENTS_START, CODEX_AGENTS_END);
  if (marked.kind === 'malformed') {
    const msg = `${CODEX_AGENTS_REL} has malformed Wukong managed section markers.`;
    return {
      file: { path: CODEX_AGENTS_REL, action: 'skipped', detail: msg },
      error: msg,
    };
  }

  if (marked.kind === 'none') {
    return {
      file: {
        path: CODEX_AGENTS_REL,
        action: 'skipped',
        detail: 'Preserved user AGENTS.md without Wukong managed markers.',
      },
    };
  }

  const remaining = stitchRemovedSection(marked.before, marked.after);
  if (remaining === '') {
    return {
      file: { path: CODEX_AGENTS_REL, action: 'removed' },
      deleteFile: true,
    };
  }

  return {
    file: { path: CODEX_AGENTS_REL, action: 'updated' },
    nextContent: remaining,
  };
}

function isExactManagedMcpServer(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  return (
    entry['command'] === 'wukong'
    && Array.isArray(entry['args'])
    && entry['args'].length === 1
    && entry['args'][0] === 'mcp'
    && keys.every((key) => key === 'command' || key === 'args')
  );
}

function isConfiguredCursorMcpEntry(entry: unknown): boolean {
  return (
    isPlainObject(entry)
    && entry['command'] === 'wukong'
    && Array.isArray(entry['args'])
    && entry['args'][0] === 'mcp'
  );
}

function isConfiguredCodexMcpEntry(entry: unknown): boolean {
  return (
    isPlainObject(entry)
    && entry['command'] === 'wukong'
    && Array.isArray(entry['args'])
    && entry['args'][0] === 'mcp'
    && entry['enabled'] !== false
  );
}

function extractMarkedRange(
  raw: string,
  startMarker: string,
  endMarker: string,
):
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed' }
  | {
      readonly kind: 'found';
      readonly before: string;
      readonly block: string;
      readonly after: string;
    } {
  const startIdx = raw.indexOf(startMarker);
  const endIdx = raw.indexOf(endMarker);
  if (startIdx === -1 && endIdx === -1) {
    return { kind: 'none' };
  }
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { kind: 'malformed' };
  }
  const blockEnd = endIdx + endMarker.length;
  return {
    kind: 'found',
    before: raw.slice(0, startIdx),
    block: raw.slice(startIdx, blockEnd),
    after: raw.slice(blockEnd),
  };
}

function stitchRemovedSection(before: string, after: string): string {
  const beforeTrimmed = before.replace(/[ \t\r\n]+$/u, '');
  const afterTrimmed = after.replace(/^[ \t\r\n]+/u, '').replace(/[ \t\r\n]+$/u, '');
  if (beforeTrimmed.length === 0 && afterTrimmed.length === 0) {
    return '';
  }
  if (beforeTrimmed.length === 0) {
    return `${afterTrimmed}\n`;
  }
  if (afterTrimmed.length === 0) {
    return `${beforeTrimmed}\n`;
  }
  return `${beforeTrimmed}\n\n${afterTrimmed}\n`;
}

function aggregateStatus(
  files: readonly IntegrateStatusEntry['files'][number][],
): IntegrateStatusKind {
  if (files.some((file) => file.state === 'invalid')) {
    return 'invalid';
  }
  const configuredCount = files.filter((file) => file.state === 'configured').length;
  if (configuredCount === files.length) {
    return 'configured';
  }
  if (configuredCount > 0) {
    return 'partial';
  }
  return 'not_configured';
}

async function applyRemovalPlan(filePath: string, plan: PlannedRemoval): Promise<void> {
  if (plan.deleteFile === true) {
    await unlink(filePath);
    return;
  }
  if (plan.nextContent !== undefined) {
    await writeTextAtomic(filePath, plan.nextContent);
  }
}

async function readJsonObject(
  filePath: string,
  relPath: string,
): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    return { ok: false, error: `Failed to read ${relPath}: ${errorMessage(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return { ok: false, error: `${relPath} is not valid JSON: ${errorMessage(error)}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${relPath} must contain a JSON object.` };
  }
  return { ok: true, value: parsed };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.${base}.${String(process.pid)}.${String(Date.now())}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o644 });
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
