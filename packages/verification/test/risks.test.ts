import { describe, expect, it } from 'vitest';

import { scanRisks } from '../src/risks';
import type { GitInspection } from '../src/types';

function inspection(overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    cwd: '/workspace',
    isRepo: true,
    statusText: '',
    diffText: '',
    diffStat: '',
    changedFiles: [],
    ...overrides,
  };
}

function diffFor(file: string, addedLines: readonly string[], newStart = 10): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,0 +${String(newStart)},${String(addedLines.length)} @@`,
    ...addedLines.map((line) => `+${line}`),
  ].join('\n');
}

describe('scanRisks added-line rules', () => {
  it('flags placeholder markers with file and line location', () => {
    const risks = scanRisks({
      git: inspection({
        changedFiles: [{ path: 'src/api.ts', status: 'M' }],
        diffText: diffFor('src/api.ts', ['// TODO: implement retry', 'const ok = 1;'], 42),
      }),
    });

    const placeholder = risks.find((risk) => risk.id === 'diff.placeholder_added');
    expect(placeholder).toMatchObject({
      severity: 'high',
      file: 'src/api.ts',
      line: 42,
      evidence: '// TODO: implement retry',
    });
  });

  it('flags mock/fake/hardcoded markers as high risk', () => {
    const risks = scanRisks({
      git: inspection({ diffText: diffFor('src/data.ts', ['return hardcoded value;']) }),
    });

    expect(risks.map((risk) => risk.id)).toContain('diff.mock_or_fake_added');
  });

  it('flags focused and skipped tests as medium risk', () => {
    const risks = scanRisks({
      git: inspection({
        diffText: diffFor('src/user.test.ts', ["it.only('runs', () => {});", "describe.skip('rest', () => {});"]),
      }),
    });

    const ids = risks.map((risk) => risk.id);
    expect(ids).toContain('diff.only_test_added');
    expect(ids).toContain('diff.skipped_test_added');
    for (const risk of risks) expect(risk.severity).toBe('medium');
  });

  it('flags debug output', () => {
    const risks = scanRisks({
      git: inspection({ diffText: diffFor('src/app.ts', ["console.log('here');", 'debugger;']) }),
    });

    expect(risks.filter((risk) => risk.id === 'diff.debug_output_added')).toHaveLength(2);
  });

  it('does not flag clean added lines', () => {
    const risks = scanRisks({
      git: inspection({
        changedFiles: [
          { path: 'src/util.ts', status: 'M' },
          { path: 'src/util.test.ts', status: 'M' },
        ],
        diffText: diffFor('src/util.ts', ['export const sum = (a: number, b: number) => a + b;']),
      }),
    });

    expect(risks).toEqual([]);
  });

  it('dedupes identical findings', () => {
    const diffText = [
      '+++ b/src/a.ts',
      '+// TODO: later',
      '+// TODO: later',
    ].join('\n');
    const risks = scanRisks({ git: inspection({ diffText }) });

    expect(risks.filter((risk) => risk.id === 'diff.placeholder_added')).toHaveLength(1);
  });
});

describe('scanRisks file and workspace rules', () => {
  it('flags secret-looking file paths', () => {
    for (const path of ['.env', 'config/.env.production', 'secrets/token.json', 'deploy/id_rsa']) {
      const risks = scanRisks({ git: inspection({ changedFiles: [{ path, status: 'M' }] }) });
      expect(risks.map((risk) => risk.id), path).toContain('file.secret_like_changed');
    }
  });

  it('does not flag ordinary environment-adjacent names', () => {
    const risks = scanRisks({
      git: inspection({ changedFiles: [{ path: 'src/environment.ts', status: 'M' }] }),
    });

    expect(risks.map((risk) => risk.id)).not.toContain('file.secret_like_changed');
  });

  it('flags source changes without test changes, and clears when tests change too', () => {
    const withoutTests = scanRisks({
      git: inspection({ changedFiles: [{ path: 'src/core.ts', status: 'M' }] }),
    });
    expect(withoutTests.map((risk) => risk.id)).toContain('coverage.source_without_tests');

    const withTests = scanRisks({
      git: inspection({
        changedFiles: [
          { path: 'src/core.ts', status: 'M' },
          { path: 'test/core.test.ts', status: 'M' },
        ],
      }),
    });
    expect(withTests.map((risk) => risk.id)).not.toContain('coverage.source_without_tests');
  });

  it('flags non-git workspaces as medium risk', () => {
    const risks = scanRisks({ git: inspection({ isRepo: false }) });

    expect(risks).toContainEqual(expect.objectContaining({ id: 'workspace.not_git_repo', severity: 'medium' }));
  });

  it('flags missing verification commands only when command risks are requested', () => {
    const withCommandRisks = scanRisks({
      git: inspection(),
      selectedCommands: [],
      includeCommandRisks: true,
    });
    expect(withCommandRisks.map((risk) => risk.id)).toContain('commands.none_detected');

    const withoutCommandRisks = scanRisks({
      git: inspection(),
      selectedCommands: [],
      includeCommandRisks: false,
    });
    expect(withoutCommandRisks.map((risk) => risk.id)).not.toContain('commands.none_detected');

    const withCommands = scanRisks({
      git: inspection(),
      selectedCommands: ['npm run test'],
      includeCommandRisks: true,
    });
    expect(withCommands.map((risk) => risk.id)).not.toContain('commands.none_detected');
  });
});
