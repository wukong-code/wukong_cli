import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { handleDoctor, type DoctorDeps } from '#/cli/sub/doctor';

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('onboarding alignment across install.sh, postinstall, and wukong doctor', () => {
  it('points to wukong init -> wukong check -> wukong gate in order across all three entrypoints', async () => {
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
    const installScript = readFileSync(resolve(repoRoot, 'install.sh'), 'utf8');
    for (const expected of ['wukong init', 'wukong check', 'wukong gate']) {
      expect(installScript).toContain(expected);
    }
    expect(installScript.indexOf('wukong init')).toBeLessThan(installScript.indexOf('wukong check'));
    expect(installScript.indexOf('wukong check')).toBeLessThan(installScript.indexOf('wukong gate'));

    const uiModule = (await import('../../scripts/postinstall/ui.mjs')) as {
      renderFreshInstallQuickstart: (opts?: { onPath?: boolean; pm?: string }) => string;
    };
    const freshOnPath = stripAnsi(uiModule.renderFreshInstallQuickstart({ onPath: true, pm: 'npm' }));
    expect(freshOnPath.indexOf('wukong init')).toBeGreaterThan(-1);
    expect(freshOnPath.indexOf('wukong init')).toBeLessThan(freshOnPath.indexOf('wukong check'));
    expect(freshOnPath.indexOf('wukong check')).toBeLessThan(freshOnPath.indexOf('wukong gate'));

    const freshOffPath = stripAnsi(uiModule.renderFreshInstallQuickstart({ onPath: false, pm: 'npm' }));
    expect(freshOffPath.indexOf('PATH')).toBeGreaterThan(-1);
    expect(freshOffPath.indexOf('PATH')).toBeLessThan(freshOffPath.indexOf('wukong init'));

    const chunks: string[] = [];
    const deps: DoctorDeps = {
      cwd: () => '/workspace',
      defaultConfigPath: () => '/workspace/config.toml',
      defaultTuiConfigPath: () => '/workspace/tui.toml',
      stdout: {
        write: (chunk) => {
          chunks.push(chunk);
          return true;
        },
      },
      stderr: { write: vi.fn() },
      exit: vi.fn() as unknown as (code: number) => never,
      fileExists: () => false,
      readTextFile: vi.fn().mockResolvedValue(''),
      validateConfigToml: vi.fn().mockResolvedValue(undefined),
    };
    expect(await handleDoctor(deps, {})).toBe(0);
    const doctorOut = chunks.join('');
    expect(doctorOut.indexOf('wukong init')).toBeGreaterThan(-1);
    expect(doctorOut.indexOf('wukong init')).toBeLessThan(doctorOut.indexOf('wukong check'));
    expect(doctorOut.indexOf('wukong check')).toBeLessThan(doctorOut.indexOf('wukong gate'));
  });
});
