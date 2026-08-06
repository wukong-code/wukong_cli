import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerLogoutCommand } from '#/cli/sub/logout';

const mocks = vi.hoisted(() => ({
  runLogoutFlow: vi.fn(),
}));

vi.mock('#/cli/sub/logout-flow', () => ({
  runLogoutFlow: mocks.runLogoutFlow,
}));

describe('registerLogoutCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers a visible logout subcommand that explains remote and local cleanup', () => {
    const parent = new Command();
    registerLogoutCommand(parent);

    const logout = parent.commands.find((command) => command.name() === 'logout');
    expect(logout).toBeDefined();
    expect(logout?.description()).toMatch(/Revoke.*remove local credentials/u);
  });

  it('invokes runLogoutFlow when the logout command is parsed', async () => {
    const parent = new Command();
    parent.exitOverride();
    parent.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerLogoutCommand(parent);
    mocks.runLogoutFlow.mockResolvedValue(undefined);

    await parent.parseAsync(['node', 'wukong', 'logout']);

    expect(mocks.runLogoutFlow).toHaveBeenCalledTimes(1);
  });
});
