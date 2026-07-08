import { resolve } from 'node:path';

import { runFile } from './process';
import type { ChangedFile, GitInspection } from './types';

export async function inspectGit(cwd = process.cwd()): Promise<GitInspection> {
  const resolvedCwd = resolve(cwd);
  const rootResult = await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedCwd });
  if (rootResult.exitCode !== 0) {
    return {
      cwd: resolvedCwd,
      isRepo: false,
      statusText: '',
      diffText: '',
      diffStat: '',
      changedFiles: [],
    };
  }

  const root = rootResult.stdout.trim();
  const [status, diff, cachedDiff, stat, cachedStat] = await Promise.all([
    runFile('git', ['status', '--short'], { cwd: resolvedCwd }),
    runFile('git', ['diff', '--unified=0'], { cwd: resolvedCwd }),
    runFile('git', ['diff', '--cached', '--unified=0'], { cwd: resolvedCwd }),
    runFile('git', ['diff', '--stat'], { cwd: resolvedCwd }),
    runFile('git', ['diff', '--cached', '--stat'], { cwd: resolvedCwd }),
  ]);

  const statusText = status.stdout.trimEnd();
  return {
    cwd: resolvedCwd,
    isRepo: true,
    root,
    statusText,
    diffText: joinSections(diff.stdout, cachedDiff.stdout),
    diffStat: joinSections(stat.stdout, cachedStat.stdout).trimEnd(),
    changedFiles: parseStatus(statusText),
  };
}

function joinSections(...values: readonly string[]): string {
  return values.filter((value) => value.trim().length > 0).join('\n');
}

function parseStatus(statusText: string): ChangedFile[] {
  if (statusText.trim().length === 0) return [];
  return statusText.split('\n').flatMap((line) => {
    if (line.trim().length === 0) return [];
    const status = line.slice(0, 2).trim() || '?';
    const rawPath = line.slice(3).trim();
    const renamed = rawPath.split(' -> ');
    const path = renamed.at(-1) ?? rawPath;
    return [{ status, path }];
  });
}
