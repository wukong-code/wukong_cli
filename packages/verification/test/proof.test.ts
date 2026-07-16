import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runProof, WorkspaceChangedError } from '../src/proof';
import { gitAdd, makeTempRepo, writeJson, writeRepoFile } from './helpers';

describe('runProof', () => {
  it('passes on a clean repo with passing verification commands', async () => {
    const cwd = await makeTempRepo('wukong-proof-pass-');
    await writeJson(join(cwd, 'package.json'), {
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    });

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('passed');
    expect(result.verification.status).toBe('passed');
    expect(result.scan.status).toBe('passed');
    expect(result.recommendation).toContain('Ready to merge');
    expect(result.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.blockers).toEqual([]);
  });

  it('blocks when scan detects a high-risk placeholder', async () => {
    const cwd = await makeTempRepo('wukong-proof-blocked-');
    await writeRepoFile(cwd, 'src/feature.ts', '// TODO: implement feature\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('blocked');
    expect(result.scan.status).toBe('failed');
    expect(result.recommendation.toLowerCase()).toContain('high-risk');
  });

  it('blocks when a verification command fails', async () => {
    const cwd = await makeTempRepo('wukong-proof-failcmd-');
    const result = await runProof({
      cwd,
      commands: ['node -e "process.exit(7)"'],
      writeReport: false,
    });

    expect(result.status).toBe('blocked');
    expect(result.verification.status).toBe('failed');
    expect(result.recommendation.toLowerCase()).toContain('failed');
    expect(result.reasonCode).toBe('check_failed');
    expect(result.blockers[0]).toMatchObject({
      id: 'check_failed',
      kind: 'check',
      command: 'node -e "process.exit(7)"',
    });
  });

  it('blocks source changes when no project checks are discovered', async () => {
    const cwd = await makeTempRepo('wukong-proof-no-tests-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = () => 1;\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('blocked');
    expect(result.recommendation).toContain('no project checks were discovered');
    expect(result.reasonCode).toBe('tests_missing');
    expect(result.blockers[0]).toMatchObject({
      id: 'tests_missing',
      file: 'src/feature.ts',
    });
  });

  it('does not require project checks for a docs-only change', async () => {
    const cwd = await makeTempRepo('wukong-proof-docs-only-');
    await writeRepoFile(cwd, 'README.md', '# Updated docs\n');
    await gitAdd(cwd);

    const result = await runProof({ cwd, writeReport: false });

    expect(result.status).toBe('passed');
    expect(result.verification.status).toBe('warning');
    expect(result.verification.risks).toEqual([]);
  });

  it('escalates warnings to blocked in strict mode', async () => {
    const cwd = await makeTempRepo('wukong-proof-strict-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = () => 1;\n');
    await gitAdd(cwd);

    const relaxed = await runProof({
      cwd,
      commands: ['node -e "process.exit(0)"'],
      writeReport: false,
    });
    expect(relaxed.status).toBe('passed');

    const strict = await runProof({
      cwd,
      commands: ['node -e "process.exit(0)"'],
      strict: true,
      writeReport: false,
    });
    expect(strict.status).toBe('blocked');
  });

  it('writes a markdown report by default', async () => {
    const cwd = await makeTempRepo('wukong-proof-report-');
    await writeJson(join(cwd, 'package.json'), {
      scripts: {
        test: 'node -e "process.exit(0)"',
      },
    });

    const result = await runProof({ cwd });

    expect(result.reportPath).toBe(join(cwd, 'wukong-proof-report.md'));
    expect(result.report).toContain('# Wukong Merge Proof Report');
    expect(result.report).toContain(`Status: ${result.status}`);
  });

  it('can skip report writing with writeReport false', async () => {
    const cwd = await makeTempRepo('wukong-proof-noreport-');
    const result = await runProof({ cwd, writeReport: false });

    expect(result.reportPath).toBeUndefined();
    expect(result.report).toBeUndefined();
  });

  it('rejects a stale conclusion when checks keep changing the workspace', async () => {
    const cwd = await makeTempRepo('wukong-proof-stale-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = 1;\n');
    await gitAdd(cwd);

    await expect(runProof({
      cwd,
      commands: ["node -e \"require('node:fs').appendFileSync('src/feature.ts', 'x')\""],
      writeReport: false,
    })).rejects.toBeInstanceOf(WorkspaceChangedError);
  });
});
