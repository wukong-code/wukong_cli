import {
  RAW_TEXT_LOADERS,
  rawTextQueryPlugin,
} from '@wukong/build-support/raw-text/rolldown';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  loader: RAW_TEXT_LOADERS,
  plugins: [rawTextQueryPlugin()],
  deps: {
    alwaysBundle: ['picomatch'],
    neverBundle: [
      '@wukong/kosong',
      '@wukong/kaos',
      '@wukong/wukong-oauth',
    ],
  },
});
