import { promisify } from 'node:util';

import {
  canonicalDigest,
  resolveWorkspaceIdentity,
} from './finish-line';
import {
  inspectSourceSnapshot,
  validateSourceSnapshot,
  type SourceSnapshotV1,
} from './source-snapshot';
import {
  createTargetStateFingerprint,
  type TargetStateFingerprintV1,
} from './target-promotion';

const CANDIDATE_REF_PREFIX = 'refs/heads/wukong/candidate/';

export async function buildTargetStateFingerprint(input: {
  readonly cwd: string;
  readonly expectedSourceSnapshot: SourceSnapshotV1;
  readonly promotableContentDigest: string;
  readonly lineageSourceSnapshotDigest?: string;
  readonly requiredGatePaths?: readonly string[];
}): Promise<TargetStateFingerprintV1> {
  if (!validateSourceSnapshot(input.expectedSourceSnapshot)
    || !isDigest(input.promotableContentDigest)
    || (input.lineageSourceSnapshotDigest !== undefined
      && !isDigest(input.lineageSourceSnapshotDigest))) {
    throw new TypeError('Target fingerprint builder input is invalid.');
  }
  const selectedUntrackedPaths =
    input.expectedSourceSnapshot.includedUntracked.map(
      (entry) => entry.canonicalRelativePath,
    );
  const [identityBefore, snapshotBefore] = await Promise.all([
    resolveWorkspaceIdentity(input.cwd),
    inspectSourceSnapshot({
      cwd: input.cwd,
      selectedUntrackedPaths,
      requiredGatePaths: input.requiredGatePaths,
    }),
  ]);
  assertExpectedSnapshot(input.expectedSourceSnapshot, snapshotBefore);
  if (identityBefore.gitCommonDirIdentity === undefined) {
    throw new Error('Target workspace is not backed by a Git common directory.');
  }
  const [head, branch, refsBefore] = await Promise.all([
    git(input.cwd, ['rev-parse', '--verify', 'HEAD']),
    git(input.cwd, ['symbolic-ref', '-q', 'HEAD'], true),
    readProtectedRefs(input.cwd),
  ]);
  const [identityAfter, snapshotAfter, refsAfter] = await Promise.all([
    resolveWorkspaceIdentity(input.cwd),
    inspectSourceSnapshot({
      cwd: input.cwd,
      selectedUntrackedPaths,
      requiredGatePaths: input.requiredGatePaths,
    }),
    readProtectedRefs(input.cwd),
  ]);
  assertExpectedSnapshot(input.expectedSourceSnapshot, snapshotAfter);
  if (identityAfter.workspaceIdentityDigest
      !== identityBefore.workspaceIdentityDigest
    || identityAfter.gitCommonDirIdentity
      !== identityBefore.gitCommonDirIdentity) {
    throw new Error('Target workspace identity changed during fingerprinting.');
  }
  if (canonicalDigest('wukong/target-protected-refs/v1', refsAfter)
      !== canonicalDigest('wukong/target-protected-refs/v1', refsBefore)) {
    throw new Error('Target protected refs changed during fingerprinting.');
  }
  const headOid = singleLine(head);
  if (headOid !== input.expectedSourceSnapshot.baseCommit) {
    throw new Error('Target HEAD changed from the frozen source snapshot.');
  }
  const branchRef = branch.length === 0 ? null : singleLine(branch);
  return createTargetStateFingerprint({
    targetWorkspaceIdentity: identityBefore.workspaceIdentityDigest,
    targetGitCommonDirIdentity: canonicalDigest(
      'wukong/git-common-dir-identity/v1',
      identityBefore.gitCommonDirIdentity,
    ),
    headOid,
    branchRef,
    branchRefDigest: branchRef === null
      ? null
      : canonicalDigest('wukong/target-branch-ref/v1', branchRef),
    indexDigest: input.expectedSourceSnapshot.indexDigest,
    trackedWorkingDeltaDigest:
      input.expectedSourceSnapshot.trackedDeltaDigest,
    untrackedProjectionDigest: canonicalDigest(
      'wukong/target-untracked-projection/v1',
      input.expectedSourceSnapshot.includedUntracked,
    ),
    protectedRefsDigest: canonicalDigest(
      'wukong/target-protected-refs/v1',
      refsBefore,
    ),
    sourceSnapshotDigest: input.lineageSourceSnapshotDigest
      ?? input.expectedSourceSnapshot.snapshotDigest,
    promotableContentDigest: input.promotableContentDigest,
  });
}

/**
 * Reconstructs the exact pre-Apply registry fingerprint after target paths may
 * already contain a journaled subset of the candidate delta. This never grants
 * a new promotion: callers must match the original consent proposal digest,
 * then let the Apply journal reconcile every changed path.
 */
export async function reconstructTargetStateFingerprintForRecovery(input: {
  readonly cwd: string;
  readonly expectedSourceSnapshot: SourceSnapshotV1;
  readonly promotableContentDigest: string;
}): Promise<TargetStateFingerprintV1> {
  if (!validateSourceSnapshot(input.expectedSourceSnapshot)
    || !isDigest(input.promotableContentDigest)) {
    throw new TypeError(
      'Target recovery fingerprint builder input is invalid.',
    );
  }
  const [identityBefore, head, branch, refsBefore] = await Promise.all([
    resolveWorkspaceIdentity(input.cwd),
    git(input.cwd, ['rev-parse', '--verify', 'HEAD']),
    git(input.cwd, ['symbolic-ref', '-q', 'HEAD'], true),
    readProtectedRefs(input.cwd),
  ]);
  const [identityAfter, refsAfter] = await Promise.all([
    resolveWorkspaceIdentity(input.cwd),
    readProtectedRefs(input.cwd),
  ]);
  if (identityBefore.gitCommonDirIdentity === undefined
    || identityAfter.workspaceIdentityDigest
      !== identityBefore.workspaceIdentityDigest
    || identityAfter.gitCommonDirIdentity
      !== identityBefore.gitCommonDirIdentity
    || canonicalDigest('wukong/target-protected-refs/v1', refsAfter)
      !== canonicalDigest('wukong/target-protected-refs/v1', refsBefore)) {
    throw new Error(
      'Target recovery identity changed while rebuilding its fingerprint.',
    );
  }
  const headOid = singleLine(head);
  const branchRef = branch.length === 0 ? null : singleLine(branch);
  const expectedBranchRef =
    input.expectedSourceSnapshot.branchName === null
      ? null
      : `refs/heads/${input.expectedSourceSnapshot.branchName}`;
  if (headOid !== input.expectedSourceSnapshot.baseCommit
    || branchRef !== expectedBranchRef) {
    throw new Error(
      'Target HEAD or branch changed from the frozen source snapshot.',
    );
  }
  return createTargetStateFingerprint({
    targetWorkspaceIdentity: identityBefore.workspaceIdentityDigest,
    targetGitCommonDirIdentity: canonicalDigest(
      'wukong/git-common-dir-identity/v1',
      identityBefore.gitCommonDirIdentity,
    ),
    headOid,
    branchRef,
    branchRefDigest: branchRef === null
      ? null
      : canonicalDigest('wukong/target-branch-ref/v1', branchRef),
    indexDigest: input.expectedSourceSnapshot.indexDigest,
    trackedWorkingDeltaDigest:
      input.expectedSourceSnapshot.trackedDeltaDigest,
    untrackedProjectionDigest: canonicalDigest(
      'wukong/target-untracked-projection/v1',
      input.expectedSourceSnapshot.includedUntracked,
    ),
    protectedRefsDigest: canonicalDigest(
      'wukong/target-protected-refs/v1',
      refsBefore,
    ),
    sourceSnapshotDigest:
      input.expectedSourceSnapshot.snapshotDigest,
    promotableContentDigest: input.promotableContentDigest,
  });
}

async function readProtectedRefs(
  cwd: string,
): Promise<readonly { readonly ref: string; readonly oid: string }[]> {
  const refs = await git(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    'refs/heads',
    'refs/tags',
  ]);
  return refs.split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [ref, oid, ...extra] = line.split('\0');
      if (ref === undefined
        || oid === undefined
        || extra.length > 0
        || !/^refs\/(?:heads|tags)\//u.test(ref)
        || !/^[a-f0-9]{40,64}$/u.test(oid)) {
        throw new Error('Target protected refs are invalid.');
      }
      return { ref, oid };
    })
    .filter(({ ref }) => !ref.startsWith(CANDIDATE_REF_PREFIX))
    .toSorted((left, right) =>
      left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
}

function assertExpectedSnapshot(
  expected: SourceSnapshotV1,
  inspected: Awaited<ReturnType<typeof inspectSourceSnapshot>>,
): void {
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null
    || inspected.proposedSnapshot.snapshotDigest
      !== expected.snapshotDigest) {
    throw new Error('Target source state changed from the frozen snapshot.');
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  allowExitOne = false,
): Promise<string> {
  try {
    const { execFile } = await import('node:child_process');
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const exitCode = (error as { readonly code?: unknown }).code;
    if (allowExitOne && exitCode === 1) return '';
    throw error;
  }
}

function singleLine(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\n')) {
    throw new Error('Git returned an invalid single-line value.');
  }
  return trimmed;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}
