import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runScan } from '../src/scan';
import { gitAdd, gitCommit, makeTempRepo, writeRepoFile } from './helpers';

describe('runScan', () => {
  it('finds placeholder and missing test risks in staged diff', async () => {
    const cwd = await makeTempRepo('wukong-scan-risk-');
    await writeRepoFile(cwd, 'src/feature.ts', 'export function feature() {\n  return "placeholder";\n}\n');
    await gitAdd(cwd);

    const result = await runScan({ cwd });

    expect(result.status).toBe('failed');
    expect(result.risks.map((risk) => risk.id)).toContain('diff.placeholder_added');
    expect(result.risks.map((risk) => risk.id)).toContain('coverage.source_without_tests');
  });

  it('scans staged and unstaged changes together', async () => {
    const cwd = await makeTempRepo('wukong-scan-mixed-');
    await writeRepoFile(cwd, 'src/tracked.ts', 'export const a = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');

    // Unstaged: placeholder marker in a tracked file.
    await writeRepoFile(cwd, 'src/tracked.ts', 'export const a = 1;\n// TODO: replace with real logic\n');
    // Staged: debug output in a new file.
    await writeRepoFile(cwd, 'src/staged.ts', "console.log('debug');\nexport const b = 1;\n");
    await gitAdd(cwd, 'src/staged.ts');

    const result = await runScan({ cwd });

    const ids = result.risks.map((risk) => risk.id);
    expect(ids).toContain('diff.placeholder_added');
    expect(ids).toContain('diff.debug_output_added');
    expect(result.risks.find((risk) => risk.id === 'diff.placeholder_added')?.file).toBe('src/tracked.ts');
    expect(result.risks.find((risk) => risk.id === 'diff.debug_output_added')?.file).toBe('src/staged.ts');
  });

  it('flags secret-looking file changes as high risk', async () => {
    const cwd = await makeTempRepo('wukong-scan-secret-');
    await writeRepoFile(cwd, '.env', 'API_KEY=abc123\n');
    await gitAdd(cwd);

    const result = await runScan({ cwd });

    expect(result.status).toBe('failed');
    expect(result.risks).toContainEqual(
      expect.objectContaining({ id: 'file.secret_like_changed', severity: 'high', file: '.env' }),
    );
  });

  it('passes on a clean repo and does not write a report by default', async () => {
    const cwd = await makeTempRepo('wukong-scan-clean-');

    const result = await runScan({ cwd });

    expect(result.status).toBe('passed');
    expect(result.risks).toEqual([]);
    expect(result.reportPath).toBeUndefined();
    expect(existsSync(join(cwd, 'wukong-scan-report.md'))).toBe(false);
  });

  it('writes a scan report when requested', async () => {
    const cwd = await makeTempRepo('wukong-scan-report-');

    const result = await runScan({ cwd, writeReport: true });

    expect(result.reportPath).toBe(join(cwd, 'wukong-scan-report.md'));
    expect(result.report).toContain('# Wukong Risk Scan Report');
    expect(existsSync(join(cwd, 'wukong-scan-report.md'))).toBe(true);
  });
});
