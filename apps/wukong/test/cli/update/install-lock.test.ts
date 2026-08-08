import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryAcquireUpdateInstallLock } from '#/cli/update/install-lock';
import { getUpdateInstallLockFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wukong-update-install-lock-'));
  process.env['WUKONG_CODE_HOME'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('update install lock', () => {
  it('allows only one holder until the lock is released', async () => {
    const first = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(first).not.toBeNull();
    expect(getUpdateInstallLockFile()).toBe(join(dir, 'updates', 'install.lock'));

    const second = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(second).toBeNull();

    await first?.release();

    const third = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(third).not.toBeNull();
    await third?.release();
  });

  it('recovers from a corrupt lock file', async () => {
    const filePath = getUpdateInstallLockFile();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{', 'utf-8');

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('recovers a stale lock file after the 30-minute threshold', async () => {
    const filePath = getUpdateInstallLockFile();
    mkdirSync(dirname(filePath), { recursive: true });
    const stale = new Date(Date.now() - 31 * 60 * 1_000);
    writeFileSync(
      filePath,
      JSON.stringify({ version: '0.4.0', pid: 1, startedAt: stale.toISOString() }),
      'utf-8',
    );

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0', now: new Date() });

    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('propagates non-EEXIST filesystem errors', async () => {
    // chmod(0555) does not make a directory unwritable on Win32. An invalid
    // path byte deterministically exercises propagation on every platform.
    const invalidFilePath = join(dir, 'updates', '\0install.lock');

    await expect(
      tryAcquireUpdateInstallLock({ version: '0.5.0' }, invalidFilePath),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
  });
});
