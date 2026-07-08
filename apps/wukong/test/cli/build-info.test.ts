import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var __WUKONG_CODE_VERSION__: string | undefined;
  // eslint-disable-next-line no-var
  var __WUKONG_CODE_CHANNEL__: string | undefined;
  // eslint-disable-next-line no-var
  var __WUKONG_CODE_COMMIT__: string | undefined;
  // eslint-disable-next-line no-var
  var __WUKONG_CODE_BUILD_TARGET__: string | undefined;
}

describe('WUKONG_BUILD_INFO', () => {
  const originalVersion = globalThis.__WUKONG_CODE_VERSION__;
  const originalChannel = globalThis.__WUKONG_CODE_CHANNEL__;
  const originalCommit = globalThis.__WUKONG_CODE_COMMIT__;
  const originalTarget = globalThis.__WUKONG_CODE_BUILD_TARGET__;

  beforeEach(() => {
    vi.resetModules();
    globalThis.__WUKONG_CODE_VERSION__ = undefined;
    globalThis.__WUKONG_CODE_CHANNEL__ = undefined;
    globalThis.__WUKONG_CODE_COMMIT__ = undefined;
    globalThis.__WUKONG_CODE_BUILD_TARGET__ = undefined;
  });

  afterEach(() => {
    globalThis.__WUKONG_CODE_VERSION__ = originalVersion;
    globalThis.__WUKONG_CODE_CHANNEL__ = originalChannel;
    globalThis.__WUKONG_CODE_COMMIT__ = originalCommit;
    globalThis.__WUKONG_CODE_BUILD_TARGET__ = originalTarget;
  });

  it('exposes all defined build globals', async () => {
    globalThis.__WUKONG_CODE_VERSION__ = '0.0.8';
    globalThis.__WUKONG_CODE_CHANNEL__ = 'stable';
    globalThis.__WUKONG_CODE_COMMIT__ = 'abc123';
    globalThis.__WUKONG_CODE_BUILD_TARGET__ = 'darwin-x64';

    const { WUKONG_BUILD_INFO } = await import('#/cli/build-info');

    expect(WUKONG_BUILD_INFO).toEqual({
      version: '0.0.8',
      channel: 'stable',
      commit: 'abc123',
      buildTarget: 'darwin-x64',
    });
  });

  it('omits empty string globals', async () => {
    globalThis.__WUKONG_CODE_VERSION__ = '';
    globalThis.__WUKONG_CODE_CHANNEL__ = 'beta';
    globalThis.__WUKONG_CODE_COMMIT__ = '   ';

    const { WUKONG_BUILD_INFO } = await import('#/cli/build-info');

    expect(WUKONG_BUILD_INFO).toEqual({
      version: undefined,
      channel: 'beta',
      commit: '   ',
      buildTarget: undefined,
    });
  });

  it('returns undefined fields when no globals are defined', async () => {
    const { WUKONG_BUILD_INFO } = await import('#/cli/build-info');

    expect(WUKONG_BUILD_INFO).toEqual({
      version: undefined,
      channel: undefined,
      commit: undefined,
      buildTarget: undefined,
    });
  });
});
