import { fileURLToPath } from 'node:url';

import {
  RAW_TEXT_LOADERS,
  rawTextQueryPlugin,
} from '@wukong/build-support/raw-text/rolldown';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  loader: RAW_TEXT_LOADERS,
  plugins: [rawTextQueryPlugin()],
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  alias: {
    '@wukong/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
    '@wukong/kaos': fileURLToPath(new URL('../kaos/src/index.ts', import.meta.url)),
    '@wukong/wukong-oauth': fileURLToPath(new URL('../oauth/src/index.ts', import.meta.url)),
    '@wukong/kosong': fileURLToPath(new URL('../kosong/src/index.ts', import.meta.url)),
  },
  deps: {
    alwaysBundle: [/^@wukong-ai\//],
    neverBundle: [],
  },
});
