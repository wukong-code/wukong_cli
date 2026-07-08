import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mockServer = vi.hoisted(() => ({
  rotateServerToken: vi.fn<() => Promise<string>>(),
  getLiveLock: vi.fn<() =>
    | { pid: number; started_at: string; port: number; host?: string }
    | undefined>(),
}));

const mockPaths = vi.hoisted(() => ({
  getDataDir: vi.fn<() => string>(),
}));

const mockAccessUrls = vi.hoisted(() => ({
  accessUrlLines: vi.fn<(
    host: string,
    port: number,
    token: string | undefined,
  ) => Array<{ label: string; url: string }>>(),
  splitTokenFragment: vi.fn<() => [string, string]>(),
}));

vi.mock('@wukong/server', () => mockServer);
vi.mock('#/utils/paths', () => mockPaths);
vi.mock('#/cli/sub/server/access-urls', () => mockAccessUrls);

async function runRotateToken(args: string[] = []): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const { registerRotateTokenCommand } = await import('#/cli/sub/server/rotate-token');
  const server = new Command('server').exitOverride();
  registerRotateTokenCommand(server);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    const code = exitSpy.mock.calls.at(-1)?.[0] ?? null;
    exitCode = typeof code === 'number' ? code : null;
    throw new Error(`process.exit(${String(code)})`);
  }) as typeof process.exit);

  try {
    await server.parseAsync(['node', 'wukong', 'rotate-token', ...args]);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('process.exit'))) throw error;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}

describe('registerRotateTokenCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaths.getDataDir.mockReturnValue('/home/wukong');
    mockServer.rotateServerToken.mockResolvedValue('fresh-token');
    mockServer.getLiveLock.mockReturnValue(undefined);
    mockAccessUrls.accessUrlLines.mockReturnValue([
      { label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=fresh-token' },
    ]);
    mockAccessUrls.splitTokenFragment.mockReturnValue([
      'http://127.0.0.1:58627/',
      '#token=fresh-token',
    ]);
  });

  it('rotates the token and prints it', async () => {
    const { stdout } = await runRotateToken();

    expect(mockServer.rotateServerToken).toHaveBeenCalledWith('/home/wukong');
    expect(stdout).toContain('New server token:');
    expect(stdout).toContain('fresh-token');
    expect(stdout).toContain('previous token is now invalid');
  });

  it('prints access URLs when a server is running', async () => {
    mockServer.getLiveLock.mockReturnValue({ pid: 1234, started_at: '', port: 58627 });
    const { stdout } = await runRotateToken();

    expect(mockAccessUrls.accessUrlLines).toHaveBeenCalledWith('127.0.0.1', 58627, 'fresh-token');
    expect(stdout).toContain('http://127.0.0.1:58627/#token=fresh-token');
  });

  it('uses the lock host when present', async () => {
    mockServer.getLiveLock.mockReturnValue({
      pid: 1234,
      started_at: '',
      port: 58627,
      host: '0.0.0.0',
    });
    await runRotateToken();

    expect(mockAccessUrls.accessUrlLines).toHaveBeenCalledWith('0.0.0.0', 58627, 'fresh-token');
  });

  it('does not print access URLs when no server is running', async () => {
    mockServer.getLiveLock.mockReturnValue(undefined);
    const { stdout } = await runRotateToken();

    expect(mockAccessUrls.accessUrlLines).not.toHaveBeenCalled();
    expect(stdout).not.toContain('http://');
  });

  it('exits 1 and prints the message when rotation fails', async () => {
    mockServer.rotateServerToken.mockRejectedValue(new Error('permission denied'));
    const { stderr, exitCode } = await runRotateToken();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('permission denied');
  });

  it('registers the rotate-token subcommand', async () => {
    const { registerRotateTokenCommand } = await import('#/cli/sub/server/rotate-token');
    const server = new Command('server');
    registerRotateTokenCommand(server);

    const names = server.commands.map((cmd) => cmd.name());
    expect(names).toContain('rotate-token');
  });
});
