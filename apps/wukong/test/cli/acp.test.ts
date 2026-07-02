/**
 * `wukong acp`
 *
 * Verifies that the ACP sub-command is registered on the program and
 * that the action wires the harness into `@wukong/acp-adapter`'s
 * `runAcpServer` (the real server is stubbed so the test doesn't
 * actually take over stdio).
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wukong/acp-adapter', () => ({
  ACP_BUILTIN_SLASH_COMMANDS: [],
  runAcpServer: vi.fn(async () => undefined),
}));

import { runAcpServer } from '@wukong/acp-adapter';

import { registerAcpCommand } from '#/cli/sub/acp';

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('wukong acp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runAcpServer).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('wukong');
    registerAcpCommand(program);

    const acp = program.commands.find((c) => c.name() === 'acp');
    expect(acp).toBeDefined();
    expect(acp?.description()).toMatch(/Agent Client Protocol/);
  });

  it('invokes runAcpServer with a constructed harness and exits 0 on success', async () => {
    const program = new Command('wukong').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'wukong', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).toHaveBeenCalledTimes(1);
    const harnessArg = vi.mocked(runAcpServer).mock.calls[0]?.[0];
    expect(harnessArg).toBeDefined();
    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1];
    expect(optsArg).toEqual(
      expect.objectContaining({
        agentInfo: { name: 'Wukong CLI', version: expect.any(String) },
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('forwards WUKONG_CODE_HOME to terminalAuthEnv when set', async () => {
    const previous = process.env['WUKONG_CODE_HOME'];
    process.env['WUKONG_CODE_HOME'] = '/tmp/wukong-debug';
    try {
      const program = new Command('wukong').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'wukong', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1];
      expect(optsArg).toEqual(
        expect.objectContaining({
          terminalAuthEnv: { WUKONG_CODE_HOME: '/tmp/wukong-debug' },
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env['WUKONG_CODE_HOME'];
      } else {
        process.env['WUKONG_CODE_HOME'] = previous;
      }
    }
  });

  it('omits terminalAuthEnv when WUKONG_CODE_HOME is unset', async () => {
    const previous = process.env['WUKONG_CODE_HOME'];
    delete process.env['WUKONG_CODE_HOME'];
    try {
      const program = new Command('wukong').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'wukong', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1] as {
        terminalAuthEnv?: unknown;
      };
      expect(optsArg.terminalAuthEnv).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env['WUKONG_CODE_HOME'] = previous;
      }
    }
  });

  it('forwards process.argv[1] as terminalAuthLegacyCommand', async () => {
    const program = new Command('wukong').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'wukong', 'acp'])).rejects.toThrow(ExitCalled);

    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1] as {
      terminalAuthLegacyCommand?: string;
    };
    // process.argv[1] points at the test runner entry — non-empty
    // absolute-ish path, exactly what we want forwarded.
    expect(typeof optsArg.terminalAuthLegacyCommand).toBe('string');
    expect((optsArg.terminalAuthLegacyCommand ?? '').length).toBeGreaterThan(0);
    expect(optsArg.terminalAuthLegacyCommand).toBe(process.argv[1]);
  });

  it('exits without starting the ACP server when --login is passed', async () => {
    // Stub the harness module so runLoginFlow doesn't hit a real OAuth
    // endpoint: harness.auth.login resolves immediately and triggers exit 0.
    // `importOriginal` preserves the other named exports (`ErrorCodes`, etc.)
    // that constant/app.ts depends on at module load.
    const loginStub = vi.fn(async () => ({ providerName: 'wukong' }));
    vi.doMock(import('@wukong/wukong-sdk'), async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createWukongHarness: () =>
          ({
            auth: { login: loginStub },
          }) as unknown as ReturnType<typeof actual.createWukongHarness>,
      };
    });
    vi.resetModules();
    const { registerAcpCommand: freshRegister } = await import('#/cli/sub/acp');
    try {
      const program = new Command('wukong').exitOverride();
      freshRegister(program);

      await expect(program.parseAsync(['node', 'wukong', 'acp', '--login'])).rejects.toThrow(
        ExitCalled,
      );

      expect(loginStub).toHaveBeenCalledTimes(1);
      expect(runAcpServer).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.doUnmock('@wukong/wukong-sdk');
      vi.resetModules();
    }
  });
});
