import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { inspectGit } from './git';
import { runFile } from './process';
import type { GitInspection, VerificationCommand, WorkspaceSnapshot } from './types';

const CONFIG_PATHS = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.wukong/checks.json',
] as const;

export async function createWorkspaceSnapshot(options: {
  readonly cwd?: string;
  readonly commands?: readonly VerificationCommand[];
  readonly git?: GitInspection;
} = {}): Promise<WorkspaceSnapshot> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const git = options.git ?? await inspectGit(cwd);
  const [headSha, untrackedContent, configContent] = await Promise.all([
    readHeadSha(cwd, git),
    readUntrackedContent(cwd, git),
    readConfigContent(cwd),
  ]);
  const inputDigest = digest([
    git.statusText,
    git.diffText,
    untrackedContent,
  ]);
  const configDigest = digest(configContent);
  const planDigest = digest((options.commands ?? []).map((command) => `${command.source}:${command.command}`));
  const id = digest([cwd, headSha ?? '', inputDigest, configDigest, planDigest]);
  return { id, cwd, headSha, inputDigest, configDigest, planDigest, git };
}

export function workspaceSnapshotMatches(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return left.id === right.id;
}

async function readHeadSha(cwd: string, git: GitInspection): Promise<string | undefined> {
  if (!git.isRepo) return undefined;
  const result = await runFile('git', ['rev-parse', 'HEAD'], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function readUntrackedContent(cwd: string, git: GitInspection): Promise<string[]> {
  const paths = git.changedFiles
    .filter((file) => file.status === '??')
    .map((file) => file.path)
    .toSorted();
  return Promise.all(paths.map(async (path) => {
    try {
      return `${path}\0${await readFile(join(cwd, path), 'utf8')}`;
    } catch {
      return `${path}\0<unreadable>`;
    }
  }));
}

async function readConfigContent(cwd: string): Promise<string[]> {
  const existing = CONFIG_PATHS.filter((path) => existsSync(join(cwd, path)));
  return Promise.all(existing.map(async (path) => `${path}\0${await readFile(join(cwd, path), 'utf8')}`));
}

function digest(parts: readonly (string | readonly string[])[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    if (typeof part === 'string') {
      hash.update(part).update('\0');
    } else {
      for (const value of part) hash.update(value).update('\0');
    }
  }
  return hash.digest('hex');
}
