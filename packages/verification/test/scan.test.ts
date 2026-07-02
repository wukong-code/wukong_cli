import { describe, expect, it } from 'vitest';

import { runScan } from '../src/scan';
import { gitAdd, makeTempRepo, writeRepoFile } from './helpers';

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
});
