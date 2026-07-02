import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { classifyCommandRisk } from './policy';
import type { GuardEvent, GuardStats, GuardStatus } from './types';

interface GuardConfig {
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface GuardOptions {
  readonly homeDir?: string;
  readonly cwd?: string;
}

export interface GuardRunOptions extends GuardOptions {
  readonly allowHighRisk?: boolean;
}

export interface GuardRunResult {
  readonly exitCode: number;
  readonly blocked: boolean;
  readonly message: string;
}

export async function getGuardStatus(options: GuardOptions = {}): Promise<GuardStatus> {
  const paths = guardPaths(options.homeDir);
  const config = await readGuardConfig(paths.configPath);
  return {
    enabled: config?.enabled === true,
    configPath: paths.configPath,
    eventsPath: paths.eventsPath,
  };
}

export async function setGuardEnabled(enabled: boolean, options: GuardOptions = {}): Promise<GuardStatus> {
  const paths = guardPaths(options.homeDir);
  await mkdir(dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  return getGuardStatus(options);
}

export async function getGuardStats(options: GuardOptions = {}): Promise<GuardStats> {
  const paths = guardPaths(options.homeDir);
  if (!existsSync(paths.eventsPath)) return { total: 0, blocked: 0, allowed: 0 };
  const text = await readFile(paths.eventsPath, 'utf8');
  const events = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as GuardEvent];
      } catch {
        return [];
      }
    });
  const total = events.length;
  const blocked = events.filter((event) => event.action === 'blocked').length;
  const allowed = events.filter((event) => event.action === 'allowed').length;
  const last = events[events.length - 1];
  if (last === undefined) return { total, blocked, allowed };
  return { total, blocked, allowed, lastEventAt: last.timestamp };
}

export async function runGuardedCommand(
  command: readonly string[],
  options: GuardRunOptions = {},
): Promise<GuardRunResult> {
  if (command.length === 0) {
    return { exitCode: 2, blocked: true, message: 'No command provided.' };
  }

  const risk = classifyCommandRisk(command);
  if (risk !== undefined && options.allowHighRisk !== true) {
    const message = `Blocked high-risk command: ${risk.message}`;
    await appendGuardEvent({
      options,
      command,
      action: 'blocked',
      message,
      riskId: risk.id,
      severity: risk.severity,
    });
    return { exitCode: 1, blocked: true, message };
  }

  const exitCode = await spawnInherited(command, options.cwd ?? process.cwd());
  await appendGuardEvent({
    options,
    command,
    action: 'allowed',
    message: risk === undefined ? 'Command allowed.' : `Allowed high-risk command: ${risk.message}`,
    riskId: risk?.id,
    severity: risk?.severity,
  });
  return {
    exitCode,
    blocked: false,
    message: risk === undefined ? 'Command completed.' : `Allowed high-risk command: ${risk.message}`,
  };
}

function guardPaths(homeDir: string | undefined): { readonly configPath: string; readonly eventsPath: string } {
  const root = homeDir ?? process.env['WUKONG_HOME'] ?? process.env['WUKONG_CODE_HOME'] ?? join(homedir(), '.wukong');
  return {
    configPath: join(root, 'guard', 'config.json'),
    eventsPath: join(root, 'guard', 'events.jsonl'),
  };
}

async function readGuardConfig(path: string): Promise<GuardConfig | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as GuardConfig;
  } catch {
    return undefined;
  }
}

async function appendGuardEvent(input: {
  readonly options: GuardOptions;
  readonly command: readonly string[];
  readonly action: GuardEvent['action'];
  readonly message: string;
  readonly riskId?: string;
  readonly severity?: GuardEvent['severity'];
}): Promise<void> {
  const paths = guardPaths(input.options.homeDir);
  await mkdir(dirname(paths.eventsPath), { recursive: true });
  const event: GuardEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    cwd: input.options.cwd ?? process.cwd(),
    command: input.command,
    action: input.action,
    message: input.message,
    ...(input.riskId === undefined ? {} : { riskId: input.riskId }),
    ...(input.severity === undefined ? {} : { severity: input.severity }),
  };
  await writeFile(paths.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
}

function spawnInherited(command: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const [file, ...args] = command;
    if (file === undefined) {
      resolve(2);
      return;
    }
    const child = spawn(file, args, { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
