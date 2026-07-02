import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VerificationCommand } from './types';

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

export async function selectVerificationCommands(options: {
  readonly cwd: string;
  readonly commands?: readonly string[];
  readonly includeBuild?: boolean;
}): Promise<VerificationCommand[]> {
  if (options.commands !== undefined && options.commands.length > 0) {
    return options.commands.map((command) => ({ command, source: 'explicit' }));
  }

  const packageJsonPath = join(options.cwd, 'package.json');
  if (!existsSync(packageJsonPath)) return [];

  const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJson;
  const scripts = parsed.scripts ?? {};
  const packageManager = detectPackageManager(options.cwd);
  const selected: VerificationCommand[] = [];
  for (const scriptName of scriptSelection(options.includeBuild === true)) {
    if (scripts[scriptName] === undefined) continue;
    selected.push({
      command: `${packageManager} run ${scriptName}`,
      source: 'package-script',
    });
  }
  return selected;
}

function scriptSelection(includeBuild: boolean): string[] {
  const names = ['lint', 'typecheck', 'type-check', 'test'];
  if (includeBuild) names.push('build');
  return names;
}

function detectPackageManager(cwd: string): 'pnpm' | 'npm' | 'yarn' | 'bun' {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}
