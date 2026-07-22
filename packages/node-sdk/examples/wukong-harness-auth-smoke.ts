import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWukongHarness } from '@wukong/wukong-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

const MANAGED_WUKONG_CODE_PROVIDER = 'managed:wukong';

async function main(): Promise<void> {
  const explicitHomeDir = process.env['WUKONG_SDK_AUTH_SMOKE_HOME'];
  const homeDir = explicitHomeDir ?? (await mkdtemp(join(tmpdir(), 'wukong-sdk-auth-smoke-home-')));
  const keepToken = shouldKeepToken(explicitHomeDir !== undefined);
  const forceLogin = process.env['WUKONG_SDK_AUTH_SMOKE_FORCE_LOGIN'] === '1';
  const harness = createWukongHarness({ homeDir, identity: smokeIdentityFromEnv() });

  process.stdout.write(`home: ${homeDir}\n`);

  try {
    if (forceLogin) {
      await harness.auth.logout(MANAGED_WUKONG_CODE_PROVIDER);
      process.stdout.write('cleared existing smoke token\n');
    }

    const login = await harness.auth.login(undefined, { onDeviceCode: printDeviceCode });
    const config = await harness.getConfig({ reload: true });
    const status = await harness.auth.status(MANAGED_WUKONG_CODE_PROVIDER);

    if (status.providers[0]?.hasToken !== true) {
      throw new Error('status did not report a stored token after login');
    }
    if (config.providers[MANAGED_WUKONG_CODE_PROVIDER] !== undefined) {
      throw new Error('account login unexpectedly provisioned a managed model provider');
    }

    process.stdout.write(`provider: ${login.providerName}\n`);
    process.stdout.write('account-only auth smoke passed; configure models separately with /provider\n');
  } finally {
    if (!keepToken) {
      await harness.auth.logout(MANAGED_WUKONG_CODE_PROVIDER).catch(() => {});
    }
    await harness.close();
    if (explicitHomeDir === undefined && !keepToken) {
      await rm(homeDir, { recursive: true, force: true });
    }
  }
}

function printDeviceCode(auth: {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number | null;
}): void {
  process.stdout.write(
    [
      'Complete Wukong OAuth device login:',
      `  URL: ${auth.verificationUriComplete || auth.verificationUri}`,
      `  Code: ${auth.userCode}`,
      auth.expiresIn === null ? undefined : `  Expires in: ${String(auth.expiresIn)}s`,
      '',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
  );
}

function shouldKeepToken(hasExplicitHomeDir: boolean): boolean {
  const value = process.env['WUKONG_SDK_AUTH_SMOKE_KEEP_TOKEN'];
  if (value !== undefined) return value === '1' || value === 'true';
  return hasExplicitHomeDir;
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
