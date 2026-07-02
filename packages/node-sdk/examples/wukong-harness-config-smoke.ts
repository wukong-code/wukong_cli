import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWukongHarness } from '@wukong/wukong-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'wukong-harness-config-home-'));
  const harness = createWukongHarness({ homeDir, identity: smokeIdentityFromEnv() });

  const initial = await harness.getConfig();
  if (Object.keys(initial.providers).length > 0) {
    throw new Error('expected empty providers for a fresh config home');
  }

  await harness.setConfig({
    defaultModel: 'wukong/wukong-for-coding',
    defaultThinking: true,
    defaultPermissionMode: 'manual',
    defaultPlanMode: false,
    providers: {
      'managed:wukong': {
        type: 'wukong',
        baseUrl: 'https://api.wukong.today/coding/v1',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/wukong' },
      },
    },
    models: {
      'wukong/wukong-for-coding': {
        provider: 'managed:wukong',
        model: 'wukong-for-coding',
        maxContextSize: 262144,
        capabilities: ['image_in', 'thinking', 'video_in'],
        displayName: 'Wukong for Coding',
      },
    },
    loopControl: {
      maxRetriesPerStep: 3,
      maxRalphIterations: 0,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
    },
    services: {
      wukongSearch: {
        baseUrl: 'https://api.wukong.today/coding/v1/search',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/wukong' },
      },
      wukongFetch: {
        baseUrl: 'https://api.wukong.today/coding/v1/fetch',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/wukong' },
      },
    },
  });

  const configPath = join(homeDir, 'config.toml');
  const text = await readFile(configPath, 'utf-8');
  for (const expected of [
    'default_model = "wukong/wukong-for-coding"',
    'default_permission_mode = "manual"',
    '[providers."managed:wukong"]',
    '[providers."managed:wukong".oauth]',
    '[models."wukong/wukong-for-coding"]',
    '[services.wukong_search]',
  ]) {
    if (!text.includes(expected)) {
      throw new Error(`missing ${expected} in written config`);
    }
  }

  const reloaded = await harness.getConfig({ reload: true });
  if (reloaded.defaultModel !== 'wukong/wukong-for-coding') {
    throw new Error('reloaded config did not preserve defaultModel');
  }
  if (reloaded.providers['managed:wukong']?.oauth?.key !== 'oauth/wukong') {
    throw new Error('reloaded config did not preserve provider oauth');
  }

  process.stdout.write(`config: ${configPath}\n`);
  process.stdout.write('ok\n');
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
