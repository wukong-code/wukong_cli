import { createWukongHarness } from '@wukong/wukong-sdk';

import {
  formatManagedWukongLogoutMessage,
  logoutManagedWukongAccount,
} from '#/cli/lib/oauth-logout';
import { createWukongCodeHostIdentity } from '#/cli/version';

export async function runLogoutFlow(): Promise<never> {
  const harness = createWukongHarness({
    identity: createWukongCodeHostIdentity(),
    uiMode: 'cli',
  });
  let exitCode = 1;
  let message: string;
  try {
    const config = await harness.getConfig();
    const result = await logoutManagedWukongAccount(harness, { config });
    harness.track('logout', {
      provider: 'managed:wukong',
      remote_revocation: result.remote.kind,
    });
    message = `${formatManagedWukongLogoutMessage(result)}\n`;
    exitCode = 0;
  } catch (error) {
    message = `Logout failed: ${error instanceof Error ? error.message : String(error)}\n`;
  } finally {
    await harness.close().catch(() => {});
  }

  process.stderr.write(message);
  process.exit(exitCode);
}
