import { describe, expect, it } from 'vitest';

import {
  accessUrlLines,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
  type AccessUrlLine,
} from '#/cli/sub/server/access-urls';

function urls(lines: AccessUrlLine[]): string[] {
  return lines.map((line) => line.url);
}

function labels(lines: AccessUrlLine[]): string[] {
  return lines.map((line) => line.label);
}

describe('buildOpenableUrl', () => {
  it('returns the bare origin with a trailing slash when no token is given', () => {
    expect(buildOpenableUrl('http://127.0.0.1:8080', undefined)).toBe('http://127.0.0.1:8080/');
    expect(buildOpenableUrl('http://127.0.0.1:8080/', undefined)).toBe('http://127.0.0.1:8080/');
  });

  it('appends the token as a URL fragment', () => {
    expect(buildOpenableUrl('http://127.0.0.1:8080', 'abc123')).toBe(
      'http://127.0.0.1:8080/#token=abc123',
    );
    expect(buildOpenableUrl('http://127.0.0.1:8080/', 'abc123')).toBe(
      'http://127.0.0.1:8080/#token=abc123',
    );
  });
});

describe('splitTokenFragment', () => {
  it('returns the full URL and an empty string when there is no token', () => {
    expect(splitTokenFragment('http://127.0.0.1:8080/')).toEqual([
      'http://127.0.0.1:8080/',
      '',
    ]);
  });

  it('splits at the #token= marker', () => {
    expect(splitTokenFragment('http://127.0.0.1:8080/#token=abc123')).toEqual([
      'http://127.0.0.1:8080/',
      '#token=abc123',
    ]);
  });
});

describe('isLoopbackHost', () => {
  it('returns true for loopback names', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('returns false for non-loopback names', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });
});

describe('accessUrlLines', () => {
  it('shows Local + Network addresses for a wildcard bind', () => {
    const lines = accessUrlLines('0.0.0.0', 8080, 'tok', [
      { address: '192.168.1.5', family: 'IPv4' },
      { address: '10.0.0.2', family: 'IPv4' },
    ]);
    expect(labels(lines)).toEqual(['Local:    ', 'Network:  ', 'Network:  ']);
    expect(urls(lines)).toEqual([
      'http://localhost:8080/#token=tok',
      'http://192.168.1.5:8080/#token=tok',
      'http://10.0.0.2:8080/#token=tok',
    ]);
  });

  it('lists network addresses from the machine when none are provided', () => {
    const lines = accessUrlLines('0.0.0.0', 8080, undefined);
    expect(labels(lines)[0]).toBe('Local:    ');
    expect(urls(lines)[0]).toBe('http://localhost:8080/');
    // The remaining lines come from the host interfaces, which vary by machine.
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('shows a single Local line for a loopback bind', () => {
    const lines = accessUrlLines('127.0.0.1', 8080, 'tok');
    expect(labels(lines)).toEqual(['Local:    ']);
    expect(urls(lines)).toEqual(['http://127.0.0.1:8080/#token=tok']);
  });

  it('shows a single URL line for a specific non-loopback host', () => {
    const lines = accessUrlLines('192.168.1.5', 8080, 'tok');
    expect(labels(lines)).toEqual(['URL:      ']);
    expect(urls(lines)).toEqual(['http://192.168.1.5:8080/#token=tok']);
  });

  it('brackets IPv6 addresses in URLs', () => {
    const lines = accessUrlLines('::', 8080, undefined, [{ address: '2001:db8::1', family: 'IPv6' }]);
    expect(urls(lines)).toContain('http://[2001:db8::1]:8080/');
  });
});
