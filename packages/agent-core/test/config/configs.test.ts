import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, WukongError } from '../../src/errors';
import {
  WukongConfigSchema,
  ensureConfigFile,
  loadRuntimeConfig,
  loadRuntimeConfigSafe,
  mergeConfigPatch,
  parseConfigString,
  parseBooleanEnv,
  readConfigFile,
  readConfigFileForUpdate,
  resolveConfigPath,
  resolveConfigValue,
  resolveWukongHome,
  validateConfig,
  writeConfigFile,
} from '../../src/config';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wukong-core-config-'));
  tempDirs.push(dir);
  return dir;
}

function expectWukongErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WukongError);
    expect((error as WukongError).code).toBe(code);
    return;
  }
  throw new Error('expected function to throw');
}

const COMPLETE_TOML = `
default_model = "wukong/wukong-for-coding"
default_thinking = true
default_permission_mode = "auto"
default_plan_mode = false
merge_all_available_skills = true
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
telemetry = false
theme = "dark"

[providers."managed:wukong"]
type = "wukong"
base_url = "https://api.wukong.today/coding/v1"
api_key = "sk-file"
custom_headers = { "X-Test" = "1" }

[providers."managed:wukong".env]
GOOGLE_CLOUD_PROJECT = "project-1"

[models."wukong/wukong-for-coding"]
provider = "managed:wukong"
model = "wukong-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]
display_name = "Wukong for Coding"

[thinking]
mode = "auto"
effort = "medium"

[permission]
mode = "manual"

[[permission.rules]]
decision = "deny"
scope = "user"
pattern = "Bash(rm *)"
reason = "no rm"

[[permission.allow]]
tool = "Read"
match = "src/**"
reason = "read src"

[loop_control]
max_steps_per_run = 42
max_retries_per_step = 3
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
keep_alive_on_exit = false
kill_grace_period_ms = 2000
print_wait_ceiling_s = 3600

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo pre"
timeout = 5

[[hooks]]
event = "Stop"
command = "echo stop"

[services.wukong_search]
base_url = "https://api.wukong.today/coding/v1/search"
api_key = "sk-search"
custom_headers = { "X-Search" = "1" }

[services.wukong_fetch]
base_url = "https://api.wukong.today/coding/v1/fetch"
api_key = "sk-fetch"

[notifications]
claim_stale_after_ms = 15000
`;

describe('harness config TOML loader', () => {
  it('loads the immutable v0.0.22 BYOK provider config without migration', async () => {
    const fixtureUrl = new URL(
      '../fixtures/compat/v0.0.22/config.toml',
      import.meta.url,
    );
    const fixture = await readFile(fixtureUrl, 'utf8');
    const config = parseConfigString(fixture, 'v0.0.22/config.toml');

    expect(config.defaultModel).toBe('release-openai');
    expect(config.providers['release-openai']).toEqual({
      type: 'openai_responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'v0.0.22-fixture-key',
    });
    expect(config.models?.['release-openai']).toMatchObject({
      provider: 'release-openai',
      model: 'gpt-5',
      maxContextSize: 262144,
    });
  });

  it('parses the current config.toml shape through explicit field mappings', () => {
    const config = parseConfigString(COMPLETE_TOML, 'config.toml');

    expect(config.defaultModel).toBe('wukong/wukong-for-coding');
    expect(config.defaultThinking).toBe(true);
    expect(config.defaultPermissionMode).toBe('auto');
    expect(config.defaultPlanMode).toBe(false);
    expect(config.mergeAllAvailableSkills).toBe(true);
    expect(config.extraSkillDirs).toEqual(['~/team-skills', '.agents/team-skills']);
    expect(config.telemetry).toBe(false);
    expect(config.providers['managed:wukong']).toMatchObject({
      type: 'wukong',
      baseUrl: 'https://api.wukong.today/coding/v1',
      apiKey: 'sk-file',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
      customHeaders: { 'X-Test': '1' },
    });
    expect(config.models?.['wukong/wukong-for-coding']).toMatchObject({
      provider: 'managed:wukong',
      model: 'wukong-for-coding',
      maxContextSize: 262144,
      capabilities: ['image_in', 'thinking', 'video_in'],
      displayName: 'Wukong for Coding',
    });
    expect(config.thinking).toEqual({ mode: 'auto', effort: 'medium' });
    expect(config.permission).toEqual({
      rules: [
        {
          decision: 'deny',
          scope: 'user',
          pattern: 'Bash(rm *)',
          reason: 'no rm',
        },
        {
          decision: 'allow',
          scope: 'user',
          pattern: 'Read(src/**)',
          reason: 'read src',
        },
      ],
    });
    expect(config.loopControl).toMatchObject({
      maxStepsPerTurn: 42,
      maxRetriesPerStep: 3,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
    });
    expect(config.background).toMatchObject({
      maxRunningTasks: 4,
      keepAliveOnExit: false,
      killGracePeriodMs: 2000,
      printWaitCeilingS: 3600,
    });
    expect(config.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Shell',
        command: 'echo pre',
        timeout: 5,
      },
      {
        event: 'Stop',
        command: 'echo stop',
      },
    ]);
    expect(config.services?.wukongSearch?.customHeaders).toEqual({ 'X-Search': '1' });
    expect(config.services?.wukongFetch?.apiKey).toBe('sk-fetch');

    expect('theme' in config).toBe(false);
    expect(config.raw?.['theme']).toBe('dark');
    expect(config.raw?.['notifications']).toEqual({ claim_stale_after_ms: 15000 });
  });

  it('round-trips a custom registry source field on a provider', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'round-trip.toml');
    const toml = `
[providers.custom]
type = "openai"
base_url = "https://custom.example/v1"
api_key = "sk-test"
source = { kind = "apiJson", url = "https://registry.example/api.json", apiKey = "sk-registry" }
`;
    const config = parseConfigString(toml, configPath);
    expect(config.providers['custom']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'sk-test',
      source: { kind: 'apiJson', url: 'https://registry.example/api.json', apiKey: 'sk-registry' },
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    const roundTripped = parseConfigString(text, configPath);
    expect(roundTripped.providers['custom']?.source).toEqual({
      kind: 'apiJson',
      url: 'https://registry.example/api.json',
      apiKey: 'sk-registry',
    });
  });

  it('reads legacy connection keys but rewrites only canonical provider fields', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'legacy-provider-keys.toml');
    const toml = `
[providers.mixed]
type = "openai"
api_key = "canonical-fixture-secret"
apiKey = "legacy-shadowed-secret"
base_url = "https://canonical.invalid/v1"
baseUrl = "https://legacy-shadowed.invalid/v1"
source = { kind = "apiJson", url = "https://registry.invalid/api.json", apiKey = "registry-fixture-secret" }

[providers.legacy_only]
type = "anthropic"
apiKey = "legacy-only-fixture-secret"
baseUrl = "https://legacy-only.invalid/v1"

[services.wukong_search]
api_key = "canonical-service-secret"
apiKey = "legacy-shadowed-service-secret"
base_url = "https://canonical-service.invalid/v1"
baseUrl = "https://legacy-shadowed-service.invalid/v1"
`;

    const config = parseConfigString(toml, configPath);
    expect(config.providers['mixed']).toMatchObject({
      apiKey: 'canonical-fixture-secret',
      baseUrl: 'https://canonical.invalid/v1',
    });
    expect(config.providers['legacy_only']).toMatchObject({
      apiKey: 'legacy-only-fixture-secret',
      baseUrl: 'https://legacy-only.invalid/v1',
    });
    expect(config.services?.wukongSearch).toMatchObject({
      apiKey: 'canonical-service-secret',
      baseUrl: 'https://canonical-service.invalid/v1',
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    const roundTripped = readConfigFile(configPath);
    const rawProviders = roundTripped.raw?.['providers'] as Record<string, unknown>;
    const rawMixed = rawProviders['mixed'] as Record<string, unknown>;
    const rawLegacyOnly = rawProviders['legacy_only'] as Record<string, unknown>;
    const rawServices = roundTripped.raw?.['services'] as Record<string, unknown>;
    const rawSearch = rawServices['wukong_search'] as Record<string, unknown>;

    expect(rawMixed).not.toHaveProperty('apiKey');
    expect(rawMixed).not.toHaveProperty('baseUrl');
    expect(rawLegacyOnly).not.toHaveProperty('apiKey');
    expect(rawLegacyOnly).not.toHaveProperty('baseUrl');
    expect(rawSearch).not.toHaveProperty('apiKey');
    expect(rawSearch).not.toHaveProperty('baseUrl');
    expect(text).not.toContain('legacy-shadowed-secret');
    expect(text).not.toContain('legacy-shadowed-service-secret');
    expect(text).not.toContain('https://legacy-shadowed.invalid/v1');
    expect(text).not.toContain('https://legacy-shadowed-service.invalid/v1');
    expect(text).toContain('api_key = "legacy-only-fixture-secret"');
    expect(text).toContain('base_url = "https://legacy-only.invalid/v1"');
    expect(text).toContain('apiKey = "registry-fixture-secret"');

    expect(roundTripped.providers['mixed']?.apiKey).toBe('canonical-fixture-secret');
    expect(roundTripped.providers['legacy_only']?.apiKey).toBe('legacy-only-fixture-secret');
    expect(roundTripped.services?.wukongSearch?.apiKey).toBe('canonical-service-secret');
  });

  it('round-trips OAuth refs with scoped OAuth hosts', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'oauth-ref.toml');
    const toml = `
[providers."managed:wukong"]
type = "wukong"
base_url = "https://api.dev.example.test/coding/v1"
api_key = ""
oauth = { storage = "file", key = "oauth/wukong-env-1234", oauth_host = "https://auth.dev.example.test" }

[services.wukong_search]
base_url = "https://api.dev.example.test/coding/v1/search"
api_key = ""
oauth = { storage = "file", key = "oauth/wukong-env-1234", oauth_host = "https://auth.dev.example.test" }
`;
    const config = parseConfigString(toml, configPath);
    expect(config.providers['managed:wukong']?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/wukong-env-1234',
      oauthHost: 'https://auth.dev.example.test',
    });
    expect(config.services?.wukongSearch?.oauth?.oauthHost).toBe('https://auth.dev.example.test');

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('oauth_host = "https://auth.dev.example.test"');
    const roundTripped = parseConfigString(text, configPath);
    expect(roundTripped.providers['managed:wukong']?.oauth?.oauthHost).toBe(
      'https://auth.dev.example.test',
    );
  });

  it('parses and round-trips experimental feature flags', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'experimental.toml');
    const toml = `
[experimental]
micro_compaction = false
`;
    const config = parseConfigString(toml, configPath);

    expect(config.experimental).toEqual({
      'micro_compaction': false,
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');

    expect(text).toContain('[experimental]');
    expect(text).toContain('micro_compaction = false');
    expect(parseConfigString(text, configPath).experimental).toEqual(config.experimental);
  });

  it('accepts obsolete experimental feature keys as inert config', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'obsolete-experimental.toml');
    const toml = `
[experimental]
legacy_feature = true
obsolete_feature = false
removed_flag = true
`;

    const config = parseConfigString(toml, configPath);

    expect(config.experimental).toEqual({
      'legacy_feature': true,
      'obsolete_feature': false,
      'removed_flag': true,
    });

    await writeConfigFile(configPath, config);
    const text = await readFile(configPath, 'utf-8');
    expect(parseConfigString(text, configPath).experimental).toEqual(config.experimental);
  });

  it('loads defaults for absent files and writes typed fields without dropping raw sections', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');

    expect(readConfigFile(configPath)).toEqual({ providers: {} });

    const config = parseConfigString(COMPLETE_TOML, configPath);
    const loopControl = config.loopControl;
    expect(loopControl).toBeDefined();
    await writeConfigFile(configPath, {
      ...config,
      defaultModel: 'wukong/wukong-for-coding',
      loopControl: {
        ...loopControl!,
        maxStepsPerTurn: 7,
      },
    });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('default_model = "wukong/wukong-for-coding"');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text).toContain('extra_skill_dirs = [ "~/team-skills", ".agents/team-skills" ]');
    expect(text).toContain('telemetry = false');
    expect(text).not.toContain('default_yolo');
    expect(text).toContain('[[permission.rules]]');
    expect(text).toContain('pattern = "Bash(rm *)"');
    expect(text).toContain('pattern = "Read(src/**)"');
    expect(text).not.toContain('[[permission.allow]]');
    expect(text).toContain('max_steps_per_turn = 7');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('claim_stale_after_ms = 15000');
    expect(text).toContain('[[hooks]]');
    expect(text).toContain('event = "PreToolUse"');
    expect(text).toContain('command = "echo pre"');

    const reloaded = readConfigFile(configPath);
    expect(reloaded.loopControl?.maxStepsPerTurn).toBe(7);
    expect(reloaded.hooks?.[0]?.event).toBe('PreToolUse');
    expect(reloaded.raw?.['theme']).toBe('dark');
  });

  it('creates a parseable default config scaffold without changing runtime defaults', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');

    await ensureConfigFile(configPath);

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('Runtime settings for Wukong.');
    expect(text).not.toMatch(/^default_thinking =/m);
    expect(text).not.toMatch(/^default_model =/m);

    const config = readConfigFile(configPath);
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultThinking).toBeUndefined();
  });

  it('does not overwrite an existing config file', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');
    const existing = 'default_model = "custom"\n';
    await writeFile(configPath, existing, 'utf-8');

    await ensureConfigFile(configPath);

    await expect(readFile(configPath, 'utf-8')).resolves.toBe(existing);
  });

  it('drops deprecated default_yolo when rewriting config files', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.toml');
    const config = parseConfigString('default_yolo = true\n', configPath);

    expect(config.defaultPermissionMode).toBeUndefined();

    await writeConfigFile(configPath, config);

    const text = await readFile(configPath, 'utf-8');
    expect(text).not.toContain('default_yolo');
    expect(text).not.toContain('default_permission_mode');
  });

  it('rejects invalid TOML and invalid schema with WukongError(config.invalid)', () => {
    expectWukongErrorCode(
      () => parseConfigString('[[[', 'broken.toml'),
      ErrorCodes.CONFIG_INVALID,
    );
    expectWukongErrorCode(
      () =>
        parseConfigString(
          `
[providers.bad]
type = "not-a-provider"
`,
          'broken.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
    expectWukongErrorCode(
      () =>
        parseConfigString(
          `
[[permission.rules]]
decision = "deny"
pattern = "Bash(rm *"
`,
          'broken.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
  });

  it('parses hooks config from TOML arrays of tables', () => {
    const config = parseConfigString(
      `
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo hi"
timeout = 5
`,
      'hooks.toml',
    );

    expect(config.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Shell',
        command: 'echo hi',
        timeout: 5,
      },
    ]);
  });

  it('rejects invalid hooks config', () => {
    expectWukongErrorCode(
      () =>
        parseConfigString(
          `
hooks = [{ type = "pre-tool-call", command = "echo hi" }]
`,
          'hooks.toml',
        ),
      ErrorCodes.CONFIG_INVALID,
    );
  });
});

describe('harness config schema and patch merge', () => {
  it('accepts the empty public config and requires model context size in full configs', () => {
    expect(WukongConfigSchema.parse({})).toEqual({ providers: {} });
    expect(() =>
      validateConfig({
        providers: {
          local: { type: 'openai', apiKey: 'sk-test' },
        },
        models: {
          broken: { provider: 'local', model: 'gpt-test' },
        },
      }),
    ).toThrow(/max_context_size/);
  });

  it('deep-merges validated patches while preserving existing typed and raw data', () => {
    const base = parseConfigString(COMPLETE_TOML);
    const merged = mergeConfigPatch(base, {
      providers: {
        'managed:wukong': {
          apiKey: 'sk-patched',
          baseUrl: undefined,
        },
      },
      models: {
        'wukong/wukong-for-coding': {
          capabilities: ['tool_use'],
        },
      },
      thinking: {
        effort: 'high',
      },
    });

    expect(merged.providers['managed:wukong']).toMatchObject({
      type: 'wukong',
      baseUrl: 'https://api.wukong.today/coding/v1',
      apiKey: 'sk-patched',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });
    expect(merged.models?.['wukong/wukong-for-coding']).toMatchObject({
      provider: 'managed:wukong',
      model: 'wukong-for-coding',
      maxContextSize: 262144,
      capabilities: ['tool_use'],
    });
    expect(merged.thinking).toEqual({ mode: 'auto', effort: 'high' });
    expect(merged.hooks).toEqual(base.hooks);
    expect(merged.raw?.['theme']).toBe('dark');
  });

  it('deep-merges experimental config patches', () => {
    const base = parseConfigString(`
[experimental]
micro_compaction = false
`);

    const merged = mergeConfigPatch(base, {
      experimental: {
        'micro_compaction': true,
      },
    });

    expect(merged.experimental).toEqual({
      'micro_compaction': true,
    });
  });

  it('rejects unknown fields in config patches', () => {
    expectWukongErrorCode(
      () => mergeConfigPatch({ providers: {} }, { theme: 'dark' } as never),
      ErrorCodes.CONFIG_INVALID,
    );
  });

  it('replaces hooks arrays in config patches', () => {
    const base = parseConfigString(COMPLETE_TOML);
    const merged = mergeConfigPatch(base, {
      hooks: [{ event: 'Notification', matcher: 'task_completed', command: 'echo notified' }],
    });

    expect(merged.hooks).toEqual([
      { event: 'Notification', matcher: 'task_completed', command: 'echo notified' },
    ]);
  });

  it('accepts maxOutputSize on a model alias and round-trips it', () => {
    const parsed = WukongConfigSchema.parse({
      providers: { local: { type: 'anthropic', apiKey: 'sk-test' } },
      models: {
        opus: {
          provider: 'local',
          model: 'claude-opus-4-7',
          maxContextSize: 200000,
          maxOutputSize: 32000,
        },
      },
    });
    expect(parsed.models?.['opus']).toMatchObject({
      maxContextSize: 200000,
      maxOutputSize: 32000,
    });
  });

  it('leaves maxOutputSize undefined when omitted', () => {
    const parsed = WukongConfigSchema.parse({
      providers: { local: { type: 'anthropic', apiKey: 'sk-test' } },
      models: {
        opus: {
          provider: 'local',
          model: 'claude-opus-4-7',
          maxContextSize: 200000,
        },
      },
    });
    expect(parsed.models?.['opus']?.maxOutputSize).toBeUndefined();
  });

  it('rejects maxOutputSize <= 0', () => {
    expect(() =>
      WukongConfigSchema.parse({
        providers: { local: { type: 'anthropic', apiKey: 'sk-test' } },
        models: {
          opus: {
            provider: 'local',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
            maxOutputSize: 0,
          },
        },
      }),
    ).toThrow();
  });
});

describe('config path env override', () => {
  it('uses WUKONG_CODE_HOME when no explicit homeDir is supplied', () => {
    const saved = process.env['WUKONG_CODE_HOME'];
    const savedLegacy = process.env['WUKONG_HOME'];
    try {
      delete process.env['WUKONG_HOME'];
      process.env['WUKONG_CODE_HOME'] = '/tmp/wukong-from-env';

      expect(resolveWukongHome()).toBe('/tmp/wukong-from-env');
      expect(resolveWukongHome('/tmp/wukong-explicit')).toBe('/tmp/wukong-explicit');
      expect(resolveConfigPath({})).toBe('/tmp/wukong-from-env/config.toml');
      expect(resolveConfigPath({ configPath: '/tmp/custom.toml' })).toBe('/tmp/custom.toml');
    } finally {
      if (saved === undefined) delete process.env['WUKONG_CODE_HOME'];
      else process.env['WUKONG_CODE_HOME'] = saved;
      if (savedLegacy === undefined) delete process.env['WUKONG_HOME'];
      else process.env['WUKONG_HOME'] = savedLegacy;
    }
  });

  it('supports WUKONG_HOME as a deprecated isolation alias', () => {
    const saved = process.env['WUKONG_CODE_HOME'];
    const savedLegacy = process.env['WUKONG_HOME'];
    try {
      delete process.env['WUKONG_CODE_HOME'];
      process.env['WUKONG_HOME'] = '/tmp/wukong-from-legacy-env';

      expect(resolveWukongHome()).toBe('/tmp/wukong-from-legacy-env');
      expect(resolveConfigPath({})).toBe('/tmp/wukong-from-legacy-env/config.toml');
    } finally {
      if (saved === undefined) delete process.env['WUKONG_CODE_HOME'];
      else process.env['WUKONG_CODE_HOME'] = saved;
      if (savedLegacy === undefined) delete process.env['WUKONG_HOME'];
      else process.env['WUKONG_HOME'] = savedLegacy;
    }
  });

  it('fails closed when WUKONG_CODE_HOME and WUKONG_HOME conflict', () => {
    const saved = process.env['WUKONG_CODE_HOME'];
    const savedLegacy = process.env['WUKONG_HOME'];
    try {
      process.env['WUKONG_CODE_HOME'] = '/tmp/wukong-primary';
      process.env['WUKONG_HOME'] = '/tmp/wukong-legacy';

      expectWukongErrorCode(() => resolveWukongHome(), ErrorCodes.CONFIG_INVALID);
      expect(resolveWukongHome('/tmp/wukong-explicit')).toBe('/tmp/wukong-explicit');
    } finally {
      if (saved === undefined) delete process.env['WUKONG_CODE_HOME'];
      else process.env['WUKONG_CODE_HOME'] = saved;
      if (savedLegacy === undefined) delete process.env['WUKONG_HOME'];
      else process.env['WUKONG_HOME'] = savedLegacy;
    }
  });
});

describe('config value env override helpers', () => {
  it('parses boolean env values', () => {
    expect(parseBooleanEnv('1')).toBe(true);
    expect(parseBooleanEnv(' true ')).toBe(true);
    expect(parseBooleanEnv('yes')).toBe(true);
    expect(parseBooleanEnv('on')).toBe(true);
    expect(parseBooleanEnv('0')).toBe(false);
    expect(parseBooleanEnv(' false ')).toBe(false);
    expect(parseBooleanEnv('no')).toBe(false);
    expect(parseBooleanEnv('off')).toBe(false);
    expect(parseBooleanEnv('')).toBeUndefined();
    expect(parseBooleanEnv('maybe')).toBeUndefined();
  });

  it('resolves env before config before default', () => {
    expect(
      resolveConfigValue({
        env: { WUKONG_TEST_FLAG: '0' },
        envKey: 'WUKONG_TEST_FLAG',
        configValue: true,
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(false);

    expect(
      resolveConfigValue({
        env: {},
        envKey: 'WUKONG_TEST_FLAG',
        configValue: false,
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(false);

    expect(
      resolveConfigValue({
        env: {},
        envKey: 'WUKONG_TEST_FLAG',
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(true);
  });

  it('ignores invalid env values', () => {
    expect(
      resolveConfigValue({
        env: { WUKONG_TEST_FLAG: 'invalid' },
        envKey: 'WUKONG_TEST_FLAG',
        configValue: false,
        defaultValue: true,
        parseEnv: parseBooleanEnv,
      }),
    ).toBe(false);
  });
});

describe('loadRuntimeConfigSafe', () => {
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

  async function writeTempConfig(text: string): Promise<string> {
    const configPath = join(makeTempDir(), 'config.toml');
    await writeFile(configPath, text, 'utf-8');
    return configPath;
  }

  it('loads a valid file with no warnings, matching the strict loader', async () => {
    const configPath = await writeTempConfig(VALID_TOML);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.fileWarnings).toEqual([]);
    expect(result.envWarnings).toEqual([]);
    expect(result.config).toEqual(loadRuntimeConfig(configPath, {}));
  });

  it('returns defaults with no warnings when the file is missing', () => {
    const configPath = join(makeTempDir(), 'config.toml');
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.fileWarnings).toEqual([]);
    expect(result.envWarnings).toEqual([]);
    expect(result.config.providers).toEqual({});
  });

  it('reports a fileError and defaults on invalid TOML syntax', async () => {
    const configPath = await writeTempConfig('[[[');
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.providers).toEqual({});
    // The whole file is unusable: callers decide to fail startup (fileError)
    // or keep the last good config mid-run (fileWarnings).
    expect(result.fileError).toBeInstanceOf(WukongError);
    expect(result.fileError?.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(result.fileError?.message).toContain('Invalid TOML');
    expect(result.fileError?.message).toContain(configPath);
    expect(result.fileWarnings).toHaveLength(1);
    const warning = result.fileWarnings[0]!;
    expect(warning).toContain('Invalid TOML');
    // Single-line summary with the error location, not the multi-line code frame.
    expect(warning).not.toContain('\n');
    expect(warning).toContain('line 1');
  });

  it('does not set fileError when only sections are dropped', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.fileError).toBeUndefined();
    expect(result.fileWarnings).toHaveLength(1);
  });

  it('drops only an invalid section on schema errors and keeps the rest', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "not-a-number"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.loopControl).toBeUndefined();
    expect(result.config.providers['wukong']).toMatchObject({ type: 'wukong', apiKey: 'sk-good' });
    expect(result.config.models?.['k2']).toMatchObject({ maxContextSize: 128000 });
    expect(result.config.defaultModel).toBe('k2');
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('loop_control');
    // The original file content stays visible in raw so nothing is lost.
    expect(result.config.raw?.['loop_control']).toEqual({ max_steps_per_turn: 'not-a-number' });
  });

  it('drops only the broken provider entry, keeping other providers', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[providers.bad]
type = "not-a-provider"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.providers['bad']).toBeUndefined();
    expect(result.config.providers['wukong']).toMatchObject({ type: 'wukong' });
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('providers.bad');
  });

  it('keeps other providers when one entry has multiple validation issues', async () => {
    // Two issues on the same entry: the second must not escalate to
    // deleting the whole providers section after the first dropped the entry.
    const configPath = await writeTempConfig(`${VALID_TOML}
[providers.bad]
type = "not-a-provider"
api_key = 123
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.providers['bad']).toBeUndefined();
    expect(result.config.providers['wukong']).toMatchObject({ type: 'wukong' });
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('providers.bad');
    expect(result.fileWarnings[0]).not.toMatch(/providers[,.]? /);
  });

  it('drops only the broken model entry', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[models.broken]
provider = "wukong"
model = "x"
max_context_size = -5
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.models?.['broken']).toBeUndefined();
    expect(result.config.models?.['k2']).toBeDefined();
    expect(result.fileWarnings[0]).toContain('models.broken');
  });

  it('drops the whole hooks list when one hook is invalid', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[[hooks]]
event = "NotARealEvent"
command = "echo hi"
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.hooks).toBeUndefined();
    expect(result.config.providers['wukong']).toBeDefined();
    expect(result.fileWarnings[0]).toContain('hooks');
  });

  it('reports every dropped section in the warning', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"

[background]
max_running_tasks = 0
`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.loopControl).toBeUndefined();
    expect(result.config.background).toBeUndefined();
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('loop_control');
    expect(result.fileWarnings[0]).toContain('background');
  });

  it('applies WUKONG_MODEL_* env overrides on top of a salvaged config', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const result = loadRuntimeConfigSafe(configPath, {
      WUKONG_MODEL_NAME: 'env-model',
      WUKONG_MODEL_API_KEY: 'sk-env',
      WUKONG_MODEL_MAX_CONTEXT_SIZE: '262144',
    });
    expect(result.envWarnings).toEqual([]);
    expect(result.config.models?.['__wukong_env_model__']).toBeDefined();
    expect(result.config.providers['wukong']).toBeDefined();
    expect(result.fileWarnings).toHaveLength(1);
  });

  it('skips WUKONG_MODEL_* overrides with an env warning instead of throwing', async () => {
    const configPath = await writeTempConfig(VALID_TOML);
    const result = loadRuntimeConfigSafe(configPath, {
      WUKONG_MODEL_NAME: 'env-model',
    });
    expect(result.fileWarnings).toEqual([]);
    expect(result.envWarnings).toHaveLength(1);
    expect(result.envWarnings[0]).toContain('WUKONG_MODEL');
    expect(result.config).toEqual(readConfigFile(configPath));
  });

  it('readConfigFileForUpdate rewraps validation errors with an actionable message', async () => {
    const configPath = await writeTempConfig(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    try {
      readConfigFileForUpdate(configPath);
      throw new Error('expected readConfigFileForUpdate to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WukongError);
      expect((error as WukongError).message).toContain('fix it first');
      expect((error as WukongError).message).toContain('wukong doctor');
      expect((error as WukongError).message).not.toContain('invalid_type');
    }

    const goodPath = await writeTempConfig(VALID_TOML);
    expect(readConfigFileForUpdate(goodPath)).toEqual(readConfigFile(goodPath));
  });

  it('drops invalid top-level scalars and keeps the rest', async () => {
    const configPath = await writeTempConfig(`default_thinking = "not-a-boolean"
${VALID_TOML}`);
    const result = loadRuntimeConfigSafe(configPath, {});
    expect(result.config.defaultThinking).toBeUndefined();
    expect(result.config.providers['wukong']).toBeDefined();
    expect(result.fileWarnings).toHaveLength(1);
    expect(result.fileWarnings[0]).toContain('default_thinking');
  });
});
