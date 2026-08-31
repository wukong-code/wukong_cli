import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WukongCore } from '../../src/rpc/core-impl';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHome(configToml?: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'wukong-home-'));
  tempDirs.push(home);
  if (configToml !== undefined) {
    await writeFile(path.join(home, 'config.toml'), configToml, 'utf-8');
  }
  return home;
}

function makeCore(home: string): WukongCore {
  return new WukongCore(async () => ({}) as never, { homeDir: home });
}

const VALID_TOML = `
default_model = "k2"

[providers.wukong]
type = "wukong"
api_key = "sk-good"

[models.k2]
provider = "wukong"
model = "wukong-for-coding"
max_context_size = 128000
`;

describe('WukongCore degraded config loading', () => {
  it('reports no diagnostics for a valid config', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const config = await core.getWukongConfig({});
    expect(config.providers['wukong']).toBeDefined();
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('refuses to start when the TOML cannot be parsed at all', async () => {
    const home = await makeHome('[[[');
    // A fully unusable file means defaults-only (looks logged out), which is
    // worse than failing fast with the parse location.
    expect(() => makeCore(home)).toThrow(/Invalid TOML/);
  });

  it('starts with a partially invalid config, keeping the valid sections', async () => {
    const core = makeCore(
      await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`),
    );
    const config = await core.getWukongConfig({});
    expect(config.providers['wukong']).toBeDefined();
    expect(config.loopControl).toBeUndefined();
    const diagnostics = await core.getConfigDiagnostics({});
    expect(diagnostics.warnings).toHaveLength(1);
    expect(diagnostics.warnings[0]).toContain('loop_control');
  });

  it('rejects config writes with an actionable error while the file is invalid', async () => {
    const home = await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const core = makeCore(home);
    const before = await readFile(path.join(home, 'config.toml'), 'utf-8');

    // Write paths stay strict: changing settings on top of a broken file
    // must fail with a short, actionable message — not raw validation JSON —
    // and must leave the file untouched.
    const write = core.setWukongConfig({ defaultThinking: true });
    await expect(write).rejects.toThrow(/fix it first/i);
    await expect(write).rejects.toThrow(/wukong doctor/);
    await expect(write).rejects.not.toThrow(/invalid_type/);

    const after = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(after).toBe(before);
  });

  it('keeps the last good config when the file breaks mid-run', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    const configPath = path.join(home, 'config.toml');

    await writeFile(configPath, '[[[', 'utf-8');
    const kept = await core.getWukongConfig({ reload: true });
    expect(kept.providers['wukong']).toBeDefined();
    const degraded = await core.getConfigDiagnostics({});
    expect(degraded.warnings.some((w) => w.includes('Invalid TOML'))).toBe(true);
    expect(degraded.warnings.some((w) => w.includes('previous'))).toBe(true);

    await writeFile(configPath, `default_thinking = true\n${VALID_TOML}`, 'utf-8');
    const adopted = await core.getWukongConfig({ reload: true });
    expect(adopted.defaultThinking).toBe(true);
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('replaces the complete config atomically instead of deep-merging stale keys', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);

    const replaced = await core.replaceWukongConfig({
      providers: {
        local: { type: 'openai', apiKey: 'sk-new' },
      },
      models: {
        'local/model': { provider: 'local', model: 'model', maxContextSize: 128_000 },
      },
      defaultModel: 'local/model',
    });

    expect(replaced.providers).toEqual({
      local: expect.objectContaining({ type: 'openai', apiKey: 'sk-new' }),
    });
    expect(replaced.providers['wukong']).toBeUndefined();
    expect(replaced.models?.['k2']).toBeUndefined();
    await expect(core.getWukongConfig({ reload: true })).resolves.toMatchObject({
      defaultModel: 'local/model',
    });
  });
});
