import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runProof } from '../src/proof';
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
});
