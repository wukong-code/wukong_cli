import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { ServiceManager, ServiceStatus } from '@wukong/server';

import { addLifecycleCommands, type LifecycleCommandDeps } from '#/cli/sub/server/lifecycle';

describe('addLifecycleCommands', () => {
  let stdout: { write: ReturnType<typeof vi.fn> };
  let stderr: { write: ReturnType<typeof vi.fn> };
  let openUrl: LifecycleCommandDeps['openUrl'];
  let manager!: ServiceManager;
  let deps: LifecycleCommandDeps;

  beforeEach(() => {
    stdout = { write: vi.fn() };
    stderr = { write: vi.fn() };
    openUrl = vi.fn();
    manager = {
      install: vi.fn().mockResolvedValue({ status: 'installed', message: 'installed' }),
      uninstall: vi.fn().mockResolvedValue({ ok: true, message: 'uninstalled' }),
      start: vi.fn().mockResolvedValue({ ok: true, message: 'started' }),
      stop: vi.fn().mockResolvedValue({ ok: true, message: 'stopped' }),
      restart: vi.fn().mockResolvedValue({ ok: true, message: 'restarted' }),
      status: vi.fn().mockResolvedValue({
        running: true,
        host: '127.0.0.1',
        port: 8080,
        logPath: '/var/log/wukong.log',
        notes: ['note'],
      } as unknown as ServiceStatus),
    };
    deps = {
      resolveManager: vi.fn(() => manager),
      openUrl,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    };
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getStdoutLine(): string {
    return stdout.write.mock.calls[0]?.[0] ?? '';
  }

  function buildProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    addLifecycleCommands(program, deps);
    return program;
  }

  it('installs the service and prints JSON', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'install', '--json']);

    expect(manager.install).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 58627 }),
    );
    const output = JSON.parse(getStdoutLine());
    expect(output.ok).toBe(true);
    expect(output.action).toBe('install');
    expect(output.url).toBe('http://127.0.0.1:8080');
  });

  it('opens the web UI after install when service is running', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'install']);

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:8080');
  });

  it('does not open the web UI when --no-open is passed', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'install', '--no-open']);

    expect(openUrl).not.toHaveBeenCalled();
  });

  it('uninstalls the service', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'uninstall', '--json']);

    expect(manager.uninstall).toHaveBeenCalled();
    const output = JSON.parse(getStdoutLine());
    expect(output).toMatchObject({ ok: true, action: 'uninstall' });
  });

  it('starts the service', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'start', '--json']);

    expect(manager.start).toHaveBeenCalled();
    const output = JSON.parse(getStdoutLine());
    expect(output.action).toBe('start');
  });

  it('stops the service', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'stop', '--json']);

    expect(manager.stop).toHaveBeenCalled();
    const output = JSON.parse(getStdoutLine());
    expect(output).toMatchObject({ ok: true, action: 'stop' });
  });

  it('restarts the service', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'restart', '--json']);

    expect(manager.restart).toHaveBeenCalled();
    const output = JSON.parse(getStdoutLine());
    expect(output.action).toBe('restart');
  });

  it('reports service status', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'status', '--json']);

    expect(manager.status).toHaveBeenCalled();
    const output = JSON.parse(getStdoutLine());
    expect(output.action).toBe('status');
    expect(output.running).toBe(true);
  });

  it('prints human-readable output by default', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'script', 'start']);

    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('start'));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('Status: running'));
  });
});
