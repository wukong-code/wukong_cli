import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from '#/cli/update/install-state';
import type { UpdateInstallState } from '#/cli/update/types';
import { getUpdateInstallStateFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

describe('update install state', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wukong-install-state-'));
    process.env['WUKONG_CODE_HOME'] = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('re-exports an empty install state shape', () => {
    expect(emptyUpdateInstallState()).toEqual({
      active: null,
      lastFailure: null,
      lastSuccess: null,
    });
  });

  it('returns an empty install state when the file is missing', async () => {
    await expect(readUpdateInstallState()).resolves.toEqual(emptyUpdateInstallState());
  });

  it('falls back to an empty install state when the file is corrupt', async () => {
    mkdirSync(join(dir, 'updates'), { recursive: true });
    writeFileSync(getUpdateInstallStateFile(), '{"broken"', 'utf-8');

    await expect(readUpdateInstallState()).resolves.toEqual(emptyUpdateInstallState());
  });

  it('writes and reads back a complete install state', async () => {
    const state: UpdateInstallState = {
      active: {
        version: '0.5.0',
        source: 'npm-global',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
      lastFailure: {
        version: '0.4.0',
        failedAt: '2026-04-22T08:00:00.000Z',
        attempts: 2,
      },
      lastSuccess: {
        version: '0.3.0',
        installedAt: '2026-04-21T08:00:00.000Z',
        notifiedAt: '2026-04-21T08:01:00.000Z',
      },
    };

    await writeUpdateInstallState(state);

    expect(getUpdateInstallStateFile()).toBe(join(dir, 'updates', 'install.json'));
    await expect(readUpdateInstallState()).resolves.toEqual(state);
  });

  it('rejects writes with an unsupported install source', async () => {
    const state = {
      active: {
        version: '0.5.0',
        source: 'cargo-global',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
      lastFailure: null,
      lastSuccess: null,
    };

    await expect(writeUpdateInstallState(state as unknown as UpdateInstallState)).rejects.toThrow();
  });

  it('rejects writes with an active entry missing the version', async () => {
    const state = {
      active: {
        source: 'npm-global',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
      lastFailure: null,
      lastSuccess: null,
    };

    await expect(writeUpdateInstallState(state as unknown as UpdateInstallState)).rejects.toThrow();
  });
});
