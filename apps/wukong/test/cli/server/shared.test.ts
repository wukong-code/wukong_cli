import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_IDLE_GRACE_MS,
  DEFAULT_LAN_HOST,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_ORIGIN,
  DEFAULT_SERVER_PORT,
  isServerHealthy,
  normalizeServerOrigin,
  parseAllowedHostArgs,
  parseHost,
  parseIdleGraceMs,
  parseLogLevel,
  parsePort,
  parseServerOptions,
  serverOrigin,
  waitForServerHealthy,
} from '#/cli/sub/server/shared';

describe('parseServerOptions', () => {
  it('returns defaults when no options are provided', () => {
    const parsed = parseServerOptions({});
    expect(parsed.host).toBe(DEFAULT_SERVER_HOST);
    expect(parsed.port).toBe(DEFAULT_SERVER_PORT);
    expect(parsed.logLevel).toBe(DEFAULT_FOREGROUND_LOG_LEVEL);
    expect(parsed.debugEndpoints).toBe(false);
    expect(parsed.insecureNoTls).toBe(true);
    expect(parsed.allowRemoteShutdown).toBe(false);
    expect(parsed.allowRemoteTerminals).toBe(false);
    expect(parsed.allowedHosts).toEqual([]);
    expect(parsed.daemon).toBe(false);
    expect(parsed.idleGraceMs).toBe(DEFAULT_IDLE_GRACE_MS);
  });

  it('applies explicit overrides', () => {
    const parsed = parseServerOptions({
      host: true,
      port: '8080',
      logLevel: 'debug',
      debugEndpoints: true,
      insecureNoTls: false,
      allowRemoteShutdown: true,
      allowRemoteTerminals: true,
      allowedHost: ['a,b', 'c'],
      daemon: true,
      idleGraceMs: '30000',
    });
    expect(parsed.host).toBe(DEFAULT_LAN_HOST);
    expect(parsed.port).toBe(8080);
    expect(parsed.logLevel).toBe('debug');
    expect(parsed.debugEndpoints).toBe(true);
    expect(parsed.insecureNoTls).toBe(false);
    expect(parsed.allowRemoteShutdown).toBe(true);
    expect(parsed.allowRemoteTerminals).toBe(true);
    expect(parsed.allowedHosts).toEqual(['a', 'b', 'c']);
    expect(parsed.daemon).toBe(true);
    expect(parsed.idleGraceMs).toBe(30_000);
  });
});

describe('parseHost', () => {
  it('returns the loopback default for undefined and false', () => {
    expect(parseHost(undefined)).toBe(DEFAULT_SERVER_HOST);
    expect(parseHost(false)).toBe(DEFAULT_SERVER_HOST);
  });

  it('returns the LAN default for true and empty string', () => {
    expect(parseHost(true)).toBe(DEFAULT_LAN_HOST);
    expect(parseHost('')).toBe(DEFAULT_LAN_HOST);
  });

  it('returns the explicit host value unchanged', () => {
    expect(parseHost('192.168.1.1')).toBe('192.168.1.1');
    expect(parseHost('example.com')).toBe('example.com');
  });
});

describe('parsePort', () => {
  it('returns the fallback when input is undefined', () => {
    expect(parsePort(undefined, '--port', DEFAULT_SERVER_PORT)).toBe(DEFAULT_SERVER_PORT);
  });

  it('parses valid port numbers', () => {
    expect(parsePort('0', '--port', DEFAULT_SERVER_PORT)).toBe(0);
    expect(parsePort('8080', '--port', DEFAULT_SERVER_PORT)).toBe(8080);
    expect(parsePort('65535', '--port', DEFAULT_SERVER_PORT)).toBe(65_535);
  });

  it('throws for invalid port values', () => {
    expect(() => parsePort('abc', '--port', DEFAULT_SERVER_PORT)).toThrow('--port');
    expect(() => parsePort('-1', '--port', DEFAULT_SERVER_PORT)).toThrow('--port');
    expect(() => parsePort('65536', '--port', DEFAULT_SERVER_PORT)).toThrow('--port');
  });
});

describe('parseLogLevel', () => {
  it('returns the default when input is undefined', () => {
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('accepts every valid log level', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const) {
      expect(parseLogLevel(level)).toBe(level);
    }
  });

  it('throws for invalid log levels', () => {
    expect(() => parseLogLevel('verbose')).toThrow('--log-level');
    expect(() => parseLogLevel('')).toThrow('--log-level');
  });
});

describe('parseAllowedHostArgs', () => {
  it('returns an empty array when input is undefined', () => {
    expect(parseAllowedHostArgs(undefined)).toEqual([]);
  });

  it('splits comma-separated values and trims whitespace', () => {
    expect(parseAllowedHostArgs(['a,b', ' c ', 'd, e'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters out empty entries', () => {
    expect(parseAllowedHostArgs(['', 'a,,b', '  '])).toEqual(['a', 'b']);
  });
});

describe('parseIdleGraceMs', () => {
  it('returns the default when input is undefined', () => {
    expect(parseIdleGraceMs(undefined)).toBe(DEFAULT_IDLE_GRACE_MS);
  });

  it('parses a positive integer', () => {
    expect(parseIdleGraceMs('1000')).toBe(1000);
    expect(parseIdleGraceMs('0')).toBe(0);
  });

  it('throws for invalid or negative values', () => {
    expect(() => parseIdleGraceMs('abc')).toThrow('--idle-grace-ms');
    expect(() => parseIdleGraceMs('-1')).toThrow('--idle-grace-ms');
  });
});

describe('normalizeServerOrigin', () => {
  it('strips trailing slashes', () => {
    expect(normalizeServerOrigin('http://localhost:8080/')).toBe('http://localhost:8080');
  });

  it('strips /api/v1 suffixes with and without trailing slash', () => {
    expect(normalizeServerOrigin('http://localhost:8080/api/v1')).toBe('http://localhost:8080');
    expect(normalizeServerOrigin('http://localhost:8080/api/v1/')).toBe('http://localhost:8080');
  });

  it('drops query strings and hashes', () => {
    expect(normalizeServerOrigin('http://localhost:8080/?x=1#frag')).toBe('http://localhost:8080');
  });
});

describe('serverOrigin', () => {
  it('builds an http origin from host and port', () => {
    expect(serverOrigin('127.0.0.1', 58627)).toBe('http://127.0.0.1:58627');
    expect(serverOrigin(DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT)).toBe(DEFAULT_SERVER_ORIGIN);
  });
});

describe('isServerHealthy', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: 0 }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when healthz reports code 0', async () => {
    const result = await isServerHealthy('http://localhost:8080', 1000);
    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/healthz',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns false when response is not ok', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ code: 0 }),
    } as Response);
    expect(await isServerHealthy('http://localhost:8080', 1000)).toBe(false);
  });

  it('returns false when the response code is non-zero', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 1 }),
    } as Response);
    expect(await isServerHealthy('http://localhost:8080', 1000)).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network error'));
    expect(await isServerHealthy('http://localhost:8080', 1000)).toBe(false);
  });

  it('returns false when the request times out', async () => {
    vi.useRealTimers();
    vi.mocked(globalThis.fetch).mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('timeout'));
          }, 5000);
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }
        }),
    );
    const result = await isServerHealthy('http://localhost:8080', 100);
    expect(result).toBe(false);
  });
});

describe('waitForServerHealthy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: 0 }),
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns true once a probe succeeds', async () => {
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockRejectedValueOnce(new Error('unreachable'));

    const resultPromise = waitForServerHealthy('http://localhost:8080', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await resultPromise).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('returns false when the deadline expires without success', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('unreachable'));

    const resultPromise = waitForServerHealthy('http://localhost:8080', 500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await resultPromise).toBe(false);
  });
});
