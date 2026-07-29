import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import {
  getAvailableOpenInApps,
  launchDetached,
} from '../src/lib/fileLaunch';

describe('file launch process safety', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it('passes command names as shell positionals when probing availability', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    expect(getAvailableOpenInApps('linux')).toEqual(['cursor', 'vscode']);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      '/bin/sh',
      [
        '-c',
        'command -v -- "$1" >/dev/null 2>&1',
        'wukong-command-exists',
        'cursor',
      ],
      { stdio: 'ignore' },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      '/bin/sh',
      [
        '-c',
        'command -v -- "$1" >/dev/null 2>&1',
        'wukong-command-exists',
        'code',
      ],
      { stdio: 'ignore' },
    );
  });

  it('does not pass an args array to shell-backed detached launches', async () => {
    const child = createSpawnedChild();
    spawnMock.mockReturnValue(child);

    const launched = launchDetached({
      command: "code '/repo/src/App.vue'",
      args: [],
      shell: true,
    });
    child.emit('spawn');
    await launched;

    expect(spawnMock).toHaveBeenCalledWith(
      "code '/repo/src/App.vue'",
      {
        detached: true,
        stdio: 'ignore',
        shell: true,
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('keeps argument arrays for direct detached launches', async () => {
    const child = createSpawnedChild();
    spawnMock.mockReturnValue(child);

    const launched = launchDetached({
      command: 'open',
      args: ['-R', '/repo/src/App.vue'],
    });
    child.emit('spawn');
    await launched;

    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['-R', '/repo/src/App.vue'],
      {
        detached: true,
        stdio: 'ignore',
        shell: false,
      },
    );
  });
});

function createSpawnedChild() {
  return Object.assign(new EventEmitter(), {
    unref: vi.fn(),
  });
}
