import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'wukong-telemetry',
    include: ['test/**/*.test.ts'],
  },
});
