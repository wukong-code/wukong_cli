import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createTrustedExecutableIdentity,
  digestCandidateBootstrapArgv,
  digestCandidateBootstrapEnvironment,
  validateTrustedExecutableIdentity,
} from '../src';

function digest(label: string): string {
  return canonicalDigest('wukong/test/trusted-executable/v1', label);
}

describe('trusted executable and private input digests', () => {
  it('seals a canonical executable identity', () => {
    const identity = createTrustedExecutableIdentity({
      platform: 'linux',
      architecture: 'x64',
      realPathDigest: digest('path'),
      device: '1',
      inode: '2',
      sizeBytes: 128,
      mode: 0o100755,
      contentDigest: digest('content'),
      runtimeVersionDigest: digest('version'),
    });

    expect(validateTrustedExecutableIdentity(identity)).toBe(true);
    expect(validateTrustedExecutableIdentity({
      ...identity,
      sizeBytes: 129,
    })).toBe(false);
  });

  it('digests argv without storing it in the plan contract', () => {
    expect(digestCandidateBootstrapArgv(['install', '--frozen']))
      .toBe(digestCandidateBootstrapArgv(['install', '--frozen']));
    expect(digestCandidateBootstrapArgv(['install', '--frozen']))
      .not.toBe(digestCandidateBootstrapArgv(['install']));
    expect(() => digestCandidateBootstrapArgv([])).toThrow(TypeError);
    expect(() => digestCandidateBootstrapArgv(['bad\0argument']))
      .toThrow(TypeError);
  });

  it('canonicalizes environment names while binding secret values', () => {
    expect(digestCandidateBootstrapEnvironment({
      TOKEN: 'secret',
      CACHE_DIR: '/private/cache',
    })).toBe(digestCandidateBootstrapEnvironment({
      CACHE_DIR: '/private/cache',
      TOKEN: 'secret',
    }));
    expect(digestCandidateBootstrapEnvironment({ TOKEN: 'secret' }))
      .not.toBe(digestCandidateBootstrapEnvironment({ TOKEN: 'changed' }));
    expect(() => digestCandidateBootstrapEnvironment({
      'bad-name': 'value',
    })).toThrow(TypeError);
  });
});
