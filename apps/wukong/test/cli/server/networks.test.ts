import { describe, it, expect } from 'vitest';

import {
  filterDisplayAddresses,
  formatHostForUrl,
  type NetworkAddress,
} from '#/cli/sub/server/networks';

describe('filterDisplayAddresses', () => {
  it('keeps non-internal IPv4 and IPv6 addresses', () => {
    const addrs: NetworkAddress[] = [
      { address: '192.168.1.10', family: 'IPv4' },
      { address: '10.0.0.5', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
      { address: 'fe80::1', family: 'IPv6' },
    ];

    const result = filterDisplayAddresses(addrs);
    expect(result).toEqual([
      { address: '192.168.1.10', family: 'IPv4' },
      { address: '10.0.0.5', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
  });

  it('deduplicates addresses and preserves IPv4 before IPv6', () => {
    const addrs: NetworkAddress[] = [
      { address: '192.168.1.10', family: 'IPv4' },
      { address: '192.168.1.10', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
      { address: '2001:db8::1', family: 'IPv6' },
    ];

    const result = filterDisplayAddresses(addrs);
    expect(result).toEqual([
      { address: '192.168.1.10', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
  });
});

describe('formatHostForUrl', () => {
  it('returns IPv4 addresses unchanged', () => {
    expect(formatHostForUrl('192.168.1.10', 'IPv4')).toBe('192.168.1.10');
  });

  it('bracket-wraps IPv6 addresses', () => {
    expect(formatHostForUrl('2001:db8::1', 'IPv6')).toBe('[2001:db8::1]');
  });
});
