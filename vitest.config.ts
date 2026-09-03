import { defineConfig } from 'vitest/config';

/**
 * Coverage thresholds are opt-in so local `pnpm test` / `pnpm test:coverage`
 * stay unblocked while iterating. They apply when:
 * - CI=true (GitHub Actions), or
 * - WUKONG_COVERAGE_GATE=1 (manual local gate check)
 *
 * Set WUKONG_COVERAGE_GATE=0 in CI to temporarily skip the gate.
 *
 * Floors are set below the 2026-07-09 apps/wukong baseline
 * (lines ~79%, branches ~67%) so small natural variance does not flake CI,
 * while large coverage regressions still fail the build.
 */
const coverageGateEnabled =
  process.env.WUKONG_COVERAGE_GATE === '1' ||
  (process.env.CI === 'true' && process.env.WUKONG_COVERAGE_GATE !== '0');

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/wukong',
      'apps/wukong-web',
      'apps/vis/web',
      'apps/vis/server',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html', 'json-summary'],
      ...(coverageGateEnabled
        ? {
            thresholds: {
              lines: 70,
              functions: 70,
              statements: 70,
              branches: 60,
            },
          }
        : {}),
    },
  },
});
