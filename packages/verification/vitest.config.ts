import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'verification',
    include: ['test/**/*.test.ts'],
  },
});
