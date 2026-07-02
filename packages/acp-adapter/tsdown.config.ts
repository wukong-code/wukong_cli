import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  deps: {
    neverBundle: [
      '@agentclientprotocol/sdk',
      '@wukong/agent-core',
      '@wukong/wukong-sdk',
      '@wukong/kosong',
      '@wukong/kaos',
    ],
  },
});
