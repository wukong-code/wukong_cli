import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

import { handleDoctor, registerDoctorCommand, type DoctorDeps } from '#/cli/sub/doctor';

describe('handleDoctor', () => {
  function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return {
      cwd: () => '/workspace',
      defaultConfigPath: () => '/workspace/config.toml',
      defaultTuiConfigPath: () => '/workspace/tui.toml',
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      exit: vi.fn((code: number) => {
        throw new Error(`exit ${code}`);
      }) as unknown as (code: number) => never,
      fileExists: () => false,
      readTextFile: vi.fn().mockResolvedValue(''),
      validateConfigToml: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('skips missing default files and returns 0', async () => {
    const deps = makeDeps();
    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('SKIP'));
    expect(deps.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('No config files were found'),
    );
    expect(deps.stdout.write).not.toHaveBeenCalledWith(
      expect.stringContaining('All checked config files are valid'),
    );
  });

  it('validates existing config and tui files', async () => {
    const deps = makeDeps({
      fileExists: (path) => true,
    });
    const code = await handleDoctor(deps, {});

    expect(code).toBe(0);
    expect(deps.validateConfigToml).toHaveBeenCalledWith('', '/workspace/config.toml');
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('OK'));
  });

  it('returns 1 and writes to stderr when config validation fails', async () => {
    const deps = makeDeps({
      fileExists: (path) => path.endsWith('config.toml'),
      validateConfigToml: vi.fn().mockRejectedValue(new Error('bad config')),
    });
    const code = await handleDoctor(deps, {});

    expect(code).toBe(1);
    expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringContaining('bad config'));
  });

  it('returns 1 when an explicit file does not exist', async () => {
    const deps = makeDeps();
    const code = await handleDoctor(deps, { target: 'config', path: 'missing.toml' });

    expect(code).toBe(1);
    expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringContaining('File does not exist'));
  });

  it('resolves relative paths against cwd', async () => {
    const deps = makeDeps({
      fileExists: (path) => true,
    });
    await handleDoctor(deps, { target: 'config', path: 'wukong.toml' });

    expect(deps.validateConfigToml).toHaveBeenCalledWith(
      '',
      resolve('/workspace', 'wukong.toml'),
    );
  });

  it('validates only tui.toml when target is tui', async () => {
    const deps = makeDeps({
      fileExists: (path) => path.endsWith('tui.toml'),
      readTextFile: vi.fn().mockResolvedValue('theme = "dark"'),
    });
    const code = await handleDoctor(deps, { target: 'tui' });

    expect(code).toBe(0);
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('tui.toml'));
    expect(deps.validateConfigToml).not.toHaveBeenCalled();
  });

  it('returns 1 when tui.toml is invalid', async () => {
    const deps = makeDeps({
      fileExists: (path) => path.endsWith('tui.toml'),
      readTextFile: vi.fn().mockResolvedValue('theme = 123'),
    });
    const code = await handleDoctor(deps, { target: 'tui' });

    expect(code).toBe(1);
    expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });
});

describe('registerDoctorCommand', () => {
  it('registers doctor, doctor config, and doctor tui commands', () => {
    const program = new Command();
    registerDoctorCommand(program);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain('doctor');

    const doctor = program.commands.find((cmd) => cmd.name() === 'doctor')!;
    const subNames = doctor.commands.map((cmd) => cmd.name());
    expect(subNames).toContain('config');
    expect(subNames).toContain('tui');
  });
});
