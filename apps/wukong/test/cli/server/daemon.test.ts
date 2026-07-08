import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LockContents } from '@wukong/server';

const mockServer = vi.hoisted(() => ({
  getLiveLock: vi.fn<() => LockContents | undefined>(),
  DEFAULT_LOCK_DIR: '/tmp/wukong/server',
}));

const mockShared = vi.hoisted(() => ({
  DEFAULT_SERVER_HOST: '127.0.0.1',
  DEFAULT_SERVER_PORT: 58627,
  LOCAL_SERVER_HOST: '127.0.0.1',
  isServerHealthy: vi.fn<() => Promise<boolean>>(),
  waitForServerHealthy: vi.fn<() => Promise<boolean>>(),
  serverOrigin: vi.fn((host: string, port: number) => `http://${host}:${port}`),
}));

const spawnMock = vi.hoisted(() => vi.fn<() => ChildProcess>());

vi.mock('@wukong/server', () => mockServer);
vi.mock('#/cli/sub/server/shared', () => mockShared);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

function fakeChild(exitCode: number | null = null): ChildProcess {
  const events = new Map<string, Array<(...values: unknown[]) => void>>();
  const child = {
    once: vi.fn((event: string, handler: (...values: unknown[]) => void) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event)!.push(handler);
      return child;
    }),
    unref: vi.fn(),
    emit: (event: string, ...values: unknown[]) => {
      events.get(event)?.forEach((handler) => {
        handler(...values);
      });
    },
  } as unknown as ChildProcess;
  return child;
}

function makeChild(exitCode: number | null = null, emitImmediately = true): ChildProcess {
  const child = fakeChild();
  if (emitImmediately) {
    setTimeout(() => {
      (child as unknown as { emit: (event: string, ...values: unknown[]) => void }).emit(
        'exit',
        exitCode,
        null,
      );
    }, 0);
  }
  spawnMock.mockReturnValueOnce(child);
  return child;
}

describe('ensureDaemon', () => {
  let workDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'wukong-daemon-'));
    prevHome = process.env['WUKONG_CODE_HOME'];
    process.env['WUKONG_CODE_HOME'] = workDir;
    mockServer.getLiveLock.mockReturnValue(undefined);
    mockShared.isServerHealthy.mockResolvedValue(false);
    mockShared.waitForServerHealthy.mockResolvedValue(false);
    spawnMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevHome === undefined) {
      delete process.env['WUKONG_CODE_HOME'];
    } else {
      process.env['WUKONG_CODE_HOME'] = prevHome;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reuses an already-live daemon when the lock is healthy', async () => {
    const lock: LockContents = { pid: 1234, started_at: '', port: 58627, host: '127.0.0.1' };
    mockServer.getLiveLock.mockReturnValue(lock);
    mockShared.waitForServerHealthy.mockResolvedValue(true);

    const { ensureDaemon } = await import('#/cli/sub/server/daemon');
    const result = await ensureDaemon();

    expect(result.reused).toBe(true);
    expect(result.origin).toBe('http://127.0.0.1:58627');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns a new daemon and returns once it becomes healthy', async () => {
    const lock: LockContents = { pid: 1234, started_at: '', port: 58627, host: '127.0.0.1' };
    makeChild(null, false);
    let calls = 0;
    mockServer.getLiveLock.mockImplementation(() => {
      calls += 1;
      return calls > 1 ? lock : undefined;
    });
    mockShared.isServerHealthy.mockResolvedValue(true);

    const { ensureDaemon } = await import('#/cli/sub/server/daemon');
    const resultPromise = ensureDaemon();
    await vi.advanceTimersByTimeAsync(500);

    const result = await resultPromise;
    expect(result.reused).toBe(false);
    expect(result.origin).toBe('http://127.0.0.1:58627');
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('throws a clear error when the spawned daemon exits early', async () => {
    makeChild(1, true);
    mockServer.getLiveLock.mockReturnValue(undefined);

    const { ensureDaemon } = await import('#/cli/sub/server/daemon');
    await expect(ensureDaemon()).rejects.toThrow(/exited with code 1/);
  });

  it('throws a timeout message when no daemon becomes healthy', async () => {
    makeChild(null, false);
    mockServer.getLiveLock.mockReturnValue(undefined);

    const { ensureDaemon } = await import('#/cli/sub/server/daemon');
    const resultPromise = ensureDaemon();
    const rejection = expect(resultPromise).rejects.toThrow(/failed to start within/);
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
  });

  it('threads options through to the spawned child args', async () => {
    const lock: LockContents = { pid: 1234, started_at: '', port: 58627, host: '0.0.0.0' };
    makeChild(null, false);
    let calls = 0;
    mockServer.getLiveLock.mockImplementation(() => {
      calls += 1;
      return calls > 1 ? lock : undefined;
    });
    mockShared.isServerHealthy.mockResolvedValue(true);

    const { ensureDaemon } = await import('#/cli/sub/server/daemon');
    const resultPromise = ensureDaemon({
      host: '0.0.0.0',
      port: 58627,
      logLevel: 'debug',
      debugEndpoints: true,
      insecureNoTls: true,
      allowRemoteShutdown: true,
      allowRemoteTerminals: true,
      allowedHosts: ['.example.com'],
      idleGraceMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(500);

    await resultPromise;
    const [, args] = (spawnMock.mock.calls[0] as unknown as [string, string[], object]);
    expect(args).toEqual(
      expect.arrayContaining([
        'server',
        'run',
        '--daemon',
        '--port',
        '58627',
        '--host',
        '0.0.0.0',
        '--log-level',
        'debug',
        '--debug-endpoints',
        '--insecure-no-tls',
        '--allow-remote-shutdown',
        '--allow-remote-terminals',
        '--idle-grace-ms',
        '30000',
        '--allowed-host',
        '.example.com',
      ]),
    );
  });
});

describe('daemonLogPath', () => {
  it('lives under the server lock directory', async () => {
    const { daemonLogPath } = await import('#/cli/sub/server/daemon');
    expect(daemonLogPath()).toBe(join(mockServer.DEFAULT_LOCK_DIR, 'server.log'));
  });
});

describe('spawnDaemonChild cwd', () => {
  let workDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'wukong-daemon-cwd-'));
    prevHome = process.env['WUKONG_CODE_HOME'];
    process.env['WUKONG_CODE_HOME'] = workDir;
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess);
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['WUKONG_CODE_HOME'];
    } else {
      process.env['WUKONG_CODE_HOME'] = prevHome;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('uses the log directory as cwd so the daemon does not pin the caller directory', async () => {
    const { spawnDaemonChild, daemonLogPath } = await import('#/cli/sub/server/daemon');
    spawnDaemonChild({ port: 58627, logLevel: 'info' });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, , options] = (spawnMock.mock.calls[0] as unknown as [string, string[], object]);
    expect(options).toMatchObject({ detached: true, cwd: dirname(daemonLogPath()) });
  });
});
