import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

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
  '.wukong/review-policy.md',
] as const;

const NON_GIT_SOURCE_PATTERN = /(?:^|\/)(?:Dockerfile|Makefile)$|\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|vue|svelte|sql|sh|toml|ya?ml|json)$/iu;
const NON_GIT_SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.turbo', '.wukong', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);
const MAX_NON_GIT_SOURCE_FILES = 5_000;

export async function createWorkspaceSnapshot(options: {
  readonly cwd?: string;
  readonly commands?: readonly VerificationCommand[];
  readonly git?: GitInspection;
} = {}): Promise<WorkspaceSnapshot> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const git = options.git ?? await inspectGit(cwd);
  const [headSha, untrackedContent, configContent, nonGitContent] = await Promise.all([
    readHeadSha(cwd, git),
    readUntrackedContent(cwd, git),
    readConfigContent(cwd),
    git.isRepo ? Promise.resolve([]) : readNonGitWorkspaceContent(cwd),
  ]);
  const inputDigest = digest([
    git.statusText,
    git.diffText,
    untrackedContent,
    nonGitContent,
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

async function readNonGitWorkspaceContent(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (paths.length >= MAX_NON_GIT_SOURCE_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (paths.length >= MAX_NON_GIT_SOURCE_FILES) break;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!NON_GIT_SKIPPED_DIRECTORIES.has(entry.name)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(cwd, absolutePath).replaceAll('\\', '/');
      if (NON_GIT_SOURCE_PATTERN.test(relativePath)) paths.push(relativePath);
    }
  };
  await walk(cwd);
  const content = await Promise.all(paths.map(async (path) => {
    try {
      return `${path}\0${await readFile(join(cwd, path), 'utf8')}`;
    } catch {
      return `${path}\0<unreadable>`;
    }
  }));
  if (paths.length >= MAX_NON_GIT_SOURCE_FILES) content.push('<source-file-limit-reached>');
  return content;
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
