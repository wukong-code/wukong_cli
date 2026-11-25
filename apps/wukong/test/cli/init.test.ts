import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleInit, registerInitCommand, type InitDeps, type InitResult } from '#/cli/sub/init';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writable() {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function makeDeps(options: {
  cwd: string;
  providers?: Record<string, unknown>;
  getConfigError?: Error;
  fetch?: typeof globalThis.fetch;
  stdout?: ReturnType<typeof writable>;
  stderr?: ReturnType<typeof writable>;
  env?: NodeJS.ProcessEnv;
}): InitDeps {
  const harness = {
    getConfig: vi.fn(async () => {
      if (options.getConfigError !== undefined) {
        throw options.getConfigError;
      }
      return {
        providers: options.providers ?? {},
        models: {},
      };
    }),
  } as unknown as ReturnType<InitDeps['getHarness']>;

  return {
    cwd: () => options.cwd,
    getHarness: () => harness,
    stdout: (options.stdout ?? writable()).writer,
    stderr: (options.stderr ?? writable()).writer,
    env: options.env ?? {},
    fetch: options.fetch,
  };
}

describe('handleInit', () => {
  it('detects pnpm monorepo toolchains, creates .wukong files, and emits relative paths only', async () => {
    const cwd = await makeTempDir('wukong-init-monorepo-');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: { typecheck: 'tsc --noEmit' } }));
    await writeFile(join(cwd, 'pnpm-lock.yaml'), '');
    await writeFile(join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await mkdir(join(cwd, 'apps', 'cli'), { recursive: true });
    await writeFile(
      join(cwd, 'apps', 'cli', 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );

    const stdout = writable();
    const stderr = writable();
    const code = await handleInit(makeDeps({ cwd, stdout, stderr }), { json: true });

    expect(code).toBe(0);
    expect(stderr.chunks).toEqual([]);

    const result = JSON.parse(stdout.chunks.join('')) as InitResult;
    expect(result.toolchains).toEqual(['node-pnpm', 'monorepo']);
    expect(result.files).toEqual([
      { path: '.wukong/checks.json', action: 'created' },
      { path: '.wukong/review-policy.md', action: 'created' },
    ]);
    expect(result.providerStatus).toBe('unconfigured');
    expect(result.nextSteps).toEqual(['wukong check', 'wukong gate']);

    const quote = process.platform === 'win32' ? '"' : "'";
    expect(result.configuredCommands).toEqual([
      'pnpm run typecheck',
      `pnpm --dir ${quote}apps/cli${quote} run test`,
    ]);

    const checksOnDisk = JSON.parse(await readFile(join(cwd, '.wukong', 'checks.json'), 'utf8')) as {
      commands: string[];
    };
    expect(checksOnDisk.commands).toEqual(result.configuredCommands);
    expect(existsSync(join(cwd, '.wukong', 'review-policy.md'))).toBe(true);
    expect(stdout.chunks.join('')).not.toContain(cwd);
  });

  it('detects python, rust, and go repos and warns when no commands are detected', async () => {
    const cwd = await makeTempDir('wukong-init-empty-');
    await writeFile(join(cwd, 'requirements.txt'), 'pytest\n');

    const stdout = writable();
    const code = await handleInit(makeDeps({ cwd, stdout }), { json: false });

    expect(code).toBe(0);
    const text = stdout.chunks.join('');
    expect(text).toContain('Toolchains: python');
    expect(text).toContain('warning: No verification commands configured.');
    expect(text).toContain('wukong check');
    expect(text).toContain('wukong gate');
    expect(text).not.toContain(cwd);
  });

  it('preserves existing .wukong/checks.json and .wukong/review-policy.md unless --force is passed', async () => {
    const cwd = await makeTempDir('wukong-init-preserve-');
    await writeFile(join(cwd, 'Cargo.toml'), '[package]\nname = "example"\nversion = "0.1.0"\n');
    await mkdir(join(cwd, '.wukong'), { recursive: true });
    await writeFile(join(cwd, '.wukong', 'checks.json'), JSON.stringify({ commands: ['custom check'] }));
    await writeFile(join(cwd, '.wukong', 'review-policy.md'), '# Custom Policy\n');

    const stdoutKeep = writable();
    const keepCode = await handleInit(makeDeps({ cwd, stdout: stdoutKeep }), { json: true });
    expect(keepCode).toBe(0);
    const keptResult = JSON.parse(stdoutKeep.chunks.join('')) as InitResult;
    expect(keptResult.files).toEqual([
      { path: '.wukong/checks.json', action: 'kept' },
      { path: '.wukong/review-policy.md', action: 'kept' },
    ]);
    expect(keptResult.configuredCommands).toEqual(['custom check']);
    expect(await readFile(join(cwd, '.wukong', 'review-policy.md'), 'utf8')).toBe('# Custom Policy\n');

    const stdoutForce = writable();
    const forceCode = await handleInit(makeDeps({ cwd, stdout: stdoutForce }), { json: true, force: true });
    expect(forceCode).toBe(0);
    const forcedResult = JSON.parse(stdoutForce.chunks.join('')) as InitResult;
    expect(forcedResult.files).toEqual([
      { path: '.wukong/checks.json', action: 'overwritten' },
      { path: '.wukong/review-policy.md', action: 'overwritten' },
    ]);
    expect(forcedResult.configuredCommands).toEqual(['cargo test']);
    expect(await readFile(join(cwd, '.wukong', 'review-policy.md'), 'utf8')).toContain('# Wukong Review Policy');
  });

  it('supports --test-provider success, failure exit 1, --offline, and missing provider while keeping secrets redacted', async () => {
    const cwd = await makeTempDir('wukong-init-provider-');
    await writeFile(join(cwd, 'go.mod'), 'module example.test/app\n\ngo 1.24\n');

    const providers = {
      openai: {
        type: 'openai',
        apiKey: 'sk-init-secret-value',
        baseUrl: 'https://user:pass@api.example.test/v1?token=init-query-secret',
      },
    };

    const stdoutOk = writable();
    const okCode = await handleInit(
      makeDeps({
        cwd,
        providers,
        stdout: stdoutOk,
        fetch: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch,
      }),
      { json: true, testProvider: true },
    );
    expect(okCode).toBe(0);
    const okResult = JSON.parse(stdoutOk.chunks.join('')) as InitResult;
    expect(okResult.providerStatus).toBe('tested');
    expect(okResult.providerTests?.[0]?.status).toBe('ok');
    expect(okResult.providerTests?.[0]?.endpoint).toBe('https://api.example.test/v1/models');
    expect(stdoutOk.chunks.join('')).not.toContain('sk-init-secret-value');
    expect(stdoutOk.chunks.join('')).not.toContain('init-query-secret');

    const stdoutFail = writable();
    const failCode = await handleInit(
      makeDeps({
        cwd,
        providers,
        stdout: stdoutFail,
        fetch: vi.fn(async () => new Response('SECRET_BODY_LEAK', { status: 401 })) as unknown as typeof globalThis.fetch,
      }),
      { json: false, testProvider: 'openai' },
    );
    expect(failCode).toBe(1);
    expect(stdoutFail.chunks.join('')).toContain('auth-failed');
    expect(stdoutFail.chunks.join('')).not.toContain('SECRET_BODY_LEAK');

    const offlineFetch = vi.fn();
    const stdoutOffline = writable();
    const offlineCode = await handleInit(
      makeDeps({
        cwd,
        providers,
        stdout: stdoutOffline,
        fetch: offlineFetch as unknown as typeof globalThis.fetch,
      }),
      { json: true, testProvider: true, offline: true },
    );
    expect(offlineCode).toBe(1);
    expect(offlineFetch).not.toHaveBeenCalled();

    const missingCode = await handleInit(
      makeDeps({ cwd, providers }),
      { json: true, testProvider: 'missing-provider' },
    );
    expect(missingCode).toBe(1);
  });

  it('degrades gracefully when config.toml cannot be loaded', async () => {
    const cwd = await makeTempDir('wukong-init-config-err-');
    const stdout = writable();
    const code = await handleInit(
      makeDeps({ cwd, getConfigError: new Error('broken toml'), stdout }),
      { json: true },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.chunks.join('')) as InitResult;
    expect(parsed.providerStatus).toBe('config-error');
  });

  it('detects available local CLI reviewers on PATH without exposing absolute paths', async () => {
    const cwd = await makeTempDir('wukong-init-cli-rev-');
    const stdoutJson = writable();
    const deps = {
      ...makeDeps({ cwd, stdout: stdoutJson }),
      detectCliReviewers: () => [
        { backend: 'claude' as const, binary: 'claude', installed: true, resolvedPath: '/opt/secret/bin/claude' },
        { backend: 'codex' as const, binary: 'codex', installed: false },
        { backend: 'gemini' as const, binary: 'gemini', installed: true, resolvedPath: '/opt/secret/bin/gemini' },
      ],
    };

    expect(await handleInit(deps, { json: true })).toBe(0);
    const parsed = JSON.parse(stdoutJson.chunks.join('')) as InitResult;
    expect(parsed.availableCliReviewers).toEqual(['claude', 'gemini']);
    expect(stdoutJson.chunks.join('')).not.toContain('/opt/secret/bin');

    const stdoutHuman = writable();
    expect(
      await handleInit({ ...deps, stdout: stdoutHuman.writer }, { json: false }),
    ).toBe(0);
    const humanOut = stdoutHuman.chunks.join('');
    expect(humanOut).toContain('Local CLI reviewers detected: claude, gemini');
    expect(humanOut).not.toContain('/opt/secret/bin');
  });

  it('registers wukong init command with expected flags', async () => {
    const cwd = await makeTempDir('wukong-init-cmd-');
    const stdout = writable();
    const program = new Command();
    program.exitOverride();
    registerInitCommand(program, {
      cwd: () => cwd,
      getHarness: makeDeps({ cwd }).getHarness,
      stdout: stdout.writer,
      stderr: writable().writer,
      env: {},
    });

    await program.parseAsync(['init', '--json'], { from: 'user' });
    const parsed = JSON.parse(stdout.chunks.join('')) as InitResult;
    expect(parsed.files[0].path).toBe('.wukong/checks.json');
    expect(parsed.availableCliReviewers).toEqual([]);
  });
});
