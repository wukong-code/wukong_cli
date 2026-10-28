/**
 * Real-process BashTool regressions for the cross-platform process contract:
 * quoting, Unicode, timeout kill, cancel, process-tree kill, and post-kill
 * contract restore. The POSIX block runs on macOS/Linux; the Windows block
 * runs on the Windows CI matrix through Git Bash (the dedicated Windows
 * tree-kill case lives in bash-windows-kill.test.ts). Everything executes
 * through LocalKaos — never a mocked Kaos — so the shell wrapper, process
 * groups, and the background manager's two-phase kill are exercised exactly
 * as shipped.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { LocalKaos } from '@wukong/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
import { createBackgroundManager } from '../agent/background/helpers';
import { executeTool } from './fixtures/execute-tool';

const NASTY_DIR_NAME = `dir with space 'quote' 中文 🎉`;
const UNICODE_ARG = 'ünïcødé 中文 🎉 "double" $dollar `tick`';

type RunResult = Awaited<ReturnType<typeof executeTool>>;

let root: string | undefined;
let tool: BashTool | undefined;
const pendingRuns: Array<Promise<unknown>> = [];

beforeEach(async () => {
  const kaos = await LocalKaos.create();
  root = await mkdtemp(join(tmpdir(), 'wukong-bash-real-'));
  tool = new BashTool(kaos, root, createBackgroundManager().manager);
});

afterEach(async () => {
  await Promise.allSettled(pendingRuns);
  pendingRuns.length = 0;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

let runCounter = 0;

function run(
  args: { command: string; timeout: number; cwd?: string },
  signal: AbortSignal = new AbortController().signal,
): Promise<RunResult> {
  if (tool === undefined) throw new Error('real-process fixture not initialized');
  runCounter += 1;
  const pending = executeTool(tool, {
    turnId: '0',
    toolCallId: `tc_real_${String(runCounter)}`,
    args,
    signal,
  });
  pendingRuns.push(pending);
  return pending;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(process.platform === 'win32')('BashTool real-process contract (POSIX)', () => {
  it('round-trips a cwd containing spaces, quotes, and Unicode through the shell wrapper', async () => {
    const cwd = join(root!, NASTY_DIR_NAME);
    await mkdir(cwd, { recursive: true });
    const result = await run({ command: 'pwd', cwd, timeout: 30 });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(NASTY_DIR_NAME);
  }, 20_000);

  it('preserves Unicode arguments, output, and file names end to end', async () => {
    const file = '文件-🎉.txt';
    const result = await run({
      command: `printf '%s\\n' '${UNICODE_ARG}' > '${file}' && cat '${file}'`,
      timeout: 30,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(UNICODE_ARG);
    expect(await readFile(join(root!, file), 'utf8')).toContain(UNICODE_ARG);
  }, 20_000);

  it('kills a foreground command at the timeout and reports the timeout label', async () => {
    const startedAt = Date.now();
    const result = await run({ command: 'sleep 30', timeout: 1 });
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/killed by timeout/i);
    expect(elapsedMs).toBeLessThan(20_000);
  }, 25_000);

  it('cancels a running command through the ambient abort signal', async () => {
    const controller = new AbortController();
    const pending = run({ command: 'sleep 30', timeout: 60 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Interrupted by user');
  }, 25_000);

  it('kills the whole process tree: a grandchild heartbeat stops after the timeout kill', async () => {
    const heartbeatPath = join(root!, 'heartbeat.txt');
    const grandchildCode = [
      "const { writeFileSync } = require('node:fs');",
      'const heartbeat = process.argv[1];',
      "setInterval(() => writeFileSync(heartbeat, String(Date.now()), 'utf8'), 40);",
    ].join('');
    const parentCode = [
      "const { spawn } = require('node:child_process');",
      'const child = spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" });',
      'setInterval(() => {}, 1000);',
    ].join('');
    const result = await run({
      command: `${quotePosix(process.execPath)} -e ${quotePosix(parentCode)} ${quotePosix(grandchildCode)} ${quotePosix(heartbeatPath)}`,
      timeout: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/killed by timeout/i);
    await vi.waitFor(
      async () => {
        expect((await readFile(heartbeatPath, 'utf8')).length).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 50 },
    );
    const stopped = await readFile(heartbeatPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(await readFile(heartbeatPath, 'utf8')).toBe(stopped);
  }, 30_000);

  it('restores a usable contract: commands after a timeout and a cancel run normally', async () => {
    const timedOut = await run({ command: 'sleep 30', timeout: 1 });
    expect(timedOut.isError).toBe(true);

    const controller = new AbortController();
    const pending = run({ command: 'sleep 30', timeout: 60 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    expect((await pending).isError).toBe(true);

    const restored = await run({ command: 'echo contract-restored-ok', timeout: 30 });

    expect(restored.isError).toBeFalsy();
    expect(restored.output).toContain('contract-restored-ok');
  }, 30_000);
});

describe.skipIf(process.platform !== 'win32')('BashTool real-process contract (Windows)', () => {
  it('round-trips a cwd containing spaces and Unicode through the Git Bash wrapper', async () => {
    const dirName = `dir with space 中文 🎉`;
    const cwd = join(root!, dirName);
    await mkdir(cwd, { recursive: true });
    const result = await run({ command: 'basename "$(pwd)"', cwd, timeout: 30 });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(basename(cwd));
  }, 30_000);

  it('preserves Unicode arguments, output, and file names end to end', async () => {
    const file = '文件-🎉.txt';
    const result = await run({
      command: `printf '%s\\n' '${UNICODE_ARG}' > '${file}' && cat '${file}'`,
      timeout: 30,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(UNICODE_ARG);
    expect(await readFile(join(root!, file), 'utf8')).toContain(UNICODE_ARG);
  }, 30_000);

  it('kills a foreground command at the timeout', async () => {
    const result = await run({ command: 'sleep 30', timeout: 1 });

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/killed by timeout/i);
  }, 30_000);

  it('cancels a running command through the ambient abort signal', async () => {
    const controller = new AbortController();
    const pending = run({ command: 'sleep 30', timeout: 60 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Interrupted by user');
  }, 30_000);

  it('runs normally after a timeout and a cancel on the same tool instance', async () => {
    expect((await run({ command: 'sleep 30', timeout: 1 })).isError).toBe(true);
    const restored = await run({ command: 'echo contract-restored-ok', timeout: 30 });

    expect(restored.isError).toBeFalsy();
    expect(restored.output).toContain('contract-restored-ok');
  }, 40_000);
});
