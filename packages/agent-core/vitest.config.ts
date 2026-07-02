import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'wukong-core',
    include: ['test/**/*.{test,e2e}.ts'],
  },
});
