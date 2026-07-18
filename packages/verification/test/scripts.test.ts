import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectVerificationCommands } from '../src/scripts';
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
    await writeRepoFile(cwd, 'apps/web/package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await writeRepoFile(cwd, 'packages/api/package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

    const selected = await selectVerificationCommands({ cwd });

    expect(selected).toEqual([
      { command: "pnpm --dir 'apps/web' run lint", source: 'workspace-script' },
      { command: "pnpm --dir 'packages/api' run test", source: 'workspace-script' },
    ]);
  });

  it('uses project-authorized checks before inferred package scripts', async () => {
    const cwd = await makeTempDir('wukong-scripts-config-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'vitest run' } });
    await writeRepoFile(cwd, '.wukong/checks.json', JSON.stringify({
      commands: ['pnpm test:unit', 'pnpm typecheck'],
    }));

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([
      { command: 'pnpm test:unit', source: 'project-config' },
      { command: 'pnpm typecheck', source: 'project-config' },
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
      { command: 'python3 -m pytest', source: 'project-inferred' },
      { command: 'ruff check .', source: 'project-inferred' },
      { command: 'mypy .', source: 'project-inferred' },
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
      { command: 'cargo test', source: 'project-inferred' },
      {
        command: 'cargo clippy --all-targets --all-features -- -D warnings',
        source: 'project-inferred',
      },
    ]);

    const go = await makeTempDir('wukong-scripts-go-');
    await writeRepoFile(go, 'go.mod', 'module example.test/project\n\ngo 1.24\n');
    await writeRepoFile(go, '.golangci.yml', 'run:\n  timeout: 2m\n');
    await expect(selectVerificationCommands({ cwd: go })).resolves.toEqual([
      { command: 'go test ./...', source: 'project-inferred' },
      { command: 'golangci-lint run', source: 'project-inferred' },
    ]);
  });

  it('combines Node and configured non-Node checks without duplicates', async () => {
    const cwd = await makeTempDir('wukong-scripts-polyglot-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'vitest run' } });
    await writeRepoFile(cwd, 'go.mod', 'module example.test/project\n\ngo 1.24\n');

    await expect(selectVerificationCommands({ cwd })).resolves.toEqual([
      { command: 'npm run test', source: 'package-script' },
      { command: 'go test ./...', source: 'project-inferred' },
    ]);
  });
});
