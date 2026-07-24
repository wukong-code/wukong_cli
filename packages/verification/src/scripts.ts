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
const MAX_DISCOVERED_COMMANDS = 12;

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
        sourceLocator: `package.json#scripts.${scriptName}`,
        definition: rootPackage.scripts[scriptName],
      });
      continue;
    }
    for (const workspacePackage of workspacePackages) {
      if (workspacePackage.packageJson.scripts?.[scriptName] === undefined) continue;
      selected.push({
        command: workspaceCommand(packageManager, workspacePackage.relativePath, scriptName),
        source: 'workspace-script',
        sourceLocator: `${normalizeLocatorPath(workspacePackage.relativePath)}/package.json#scripts.${scriptName}`,
        definition: workspacePackage.packageJson.scripts[scriptName],
      });
    }
  }
  selected.push(...await discoverConfiguredLanguageChecks(options.cwd));
  return deduplicateCommands(selected).slice(0, MAX_DISCOVERED_COMMANDS);
}

async function discoverConfiguredLanguageChecks(cwd: string): Promise<VerificationCommand[]> {
  const selected: VerificationCommand[] = [];
  const pyproject = await readOptionalText(join(cwd, 'pyproject.toml'));
  const setupCfg = await readOptionalText(join(cwd, 'setup.cfg'));
  const toxIni = await readOptionalText(join(cwd, 'tox.ini'));

  if (
    hasFile(cwd, 'pytest.ini') ||
    hasSection(pyproject, 'tool.pytest') ||
    hasSection(setupCfg, 'tool:pytest') ||
    hasSection(toxIni, 'pytest')
  ) {
    selected.push(inferred('python3 -m pytest', firstExistingLocator(cwd, [
      'pytest.ini',
      'pyproject.toml#tool.pytest',
      'setup.cfg#tool:pytest',
      'tox.ini#pytest',
    ])));
  }
  if (
    hasFile(cwd, 'ruff.toml') ||
    hasFile(cwd, '.ruff.toml') ||
    hasSection(pyproject, 'tool.ruff')
  ) {
    selected.push(inferred('ruff check .', firstExistingLocator(cwd, [
      'ruff.toml',
      '.ruff.toml',
      'pyproject.toml#tool.ruff',
    ])));
  }
  if (
    hasFile(cwd, 'mypy.ini') ||
    hasFile(cwd, '.mypy.ini') ||
    hasSection(pyproject, 'tool.mypy') ||
    hasSection(setupCfg, 'mypy')
  ) {
    selected.push(inferred('mypy .', firstExistingLocator(cwd, [
      'mypy.ini',
      '.mypy.ini',
      'pyproject.toml#tool.mypy',
      'setup.cfg#mypy',
    ])));
  }

  if (hasFile(cwd, 'Cargo.toml')) {
    selected.push(inferred('cargo test', 'Cargo.toml'));
    if (hasFile(cwd, 'clippy.toml') || hasFile(cwd, '.clippy.toml')) {
      selected.push(inferred(
        'cargo clippy --all-targets --all-features -- -D warnings',
        hasFile(cwd, 'clippy.toml') ? 'clippy.toml' : '.clippy.toml',
      ));
    }
  }

  if (hasFile(cwd, 'go.mod')) {
    selected.push(inferred('go test ./...', 'go.mod'));
    if (
      hasFile(cwd, '.golangci.yml') ||
      hasFile(cwd, '.golangci.yaml') ||
      hasFile(cwd, '.golangci.toml') ||
      hasFile(cwd, '.golangci.json')
    ) {
      selected.push(inferred('golangci-lint run', firstExistingLocator(cwd, [
        '.golangci.yml',
        '.golangci.yaml',
        '.golangci.toml',
        '.golangci.json',
      ])));
    }
  }

  return selected;
}

function inferred(command: string, sourceLocator: string): VerificationCommand {
  return { command, source: 'project-inferred', sourceLocator };
}

function hasFile(cwd: string, name: string): boolean {
  return existsSync(join(cwd, name));
}

function hasSection(text: string | undefined, section: string): boolean {
  if (text === undefined) return false;
  const escaped = section.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[${escaped}(?:[.:-][^\\]]+)?\\]`, 'mu').test(text);
}

async function readOptionalText(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function deduplicateCommands(commands: readonly VerificationCommand[]): VerificationCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.command)) return false;
    seen.add(command.command);
    return true;
  });
}

async function readProjectChecks(cwd: string): Promise<VerificationCommand[]> {
  const path = join(cwd, '.wukong', 'checks.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ProjectChecksConfig;
  if (!Array.isArray(parsed.commands)) {
    throw new TypeError('.wukong/checks.json must contain a commands array.');
  }
  return parsed.commands.map((command, index) => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('.wukong/checks.json commands must be non-empty strings.');
    }
    const normalized = command.trim();
    return {
      command: normalized,
      source: 'project-config',
      sourceLocator: `.wukong/checks.json#/commands/${String(index)}`,
      definition: normalized,
    };
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

function normalizeLocatorPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function firstExistingLocator(cwd: string, candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const file = candidate.split('#', 1)[0]!;
    if (hasFile(cwd, file)) return candidate;
  }
  return candidates[0]!;
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
