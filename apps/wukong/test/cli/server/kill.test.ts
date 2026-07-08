import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

import {
  handleKillCommand,
  registerKillCommand,
  requestShutdownViaApi,
  type KillCommandDeps,
} from '#/cli/sub/server/kill';

describe('handleKillCommand', () => {
  function makeDeps(overrides: Partial<KillCommandDeps> = {}): KillCommandDeps {
    let time = 0;
    return {
      getLiveLock: vi.fn().mockReturnValue({ pid: 1234, host: '127.0.0.1', port: 8080 }),
      requestShutdown: vi.fn().mockResolvedValue(undefined),
      resolveToken: () => 'token',
      signalPid: vi.fn().mockReturnValue(true),
      pidAlive: vi.fn().mockReturnValue(false),
      sleep: vi.fn().mockResolvedValue(undefined),
      stdout: { write: vi.fn() },
      now: vi.fn(() => {
        const t = time;
        time += 5000;
        return t;
      }),
      ...overrides,
    };
  }

  it('reports no server when there is no lock', async () => {
    const deps = makeDeps({ getLiveLock: vi.fn().mockReturnValue(undefined) });
    await handleKillCommand(deps);

    expect(deps.stdout.write).toHaveBeenCalledWith('No running Wukong server.\n');
    expect(deps.signalPid).not.toHaveBeenCalled();
  });

  it('stops gracefully when the pid exits after SIGTERM', async () => {
    const deps = makeDeps();
    await handleKillCommand(deps);

    expect(deps.requestShutdown).toHaveBeenCalledWith('http://127.0.0.1:8080', 'token');
    expect(deps.signalPid).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(deps.stdout.write).toHaveBeenCalledWith('Wukong server (pid 1234) stopped.\n');
  });

  it('escalates to SIGKILL when SIGTERM does not stop the process', async () => {
    let calls = 0;
    const alive = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls < 3;
    });
    const deps = makeDeps({ pidAlive: alive });
    await handleKillCommand(deps);

    expect(deps.signalPid).toHaveBeenCalledWith(1234, 'SIGKILL');
    expect(deps.stdout.write).toHaveBeenCalledWith('Wukong server (pid 1234) killed.\n');
  });

  it('throws when the process survives SIGKILL', async () => {
    const deps = makeDeps({ pidAlive: vi.fn().mockReturnValue(true) });

    await expect(handleKillCommand(deps)).rejects.toThrow('Failed to stop Wukong server');
  });

  it('ignores API shutdown failures and falls back to PID kill', async () => {
    const deps = makeDeps({ requestShutdown: vi.fn().mockRejectedValue(new Error('timeout')) });
    await handleKillCommand(deps);

    expect(deps.signalPid).toHaveBeenCalledWith(1234, 'SIGTERM');
  });
});

describe('registerKillCommand', () => {
  it('registers the kill subcommand', () => {
    const server = new Command();
    registerKillCommand(server);

    const names = server.commands.map((cmd) => cmd.name());
    expect(names).toContain('kill');
  });
});

describe('requestShutdownViaApi', () => {
  it('posts to the shutdown endpoint with auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;

    await requestShutdownViaApi('http://127.0.0.1:8080', 'token');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/api/v1/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });
});
