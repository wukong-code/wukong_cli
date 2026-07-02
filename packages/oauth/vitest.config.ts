import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'wukong-oauth',
    include: ['test/**/*.test.ts'],
  },
});
