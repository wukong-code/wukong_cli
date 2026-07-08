import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerLoginCommand } from '#/cli/sub/login';

const mocks = vi.hoisted(() => ({
  runLoginFlow: vi.fn(),
}));

vi.mock('#/cli/sub/login-flow', () => ({
  runLoginFlow: mocks.runLoginFlow,
}));

describe('registerLoginCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers a visible login subcommand with the device-code description', () => {
    const parent = new Command();
    registerLoginCommand(parent);

    const login = parent.commands.find((command) => command.name() === 'login');
    expect(login).toBeDefined();
    expect(login?.description()).toMatch(/device-code/);
  });

  it('invokes runLoginFlow when the login command is parsed', async () => {
    const parent = new Command();
    parent.exitOverride();
    parent.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerLoginCommand(parent);

    mocks.runLoginFlow.mockResolvedValue(undefined);

    parent.parse(['node', 'wukong', 'login']);

    expect(mocks.runLoginFlow).toHaveBeenCalledTimes(1);
  });

  it('does not invoke runLoginFlow for other commands', () => {
    const parent = new Command();
    parent.exitOverride();
    parent.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerLoginCommand(parent);

    parent.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

    expect(() => parent.parse(['node', 'wukong', 'logout'])).toThrow();
    expect(mocks.runLoginFlow).not.toHaveBeenCalled();
  });
});
