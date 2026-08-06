import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workspace `resolve.alias` mirrors `packages/services/vitest.config.ts:11` so
// tests run against src/index.ts (not built dist/) — keeps the feedback loop
// tight when adjacent packages change.
export default defineConfig({
  resolve: {
    alias: [
      // Order matters — list MORE specific entries first so prefix matching
      // doesn't route them through the bare `@wukong/agent-core` alias
      // (which points at agent-core/src/index.ts, breaking subpath imports).
      {
        find: /^@wukong\/agent-core\/session\/store$/,
        replacement: fileURLToPath(
          new URL('../agent-core/src/session/store/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@wukong\/agent-core\/base\/common\/event$/,
        replacement: fileURLToPath(
          new URL('../agent-core/src/base/common/event.ts', import.meta.url),
        ),
      },
      {
        find: '@wukong/wukong-sdk',
        replacement: fileURLToPath(
          new URL('../node-sdk/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@wukong/agent-core',
        replacement: fileURLToPath(
          new URL('../agent-core/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@wukong/protocol',
        replacement: fileURLToPath(
          new URL('../protocol/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@wukong/wukong-oauth',
        replacement: fileURLToPath(
          new URL('../oauth/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: 'server',
    include: ['test/**/*.{test,e2e}.ts'],
    // The server e2e tests pull in the full agent-core tree, which makes module
    // import very slow on Windows runners and destabilizes the test-windows job
    // (flaky timeouts and worker crashes). Skip them on Windows; they still run
    // on the Linux/macOS `test` job.
    exclude: process.platform === 'win32' ? ['test/**/*.e2e.test.ts'] : [],
  },
});
