/**
 * Shared device-code login flow used by both `wukong login` (top-level
 * subcommand) and `wukong acp --login` (the first-class ACP terminal-auth
 * entry point). Exiting the process is part of the contract — callers
 * MUST treat the returned promise as `Promise<never>`.
 */

import { createWukongHarness } from '@wukong/wukong-sdk';

import { createWukongCodeHostIdentity } from '#/cli/version';
import { openUrl } from '#/utils/open-url';

function loginFailureReason(error: unknown): 'expired' | 'denied' | 'network' | 'unknown' {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('expired')) return 'expired';
  if (message.includes('denied') || message.includes('declined')) return 'denied';
  if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) return 'network';
  return 'unknown';
}

export async function runLoginFlow(): Promise<never> {
  const identity = createWukongCodeHostIdentity();
  const harness = createWukongHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  harness.track('device_login_started');
  try {
    const result = await harness.auth.login(undefined, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
        process.stderr.write(
          [
            '',
            `Opening browser for Wukong device login: ${url}`,
            `If the browser did not open, paste the URL above and enter code: ${data.userCode}`,
            data.expiresIn !== null && data.expiresIn !== undefined
              ? `Code expires in ${data.expiresIn}s.`
              : undefined,
            'Waiting for authorization to complete...',
            '',
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        );
        try {
          openUrl(url);
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    harness.track('device_login_terminal', { outcome: 'approved' });
    process.stderr.write(`Logged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      harness.track('device_login_terminal', { outcome: 'cancelled', reason_code: 'user_cancelled' });
      process.stderr.write('Login cancelled.\n');
    } else {
      harness.track('device_login_terminal', {
        outcome: 'error',
        reason_code: loginFailureReason(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}
