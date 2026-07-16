import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runProof } from '../src/proof';
import { gitAdd, makeTempRepo, writeJson, writeRepoFile } from './helpers';

describe('real monorepo proof E2E', () => {
  it('discovers and executes checks from multiple nested npm packages', { timeout: 15_000 }, async () => {
    const cwd = await makeTempRepo('wukong-monorepo-e2e-');
    await writeJson(join(cwd, 'package.json'), {
      private: true,
      workspaces: ['packages/*'],
    });
    await writeRepoFile(cwd, 'packages/api/package.json', `${JSON.stringify({
      name: 'api',
      scripts: {
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2)}\n`);
    await writeRepoFile(cwd, 'packages/web/package.json', `${JSON.stringify({
      name: 'web',
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2)}\n`);
    await writeRepoFile(cwd, 'packages/api/src/index.ts', 'export const api = true;\n');
    await writeRepoFile(cwd, 'packages/web/src/index.ts', 'export const web = true;\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('passed');
    expect(result.verification.selectedCommands).toEqual([
      "npm --prefix 'packages/api' run lint",
      "npm --prefix 'packages/web' run typecheck",
      "npm --prefix 'packages/api' run test",
      "npm --prefix 'packages/web' run test",
    ]);
    expect(result.verification.commandResults).toHaveLength(4);
    expect(result.verification.commandResults.every((item) => item.status === 'passed')).toBe(true);
    expect(result.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.blockers).toEqual([]);
  });

  it('returns a stable actionable blocker from a nested package failure', { timeout: 15_000 }, async () => {
    const cwd = await makeTempRepo('wukong-monorepo-fail-e2e-');
    await writeJson(join(cwd, 'package.json'), { private: true, workspaces: ['packages/*'] });
    await writeRepoFile(cwd, 'packages/api/package.json', `${JSON.stringify({
      name: 'api',
      scripts: { test: 'node -e "console.error(\'nested failure\'); process.exit(2)"' },
    }, null, 2)}\n`);
    await writeRepoFile(cwd, 'packages/api/src/index.ts', 'export const api = false;\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('blocked');
    expect(result.reasonCode).toBe('check_failed');
    expect(result.blockers[0]).toMatchObject({
      kind: 'check',
      command: "npm --prefix 'packages/api' run test",
      nextAction: "Run npm --prefix 'packages/api' run test and fix the reported failure.",
    });
    expect(result.blockers[0]?.evidence).toContain('nested failure');
  });
});
