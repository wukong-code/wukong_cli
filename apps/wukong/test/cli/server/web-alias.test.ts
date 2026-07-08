import { describe, expect, it } from 'vitest';
import { Command } from 'commander';

import { registerWebAliasCommand } from '#/cli/sub/server/web-alias';

describe('registerWebAliasCommand', () => {
  it('registers a top-level `web` command', () => {
    const program = new Command('wukong');
    registerWebAliasCommand(program);

    const web = program.commands.find((cmd) => cmd.name() === 'web');
    expect(web).toBeDefined();
  });

  it('defaults to opening the browser', () => {
    const program = new Command('wukong');
    registerWebAliasCommand(program);

    const web = program.commands.find((cmd) => cmd.name() === 'web')!;
    const longs = web.options.map((option) => option.long).filter(Boolean);
    expect(longs).toContain('--no-open');
  });

  it('exposes the same server-run options', () => {
    const program = new Command('wukong');
    registerWebAliasCommand(program);

    const web = program.commands.find((cmd) => cmd.name() === 'web')!;
    const longs = web.options.map((option) => option.long).filter(Boolean);
    expect(longs).toContain('--host');
    expect(longs).toContain('--port');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--foreground');
  });
});
