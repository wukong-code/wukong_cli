import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectVerificationCommands, workspaceCommand } from '../src/scripts';
import { makeTempDir, writeJson, writeRepoFile } from './helpers';

describe('selectVerificationCommands', () => {
  it('prefers explicit commands over package scripts', async () => {
    const cwd = await makeTempDir('wukong-scripts-explicit-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'echo test' } });

    const selected = await selectVerificationCommands({ cwd, commands: ['pnpm lint', 'pnpm test'] });

    expect(selected).toEqual([
      { command: 'pnpm lint', source: 'explicit' },
      { command: 'pnpm test', source: 'explicit' },
    ]);
  });

  it('returns no commands when package.json is missing', async () => {
    const cwd = await makeTempDir('wukong-scripts-none-');

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([]);
  });

  it('selects lint, typecheck, type-check, and test scripts in order', async () => {
    const cwd = await makeTempDir('wukong-scripts-selection-');
    await writeJson(join(cwd, 'package.json'), {
      scripts: {
        lint: 'x',
        typecheck: 'x',
        'type-check': 'x',
        test: 'x',
        build: 'x',
        deploy: 'x',
      },
    });

    const selected = await selectVerificationCommands({ cwd });

    expect(selected.map((command) => command.command)).toEqual([
      'npm run lint',
      'npm run typecheck',
      'npm run type-check',
      'npm run test',
    ]);
    for (const command of selected) expect(command.source).toBe('package-script');
  });

  it('only includes build when includeBuild is set', async () => {
    const cwd = await makeTempDir('wukong-scripts-build-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'x', build: 'x' } });

    const withoutBuild = await selectVerificationCommands({ cwd });
    expect(withoutBuild.map((command) => command.command)).toEqual(['npm run test']);

    const withBuild = await selectVerificationCommands({ cwd, includeBuild: true });
    expect(withBuild.map((command) => command.command)).toEqual(['npm run test', 'npm run build']);
  });

  it('detects the package manager from lockfiles', async () => {
    const cases: ReadonlyArray<{ lockfile?: string; expected: string }> = [
      { lockfile: 'pnpm-lock.yaml', expected: 'pnpm run test' },
      { lockfile: 'yarn.lock', expected: 'yarn run test' },
      { lockfile: 'bun.lockb', expected: 'bun run test' },
      { lockfile: 'bun.lock', expected: 'bun run test' },
      { expected: 'npm run test' },
    ];

    for (const { lockfile, expected } of cases) {
      const cwd = await makeTempDir('wukong-scripts-pm-');
      await writeJson(join(cwd, 'package.json'), { scripts: { test: 'x' } });
      if (lockfile !== undefined) await writeRepoFile(cwd, lockfile, '');

      const selected = await selectVerificationCommands({ cwd });
      expect(selected[0]?.command, lockfile ?? 'no lockfile').toBe(expected);
    }
  });

  it('discovers checks in nested workspace packages when root scripts are absent', async () => {
    const cwd = await makeTempDir('wukong-scripts-workspace-');
    await writeJson(join(cwd, 'package.json'), { private: true });
    await writeRepoFile(cwd, 'pnpm-lock.yaml', '');
    await writeRepoFile(cwd, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    await writeRepoFile(cwd, 'apps/web/package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await writeRepoFile(cwd, 'packages/api/package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

    const selected = await selectVerificationCommands({ cwd });

    const quote = process.platform === 'win32' ? '"' : "'";
    expect(selected).toEqual([
      {
        command: `pnpm --dir ${quote}apps/web${quote} run lint`,
        source: 'workspace-script',
        sourceLocator: 'apps/web/package.json#scripts.lint',
        definition: 'eslint .',
      },
      {
        command: `pnpm --dir ${quote}packages/api${quote} run test`,
        source: 'workspace-script',
        sourceLocator: 'packages/api/package.json#scripts.test',
        definition: 'vitest run',
      },
    ]);
  });

  it('checks both root and declared workspace scripts with the same name', async () => {
    const cwd = await makeTempDir('wukong-scripts-root-workspace-');
    await writeJson(join(cwd, 'package.json'), {
      private: true,
      workspaces: ['packages/*'],
      scripts: { test: 'vitest run' },
    });
    await writeRepoFile(cwd, 'packages/api/package.json', JSON.stringify({
      scripts: { test: 'vitest run --project api' },
    }));

    const selected = await selectVerificationCommands({ cwd });
    const quote = process.platform === 'win32' ? '"' : "'";

    expect(selected.map((command) => command.command)).toEqual([
      'npm run test',
      `npm --prefix ${quote}packages/api${quote} run test`,
    ]);
  });

  it('ignores package.json files outside declared workspaces', async () => {
    const cwd = await makeTempDir('wukong-scripts-workspace-scope-');
    await writeJson(join(cwd, 'package.json'), { private: true, workspaces: ['packages/*'] });
    await writeRepoFile(cwd, 'packages/api/package.json', JSON.stringify({
      scripts: { test: 'vitest run' },
    }));
    await writeRepoFile(cwd, 'examples/untrusted/package.json', JSON.stringify({
      scripts: { test: 'curl https://example.invalid' },
    }));

    const selected = await selectVerificationCommands({ cwd });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.sourceLocator).toBe('packages/api/package.json#scripts.test');
  });

  it('normalizes workspace paths and uses quoting accepted by each platform shell', () => {
    expect(workspaceCommand('pnpm', 'apps/web', 'lint', 'linux')).toBe(
      "pnpm --dir 'apps/web' run lint",
    );
    expect(workspaceCommand('npm', 'packages/api', 'test', 'darwin')).toBe(
      "npm --prefix 'packages/api' run test",
    );
    expect(workspaceCommand('pnpm', 'apps\\web', 'lint', 'win32')).toBe(
      'pnpm --dir "apps/web" run lint',
    );
    expect(workspaceCommand('npm', 'packages\\api', 'test', 'win32')).toBe(
      'npm --prefix "packages/api" run test',
    );
  });

  it('uses project-authorized checks before inferred package scripts', async () => {
    const cwd = await makeTempDir('wukong-scripts-config-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'vitest run' } });
    await writeRepoFile(cwd, '.wukong/checks.json', JSON.stringify({
      commands: ['pnpm test:unit', 'pnpm typecheck'],
    }));

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([
      {
        command: 'pnpm test:unit',
        source: 'project-config',
        sourceLocator: '.wukong/checks.json#/commands/0',
        definition: 'pnpm test:unit',
      },
      {
        command: 'pnpm typecheck',
        source: 'project-config',
        sourceLocator: '.wukong/checks.json#/commands/1',
        definition: 'pnpm typecheck',
      },
    ]);
  });

  it('discovers only configured Python checks', async () => {
    const cwd = await makeTempDir('wukong-scripts-python-');
    await writeRepoFile(cwd, 'pyproject.toml', [
      '[project]',
      'name = "example"',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
      '',
      '[tool.ruff]',
      'line-length = 100',
      '',
      '[tool.mypy]',
      'strict = true',
    ].join('\n'));

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([
      {
        command: 'python3 -m pytest',
        source: 'project-inferred',
        sourceLocator: 'pyproject.toml#tool.pytest',
      },
      { command: 'ruff check .', source: 'project-inferred', sourceLocator: 'pyproject.toml#tool.ruff' },
      { command: 'mypy .', source: 'project-inferred', sourceLocator: 'pyproject.toml#tool.mypy' },
    ]);
  });

  it('does not infer Python tools from pyproject.toml alone', async () => {
    const cwd = await makeTempDir('wukong-scripts-python-unconfigured-');
    await writeRepoFile(cwd, 'pyproject.toml', '[project]\nname = "example"\n');

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([]);
  });

  it('discovers Rust and Go project checks and configured linters', async () => {
    const rust = await makeTempDir('wukong-scripts-rust-');
    await writeRepoFile(rust, 'Cargo.toml', '[package]\nname = "example"\nversion = "0.1.0"\n');
    await writeRepoFile(rust, 'clippy.toml', 'msrv = "1.80"\n');
    await expect(selectVerificationCommands({ cwd: rust })).resolves.toEqual([
      { command: 'cargo test', source: 'project-inferred', sourceLocator: 'Cargo.toml' },
      {
        command: 'cargo clippy --all-targets --all-features -- -D warnings',
        source: 'project-inferred',
        sourceLocator: 'clippy.toml',
      },
    ]);

    const go = await makeTempDir('wukong-scripts-go-');
    await writeRepoFile(go, 'go.mod', 'module example.test/project\n\ngo 1.24\n');
    await writeRepoFile(go, '.golangci.yml', 'run:\n  timeout: 2m\n');
    await expect(selectVerificationCommands({ cwd: go })).resolves.toEqual([
      { command: 'go test ./...', source: 'project-inferred', sourceLocator: 'go.mod' },
      { command: 'golangci-lint run', source: 'project-inferred', sourceLocator: '.golangci.yml' },
    ]);
  });

  it('combines Node and configured non-Node checks without duplicates', async () => {
    const cwd = await makeTempDir('wukong-scripts-polyglot-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'vitest run' } });
    await writeRepoFile(cwd, 'go.mod', 'module example.test/project\n\ngo 1.24\n');

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([
      {
        command: 'npm run test',
        source: 'package-script',
        sourceLocator: 'package.json#scripts.test',
        definition: 'vitest run',
      },
      { command: 'go test ./...', source: 'project-inferred', sourceLocator: 'go.mod' },
    ]);
  });
});
