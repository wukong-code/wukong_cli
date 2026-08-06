import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  getConfig: vi.fn(),
  logoutManaged: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@wukong/wukong-sdk', () => ({
  createWukongHarness: vi.fn(() => ({
    close: mocks.close,
    getConfig: mocks.getConfig,
    track: mocks.track,
  })),
}));

vi.mock('#/cli/lib/oauth-logout', async () => {
  const actual = await vi.importActual<typeof import('#/cli/lib/oauth-logout')>(
    '#/cli/lib/oauth-logout',
  );
  return {
    ...actual,
    logoutManagedWukongAccount: mocks.logoutManaged,
  };
});

vi.mock('#/cli/version', () => ({
  createWukongCodeHostIdentity: vi.fn(() => ({ name: 'wukong-test' })),
}));

import { runLogoutFlow } from '#/cli/sub/logout-flow';

describe('runLogoutFlow', () => {
  let stderrChunks: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    stderrChunks = [];
    exitCode = undefined;
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.getConfig.mockReset().mockResolvedValue({ providers: {} });
    mocks.logoutManaged.mockReset();
    mocks.track.mockReset();
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports confirmed remote revocation and exits successfully', async () => {
    mocks.logoutManaged.mockResolvedValue({
      hadLocalAccount: true,
      remote: { kind: 'confirmed' },
    });

    await runLogoutFlow();

    expect(exitCode).toBe(0);
    expect(stderrChunks.join('')).toContain('Remote session revoked and local credentials removed');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('warns that the server session may remain active when revocation is unknown', async () => {
    mocks.logoutManaged.mockResolvedValue({
      hadLocalAccount: true,
      remote: { kind: 'unknown', reason: 'server_error', status: 503 },
    });

    await runLogoutFlow();

    expect(exitCode).toBe(0);
    expect(stderrChunks.join('')).toMatch(
      /remote revocation was not confirmed.*server session may still be active/u,
    );
    expect(mocks.track).toHaveBeenCalledWith('logout', {
      provider: 'managed:wukong',
      remote_revocation: 'unknown',
    });
  });

  it('exits with an error when local cleanup cannot finish', async () => {
    mocks.logoutManaged.mockRejectedValue(new Error('config is read-only'));

    await runLogoutFlow();

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('Logout failed: config is read-only');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
