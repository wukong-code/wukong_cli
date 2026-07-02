

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const daemonSrc = resolve(here, '..', 'src');

describe('packages/server/src anti-corruption', () => {
  it('has zero @wukong/wukong-sdk / WukongHarness / createRPC / SDKRpcClient references', () => {

    const out = execSync(
      `grep -rE "@wukong/wukong-sdk|WukongHarness\\b|createRPC\\b|SDKRpcClient\\b" "${daemonSrc}" || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('');
  });

  it('imports shared filesystem, file store, logger, and workspace services from @wukong/agent-core', () => {
    const out = execSync(
      `grep -rE '["'"'"']#/services/(fileStore|fs|logger|workspace)(/|["'"'"'])' "${daemonSrc}" || true`,
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('');
  });
});
