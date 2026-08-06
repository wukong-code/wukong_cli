import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runJudge } from '../src/judge';
import { gitAdd, makeTempRepo, writeJson, writeRepoFile } from './helpers';

describe('runJudge', () => {
  it('passes on a clean repo', async () => {
    const cwd = await makeTempRepo('wukong-judge-pass-');
    await writeJson(join(cwd, 'package.json'), {
      scripts: {
        test: 'node -e "process.exit(0)"',
      },
    });

    const result = await runJudge({ cwd });

    expect(result.verdict).toBe('pass');
    expect(result.mode).toBe('deterministic');
    expect(result.reason).toContain('No blockers');
  });

  it('blocks when verification commands fail', async () => {
    const cwd = await makeTempRepo('wukong-judge-failcmd-');
    const result = await runJudge({
      cwd,
      commands: ['node -e "process.exit(7)"'],
    });

    expect(result.verdict).toBe('block');
    expect(result.reason).toContain('failed');
  });

  it('blocks instead of claiming pass when no verification commands ran', async () => {
    const cwd = await makeTempRepo('wukong-judge-no-evidence-');

    const result = await runJudge({ cwd });

    expect(result.verdict).toBe('block');
    expect(result.reason).toContain('No verification commands');
    expect(result.proof.verification.commandResults).toHaveLength(0);
  });

  it('blocks on high-risk changes', async () => {
    const cwd = await makeTempRepo('wukong-judge-highrisk-');
    await writeRepoFile(cwd, 'src/feature.ts', '// TODO: implement feature\n');
    await gitAdd(cwd);

    const result = await runJudge({ cwd, commands: ['node -e "process.exit(0)"'] });

    expect(result.verdict).toBe('block');
    expect(result.reason).toContain('High-risk');
  });

  it('passes with warnings on medium-risk changes', async () => {
    const cwd = await makeTempRepo('wukong-judge-mediumrisk-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = () => 1;\n');
    await gitAdd(cwd);

    const result = await runJudge({ cwd, commands: ['node -e "process.exit(0)"'] });

    expect(result.verdict).toBe('pass');
    expect(result.reason.toLowerCase()).toContain('medium');
  });

  it('blocks on medium-risk changes in strict mode', async () => {
    const cwd = await makeTempRepo('wukong-judge-strict-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = () => 1;\n');
    await gitAdd(cwd);

    const result = await runJudge({
      cwd,
      commands: ['node -e "process.exit(0)"'],
      strict: true,
    });

    expect(result.verdict).toBe('block');
    expect(result.reason).toContain('Strict');
  });

  it('does not write any reports by default', async () => {
    const cwd = await makeTempRepo('wukong-judge-nowrite-');
    await writeJson(join(cwd, 'package.json'), {
      scripts: {
        test: 'node -e "process.exit(0)"',
      },
    });

    const result = await runJudge({ cwd });

    expect(result.proof.reportPath).toBeUndefined();
    expect(result.proof.report).toBeUndefined();
  });
});
