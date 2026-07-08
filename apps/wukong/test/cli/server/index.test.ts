import { describe, expect, it } from 'vitest';
import { Command } from 'commander';

import { registerServerCommand } from '#/cli/sub/server';

describe('registerServerCommand', () => {
  it('registers the `server` parent and its expected subcommands', () => {
    const program = new Command('wukong');
    registerServerCommand(program);

    const server = program.commands.find((cmd) => cmd.name() === 'server');
    expect(server).toBeDefined();

    const subNames = server!.commands.map((cmd) => cmd.name()).toSorted();
    expect(subNames).toEqual(['kill', 'ps', 'rotate-token', 'run']);
  });

  it('registers the top-level `web` alias', () => {
    const program = new Command('wukong');
    registerServerCommand(program);

    const web = program.commands.find((cmd) => cmd.name() === 'web');
    expect(web).toBeDefined();
  });

  it('exports registerWebAliasCommand', async () => {
    const mod = await import('#/cli/sub/server');
    expect(mod.registerWebAliasCommand).toBeTypeOf('function');
  });
});
