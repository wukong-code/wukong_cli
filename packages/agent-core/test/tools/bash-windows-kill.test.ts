import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos, type KaosProcess } from '@wukong/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(process.platform !== 'win32')('LocalKaos — Windows kill tree', () => {
  let root: string | undefined;
  let parent: KaosProcess | undefined;

  afterEach(async () => {
    await parent?.kill('SIGKILL').catch(() => {});
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('terminates a grandchild process through taskkill /T /F', async () => {
    root = await mkdtemp(join(tmpdir(), 'wukong-win-tree-kill-'));
    const readyPath = join(root, 'grandchild.pid');
    const heartbeatPath = join(root, 'heartbeat.txt');
    const grandchildCode = [
      "const { writeFileSync } = require('node:fs');",
      'const heartbeat = process.argv[1];',
      "setInterval(() => writeFileSync(heartbeat, String(Date.now()), 'utf8'), 40);",
    ].join('');
    const parentCode = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'const ready = process.argv[1];',
      'const heartbeat = process.argv[2];',
      'const grandchildCode = process.argv[3];',
      'const child = spawn(process.execPath, ["-e", grandchildCode, heartbeat], { stdio: "ignore" });',
      "writeFileSync(ready, String(child.pid), 'utf8');",
      'setInterval(() => {}, 1000);',
    ].join('');
    const kaos = await LocalKaos.create();
    parent = await kaos.exec(
      process.execPath,
      '-e',
      parentCode,
      readyPath,
      heartbeatPath,
      grandchildCode,
    );

    await vi.waitFor(async () => {
      expect((await readFile(readyPath, 'utf8')).trim()).toMatch(/^\d+$/u);
      expect((await stat(heartbeatPath)).size).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 50 });

    await parent.kill('SIGTERM');
    await parent.wait();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stoppedHeartbeat = await readFile(heartbeatPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await readFile(heartbeatPath, 'utf8')).toBe(stoppedHeartbeat);
  }, 20_000);
});
