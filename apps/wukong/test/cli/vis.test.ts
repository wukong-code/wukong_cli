/**
 * `wukong vis`
 *
 * Verifies the CLI layer for the session visualizer: home + auto-port
 * resolution, browser open vs `--no-open`, and the session deep-link path.
 * Uses injected deps so no real port is bound and the real vis server is
 * never started.
 */

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

import { handleVis, registerVisCommand, type VisDeps } from '#/cli/sub/vis';

function makeDeps(over: Partial<VisDeps> = {}): {
  deps: VisDeps;
  opened: string[];
  out: string[];
} {
  const opened: string[] = [];
  const out: string[] = [];
  const deps: VisDeps = {
    getHomeDir: () => '/home/k',
    startVisServer: vi.fn(async (o) => ({
      port: 41234,
      host: '127.0.0.1',
      url: 'http://127.0.0.1:41234/',
      close: async () => {},
      _opts: o,
    })) as unknown as VisDeps['startVisServer'],
    openUrl: async (u: string) => {
      opened.push(u);
    },
    waitForShutdown: async () => {},
    stdout: {
      write: (s: string) => {
        out.push(s);
        return true;
      },
    },
    stderr: { write: () => true },
    exit: vi.fn() as unknown as VisDeps['exit'],
    ...over,
  };
  return { deps, opened, out };
}

describe('handleVis', () => {
  it('starts the server with the home dir + auto port and opens the browser', async () => {
    const { deps, opened, out } = makeDeps();
    await handleVis(deps, { open: true });
    expect(deps.startVisServer).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/home/k', port: 0 }),
    );
    expect(opened).toEqual(['http://127.0.0.1:41234/']);
    expect(out.join('')).toContain('http://127.0.0.1:41234/');
  });

  it('does not open the browser when open is false', async () => {
    const { deps, opened } = makeDeps();
    await handleVis(deps, { open: false });
    expect(opened).toEqual([]);
  });

  it('deep-links to a session when sessionId is given', async () => {
    const { deps, opened } = makeDeps();
    await handleVis(deps, { open: true, sessionId: 'sess_abc' });
    expect(opened[0]).toBe('http://127.0.0.1:41234/sessions/sess_abc');
  });

  it('uses the explicit port when provided', async () => {
    const { deps } = makeDeps();
    await handleVis(deps, { open: false, port: 4321 });
    expect(deps.startVisServer).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/home/k', port: 4321 }),
    );
  });

  it('closes the server after shutdown', async () => {
    const close = vi.fn(async () => {});
    const { deps } = makeDeps({
      startVisServer: vi.fn(async () => ({
        port: 41234,
        host: '127.0.0.1',
        url: 'http://127.0.0.1:41234/',
        close,
      })) as unknown as VisDeps['startVisServer'],
    });
    await handleVis(deps, { open: false });
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a clean error and exits when the server fails to start', async () => {
    const errored: string[] = [];
    const { deps, opened } = makeDeps({
      startVisServer: vi.fn(async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:4321');
      }) as unknown as VisDeps['startVisServer'],
      stderr: {
        write: (s: string) => {
          errored.push(s);
          return true;
        },
      },
      waitForShutdown: vi.fn(async () => {}),
    });
    await handleVis(deps, { open: true, port: 4321 });
    expect(errored.join('')).toContain('Failed to start wukong vis');
    expect(errored.join('')).toContain('EADDRINUSE');
    expect(deps.exit).toHaveBeenCalledWith(1);
    // Nothing past the failed start should run.
    expect(opened).toEqual([]);
    expect(deps.waitForShutdown).not.toHaveBeenCalled();
  });

  it('passes the explicit host through to the server', async () => {
    const { deps } = makeDeps();
    await handleVis(deps, { open: false, host: '0.0.0.0' });
    expect(deps.startVisServer).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/home/k', host: '0.0.0.0' }),
    );
  });

  it('warns when the browser cannot be opened but keeps running', async () => {
    const errored: string[] = [];
    const { deps, opened } = makeDeps({
      openUrl: vi.fn(async () => {
        throw new Error('no browser');
      }),
      stderr: {
        write: (s: string) => {
          errored.push(s);
          return true;
        },
      },
    });
    await handleVis(deps, { open: true });
    expect(opened).toEqual([]);
    expect(errored.join('')).toContain('Could not open a browser');
  });
});

describe('registerVisCommand', () => {
  function makeCommandDeps(): {
    opened: string[];
    out: string[];
    closed: boolean;
    overrides: Partial<VisDeps>;
  } {
    const opened: string[] = [];
    const out: string[] = [];
    const closed = { value: false };

    const overrides: Partial<VisDeps> = {
      getHomeDir: () => '/home/k',
      startVisServer: vi.fn(async () => ({
        port: 41234,
        host: '127.0.0.1',
        url: 'http://127.0.0.1:41234/',
        close: async () => {
          closed.value = true;
        },
      })),
      openUrl: async (u: string) => {
        opened.push(u);
      },
      waitForShutdown: async () => {},
      stdout: {
        write: (s: string) => {
          out.push(s);
          return true;
        },
      },
      stderr: { write: () => true },
      exit: vi.fn() as unknown as VisDeps['exit'],
    };

    return { opened, out, closed: closed.value, overrides };
  }

  it('registers the vis subcommand with the expected options', () => {
    const program = new Command('wukong').exitOverride();
    registerVisCommand(program);

    const vis = program.commands.find((cmd) => cmd.name() === 'vis');
    expect(vis).toBeDefined();

    const longs = vis!.options.map((option) => option.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--no-open');
  });

  it('parses --port and --host and forwards them to handleVis', async () => {
    const { overrides } = makeCommandDeps();
    const program = new Command('wukong').exitOverride();
    registerVisCommand(program, overrides);

    const runPromise = program.parseAsync(['node', 'wukong', 'vis', '--port', '4321', '--host', '0.0.0.0']);
    await runPromise;

    expect(overrides.startVisServer).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/home/k', port: 4321, host: '0.0.0.0' }),
    );
  });

  it('opens the browser by default', async () => {
    const { overrides, opened } = makeCommandDeps();
    const program = new Command('wukong').exitOverride();
    registerVisCommand(program, overrides);

    await program.parseAsync(['node', 'wukong', 'vis']);
    expect(opened).toEqual(['http://127.0.0.1:41234/']);
  });

  it('respects --no-open', async () => {
    const { overrides, opened } = makeCommandDeps();
    const program = new Command('wukong').exitOverride();
    registerVisCommand(program, overrides);

    await program.parseAsync(['node', 'wukong', 'vis', '--no-open']);
    expect(opened).toEqual([]);
  });

  it('deep-links to the provided session argument', async () => {
    const { overrides, opened } = makeCommandDeps();
    const program = new Command('wukong').exitOverride();
    registerVisCommand(program, overrides);

    await program.parseAsync(['node', 'wukong', 'vis', 'sess_abc']);
    expect(opened).toEqual(['http://127.0.0.1:41234/sessions/sess_abc']);
  });
});
