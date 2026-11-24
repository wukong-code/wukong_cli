import { describe, expect, it, vi } from 'vitest';

import {
  CLI_CORE_COMMANDS,
  createProgram,
  formatAllCommandsHelp,
} from '#/cli/commands';
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

  it('focuses default help on core commands while keeping login/logout executable via help --all', async () => {
    const program = createProgram('1.2.3', () => {}, () => {});
    const commandNames = program.commands.map((command) => command.name());
    const out: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeOut: (chunk) => out.push(chunk),
      writeErr: () => {},
    });
    program.outputHelp();
    const help = out.join('');
    const allHelp = formatAllCommandsHelp(program);

    expect(commandNames).toContain('login');
    expect(commandNames).toContain('logout');
    for (const coreName of CLI_CORE_COMMANDS) {
      expect(help).toMatch(new RegExp(`^\\s+${coreName}\\b`, 'mu'));
    }
    expect(help).toContain('wukong help --all');
    expect(help).not.toMatch(/^\s+logout\s+/mu);
    expect(help).not.toMatch(/^\s+login\s+/mu);
    expect(allHelp).toContain('Advanced Commands:');
    expect(allHelp).toContain('Diagnostics & Compatibility:');
    expect(allHelp).toMatch(/^\s+logout\s+Revoke the Wukong account session/mu);
    expect(allHelp).toMatch(/^\s+verify\b/mu);

    out.length = 0;
    await program.parseAsync(['node', 'wukong', 'help', '--all']);
    expect(out.join('')).toContain('Advanced Commands:');

    out.length = 0;
    await program.parseAsync(['node', 'wukong', 'help', 'logout']);
    expect(out.join('')).toContain('Revoke the Wukong account session');
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
