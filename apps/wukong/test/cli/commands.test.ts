import { describe, expect, it, vi } from 'vitest';

import { createProgram } from '#/cli/commands';
import type { CLIOptions } from '#/cli/options';

function swallowOutput(program: ReturnType<typeof createProgram>): void {
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
}

describe('createProgram', () => {
  it('returns a Command named wukong with the expected metadata', () => {
    const program = createProgram('1.2.3', () => {}, () => {});

    expect(program.name()).toBe('wukong');
    expect(program.description()).toMatch(/Wukong Code/);
    expect(program.version()).toBe('1.2.3');
  });

  it('shows canonical session, permission, and headless options', () => {
    const program = createProgram('1.2.3', () => {}, () => {});
    const help = program.helpInformation();

    expect(help).toContain('-r, --resume [id]');
    expect(help).not.toContain('-S, --session [id]');
    expect(help).toContain('Auto-approve ordinary actions');
    expect(help).toContain('Run one headless turn in guarded Auto mode');
    expect(help).toContain('--yes');
    expect(help).toContain('Grant this session access');
    expect(help).not.toContain('roles [command]');
  });

  it('keeps legacy session flags available without advertising them', () => {
    let captured: CLIOptions | undefined;
    const program = createProgram(
      '0.0.0',
      (opts) => {
        captured = opts;
      },
      () => {},
    );
    swallowOutput(program);

    program.parse(['node', 'wukong', '--session', 'legacy-session']);

    expect(captured?.session).toBe('legacy-session');
  });

  it('describes judge as a deterministic local gate and hides its legacy no-op flag', () => {
    const program = createProgram('1.2.3', () => {}, () => {});
    const judge = program.commands.find((command) => command.name() === 'judge');

    expect(judge).toBeDefined();
    const help = judge!.helpInformation();
    expect(help).toContain("passes Wukong's local merge gate");
    expect(help).toMatch(/no model\s+calls/u);
    expect(help).not.toContain('--assume-broken');
    expect(help).not.toContain('P0.5');
    expect(judge!.options.find((option) => option.long === '--assume-broken')?.hidden).toBe(true);
  });

  it('errors when an unknown command is supplied', () => {
    const program = createProgram('0.0.0', () => {}, () => {});
    swallowOutput(program);

    expect(() => program.parse(['node', 'wukong', 'nope'])).toThrow(/unknown command 'nope'/);
  });

  it('invokes the main action for bare invocation and passes parsed options', () => {
    let captured: CLIOptions | undefined;
    const program = createProgram(
      '0.0.0',
      (opts) => {
        captured = opts;
      },
      () => {},
    );
    swallowOutput(program);

    program.parse(['node', 'wukong', '--yolo', '--model', 'wukong/k2']);

    expect(captured).toEqual(
      expect.objectContaining({
        yolo: true,
        model: 'wukong/k2',
        session: undefined,
        continue: false,
      }),
    );
  });

  it('routes the migrate subcommand to onMigrate without invoking the main action', () => {
    let migrateCalled = false;
    const program = createProgram(
      '0.0.0',
      () => {
        throw new Error('main action should not run');
      },
      () => {
        migrateCalled = true;
      },
    );
    swallowOutput(program);

    program.parse(['node', 'wukong', 'migrate']);

    expect(migrateCalled).toBe(true);
  });

  it('routes upgrade to onUpgrade', () => {
    let upgradeCalls = 0;
    const program = createProgram(
      '0.0.0',
      () => {
        throw new Error('main action should not run');
      },
      () => {},
      () => {},
      () => {
        upgradeCalls += 1;
      },
    );
    swallowOutput(program);

    program.parse(['node', 'wukong', 'upgrade']);

    expect(upgradeCalls).toBe(1);
  });

  it('routes the update alias to onUpgrade', () => {
    let upgradeCalls = 0;
    const program = createProgram(
      '0.0.0',
      () => {
        throw new Error('main action should not run');
      },
      () => {},
      () => {},
      () => {
        upgradeCalls += 1;
      },
    );
    swallowOutput(program);

    program.parse(['node', 'wukong', 'update']);

    expect(upgradeCalls).toBe(1);
  });

  it('routes the hidden __plugin_run_node subcommand to the plugin runner', () => {
    const pluginCalls: Array<{ entry: string; args: readonly string[] }> = [];
    const program = createProgram(
      '0.0.0',
      () => {
        throw new Error('main action should not run');
      },
      () => {},
      (entry, args) => {
        pluginCalls.push({ entry, args });
      },
    );
    swallowOutput(program);

    program.parse([
      'node',
      'wukong',
      '__plugin_run_node',
      '/plugin/tool.mjs',
      '--',
      'query',
      '--flag',
    ]);

    expect(pluginCalls).toEqual([
      { entry: '/plugin/tool.mjs', args: ['query', '--flag'] },
    ]);
  });
});
