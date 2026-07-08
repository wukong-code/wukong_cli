import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { wukongInternalAliasPlugin } from '../../build/wukong-internal-alias-plugin.mjs';

const appRoot = import.meta.dirname;

export default defineConfig({
  plugins: [wukongInternalAliasPlugin()],
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    name: 'cli',
    env: {
      WUKONG_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 15_000,
  },
});
