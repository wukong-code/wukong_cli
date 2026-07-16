import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { VerificationCommand } from './types';

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

interface ProjectChecksConfig {
  readonly commands?: readonly string[];
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

const MAX_PACKAGE_DEPTH = 4;

export async function selectVerificationCommands(options: {
  readonly cwd: string;
  readonly commands?: readonly string[];
  readonly includeBuild?: boolean;
}): Promise<VerificationCommand[]> {
  if (options.commands !== undefined && options.commands.length > 0) {
    return options.commands.map((command) => ({ command, source: 'explicit' }));
  }

  const configured = await readProjectChecks(options.cwd);
  if (configured.length > 0) return configured;

  const packageJsonPath = join(options.cwd, 'package.json');
  const packageManager = detectPackageManager(options.cwd);
  const rootPackage = existsSync(packageJsonPath)
    ? await readPackageJson(packageJsonPath)
    : {};
  const workspacePackages = await discoverWorkspacePackages(options.cwd);
  const selected: VerificationCommand[] = [];
  for (const scriptName of scriptSelection(options.includeBuild === true)) {
    if (rootPackage.scripts?.[scriptName] !== undefined) {
      selected.push({
        command: `${packageManager} run ${scriptName}`,
        source: 'package-script',
      });
      continue;
    }
    for (const workspacePackage of workspacePackages) {
      if (workspacePackage.packageJson.scripts?.[scriptName] === undefined) continue;
      selected.push({
        command: workspaceCommand(packageManager, workspacePackage.relativePath, scriptName),
        source: 'workspace-script',
      });
    }
  }
  return selected;
}

async function readProjectChecks(cwd: string): Promise<VerificationCommand[]> {
  const path = join(cwd, '.wukong', 'checks.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ProjectChecksConfig;
  if (!Array.isArray(parsed.commands)) {
    throw new TypeError('.wukong/checks.json must contain a commands array.');
  }
  return parsed.commands.map((command) => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('.wukong/checks.json commands must be non-empty strings.');
    }
    return { command: command.trim(), source: 'project-config' };
  });
}

async function discoverWorkspacePackages(cwd: string): Promise<Array<{
  readonly relativePath: string;
  readonly packageJson: PackageJson;
}>> {
  const packagePaths: string[] = [];
  await walkForPackages(cwd, 0, packagePaths);
  const sortedPackagePaths = packagePaths.toSorted();
  return Promise.all(sortedPackagePaths.map(async (path) => ({
    relativePath: relative(cwd, path),
    packageJson: await readPackageJson(join(path, 'package.json')),
  })));
}

async function walkForPackages(
  directory: string,
  depth: number,
  output: string[],
): Promise<void> {
  if (depth >= MAX_PACKAGE_DEPTH) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (existsSync(join(child, 'package.json'))) output.push(child);
    await walkForPackages(child, depth + 1, output);
  }
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageJson;
}

function workspaceCommand(
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun',
  workspacePath: string,
  scriptName: string,
): string {
  const path = shellQuote(workspacePath);
  switch (packageManager) {
    case 'pnpm':
      return `pnpm --dir ${path} run ${scriptName}`;
    case 'npm':
      return `npm --prefix ${path} run ${scriptName}`;
    case 'yarn':
      return `yarn --cwd ${path} run ${scriptName}`;
    case 'bun':
      return `bun --cwd ${path} run ${scriptName}`;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
