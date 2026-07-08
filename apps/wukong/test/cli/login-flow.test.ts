import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runLoginFlow } from '#/cli/sub/login-flow';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('@wukong/wukong-sdk', () => ({
  createWukongHarness: vi.fn(() => ({
    auth: {
      login: mocks.login,
    },
  })),
}));

vi.mock('#/cli/version', () => ({
  createWukongCodeHostIdentity: vi.fn(() => ({ name: 'wukong-test' })),
}));

vi.mock('#/utils/open-url', () => ({
  openUrl: mocks.openUrl,
}));

describe('runLoginFlow', () => {
  let sigintHandler: (() => void) | undefined;
  let stderrChunks: string[] = [];
  let exitCode: number | undefined;

  beforeEach(() => {
    stderrChunks = [];
    exitCode = undefined;
    sigintHandler = undefined;
    mocks.login.mockReset();
    mocks.openUrl.mockReset();
    vi.spyOn(process, 'once').mockImplementation((event: string | symbol, listener: (...args: any[]) => void) => {
      if (event === 'SIGINT') {
        sigintHandler = listener as () => void;
      }
      return process;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode ??= code;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 after successful login', async () => {
    mocks.login.mockResolvedValue({ providerName: 'wukong' });

    await runLoginFlow();
    expect(exitCode).toBe(0);
    expect(stderrChunks.join('')).toContain('Logged in to wukong');
  });

  it('exits 1 and prints cancellation message when aborted', async () => {
    mocks.login.mockImplementation(async (_provider: unknown, options: { signal?: AbortSignal }) => {
      // Simulate the user pressing Ctrl-C while waiting for authorization.
      sigintHandler?.();
      if (options?.signal?.aborted) {
        throw new Error('aborted');
      }
      return { providerName: 'wukong' };
    });

    await runLoginFlow();
    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Login cancelled');
  });

  it('exits 1 and prints error message on login failure', async () => {
    mocks.login.mockRejectedValue(new Error('network error'));

    await runLoginFlow();
    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Login failed: network error');
  });
});
