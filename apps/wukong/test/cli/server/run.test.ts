import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

import {
  buildRunCommand,
  buildWebUrl,
  createIdleShutdownHandler,
  handleRunCommand,
  type RunCommandDeps,
} from '#/cli/sub/server/run';

describe('buildRunCommand', () => {
  it('registers server run options and action', () => {
    const run = new Command('run');
    const cmd = buildRunCommand(run, { defaultOpen: false });

    expect(cmd.name()).toBe('run');
    const options = cmd.options.map((o) => o.name());
    expect(options).toContain('port');
    expect(options).toContain('host');
    expect(options).toContain('foreground');
    expect(options).toContain('open');
  });

  it('uses --no-open as the option when defaultOpen is true', () => {
    const program = new Command();
    const cmd = buildRunCommand(program, { defaultOpen: true });

    const names = cmd.options.map((o) => o.name());
    expect(names).toContain('no-open');
  });
});

describe('handleRunCommand', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  function makeDeps(overrides: Partial<RunCommandDeps> = {}): RunCommandDeps {
    return {
      startServerBackground: vi.fn().mockResolvedValue({ origin: 'http://127.0.0.1:8080' }),
      startServerForeground: vi.fn().mockImplementation(async (_opts, hooks) => {
        hooks?.onReady?.('http://127.0.0.1:8080');
        return Promise.resolve() as unknown as Promise<never>;
      }),
      openUrl: vi.fn(),
      resolveToken: () => 'secret-token',
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      ...overrides,
    };
  }

  it('starts a background server and prints the ready banner', async () => {
    const deps = makeDeps();
    await handleRunCommand({ port: '8080', host: '127.0.0.1' } as any, deps);

    expect(deps.startServerBackground).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8080, host: '127.0.0.1' }),
    );
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('Wukong server ready'));
  });

  it('opens the web UI when --open is true and a token is available', async () => {
    const deps = makeDeps();
    await handleRunCommand({ port: '8080', host: '127.0.0.1', open: true } as any, deps);

    expect(deps.openUrl).toHaveBeenCalledWith(buildWebUrl('http://127.0.0.1:8080', 'secret-token'));
  });

  it('does not open the web UI when --open is false', async () => {
    const deps = makeDeps();
    await handleRunCommand({ port: '8080', host: '127.0.0.1', open: false } as any, deps);

    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('prints a reuse notice when the background server was already running', async () => {
    const deps = makeDeps({
      startServerBackground: vi.fn().mockResolvedValue({
        origin: 'http://127.0.0.1:8080',
        reused: true,
        host: '127.0.0.1',
        port: 8080,
      }),
    });
    await handleRunCommand({ port: '8080', host: '127.0.0.1' } as any, deps);

    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('runs in the foreground when --foreground is true', async () => {
    const deps = makeDeps();
    await handleRunCommand(
      { port: '8080', host: '127.0.0.1', foreground: true } as any,
      deps,
    );

    expect(deps.startServerForeground).toHaveBeenCalled();
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('Wukong server ready'));
  });
});

describe('buildWebUrl', () => {
  it('appends the token as a URL fragment', () => {
    expect(buildWebUrl('http://127.0.0.1:8080', 'abc123')).toContain('#token=abc123');
  });
});

describe('createIdleShutdownHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('does not fire onIdle before any client has connected', () => {
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 10, onIdle });

    handler.onConnectionCountChange(0);
    vi.advanceTimersByTime(20);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires onIdle after the client count drops to zero for the grace period', () => {
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 10, onIdle });

    handler.onConnectionCountChange(1);
    handler.onConnectionCountChange(0);
    vi.advanceTimersByTime(20);
    expect(onIdle).toHaveBeenCalled();
  });

  it('cancels the idle timer if a client reconnects', () => {
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 10, onIdle });

    handler.onConnectionCountChange(1);
    handler.onConnectionCountChange(0);
    handler.onConnectionCountChange(1);
    vi.advanceTimersByTime(20);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
