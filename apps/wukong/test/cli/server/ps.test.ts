import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLiveLock, type LockContents } from '@wukong/server';
import {
  formatAge,
  formatTable,
  handlePsCommand,
  truncate,
} from '#/cli/sub/server/ps';
import {
  authHeaders,
  isServerHealthy,
  resolveServerToken,
  serverOrigin,
} from '#/cli/sub/server/shared';
import { lockConnectHost } from '#/cli/sub/server/daemon';
import { getDataDir } from '#/utils/paths';

const fakeLock: LockContents = {
  pid: 1234,
  started_at: '2026-07-08T12:00:00.000Z',
  host: '127.0.0.1',
  port: 58627,
};

const mockServer = vi.hoisted(() => ({
  getLiveLock: vi.fn(() => undefined as LockContents | undefined),
}));

const mockShared = vi.hoisted(() => ({
  isServerHealthy: vi.fn(async () => true),
  resolveServerToken: vi.fn(() => 'server-token'),
  serverOrigin: vi.fn(() => 'http://127.0.0.1:58627'),
  authHeaders: vi.fn(() => ({ Authorization: 'Bearer server-token' })),
}));

const mockDaemon = vi.hoisted(() => ({
  lockConnectHost: vi.fn(() => '127.0.0.1'),
}));

const mockPaths = vi.hoisted(() => ({
  getDataDir: vi.fn(() => '/tmp/wukong'),
}));

vi.mock('@wukong/server', () => mockServer);
vi.mock('#/cli/sub/server/shared', () => mockShared);
vi.mock('#/cli/sub/server/daemon', () => mockDaemon);
vi.mock('#/utils/paths', () => mockPaths);

interface FakeConnection {
  id: string;
  connected_at: string;
  remote_address: string | null;
  user_agent: string | null;
  has_client_hello: boolean;
  subscriptions: string[];
}

function fakeConnection(overrides: Partial<FakeConnection> = {}): FakeConnection {
  return {
    id: 'conn-1',
    connected_at: new Date(Date.now() - 30_000).toISOString(),
    remote_address: '127.0.0.1',
    user_agent: 'wukong-test/1.0',
    has_client_hello: true,
    subscriptions: ['sess-1'],
    ...overrides,
  };
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  return {
    output: () => chunks.join(''),
    restore: () => {
      spy.mockRestore();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 0, msg: 'ok', data: { connections: [] } }),
    })),
  );
  mockServer.getLiveLock.mockReturnValue(fakeLock);
  mockShared.isServerHealthy.mockResolvedValue(true);
  mockShared.resolveServerToken.mockReturnValue('server-token');
  mockShared.serverOrigin.mockReturnValue('http://127.0.0.1:58627');
  mockShared.authHeaders.mockReturnValue({ Authorization: 'Bearer server-token' });
  mockDaemon.lockConnectHost.mockReturnValue('127.0.0.1');
  mockPaths.getDataDir.mockReturnValue('/tmp/wukong');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handlePsCommand', () => {
  it('throws when there is no live lock', async () => {
    mockServer.getLiveLock.mockReturnValue(undefined);
    await expect(handlePsCommand({})).rejects.toThrow(
      'No running Wukong server. Start one with `wukong server run` or `wukong web`.',
    );
  });

  it('throws when the server is not healthy', async () => {
    mockShared.isServerHealthy.mockResolvedValue(false);
    await expect(handlePsCommand({})).rejects.toThrow(
      'Wukong server at http://127.0.0.1:58627 is not responding.',
    );
  });

  it('prints a formatted table for active connections', async () => {
    const connection = fakeConnection();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        msg: 'ok',
        data: { connections: [connection] },
      }),
    } as Response);
    const { output, restore } = captureStdout();

    await handlePsCommand({});

    const text = stripAnsi(output());
    restore();
    expect(text).toContain('ID');
    expect(text).toContain('conn-1');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('wukong-test/1.0');
  });

  it('prints raw JSON when --json is passed', async () => {
    const connection = fakeConnection();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        msg: 'ok',
        data: { connections: [connection] },
      }),
    } as Response);
    const { output, restore } = captureStdout();

    await handlePsCommand({ json: true });

    const text = output();
    restore();
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 'conn-1' });
  });

  it('prints a friendly message when there are no connections', async () => {
    const { output, restore } = captureStdout();

    await handlePsCommand({});

    const text = output();
    restore();
    expect(text).toBe('No active clients.\n');
  });

  it('throws a timeout message when fetch is aborted', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(abortError);

    await expect(handlePsCommand({})).rejects.toThrow(
      'Timed out listing clients from http://127.0.0.1:58627.',
    );
  });

  it('passes the resolved token to fetch', async () => {
    const connection = fakeConnection();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        msg: 'ok',
        data: { connections: [connection] },
      }),
    } as Response);

    await handlePsCommand({});

    expect(mockShared.resolveServerToken).toHaveBeenCalledWith('/tmp/wukong');
    expect(mockShared.authHeaders).toHaveBeenCalledWith('server-token');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/api/v1/connections',
      expect.objectContaining({
        headers: { Authorization: 'Bearer server-token' },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe('formatTable', () => {
  it('renders a friendly message for an empty connection list', () => {
    expect(formatTable([])).toBe('No active clients.\n');
  });

  it('renders headers and rows aligned', () => {
    const table = formatTable([
      fakeConnection({
        id: 'conn-a',
        connected_at: new Date(Date.now() - 90_000).toISOString(),
        remote_address: '10.0.0.1',
        user_agent: 'agent/1',
        has_client_hello: false,
        subscriptions: ['s1', 's2'],
      }),
    ]);
    const text = stripAnsi(table);
    expect(text).toContain('ID');
    expect(text).toContain('conn-a');
    expect(text).toContain('1m');
    expect(text).toContain('10.0.0.1');
    expect(text).toContain('agent/1');
    expect(text).toContain('2');
    expect(text).toContain('no');
  });
});

describe('formatAge', () => {
  it('formats recent timestamps as seconds', () => {
    expect(formatAge(new Date(Date.now() - 30_000).toISOString())).toMatch(/^\d+s$/);
  });

  it('formats minutes, hours, and days', () => {
    expect(formatAge(new Date(Date.now() - 90_000).toISOString())).toBe('1m');
    expect(formatAge(new Date(Date.now() - 90 * 60 * 1000).toISOString())).toBe('1h');
    expect(formatAge(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())).toBe('1d');
  });

  it('returns dash for invalid or future timestamps', () => {
    expect(formatAge('not-a-date')).toBe('-');
    expect(formatAge(new Date(Date.now() + 60_000).toISOString())).toBe('-');
  });
});

describe('truncate', () => {
  it('returns short values unchanged', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates long values with an ellipsis', () => {
    const value = 'a'.repeat(50);
    expect(truncate(value, 5)).toBe('aaaa…');
  });

  it('handles max values of one or less', () => {
    expect(truncate('abc', 1)).toBe('a');
    expect(truncate('abc', 0)).toBe('');
  });
});
