import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPluginNodeEntry } from '#/cli/sub/plugin-run-node';

declare global {
  // eslint-disable-next-line no-var
  var __pluginRunTestArgv: string[] | undefined;
  // eslint-disable-next-line no-var
  var __pluginRan: boolean | undefined;
}

describe('runPluginNodeEntry', () => {
  let workDir: string;
  let prevPluginRoot: string | undefined;
  let originalArgv: string[];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'wukong-plugin-'));
    prevPluginRoot = process.env['WUKONG_PLUGIN_ROOT'];
    originalArgv = process.argv.slice();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (prevPluginRoot === undefined) {
      delete process.env['WUKONG_PLUGIN_ROOT'];
    } else {
      process.env['WUKONG_PLUGIN_ROOT'] = prevPluginRoot;
    }
    rmSync(workDir, { recursive: true, force: true });
    delete globalThis.__pluginRunTestArgv;
    delete globalThis.__pluginRan;
  });

  it('throws when WUKONG_PLUGIN_ROOT is missing', async () => {
    delete process.env['WUKONG_PLUGIN_ROOT'];
    await expect(runPluginNodeEntry('/tmp/entry.mjs', [])).rejects.toThrow(
      'WUKONG_PLUGIN_ROOT is required',
    );
  });

  it('throws when WUKONG_PLUGIN_ROOT is empty', async () => {
    process.env['WUKONG_PLUGIN_ROOT'] = '   ';
    await expect(runPluginNodeEntry('/tmp/entry.mjs', [])).rejects.toThrow(
      'WUKONG_PLUGIN_ROOT is required',
    );
  });

  it('throws when the entry is outside WUKONG_PLUGIN_ROOT', async () => {
    process.env['WUKONG_PLUGIN_ROOT'] = workDir;
    const outside = mkdtempSync(join(tmpdir(), 'wukong-plugin-outside-'));
    const entry = join(outside, 'entry.mjs');
    writeFileSync(entry, '// outside', 'utf8');
    try {
      await expect(runPluginNodeEntry(entry, [])).rejects.toThrow(
        'Plugin node entry must be inside WUKONG_PLUGIN_ROOT',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('runs an entry inside WUKONG_PLUGIN_ROOT with rewritten argv', async () => {
    process.env['WUKONG_PLUGIN_ROOT'] = workDir;
    const entry = join(workDir, 'entry.mjs');
    writeFileSync(
      entry,
      `
      globalThis.__pluginRan = true;
      globalThis.__pluginRunTestArgv = process.argv.slice();
    `,
      'utf8',
    );

    await runPluginNodeEntry(entry, ['--arg1', 'value']);

    expect(globalThis.__pluginRan).toBe(true);
    expect(globalThis.__pluginRunTestArgv).toEqual([
      process.argv[0],
      realpathSync(entry),
      '--arg1',
      'value',
    ]);
  });

  it('resolves symlinks before checking containment', async () => {
    const realDir = mkdtempSync(join(workDir, 'real-'));
    process.env['WUKONG_PLUGIN_ROOT'] = workDir;
    const linkDir = join(workDir, 'linked');
    mkdirSync(linkDir);
    const entry = join(linkDir, 'entry.mjs');
    writeFileSync(
      entry,
      `
      globalThis.__pluginRan = true;
    `,
      'utf8',
    );

    await runPluginNodeEntry(entry, []);

    expect(globalThis.__pluginRan).toBe(true);
  });
});
