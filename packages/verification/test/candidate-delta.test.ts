import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createCandidateDelta,
  createCandidateProjection,
  validateCandidateChangeManifest,
  validateCandidateDelta,
  validateCandidateProjection,
  type CreateCandidateProjectionInputV1,
} from '../src';

const CANDIDATE_ID = '10000000-0000-4000-8000-000000000001';
const LEASE_ID = '20000000-0000-4000-8000-000000000002';

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-delta/v1', label);
}

function projection(
  entries: CreateCandidateProjectionInputV1['entries'],
) {
  return createCandidateProjection({
    candidateId: CANDIDATE_ID,
    leaseId: LEASE_ID,
    sourceSnapshotDigest: digest('source'),
    materializedSourceDigest: digest('materialized'),
    bootstrapPlanDigest: digest('bootstrap'),
    generatedScopesDigest: digest('generated'),
    entries,
  });
}

function entry(
  canonicalRelativePath: string,
  content: string,
  mode: 0o100644 | 0o100755 = 0o100644,
) {
  return {
    canonicalRelativePath,
    mode,
    sizeBytes: Buffer.byteLength(content),
    contentDigest: digest(`content:${content}`),
  };
}

describe('CandidateDeltaV1', () => {
  it('freezes a canonical projection independent of input order', () => {
    const left = projection([
      entry('src/z.ts', 'z'),
      entry('src/a.ts', 'a'),
    ]);
    const right = projection([
      entry('src/a.ts', 'a'),
      entry('src/z.ts', 'z'),
    ]);

    expect(left).toEqual(right);
    expect(validateCandidateProjection(left)).toBe(true);
    expect(left.entries.map(({ canonicalRelativePath }) =>
      canonicalRelativePath)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('separates original dirty baseline from Agent changes', () => {
    const baseline = projection([
      entry('dirty-user.ts', 'user preexisting change'),
      entry('delete.ts', 'delete me'),
      entry('mode.sh', 'echo ok'),
      entry('rename-old.ts', 'same bytes'),
      entry('update.ts', 'before'),
    ]);
    const candidate = projection([
      entry('create.ts', 'created'),
      entry('dirty-user.ts', 'user preexisting change'),
      entry('mode.sh', 'echo ok', 0o100755),
      entry('rename-new.ts', 'same bytes'),
      entry('update.ts', 'after'),
    ]);

    const bundle = createCandidateDelta(baseline, candidate);

    expect(bundle.manifest.changes.map((change) => ({
      operation: change.operation,
      sourcePath: change.sourcePath,
      targetPath: change.targetPath,
    }))).toEqual([
      { operation: 'create', sourcePath: null, targetPath: 'create.ts' },
      { operation: 'delete', sourcePath: 'delete.ts', targetPath: null },
      { operation: 'mode', sourcePath: 'mode.sh', targetPath: 'mode.sh' },
      {
        operation: 'rename',
        sourcePath: 'rename-old.ts',
        targetPath: 'rename-new.ts',
      },
      { operation: 'update', sourcePath: 'update.ts', targetPath: 'update.ts' },
    ]);
    expect(bundle.delta.changedPaths).not.toContain('dirty-user.ts');
    expect(bundle.delta.changedPaths).toEqual([
      'create.ts',
      'delete.ts',
      'mode.sh',
      'rename-new.ts',
      'rename-old.ts',
      'update.ts',
    ]);
    expect(validateCandidateChangeManifest(bundle.manifest)).toBe(true);
    expect(validateCandidateDelta(bundle.delta)).toBe(true);
  });

  it('pairs duplicate-content renames deterministically', () => {
    const baseline = projection([
      entry('old-a.ts', 'same'),
      entry('old-b.ts', 'same'),
    ]);
    const candidate = projection([
      entry('new-a.ts', 'same'),
      entry('new-b.ts', 'same'),
    ]);

    expect(createCandidateDelta(baseline, candidate).manifest.changes.map(
      ({ sourcePath, targetPath }) => ({ sourcePath, targetPath }),
    )).toEqual([
      { sourcePath: 'old-a.ts', targetPath: 'new-a.ts' },
      { sourcePath: 'old-b.ts', targetPath: 'new-b.ts' },
    ]);
  });

  it('rejects path escapes, protected paths and digest tampering', () => {
    for (const path of ['../outside.ts', '.git/config', '.wukong/state']) {
      expect(() => projection([entry(path, 'bad')])).toThrow(
        /projection entry is invalid/u,
      );
    }
    const baseline = projection([entry('safe.ts', 'before')]);
    const candidate = projection([entry('safe.ts', 'after')]);
    const { manifest, delta } = createCandidateDelta(baseline, candidate);

    expect(validateCandidateProjection({
      ...baseline,
      projectionDigest: digest('tampered'),
    })).toBe(false);
    expect(validateCandidateChangeManifest({
      ...manifest,
      changedPaths: [],
    })).toBe(false);
    expect(validateCandidateDelta({
      ...delta,
      agentDeltaDigest: digest('tampered'),
    })).toBe(false);
  });

  it('rejects cross-platform path aliases', () => {
    expect(() => projection([
      entry('Source/File.ts', 'one'),
      entry('source/file.ts', 'two'),
    ])).toThrow(/non-portable path aliases/u);
  });
});
