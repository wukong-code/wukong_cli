import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CliReviewerError,
  buildCliReviewerInvocation,
  detectAvailableCliReviewer,
  detectLocalCliReviewers,
  isCliReviewerBackend,
  parseCliReviewerSpecifier,
  probeLocalCliReviewer,
  resolveBinaryOnPath,
  runCliReviewCompletion,
} from '../src/cli-reviewer';

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

describe('cli reviewer helpers', () => {
  it('validates and parses backend specifiers', () => {
    expect(isCliReviewerBackend('claude')).toBe(true);
    expect(isCliReviewerBackend('codex')).toBe(true);
    expect(isCliReviewerBackend('gemini')).toBe(true);
    expect(isCliReviewerBackend('auto')).toBe(false);

    expect(parseCliReviewerSpecifier('claude')).toBe('claude');
    expect(parseCliReviewerSpecifier(' CLI:Codex ')).toBe('codex');
    expect(parseCliReviewerSpecifier('cli:gemini')).toBe('gemini');
    expect(parseCliReviewerSpecifier('openai')).toBeUndefined();
    expect(parseCliReviewerSpecifier('')).toBeUndefined();
  });

  it('returns all uninstalled when env has no PATH without falling back to process.env', () => {
    const detected = detectLocalCliReviewers({ env: {} });
    expect(detected).toEqual([
      { backend: 'claude', binary: 'claude', installed: false },
      { backend: 'codex', binary: 'codex', installed: false },
      { backend: 'gemini', binary: 'gemini', installed: false },
    ]);
    expect(detectAvailableCliReviewer({ env: {} })).toBeUndefined();
  });

  it('detects executable binaries on PATH and ignores non-executable files or directories', async () => {
    if (process.platform === 'win32') return;
    const binDir = await makeTempDir('wukong-cli-bin-');
    await mkdir(join(binDir, 'claude')); // directory must be ignored
    const nonExec = join(binDir, 'codex');
    await writeFile(nonExec, '#!/bin/sh\necho codex\n', 'utf8');
    await chmod(nonExec, 0o644);
    const execGemini = join(binDir, 'gemini');
    await writeFile(execGemini, '#!/bin/sh\necho gemini 1.0.0\n', 'utf8');
    await chmod(execGemini, 0o755);

    const env = { PATH: binDir };
    expect(resolveBinaryOnPath('claude', env, 'linux')).toBeUndefined();
    expect(resolveBinaryOnPath('codex', env, 'linux')).toBeUndefined();
    expect(resolveBinaryOnPath('gemini', env, 'linux')).toBe(execGemini);

    const detected = detectLocalCliReviewers({ env, platform: 'linux' });
    expect(detected).toEqual([
      { backend: 'claude', binary: 'claude', installed: false },
      { backend: 'codex', binary: 'codex', installed: false },
      { backend: 'gemini', binary: 'gemini', installed: true, resolvedPath: execGemini },
    ]);
    expect(detectAvailableCliReviewer({ env, platform: 'linux' })?.backend).toBe('gemini');
  });
});

describe('buildCliReviewerInvocation', () => {
  it('constructs isolated read-only flags for claude and strips nested env vars', () => {
    const inv = buildCliReviewerInvocation('claude', {
      binary: '/usr/local/bin/claude',
      systemPrompt: 'SYSTEM',
      userPrompt: 'USER',
      model: 'sonnet',
      env: {
        PATH: '/usr/local/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
    });

    expect(inv.command).toBe('/usr/local/bin/claude');
    expect(inv.args).toEqual([
      '--print',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--tools',
      '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--permission-mode',
      'plan',
      '--system-prompt',
      'SYSTEM',
      '--model',
      'sonnet',
    ]);
    expect(inv.stdin).toBe('USER');
    expect(inv.env['CLAUDECODE']).toBeUndefined();
    expect(inv.env['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    expect(inv.env['PATH']).toBe('/usr/local/bin');
  });

  it('constructs read-only invocation for codex and gemini', () => {
    const codexInv = buildCliReviewerInvocation('codex', {
      binary: 'codex',
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      outputFilePath: '/tmp/out.txt',
      model: 'o3',
      env: {},
    });
    expect(codexInv.args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-o',
      '/tmp/out.txt',
      '--model',
      'o3',
      '-',
    ]);
    expect(codexInv.stdin).toBe('SYS\n\nUSR');

    const geminiInv = buildCliReviewerInvocation('gemini', {
      binary: 'gemini',
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      env: {},
    });
    expect(geminiInv.args).toEqual([
      '--prompt',
      'Follow the instructions from stdin and emit the final GATE_VERDICT_JSON line.',
      '--output-format',
      'text',
      '--approval-mode',
      'plan',
    ]);
    expect(geminiInv.stdin).toBe('SYS\n\nUSR');
  });
});

describe('runCliReviewCompletion', () => {
  it('runs inside a clean temp directory, removes it afterwards, and returns text', async () => {
    let seenCwd: string | undefined;
    let entriesInCwd: string[] = [];

    const result = await runCliReviewCompletion({
      backend: 'claude',
      binaryPath: '/opt/bin/claude',
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      execImpl: async (input) => {
        seenCwd = input.cwd;
        entriesInCwd = await readdir(input.cwd);
        return {
          exitCode: 0,
          timedOut: false,
          stdout: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Clean","findings":[],"uncoveredItems":[]}\n',
          stderr: '',
        };
      },
    });

    expect(seenCwd).toBeDefined();
    expect(entriesInCwd).toEqual([]);
    await expect(readdir(seenCwd!)).rejects.toThrow();
    expect(result).toEqual({
      modelAlias: 'claude',
      providerId: 'cli:claude',
      text: 'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Clean","findings":[],"uncoveredItems":[]}',
      finishReason: 'completed',
    });
  });

  it('prefers codex -o output file over stdout and falls back to stdout if absent', async () => {
    const codexResult = await runCliReviewCompletion({
      backend: 'codex',
      model: 'gpt-5-codex',
      binaryPath: '/opt/bin/codex',
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      execImpl: async (input) => {
        const outFlag = input.args.indexOf('-o');
        const outPath = input.args[outFlag + 1]!;
        await writeFile(outPath, 'from-file-verdict\n', 'utf8');
        return { exitCode: 0, timedOut: false, stdout: 'noisy banner', stderr: '' };
      },
    });
    expect(codexResult.modelAlias).toBe('gpt-5-codex');
    expect(codexResult.providerId).toBe('cli:codex');
    expect(codexResult.text).toBe('from-file-verdict');

    const fallbackResult = await runCliReviewCompletion({
      backend: 'codex',
      binaryPath: '/opt/bin/codex',
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      execImpl: async () => ({
        exitCode: 0,
        timedOut: false,
        stdout: 'from-stdout-fallback',
        stderr: '',
      }),
    });
    expect(fallbackResult.text).toBe('from-stdout-fallback');
  });

  it('executes a real node stub binary and reads stdin cleanly', async () => {
    if (process.platform === 'win32') return;
    const binDir = await makeTempDir('wukong-cli-real-');
    const stubPath = join(binDir, 'claude');
    await writeFile(
      stubPath,
      [
        `#!${process.execPath}`,
        'let buf = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (d) => { buf += d; });',
        'process.stdin.on("end", () => {',
        '  if (process.argv[1]?.includes("--version") || process.argv.includes("--version")) {',
        '    console.log("claude 2.0.0-stub");',
        '    return;',
        '  }',
        '  console.log("RECEIVED:" + buf.trim());',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(stubPath, 0o755);

    const probe = await probeLocalCliReviewer('claude', { env: { PATH: binDir } });
    expect(probe.status).toBe('ok');
    expect(probe.version).toBe('claude 2.0.0-stub');

    const res = await runCliReviewCompletion({
      backend: 'claude',
      env: { PATH: binDir },
      systemPrompt: 'SYS',
      userPrompt: 'DIFF_BODY',
    });
    expect(res.text).toBe('RECEIVED:DIFF_BODY');
  });

  it('throws typed sanitized errors for missing binary, auth failure, generic error, empty output, timeout, and abort', async () => {
    await expect(
      runCliReviewCompletion({
        backend: 'codex',
        env: {},
        systemPrompt: 'S',
        userPrompt: 'U',
      }),
    ).rejects.toMatchObject({
      code: 'cli_reviewer_not_found',
    });

    await expect(
      runCliReviewCompletion({
        backend: 'claude',
        binaryPath: '/bin/claude',
        systemPrompt: 'S',
        userPrompt: 'U',
        execImpl: async () => ({
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr: 'Not logged in. Please log in with sk-secret-value /Users/alice/home',
        }),
      }),
    ).rejects.toMatchObject({
      code: 'cli_reviewer_auth_failed',
    });

    try {
      await runCliReviewCompletion({
        backend: 'gemini',
        binaryPath: '/bin/gemini',
        systemPrompt: 'S',
        userPrompt: 'U',
        execImpl: async () => ({
          exitCode: 1,
          timedOut: false,
          stdout: '',
          stderr: 'Failed at https://user:pass@api.example.test?token=tok123 with sk-secret-value in /Users/bob/proj',
        }),
      });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CliReviewerError);
      const err = error as CliReviewerError;
      expect(err.code).toBe('cli_reviewer_error');
      expect(err.message).not.toContain('user:pass');
      expect(err.message).not.toContain('tok123');
      expect(err.message).not.toContain('sk-secret-value');
      expect(err.message).not.toContain('/Users/bob');
    }

    await expect(
      runCliReviewCompletion({
        backend: 'claude',
        binaryPath: '/bin/claude',
        systemPrompt: 'S',
        userPrompt: 'U',
        execImpl: async () => ({ exitCode: 0, timedOut: false, stdout: '   ', stderr: '' }),
      }),
    ).rejects.toMatchObject({ code: 'cli_reviewer_error' });

    await expect(
      runCliReviewCompletion({
        backend: 'claude',
        binaryPath: '/bin/claude',
        systemPrompt: 'S',
        userPrompt: 'U',
        timeoutMs: 250,
        execImpl: async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: '' }),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });

    const controller = new AbortController();
    const promise = runCliReviewCompletion({
      backend: 'claude',
      binaryPath: '/bin/claude',
      systemPrompt: 'S',
      userPrompt: 'U',
      signal: controller.signal,
      execImpl: (input) =>
        new Promise((_resolve, reject) => {
          if (input.signal?.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          input.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    });
    controller.abort(new Error('cancelled'));
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('probeLocalCliReviewer', () => {
  it('reports offline, not-found, timeout, and ok cleanly', async () => {
    expect(await probeLocalCliReviewer('claude', { offline: true })).toMatchObject({
      backend: 'claude',
      status: 'offline',
    });

    expect(await probeLocalCliReviewer('codex', { env: {} })).toMatchObject({
      backend: 'codex',
      status: 'not-found',
    });

    expect(
      await probeLocalCliReviewer('gemini', {
        binaryPath: '/bin/gemini',
        timeoutMs: 100,
        execImpl: async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: '' }),
      }),
    ).toMatchObject({
      backend: 'gemini',
      status: 'timeout',
    });

    expect(
      await probeLocalCliReviewer('claude', {
        binaryPath: '/bin/claude',
        execImpl: async () => ({ exitCode: 0, timedOut: false, stdout: '2.1.0\n', stderr: '' }),
      }),
    ).toMatchObject({
      backend: 'claude',
      status: 'ok',
      version: '2.1.0',
    });
  });

  it('calls mocked exec with expected cwd', async () => {
    const execMock = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: '1.0.0',
      stderr: '',
    }));
    const res = await probeLocalCliReviewer('codex', {
      binaryPath: '/opt/codex',
      execImpl: execMock,
    });
    expect(res.status).toBe('ok');
    expect(execMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/codex',
        args: ['--version'],
      }),
    );
  });
});
