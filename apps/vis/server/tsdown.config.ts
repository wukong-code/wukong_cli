import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  external: ['@wukong/agent-core', '@wukong/kosong', '@wukong/kaos'],
});
