import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('@wukong/agent-core package exports', () => {
  it('keeps supported subpaths while denying test-fault internals', () => {
    for (const subpath of [
      'session/store',
      'session/store/index',
      'agent/records/migration/index',
      'base/common/event',
      'flags/registry',
    ]) {
      expect(
        require.resolve(`@wukong/agent-core/${subpath}`)
          .replaceAll('\\', '/'),
      ).toContain('/packages/agent-core/src/');
    }

    try {
      require.resolve(
        '@wukong/agent-core/durable-boundary-test-fault',
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
      return;
    }
    throw new Error(
      'The durable-boundary test-fault module must not be package-exported.',
    );
  });
});
