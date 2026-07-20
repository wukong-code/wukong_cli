import { spawnSync } from 'node:child_process';
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
        test: 'node test.cjs',
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
    await writeRepoFile(cwd, 'packages/api/src/ready.json', '{"ready":false}\n');
    await writeRepoFile(
      cwd,
      'packages/api/test.cjs',
      "process.exit(require('./src/ready.json').ready ? 0 : 1);\n",
    );
    await writeRepoFile(cwd, 'packages/web/src/index.ts', 'export const web = true;\n');
    await writeRepoFile(
      cwd,
      '.wukong/review-policy.md',
      '# Review policy\n\n- Public API changes require tests.\n',
    );
    await gitAdd(cwd);

    const blocked = await runProof({ cwd, writeReport: false });
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockers[0]?.command).toBe("npm --prefix 'packages/api' run test");

    await writeRepoFile(cwd, 'packages/api/src/ready.json', '{"ready":true}\n');
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
    expect(result.workspaceFingerprint.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.blockers).toEqual([]);
  });

  it.skipIf(!toolAvailable('cargo'))(
    'discovers and executes a real Rust project test',
    { timeout: 30_000 },
    async () => {
      const cwd = await makeTempRepo('wukong-rust-e2e-');
      await writeRepoFile(
        cwd,
        'Cargo.toml',
        '[package]\nname = "wukong_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      await writeRepoFile(
        cwd,
        'src/lib.rs',
        'pub fn ready() -> bool { false }\n\n#[test]\nfn fixture_is_ready() { assert!(ready()); }\n',
      );
      await gitAdd(cwd);

      const blocked = await runProof({ cwd, writeReport: false });
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockers[0]?.command).toBe('cargo test');

      await writeRepoFile(
        cwd,
        'src/lib.rs',
        'pub fn ready() -> bool { true }\n\n#[test]\nfn fixture_is_ready() { assert!(ready()); }\n',
      );
      const result = await runProof({ cwd, writeReport: false });

      expect(result.status).toBe('passed');
      expect(result.verification.selectedCommands).toEqual(['cargo test']);
      expect(result.verification.commandResults[0]?.status).toBe('passed');
    },
  );

  it.skipIf(!toolAvailable('ruff'))(
    'discovers and executes a real configured Python lint check',
    { timeout: 15_000 },
    async () => {
      const cwd = await makeTempRepo('wukong-python-e2e-');
      await writeRepoFile(
        cwd,
        'pyproject.toml',
        '[project]\nname = "wukong-fixture"\nversion = "0.1.0"\n\n[tool.ruff]\nline-length = 100\n',
      );
      await writeRepoFile(cwd, 'src/ready.py', 'def ready() -> bool:\n    return True\n');
      await gitAdd(cwd);

      const result = await runProof({ cwd, writeReport: false });

      expect(result.status).toBe('passed');
      expect(result.verification.selectedCommands).toEqual(['ruff check .']);
      expect(result.verification.commandResults[0]?.status).toBe('passed');
    },
  );

  it.skipIf(!toolAvailable('python3'))(
    'executes a real Python standard-library test configured by the project',
    { timeout: 15_000 },
    async () => {
      const cwd = await makeTempRepo('wukong-python-unittest-e2e-');
      await writeRepoFile(cwd, '.wukong/checks.json', JSON.stringify({
        commands: ['python3 -m unittest discover -s tests'],
      }));
      await writeRepoFile(cwd, 'ready.py', 'def ready() -> bool:\n    return False\n');
      await writeRepoFile(
        cwd,
        'tests/test_ready.py',
        'import unittest\nfrom ready import ready\n\nclass ReadyTest(unittest.TestCase):\n    def test_ready(self):\n        self.assertTrue(ready())\n',
      );
      await gitAdd(cwd);

      const blocked = await runProof({ cwd, writeReport: false });
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockers[0]?.command).toBe('python3 -m unittest discover -s tests');

      await writeRepoFile(cwd, 'ready.py', 'def ready() -> bool:\n    return True\n');
      const result = await runProof({ cwd, writeReport: false });

      expect(result.status).toBe('passed');
      expect(result.verification.selectedCommands).toEqual([
        'python3 -m unittest discover -s tests',
      ]);
      expect(result.verification.commandResults[0]?.status).toBe('passed');
    },
  );

  it.skipIf(!toolAvailable('go'))(
    'discovers and executes a real Go project test',
    { timeout: 30_000 },
    async () => {
      const cwd = await makeTempRepo('wukong-go-e2e-');
      await writeRepoFile(cwd, 'go.mod', 'module example.test/wukongfixture\n\ngo 1.24\n');
      await writeRepoFile(cwd, 'ready.go', 'package wukongfixture\n\nfunc Ready() bool { return false }\n');
      await writeRepoFile(
        cwd,
        'ready_test.go',
        'package wukongfixture\n\nimport "testing"\n\nfunc TestReady(t *testing.T) { if !Ready() { t.Fatal("not ready") } }\n',
      );
      await gitAdd(cwd);

      const blocked = await runProof({ cwd, writeReport: false });
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockers[0]?.command).toBe('go test ./...');

      await writeRepoFile(cwd, 'ready.go', 'package wukongfixture\n\nfunc Ready() bool { return true }\n');
      const result = await runProof({ cwd, writeReport: false });

      expect(result.status).toBe('passed');
      expect(result.verification.selectedCommands).toEqual(['go test ./...']);
      expect(result.verification.commandResults[0]?.status).toBe('passed');
    },
  );

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

  it('returns NEEDS_WORK guidance when source changed but no checks exist', async () => {
    const cwd = await makeTempRepo('wukong-no-checks-e2e-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = true;\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('blocked');
    expect(result.reasonCode).toBe('tests_missing');
    expect(result.blockers[0]).toMatchObject({
      id: 'tests_missing',
      summary: 'Source code changed but no project checks were discovered.',
      nextAction: 'Add a project test/typecheck script or configure .wukong/checks.json.',
    });
  });

  it('separates a missing check tool from a failed project test', async () => {
    const cwd = await makeTempRepo('wukong-missing-tool-e2e-');
    await writeRepoFile(cwd, '.wukong/checks.json', JSON.stringify({
      commands: ['wukong-tool-that-does-not-exist --check'],
    }));
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = true;\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('blocked');
    expect(result.reasonCode).toBe('check_unavailable');
    expect(result.blockers[0]).toMatchObject({
      id: 'check_unavailable',
      nextAction: expect.stringContaining('Install the required tool'),
    });
  });
});

function toolAvailable(command: string): boolean {
  const args = command === 'go' ? ['version'] : ['--version'];
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}
