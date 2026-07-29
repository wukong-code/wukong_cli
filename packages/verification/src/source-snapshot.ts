import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { canonicalDigest } from './finish-line';

export const SOURCE_SNAPSHOT_POLICY_VERSION = 'source-snapshot/1';
export const SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION = '2.29.0';

export interface SourceSnapshotLimitsV1 {
  readonly maxTrackedFileBytes: number;
  readonly maxUntrackedFiles: number;
  readonly maxUntrackedFileBytes: number;
  readonly maxUntrackedTotalBytes: number;
  readonly maxDiscoveredUntrackedFiles: number;
}

export const SOURCE_SNAPSHOT_LIMITS = {
  maxTrackedFileBytes: 8 * 1024 * 1024,
  maxUntrackedFiles: 100,
  maxUntrackedFileBytes: 1024 * 1024,
  maxUntrackedTotalBytes: 8 * 1024 * 1024,
  maxDiscoveredUntrackedFiles: 500,
} as const satisfies SourceSnapshotLimitsV1;

export type SnapshotExclusionReasonV1 =
  | 'secret_or_credential'
  | 'ignored_or_generated'
  | 'oversize'
  | 'unsupported_file_type'
  | 'symlink'
  | 'policy_denied';

export interface SnapshotFileRefV1 {
  readonly canonicalRelativePath: string;
  readonly mode: number;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  readonly fileRefDigest: string;
}

export interface SnapshotExclusionV1 {
  readonly pathProjection: string;
  readonly reason: SnapshotExclusionReasonV1;
  readonly requiredByFrozenGate: boolean;
  readonly exclusionDigest: string;
}

export interface SourceSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotPolicyVersion: string;
  readonly snapshotLimits: SourceSnapshotLimitsV1;
  readonly snapshotPolicyDigest: string;
  readonly sourceWorkspaceIdentity: string;
  readonly repositoryIdentity: string;
  readonly repositoryRelativeCwd: string;
  readonly baseCommit: string;
  readonly branchName: string | null;
  readonly headTreeDigest: string;
  readonly indexDigest: string;
  readonly trackedDeltaDigest: string | null;
  readonly includedUntracked: readonly SnapshotFileRefV1[];
  readonly exclusions: readonly SnapshotExclusionV1[];
  readonly snapshotDigest: string;
}

export interface SnapshotUntrackedCandidateV1 {
  readonly pathProjection: string;
  readonly sizeBytes: number | null;
  readonly selected: boolean;
  readonly eligibility: 'eligible' | 'excluded';
  readonly exclusionReason: SnapshotExclusionReasonV1 | null;
  readonly candidateDigest: string;
}

export type SourceSnapshotReasonCodeV1 =
  | 'isolated_loop_not_git'
  | 'isolated_loop_git_unsupported'
  | 'source_snapshot_untrusted'
  | 'snapshot_dependency_excluded'
  | 'snapshot_selection_excluded';

export interface SourceSnapshotDryRunV1 {
  readonly schemaVersion: 1;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly status: 'ready' | 'blocked';
  readonly reasonCode: SourceSnapshotReasonCodeV1 | null;
  readonly proposedSnapshot: SourceSnapshotV1 | null;
  readonly untrackedCandidates: readonly SnapshotUntrackedCandidateV1[];
  readonly untrackedCandidateCount: number;
  readonly untrackedDiscoveryTruncated: boolean;
  readonly dryRunDigest: string;
}

export interface InspectSourceSnapshotOptions {
  readonly cwd?: string;
  readonly selectedUntrackedPaths?: readonly string[];
  readonly requiredGatePaths?: readonly string[];
  readonly limits?: Partial<SourceSnapshotLimitsV1>;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

interface IndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
}

interface MutableExclusion {
  readonly pathProjection: string;
  readonly reason: SnapshotExclusionReasonV1;
  requiredByFrozenGate: boolean;
}

interface WorktreePathState {
  readonly presence: 'absent' | 'present';
  readonly fileType: 'regular' | 'directory' | 'symlink' | 'other' | null;
  readonly mode: number | null;
  readonly sizeBytes: number | null;
  readonly contentDigest: string | null;
  readonly exclusionReason: SnapshotExclusionReasonV1 | null;
}

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_GIT_RUNTIME_MS = 30_000;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const PRIVATE_STATE = /(?:^|\/)(?:\.git|\.wukong\/(?:sessions?|logs?|trust|auth|providers?))(?:\/|$)/u;
const GENERATED = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|target|\.next|\.nuxt|out|\.venv|venv|\.tox|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)/u;
const SECRET_PATH_SEGMENT = /(?:^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|tokens?|keys?|certs?|auth)(?:\/|$)/iu;
const SECRET_FILE = /(?:^|\/)[^/]*(?:secret|credential|token|api[_-]?key|private[_-]?key|\.pem|\.p12|\.pfx|\.key)(?:[^/]*)$/iu;
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_PORTABLE_PATH_BYTES = 4_096;
const MAX_PORTABLE_SEGMENT_BYTES = 255;
const SECRET_CONTENT = [
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/iu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{12,}\b/u,
  /\bAuthorization\s*:\s*Bearer\s+\S+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
] as const;
const SNAPSHOT_POLICY_CONTRACT = {
  pathPolicyVersion: 'source-path-policy/1',
  secretContentPolicyVersion: 'source-secret-content-policy/1',
  portableCaseCollisionPolicy: 'unicode-nfc-lowercase/1',
  portablePathPolicy: 'nfc-windows-safe-path/1',
  gitProbePolicy: 'read-only-no-fsmonitor-no-filters/1',
  minimumGitVersion: SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION,
} as const;

export async function inspectSourceSnapshot(
  options: InspectSourceSnapshotOptions = {},
): Promise<SourceSnapshotDryRunV1> {
  const first = await inspectSourceSnapshotOnce(options);
  if (first.reasonCode === 'isolated_loop_not_git'
    || first.reasonCode === 'isolated_loop_git_unsupported'
    || first.reasonCode === 'source_snapshot_untrusted') return first;
  const second = await inspectSourceSnapshotOnce(options);
  return first.dryRunDigest === second.dryRunDigest
    ? second
    : blockedDryRun('source_snapshot_untrusted', first.policyDigest);
}

async function inspectSourceSnapshotOnce(
  options: InspectSourceSnapshotOptions,
): Promise<SourceSnapshotDryRunV1> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const limits = resolveLimits(options.limits);
  const policyDigest = digestSourceSnapshotPolicy(limits);
  const selected = normalizeInputPaths(options.selectedUntrackedPaths ?? []);
  const required = normalizeInputPaths(options.requiredGatePaths ?? []);

  try {
    const gitVersion = await runGit(cwd, ['--version']);
    if (gitVersion.exitCode !== 0
      || !isSupportedGitVersion(
        gitVersion.stdout.toString('utf8'),
      )) {
      return blockedDryRun(
        'isolated_loop_git_unsupported',
        policyDigest,
      );
    }
    const rootResult = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (rootResult.exitCode !== 0) {
      return blockedDryRun('isolated_loop_not_git', policyDigest);
    }
    const root = await realpath(singleLine(rootResult.stdout));
    const requestedPath = await realpath(cwd);
    if (!isInside(root, requestedPath)) {
      return blockedDryRun('source_snapshot_untrusted', policyDigest);
    }
    const repositoryRelativeCwd = canonicalRepositoryRelativePath(root, requestedPath);
    const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    if (inside.exitCode !== 0 || singleLine(inside.stdout) !== 'true') {
      return blockedDryRun('isolated_loop_not_git', policyDigest);
    }
    const configuredFilters = await runGit(root, [
      'config', '--local', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$',
    ]);
    if (configuredFilters.exitCode === 0) {
      return blockedDryRun('source_snapshot_untrusted', policyDigest);
    }
    if (configuredFilters.exitCode !== 1) {
      return blockedDryRun('source_snapshot_untrusted', policyDigest);
    }

    const [base, tree, branch, commonDirResult, objectFormat, index, tracked,
      trackedFlags, stagedNames, unstagedNames, untracked] = await Promise.all([
      runGit(root, ['rev-parse', '--verify', 'HEAD']),
      runGit(root, ['rev-parse', '--verify', 'HEAD^{tree}']),
      runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(root, ['rev-parse', '--git-common-dir']),
      runGit(root, ['rev-parse', '--show-object-format']),
      runGit(root, ['ls-files', '--stage', '-z']),
      runGit(root, ['ls-files', '--cached', '-z']),
      runGit(root, ['ls-files', '-v', '-z']),
      runGit(root, [
        'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
        '--name-only', '-z', '--cached', 'HEAD', '--',
      ]),
      runGit(root, [
        'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--',
      ]),
      runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    if ([base, tree, commonDirResult, objectFormat, index, tracked, trackedFlags,
      stagedNames, unstagedNames, untracked].some((result) => result.exitCode !== 0)
      || (branch.exitCode !== 0 && branch.exitCode !== 1)) {
      return blockedDryRun('source_snapshot_untrusted', policyDigest);
    }

    const baseCommit = singleLine(base.stdout);
    const headTreeObjectId = singleLine(tree.stdout);
    if (!isGitObjectId(baseCommit) || !isGitObjectId(headTreeObjectId)) {
      return blockedDryRun('source_snapshot_untrusted', policyDigest);
    }

    const commonDirValue = singleLine(commonDirResult.stdout);
    const commonDir = await realpath(isAbsolute(commonDirValue)
      ? commonDirValue
      : resolve(root, commonDirValue));
    const [rootStat, commonDirStat] = await Promise.all([
      stat(root, { bigint: true }),
      stat(commonDir, { bigint: true }),
    ]);
    const repositoryIdentity = canonicalDigest('wukong/repository-identity/v1', {
      commonDirPathDigest: canonicalDigest('wukong/private-path/v1', commonDir),
      device: commonDirStat.dev.toString(),
      inode: commonDirStat.ino.toString(),
      objectFormat: singleLine(objectFormat.stdout),
    });
    const sourceWorkspaceIdentity = canonicalDigest('wukong/source-workspace-identity/v1', {
      workspacePathDigest: canonicalDigest('wukong/private-path/v1', root),
      device: rootStat.dev.toString(),
      inode: rootStat.ino.toString(),
      repositoryIdentity,
    });

    const indexEntries = parseIndexEntries(index.stdout);
    const trackedPaths = new Set(parseNulPaths(tracked.stdout));
    const changedTrackedPaths = [...new Set([
      ...parseNulPaths(stagedNames.stdout),
      ...parseNulPaths(unstagedNames.stdout),
    ])].toSorted(comparePaths);
    const changedTrackedSet = new Set(changedTrackedPaths);
    const untrackedPaths = parseNulPaths(untracked.stdout)
      .filter((path) => !changedTrackedSet.has(path))
      .toSorted(comparePaths);
    const untrackedSet = new Set(untrackedPaths);
    const exclusions = new Map<string, MutableExclusion>();
    let sourceUntrusted = false;

    for (const invalid of selected.invalid) {
      addExclusion(exclusions, invalid, 'policy_denied', false);
    }
    for (const invalid of required.invalid) {
      addExclusion(exclusions, invalid, 'policy_denied', true);
    }

    for (const [path, entries] of indexEntries) {
      const hardExclusion = hardPathExclusion(path);
      if (hardExclusion !== null) {
        addExclusion(exclusions, path, hardExclusion, required.paths.has(path));
        sourceUntrusted = true;
      } else if (entries.some((entry) => entry.mode === '120000')) {
        addExclusion(exclusions, path, 'symlink', required.paths.has(path));
        sourceUntrusted = true;
      } else if (entries.some((entry) => entry.mode === '160000')) {
        addExclusion(exclusions, path, 'unsupported_file_type', required.paths.has(path));
        sourceUntrusted = true;
      }
      if (entries.some((entry) => entry.stage !== 0)) sourceUntrusted = true;
    }
    for (const path of parseUnsupportedTrackedFlags(trackedFlags.stdout)) {
      addExclusion(exclusions, path, 'policy_denied', required.paths.has(path));
      sourceUntrusted = true;
    }

    const trackedProjection: unknown[] = [];
    for (const path of changedTrackedPaths) {
      const pathRequired = required.paths.has(path);
      const hardExclusion = hardPathExclusion(path);
      if (hardExclusion !== null) {
        addExclusion(exclusions, path, hardExclusion, pathRequired);
        sourceUntrusted = true;
        continue;
      }
      const entries = indexEntries.get(path) ?? [];
      if (entries.some((entry) => entry.stage !== 0)) {
        addExclusion(exclusions, path, 'policy_denied', pathRequired);
        sourceUntrusted = true;
        continue;
      }
      const indexed = await inspectIndexPath(root, entries, limits.maxTrackedFileBytes);
      if (indexed.reason !== null) {
        addExclusion(exclusions, path, indexed.reason, pathRequired);
        sourceUntrusted = true;
        continue;
      }
      const worktree = await inspectWorktreePath(root, path, limits.maxTrackedFileBytes);
      const indexedSymlink = entries.some((entry) => entry.mode === '120000');
      const indexedGitlink = entries.some((entry) => entry.mode === '160000');
      if (worktree.exclusionReason !== null) {
        addExclusion(exclusions, path, worktree.exclusionReason, pathRequired);
        sourceUntrusted = true;
        continue;
      }
      if (worktree.fileType === 'symlink' || indexedSymlink) {
        addExclusion(exclusions, path, 'symlink', pathRequired);
        sourceUntrusted = true;
        continue;
      }
      if (worktree.fileType === 'directory' || worktree.fileType === 'other' || indexedGitlink) {
        addExclusion(exclusions, path, 'unsupported_file_type', pathRequired);
        sourceUntrusted = true;
        continue;
      }
      trackedProjection.push({ path, index: entries, worktree });
    }

    const untrackedCandidates = await buildUntrackedCandidates({
      root,
      paths: untrackedPaths.slice(0, limits.maxDiscoveredUntrackedFiles),
      selected: selected.paths,
      maxFileBytes: limits.maxUntrackedFileBytes,
    });
    const includedUntracked: SnapshotFileRefV1[] = [];
    let includedUntrackedBytes = 0;
    for (const path of selected.paths) {
      const pathRequired = required.paths.has(path);
      if (changedTrackedSet.has(path)) continue;
      const hardExclusion = hardPathExclusion(path);
      if (hardExclusion !== null) {
        addExclusion(exclusions, path, hardExclusion, pathRequired);
        continue;
      }
      if (!untrackedSet.has(path)) {
        const ignored = await runGit(root, ['check-ignore', '--quiet', '--no-index', '--', path]);
        addExclusion(
          exclusions,
          path,
          ignored.exitCode === 0 ? 'ignored_or_generated' : 'policy_denied',
          pathRequired,
        );
        continue;
      }
      if (includedUntracked.length >= limits.maxUntrackedFiles) {
        addExclusion(exclusions, path, 'oversize', pathRequired);
        continue;
      }
      const inspected = await inspectSelectedUntracked(root, path, limits.maxUntrackedFileBytes);
      if (!inspected.ok) {
        addExclusion(exclusions, path, inspected.reason, pathRequired);
        continue;
      }
      if (includedUntrackedBytes + inspected.ref.sizeBytes > limits.maxUntrackedTotalBytes) {
        addExclusion(exclusions, path, 'oversize', pathRequired);
        continue;
      }
      includedUntrackedBytes += inspected.ref.sizeBytes;
      includedUntracked.push(inspected.ref);
    }

    for (const path of required.paths) {
      const existing = exclusions.get(path);
      if (existing !== undefined) {
        existing.requiredByFrozenGate = true;
        continue;
      }
      if (trackedPaths.has(path) || includedUntracked.some(
        (entry) => entry.canonicalRelativePath === path,
      )) continue;
      const reason = hardPathExclusion(path)
        ?? (untrackedSet.has(path) ? 'policy_denied' : await missingPathReason(root, path));
      addExclusion(exclusions, path, reason, true);
    }

    const frozenExclusions = [...exclusions.values()]
      .map(buildExclusion)
      .toSorted((left, right) => comparePaths(left.pathProjection, right.pathProjection));
    const sortedUntracked = includedUntracked.toSorted(
      (left, right) => comparePaths(left.canonicalRelativePath, right.canonicalRelativePath),
    );
    const snapshotCore = {
      schemaVersion: 1 as const,
      snapshotPolicyVersion: SOURCE_SNAPSHOT_POLICY_VERSION,
      snapshotLimits: limits,
      snapshotPolicyDigest: policyDigest,
      sourceWorkspaceIdentity,
      repositoryIdentity,
      repositoryRelativeCwd,
      baseCommit,
      branchName: branch.exitCode === 0 ? singleLine(branch.stdout) : null,
      headTreeDigest: canonicalDigest('wukong/git-head-tree/v1', {
        objectFormat: singleLine(objectFormat.stdout),
        objectId: headTreeObjectId,
      }),
      indexDigest: canonicalDigest('wukong/git-index/v1', index.stdout.toString('base64')),
      trackedDeltaDigest: trackedProjection.length === 0
        ? null
        : canonicalDigest('wukong/source-tracked-delta/v1', trackedProjection),
      includedUntracked: sortedUntracked,
      exclusions: frozenExclusions,
    };
    const proposedSnapshot: SourceSnapshotV1 = {
      ...snapshotCore,
      snapshotDigest: canonicalDigest('wukong/source-snapshot/v1', snapshotCore),
    };
    const dependencyExcluded = frozenExclusions.some((entry) => entry.requiredByFrozenGate);
    const selectionExcluded = selected.invalid.length > 0
      || [...selected.paths].some((path) => exclusions.has(path));
    const reasonCode = sourceUntrusted
      ? 'source_snapshot_untrusted'
      : dependencyExcluded
        ? 'snapshot_dependency_excluded'
        : selectionExcluded ? 'snapshot_selection_excluded' : null;
    return finishDryRun({
      status: reasonCode === null ? 'ready' : 'blocked',
      reasonCode,
      proposedSnapshot,
      untrackedCandidates,
      untrackedCandidateCount: untrackedPaths.length,
      untrackedDiscoveryTruncated: untrackedPaths.length > limits.maxDiscoveredUntrackedFiles,
    }, policyDigest);
  } catch {
    return blockedDryRun('source_snapshot_untrusted', policyDigest);
  }
}

export function validateSourceSnapshot(snapshot: SourceSnapshotV1): boolean {
  if (snapshot.schemaVersion !== 1
    || snapshot.snapshotPolicyVersion !== SOURCE_SNAPSHOT_POLICY_VERSION
    || !validateSnapshotLimits(snapshot.snapshotLimits)
    || digestSourceSnapshotPolicy(snapshot.snapshotLimits)
      !== snapshot.snapshotPolicyDigest
    || !isSha256Digest(snapshot.snapshotPolicyDigest)
    || !isGitObjectId(snapshot.baseCommit)
    || (snapshot.repositoryRelativeCwd !== '.'
      && normalizeRelativePath(snapshot.repositoryRelativeCwd)
        !== snapshot.repositoryRelativeCwd)) return false;
  if (!isSortedUnique(snapshot.includedUntracked.map((entry) => entry.canonicalRelativePath))) {
    return false;
  }
  if (!isSortedUnique(snapshot.exclusions.map((entry) => entry.pathProjection))) return false;
  for (const entry of snapshot.includedUntracked) {
    const { fileRefDigest, ...core } = entry;
    if (normalizeRelativePath(entry.canonicalRelativePath) !== entry.canonicalRelativePath
      || canonicalDigest('wukong/snapshot-file-ref/v1', core) !== fileRefDigest) return false;
  }
  for (const entry of snapshot.exclusions) {
    const { exclusionDigest, ...core } = entry;
    if (canonicalDigest('wukong/snapshot-exclusion/v1', core) !== exclusionDigest) return false;
  }
  const { snapshotDigest, ...core } = snapshot;
  return canonicalDigest('wukong/source-snapshot/v1', core) === snapshotDigest;
}

export function sourceSnapshotMatches(left: SourceSnapshotV1, right: SourceSnapshotV1): boolean {
  return left.snapshotDigest === right.snapshotDigest;
}

function finishDryRun(
  input: Omit<
    SourceSnapshotDryRunV1,
    'schemaVersion' | 'policyVersion' | 'policyDigest' | 'dryRunDigest'
  >,
  policyDigest: string,
): SourceSnapshotDryRunV1 {
  const core = {
    schemaVersion: 1 as const,
    policyVersion: SOURCE_SNAPSHOT_POLICY_VERSION,
    policyDigest,
    ...input,
  };
  return {
    ...core,
    dryRunDigest: canonicalDigest('wukong/source-snapshot-dry-run/v1', core),
  };
}

function blockedDryRun(
  reasonCode: Extract<
    SourceSnapshotReasonCodeV1,
    | 'isolated_loop_not_git'
    | 'isolated_loop_git_unsupported'
    | 'source_snapshot_untrusted'
  >,
  policyDigest: string,
): SourceSnapshotDryRunV1 {
  return finishDryRun({
    status: 'blocked',
    reasonCode,
    proposedSnapshot: null,
    untrackedCandidates: [],
    untrackedCandidateCount: 0,
    untrackedDiscoveryTruncated: false,
  }, policyDigest);
}

export function isSupportedGitVersion(value: string): boolean {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:[.\s-].*)?$/u
    .exec(value.trim());
  if (match === null) return false;
  const actual = [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3] ?? '0', 10),
  ];
  const minimum = SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function resolveLimits(input: Partial<SourceSnapshotLimitsV1> | undefined): SourceSnapshotLimitsV1 {
  const limits = { ...SOURCE_SNAPSHOT_LIMITS, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Source snapshot limits must be positive integers.');
    }
  }
  return limits;
}

export function digestSourceSnapshotPolicy(limits: SourceSnapshotLimitsV1): string {
  return canonicalDigest('wukong/source-snapshot-policy/v1', {
    policyVersion: SOURCE_SNAPSHOT_POLICY_VERSION,
    contract: SNAPSHOT_POLICY_CONTRACT,
    limits,
  });
}

function validateSnapshotLimits(value: unknown): value is SourceSnapshotLimitsV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).toSorted().join(',') !== [
      'maxDiscoveredUntrackedFiles',
      'maxTrackedFileBytes',
      'maxUntrackedFileBytes',
      'maxUntrackedFiles',
      'maxUntrackedTotalBytes',
    ].join(',')) return false;
  return Object.values(value).every(
    (entry) => Number.isSafeInteger(entry) && Number(entry) > 0,
  );
}

function canonicalRepositoryRelativePath(root: string, cwd: string): string {
  const path = relative(root, cwd);
  if (path === '') return '.';
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
}

function normalizeInputPaths(values: readonly string[]): {
  readonly paths: Set<string>;
  readonly invalid: readonly string[];
} {
  const paths = new Set<string>();
  const invalid: string[] = [];
  for (const value of values) {
    const normalized = normalizeRelativePath(value);
    if (normalized === null) {
      invalid.push(`invalid:${canonicalDigest('wukong/invalid-source-path/v1', value)}`);
    } else {
      paths.add(normalized);
    }
  }
  return { paths, invalid };
}

function normalizeRelativePath(value: string): string | null {
  if (value.length === 0 || value.includes('\0') || isAbsolute(value)) return null;
  const normalized = (process.platform === 'win32' ? value.replaceAll('\\', '/') : value)
    .replace(/^\.\//u, '');
  if (normalized !== normalized.normalize('NFC')
    || normalized.includes('\\')
    || /[\u0000-\u001F\u007F]/u.test(normalized)
    || Buffer.byteLength(normalized, 'utf8') > MAX_PORTABLE_PATH_BYTES) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) =>
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.toLowerCase() === '.git'
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || WINDOWS_RESERVED_CHARACTERS.test(segment)
    || WINDOWS_RESERVED_DEVICE.test(segment)
    || Buffer.byteLength(segment, 'utf8') > MAX_PORTABLE_SEGMENT_BYTES)) {
    return null;
  }
  return normalized;
}

function hardPathExclusion(path: string): SnapshotExclusionReasonV1 | null {
  if (PRIVATE_STATE.test(path)) return 'policy_denied';
  if (GENERATED.test(path)) return 'ignored_or_generated';
  if (SECRET_PATH_SEGMENT.test(path) || SECRET_FILE.test(path)) return 'secret_or_credential';
  return null;
}

function addExclusion(
  exclusions: Map<string, MutableExclusion>,
  pathProjection: string,
  reason: SnapshotExclusionReasonV1,
  requiredByFrozenGate: boolean,
): void {
  const existing = exclusions.get(pathProjection);
  if (existing !== undefined) {
    existing.requiredByFrozenGate ||= requiredByFrozenGate;
    return;
  }
  exclusions.set(pathProjection, { pathProjection, reason, requiredByFrozenGate });
}

function buildExclusion(input: MutableExclusion): SnapshotExclusionV1 {
  const core = {
    pathProjection: input.pathProjection,
    reason: input.reason,
    requiredByFrozenGate: input.requiredByFrozenGate,
  };
  return {
    ...core,
    exclusionDigest: canonicalDigest('wukong/snapshot-exclusion/v1', core),
  };
}

async function buildUntrackedCandidates(input: {
  readonly root: string;
  readonly paths: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly maxFileBytes: number;
}): Promise<SnapshotUntrackedCandidateV1[]> {
  const candidates = await Promise.all(input.paths.map(async (path) => {
    let sizeBytes: number | null = null;
    let exclusionReason = hardPathExclusion(path);
    try {
      const absolutePath = resolve(input.root, path);
      if (!isInside(input.root, absolutePath)) throw new Error('Candidate path escaped workspace.');
      const info = await lstat(absolutePath);
      sizeBytes = info.isFile() ? info.size : null;
      if (info.isSymbolicLink()) exclusionReason = 'symlink';
      else if (!info.isFile()) exclusionReason = 'unsupported_file_type';
      else if (info.size > input.maxFileBytes) exclusionReason = 'oversize';
      else if (!isInside(input.root, await realpath(absolutePath))) exclusionReason = 'policy_denied';
    } catch {
      exclusionReason = 'policy_denied';
    }
    const core = {
      pathProjection: path,
      sizeBytes,
      selected: input.selected.has(path),
      eligibility: exclusionReason === null ? 'eligible' as const : 'excluded' as const,
      exclusionReason,
    };
    return {
      ...core,
      candidateDigest: canonicalDigest('wukong/snapshot-untracked-candidate/v1', core),
    };
  }));
  return candidates.toSorted((left, right) => comparePaths(
    left.pathProjection,
    right.pathProjection,
  ));
}

async function inspectSelectedUntracked(
  root: string,
  path: string,
  maxFileBytes: number,
): Promise<
  { readonly ok: true; readonly ref: SnapshotFileRefV1 }
  | { readonly ok: false; readonly reason: SnapshotExclusionReasonV1 }
> {
  const absolutePath = resolve(root, path);
  if (!isInside(root, absolutePath)) return { ok: false, reason: 'policy_denied' };
  let info;
  try {
    info = await lstat(absolutePath);
  } catch {
    return { ok: false, reason: 'policy_denied' };
  }
  if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!info.isFile()) return { ok: false, reason: 'unsupported_file_type' };
  if (info.size > maxFileBytes) return { ok: false, reason: 'oversize' };
  const resolvedPath = await realpath(absolutePath);
  if (!isInside(root, resolvedPath)) return { ok: false, reason: 'policy_denied' };
  const content = await readFile(resolvedPath);
  if (content.byteLength > maxFileBytes) return { ok: false, reason: 'oversize' };
  if (SECRET_CONTENT.some((pattern) => pattern.test(content.toString('utf8')))) {
    return { ok: false, reason: 'secret_or_credential' };
  }
  const core = {
    canonicalRelativePath: path,
    mode: gitFileMode(info.mode),
    sizeBytes: content.byteLength,
    contentDigest: digestBytes('wukong/snapshot-file-content/v1', content),
  };
  return {
    ok: true,
    ref: {
      ...core,
      fileRefDigest: canonicalDigest('wukong/snapshot-file-ref/v1', core),
    },
  };
}

async function inspectIndexPath(
  root: string,
  entries: readonly IndexEntry[],
  maxFileBytes: number,
): Promise<{ readonly reason: SnapshotExclusionReasonV1 | null }> {
  if (entries.length === 0) return { reason: null };
  if (entries.length !== 1
    || entries[0]?.stage !== 0
    || (entries[0].mode !== '100644' && entries[0].mode !== '100755')) {
    return { reason: 'unsupported_file_type' };
  }
  const result = await runGit(root, ['cat-file', 'blob', entries[0].objectId]);
  if (result.exitCode !== 0) return { reason: 'policy_denied' };
  if (result.stdout.byteLength > maxFileBytes) return { reason: 'oversize' };
  if (SECRET_CONTENT.some((pattern) => pattern.test(result.stdout.toString('utf8')))) {
    return { reason: 'secret_or_credential' };
  }
  return { reason: null };
}

async function inspectWorktreePath(
  root: string,
  path: string,
  maxFileBytes: number,
): Promise<WorktreePathState> {
  const absolutePath = resolve(root, path);
  if (!isInside(root, absolutePath)) {
    return {
      presence: 'present',
      fileType: 'other',
      mode: null,
      sizeBytes: null,
      contentDigest: null,
      exclusionReason: 'policy_denied',
    };
  }
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      return {
        presence: 'present',
        fileType: 'symlink',
        mode: null,
        sizeBytes: info.size,
        contentDigest: null,
        exclusionReason: 'symlink',
      };
    }
    if (info.isDirectory()) {
      return {
        presence: 'present',
        fileType: 'directory',
        mode: null,
        sizeBytes: null,
        contentDigest: null,
        exclusionReason: 'unsupported_file_type',
      };
    }
    if (!info.isFile()) {
      return {
        presence: 'present',
        fileType: 'other',
        mode: null,
        sizeBytes: null,
        contentDigest: null,
        exclusionReason: 'unsupported_file_type',
      };
    }
    if (info.size > maxFileBytes) {
      return {
        presence: 'present',
        fileType: 'regular',
        mode: gitFileMode(info.mode),
        sizeBytes: info.size,
        contentDigest: null,
        exclusionReason: 'oversize',
      };
    }
    const resolvedPath = await realpath(absolutePath);
    if (!isInside(root, resolvedPath)) {
      return {
        presence: 'present',
        fileType: 'other',
        mode: null,
        sizeBytes: null,
        contentDigest: null,
        exclusionReason: 'policy_denied',
      };
    }
    const content = await readFile(resolvedPath);
    if (content.byteLength > maxFileBytes) {
      return {
        presence: 'present',
        fileType: 'regular',
        mode: gitFileMode(info.mode),
        sizeBytes: content.byteLength,
        contentDigest: null,
        exclusionReason: 'oversize',
      };
    }
    if (SECRET_CONTENT.some((pattern) => pattern.test(content.toString('utf8')))) {
      return {
        presence: 'present',
        fileType: 'regular',
        mode: gitFileMode(info.mode),
        sizeBytes: content.byteLength,
        contentDigest: null,
        exclusionReason: 'secret_or_credential',
      };
    }
    return {
      presence: 'present',
      fileType: 'regular',
      mode: gitFileMode(info.mode),
      sizeBytes: content.byteLength,
      contentDigest: digestBytes('wukong/snapshot-file-content/v1', content),
      exclusionReason: null,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        presence: 'absent',
        fileType: null,
        mode: null,
        sizeBytes: null,
        contentDigest: null,
        exclusionReason: null,
      };
    }
    throw error;
  }
}

async function missingPathReason(root: string, path: string): Promise<SnapshotExclusionReasonV1> {
  const ignored = await runGit(root, ['check-ignore', '--quiet', '--no-index', '--', path]);
  if (ignored.exitCode === 0) return 'ignored_or_generated';
  try {
    const info = await lstat(resolve(root, path));
    if (info.isSymbolicLink()) return 'symlink';
    if (!info.isFile()) return 'unsupported_file_type';
  } catch {
    return 'policy_denied';
  }
  return 'policy_denied';
}

function parseIndexEntries(input: Buffer): Map<string, IndexEntry[]> {
  const entries = new Map<string, IndexEntry[]>();
  for (const record of parseNulRecords(input)) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('Invalid Git index entry.');
    const [mode, objectId, stageText, extra] = record.slice(0, tab).split(' ');
    const path = normalizeRelativePath(record.slice(tab + 1));
    const stage = Number(stageText);
    if (path === null || mode === undefined || objectId === undefined || extra !== undefined
      || !Number.isInteger(stage)) throw new Error('Invalid Git index entry.');
    const current = entries.get(path) ?? [];
    current.push({ mode, objectId, stage });
    entries.set(path, current);
  }
  for (const current of entries.values()) {
    current.sort((left, right) => left.stage - right.stage);
  }
  return entries;
}

function parseNulPaths(input: Buffer): string[] {
  const paths = parseNulRecords(input).map((record) => {
    const normalized = normalizeRelativePath(record);
    if (normalized === null) throw new Error('Git returned an unsafe path.');
    return normalized;
  });
  assertNoPathCollisions(paths);
  return paths;
}

function assertNoPathCollisions(paths: readonly string[]): void {
  const exact = new Set<string>();
  const portable = new Map<string, string>();
  for (const path of paths) {
    const portableKey = path.normalize('NFC').toLowerCase();
    const existing = portable.get(portableKey);
    if (exact.has(path) || (existing !== undefined && existing !== path)) {
      throw new Error('Git paths collide after source snapshot normalization.');
    }
    exact.add(path);
    portable.set(portableKey, path);
  }
}

function parseUnsupportedTrackedFlags(input: Buffer): string[] {
  return parseNulRecords(input).flatMap((record) => {
    if (record.length < 3 || record[1] !== ' ') {
      throw new Error('Invalid Git tracked flag entry.');
    }
    const path = normalizeRelativePath(record.slice(2));
    if (path === null) throw new Error('Git returned an unsafe path.');
    const tag = record[0]!;
    return tag === 'S' || tag === tag.toLowerCase() ? [path] : [];
  });
}

function parseNulRecords(input: Buffer): string[] {
  const text = input.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(input)) {
    throw new Error('Git returned a path that is not valid UTF-8.');
  }
  if (text.length === 0) return [];
  const records = text.split('\0');
  if (records.at(-1) !== '') throw new Error('Git returned an unterminated path record.');
  records.pop();
  return records;
}

function singleLine(input: Buffer): string {
  return input.toString('utf8').trim();
}

function isGitObjectId(value: string): boolean {
  return /^[a-f0-9]{40,64}$/u.test(value);
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function gitFileMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o100644 : 0o100755;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || comparePaths(values[index - 1]!, value) < 0,
  );
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestBytes(domain: string, value: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')}`;
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      'git',
      [
        '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false',
        '-c', `core.attributesFile=${GIT_NULL_DEVICE}`,
        '-c', 'maintenance.auto=false',
        ...args,
      ],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: MAX_GIT_RUNTIME_MS,
        env: sanitizedGitEnvironment(),
      },
      (error, stdout) => {
        if (error === null) {
          resolveResult({
            exitCode: 0,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          });
          return;
        }
        if (typeof error.code !== 'number') {
          rejectResult(error);
          return;
        }
        resolveResult({
          exitCode: error.code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        });
      },
    );
  });
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
