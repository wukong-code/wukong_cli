import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectTrustedExecutable,
  TrustedExecutableError,
  withTrustedExecutablePath,
} from '../src/trusted-executable';

const roots: string[] = [];

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wukong-trusted-executable-'));
  roots.push(root);
  return root;
}

describe('trusted executable inspection', () => {
  it('pins a native executable and keeps its absolute path private', async () => {
    const executablePath = await realpath(process.execPath);
    const handle = await inspectTrustedExecutable({
      executablePath,
      versionProbeArgs: ['--version'],
      forbiddenRoots: [],
    });

    expect(handle.identity.executableIdentityDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(handle)).toContain('[PRIVATE]');
    expect(JSON.stringify(handle)).not.toContain(executablePath);
    await expect(withTrustedExecutablePath(handle, (path) => path))
      .resolves.toBe(executablePath);
  });

  it('rejects a symlink path even when its target is a native executable', async () => {
    if (process.platform === 'win32') return;
    const root = await makeRoot();
    const link = join(root, 'runtime-link');
    await symlink(await realpath(process.execPath), link);

    await expect(inspectTrustedExecutable({
      executablePath: link,
      versionProbeArgs: ['--version'],
      forbiddenRoots: [],
    })).rejects.toMatchObject({
      reasonCode: 'trusted_executable_file_unsafe',
    });
  });

  it('rejects executables inside source, candidate, Git, or generated roots', async () => {
    const executablePath = await realpath(process.execPath);

    await expect(inspectTrustedExecutable({
      executablePath,
      versionProbeArgs: ['--version'],
      forbiddenRoots: [dirname(executablePath)],
    })).rejects.toMatchObject({
      reasonCode: 'trusted_executable_forbidden_root',
    });
  });

  it('rejects script shims until their interpreter and script are separately frozen', async () => {
    if (process.platform === 'win32') return;
    const root = await makeRoot();
    const script = join(root, 'tool');
    await writeFile(script, '#!/bin/sh\nprintf "tool 1.0\\n"\n');
    await chmod(script, 0o755);

    await expect(inspectTrustedExecutable({
      executablePath: await realpath(script),
      versionProbeArgs: ['--version'],
      forbiddenRoots: [],
    })).rejects.toMatchObject({
      reasonCode: 'trusted_executable_file_unsafe',
    });
  });

  it('detects executable replacement after the handle was issued', async () => {
    // macOS kills relocated platform binaries before the test can issue a
    // handle; Linux exercises this replacement path in CI.
    if (process.platform === 'win32' || process.platform === 'darwin') return;
    const root = await makeRoot();
    const source = await realpath('/bin/echo');
    const copy = join(root, 'echo');
    await copyFile(source, copy);
    await chmod(copy, 0o755);
    const executablePath = await realpath(copy);
    const handle = await inspectTrustedExecutable({
      executablePath,
      versionProbeArgs: ['bootstrap-version-probe'],
      forbiddenRoots: [],
    });
    await appendFile(copy, Buffer.from([0]));

    await expect(withTrustedExecutablePath(handle, () => undefined))
      .rejects.toMatchObject({
        reasonCode: 'trusted_executable_identity_changed',
      });
  });

  it('rejects a failed version probe', async () => {
    if (process.platform === 'win32') return;
    const root = await makeRoot();
    const directory = join(root, 'allowed');
    await mkdir(directory);
    const source = await realpath('/usr/bin/false');
    const copy = join(directory, 'false');
    await copyFile(source, copy);
    await chmod(copy, 0o755);

    await expect(inspectTrustedExecutable({
      executablePath: await realpath(copy),
      versionProbeArgs: [],
      forbiddenRoots: [],
    })).rejects.toBeInstanceOf(TrustedExecutableError);
  });
});
