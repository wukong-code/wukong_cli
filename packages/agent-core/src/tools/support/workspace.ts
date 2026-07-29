/**
 * WorkspaceConfig — defines the roots that tools are allowed to access.
 *
 * Injected through each Tool's constructor. Not passed through Runtime:
 * the Runtime keeps a small fixed shape and workspace limits live on
 * the Tool side.
 *
 * Paths should already be canonicalized lexically (absolute + normalized);
 * callers are responsible for normalizing before constructing this config.
 */

import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  canonicalDigest,
  validateCandidateBootstrapPlan,
  type CandidateBootstrapPlanV1,
} from '@wukong/verification';

import {
  CANDIDATE_WRITER_FIXED_DENIED_SEGMENTS,
  CandidateWorkspaceFileBackend,
  CandidateWorkspaceFileBackendError,
  type CandidateWorkspaceFileIO,
} from './candidate-workspace-file-backend';

export interface WorkspaceConfig {
  /** Primary workspace directory (absolute, canonicalized). */
  readonly workspaceDir: string;
  /** Extra allowed roots (e.g. `--add-dir` CLI flag). */
  readonly additionalDirs: readonly string[];
  /**
   * Candidate worktrees use workspace-only mode so even an absolute path
   * cannot opt out of the workspace boundary.
   */
  readonly accessMode?: 'default' | 'workspace-only';
}

export type WorkspaceGuardOperation = 'read' | 'write' | 'search';

interface CandidateWorkspaceGuardBinding {
  readonly rootDirectory: string;
  readonly expectedRootIdentity: string;
  readonly bootstrapPlanDigest: string | null;
  readonly generatedPathScopes: readonly string[];
  readonly validateAuthority?: () => Promise<void>;
  readonly fileBackend: CandidateWorkspaceFileBackend;
}

interface ExistingPathIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly isDirectory: boolean;
}

const candidateWorkspaceGuards =
  new WeakMap<WorkspaceConfig, CandidateWorkspaceGuardBinding>();
const candidateWorkspacePathPolicies =
  new WeakMap<CandidateWorkspacePathPolicyV1, {
    readonly bootstrapPlanDigest: string;
    readonly generatedPathScopes: readonly string[];
  }>();
const PROTECTED_SEGMENTS = new Set(['.git', '.wukong']);
const FIXED_WRITER_DENIED_SEGMENTS = new Set(
  CANDIDATE_WRITER_FIXED_DENIED_SEGMENTS,
);

export class WorkspacePathGuardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspacePathGuardError';
  }
}

/**
 * Opaque, process-local binding between a Candidate Writer and the exact
 * confirmed bootstrap plan that produced its dependency tree. The actual
 * generated paths live only in a WeakMap, so cloning or serializing the
 * workspace cannot recreate this authority.
 */
export class CandidateWorkspacePathPolicyV1 {
  private constructor(bootstrapPlan: CandidateBootstrapPlanV1) {
    if (!validateCandidateBootstrapPlan(bootstrapPlan)) {
      throw new WorkspacePathGuardError(
        'The candidate workspace path policy plan is invalid.',
      );
    }
    const generatedPathScopes = Object.freeze([
      ...new Set(bootstrapPlan.steps.flatMap(
        (step) => step.generatedPathScopes,
      )),
    ].toSorted());
    candidateWorkspacePathPolicies.set(this, {
      bootstrapPlanDigest: bootstrapPlan.bootstrapPlanDigest,
      generatedPathScopes,
    });
    Object.freeze(this);
  }

  static create(
    bootstrapPlan: CandidateBootstrapPlanV1,
  ): CandidateWorkspacePathPolicyV1 {
    return new CandidateWorkspacePathPolicyV1(bootstrapPlan);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      schemaVersion: 1,
      bootstrapPlanDigest: '[REDACTED]',
      generatedPathScopes: '[PRIVATE]',
    });
  }
}

export function assertCandidateWorkspacePathPolicyPlan(
  policy: CandidateWorkspacePathPolicyV1,
  bootstrapPlanDigest: string,
): void {
  const binding = candidateWorkspacePathPolicies.get(policy);
  if (!(policy instanceof CandidateWorkspacePathPolicyV1)
    || binding === undefined
    || binding.bootstrapPlanDigest !== bootstrapPlanDigest) {
    throw new WorkspacePathGuardError(
      'The candidate workspace path policy is stale or unauthentic.',
    );
  }
}

export function bindCandidateWorkspaceGuard(
  workspace: WorkspaceConfig,
  input: {
    readonly rootDirectory: string;
    readonly expectedRootIdentity: string;
    readonly pathPolicy?: CandidateWorkspacePathPolicyV1;
    /**
     * Optional live lease/fencing check. Candidate Agent tools bind this so
     * every individual I/O operation revalidates authority before and after
     * touching the worktree.
     */
    readonly validateAuthority?: () => Promise<void>;
  },
): void {
  const pathPolicy = input.pathPolicy === undefined
    ? null
    : candidateWorkspacePathPolicies.get(input.pathPolicy);
  if (workspace.accessMode !== 'workspace-only'
    || !isAbsolute(input.rootDirectory)
    || !isDigest(input.expectedRootIdentity)
    || (input.pathPolicy !== undefined
      && (!(input.pathPolicy instanceof CandidateWorkspacePathPolicyV1)
        || pathPolicy === undefined))
    || (input.validateAuthority !== undefined
      && typeof input.validateAuthority !== 'function')
    || candidateWorkspaceGuards.has(workspace)) {
    throw new WorkspacePathGuardError(
      'The candidate workspace guard binding is invalid.',
    );
  }
  candidateWorkspaceGuards.set(workspace, {
    rootDirectory: resolve(input.rootDirectory),
    expectedRootIdentity: input.expectedRootIdentity,
    bootstrapPlanDigest: pathPolicy?.bootstrapPlanDigest ?? null,
    generatedPathScopes:
      pathPolicy?.generatedPathScopes ?? Object.freeze([]),
    validateAuthority: input.validateAuthority,
    fileBackend: new CandidateWorkspaceFileBackend({
      rootDirectory: resolve(input.rootDirectory),
      expectedRootIdentity: input.expectedRootIdentity,
      generatedPathScopes:
        pathPolicy?.generatedPathScopes ?? Object.freeze([]),
    }),
  });
}

/**
 * Synchronous pre-dispatch check used while resolving a tool invocation.
 * The descriptor backend repeats it before filesystem access.
 */
export function assertWorkspacePathPolicyAllows(
  workspace: WorkspaceConfig,
  path: string,
  operation: WorkspaceGuardOperation,
): void {
  const binding = candidateWorkspaceGuards.get(workspace);
  if (workspace.accessMode !== 'workspace-only') return;
  if (binding === undefined) {
    throw new WorkspacePathGuardError(
      'The isolated candidate workspace capability is missing.',
    );
  }
  assertCandidateGeneratedPathDenied(binding, path, operation);
}

export async function withWorkspacePathGuard<Result>(
  workspace: WorkspaceConfig,
  path: string,
  operation: WorkspaceGuardOperation,
  callback: (io?: CandidateWorkspaceFileIO) => Promise<Result>,
): Promise<Result> {
  const binding = candidateWorkspaceGuards.get(workspace);
  if (workspace.accessMode !== 'workspace-only') return callback(undefined);
  if (binding === undefined) {
    throw new WorkspacePathGuardError(
      'The isolated candidate workspace capability is missing.',
    );
  }
  await binding.validateAuthority?.();
  assertCandidateGeneratedPathDenied(binding, path, operation);
  const before = await inspectCandidatePath(binding, path, operation);
  try {
    return await binding.fileBackend.run(
      path,
      operation,
      (io) => callback(io),
    );
  } finally {
    try {
      await inspectCandidatePath(binding, path, operation, before);
    } finally {
      await binding.validateAuthority?.();
    }
  }
}

function assertCandidateGeneratedPathDenied(
  binding: CandidateWorkspaceGuardBinding,
  path: string,
  operation: WorkspaceGuardOperation,
): void {
  if (!isAbsolute(path) || resolve(path) !== path
    || !isInside(binding.rootDirectory, path)) {
    return;
  }
  const candidateRelativePath = relative(
    binding.rootDirectory,
    path,
  ).split(sep).join('/');
  if (candidateRelativePath === '') return;
  const foldedSegments = candidateRelativePath
    .split('/')
    .map((segment) => segment.normalize('NFC').toLowerCase());
  const inFixedScope = foldedSegments.some((segment) =>
    FIXED_WRITER_DENIED_SEGMENTS.has(segment));
  const foldedPath = candidateRelativePath.normalize('NFC').toLowerCase();
  const inPlanScope = binding.generatedPathScopes.some((scope) => {
    const foldedScope = scope.normalize('NFC').toLowerCase();
    return foldedPath === foldedScope
      || foldedPath.startsWith(`${foldedScope}/`);
  });
  if (!inFixedScope && !inPlanScope) return;
  throw new CandidateWorkspaceFileBackendError(
    operation === 'search'
      ? 'candidate_atomic_search_scope_denied'
      : 'candidate_atomic_generated_scope_denied',
    'Candidate Writer tools cannot access bootstrap-owned generated paths.',
  );
}

async function inspectCandidatePath(
  binding: CandidateWorkspaceGuardBinding,
  path: string,
  operation: WorkspaceGuardOperation,
  before?: readonly ExistingPathIdentity[],
): Promise<readonly ExistingPathIdentity[]> {
  const root = binding.rootDirectory;
  if (!isAbsolute(path) || resolve(path) !== path || !isInside(root, path)) {
    throw new WorkspacePathGuardError(
      'The candidate file path escaped its guarded root.',
    );
  }
  await assertCandidateRoot(binding);
  const relativePath = relative(root, path);
  const segments = relativePath === ''
    ? []
    : relativePath.split(sep);
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    throw new WorkspacePathGuardError(
      'Git control and Wukong internal paths are not exposed to candidate tools.',
    );
  }
  const identities: ExistingPathIdentity[] = [];
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) break;
      throw new WorkspacePathGuardError(
        'Unable to inspect the candidate path identity.',
        { cause: error },
      );
    }
    if (info.isSymbolicLink()
      || (!info.isDirectory() && !info.isFile())
      || (info.isFile() && info.nlink !== 1)
      || (index < segments.length - 1 && !info.isDirectory())) {
      throw new WorkspacePathGuardError(
        'The candidate path contains a symlink, hardlink, or unsafe node.',
      );
    }
    identities.push({
      path: current,
      device: String(info.dev),
      inode: String(info.ino),
      mode: info.mode,
      isDirectory: info.isDirectory(),
    });
  }
  if (before !== undefined) {
    const stableCount = operation === 'write'
      && before.length === segments.length
      ? Math.max(0, before.length - 1)
      : before.length;
    for (let index = 0; index < stableCount; index++) {
      const previous = before[index]!;
      const currentIdentity = identities[index];
      if (currentIdentity === undefined
        || !sameIdentity(previous, currentIdentity)) {
        throw new WorkspacePathGuardError(
          'The candidate path identity changed during tool execution.',
        );
      }
    }
  }
  return identities;
}

async function assertCandidateRoot(
  binding: CandidateWorkspaceGuardBinding,
): Promise<void> {
  const [actualPath, info, linkInfo] = await Promise.all([
    realpath(binding.rootDirectory),
    stat(binding.rootDirectory, { bigint: true }),
    lstat(binding.rootDirectory),
  ]);
  const actualIdentity = canonicalDigest(
    'wukong/candidate-path-identity/v1',
    {
      pathDigest: canonicalDigest('wukong/private-path/v1', actualPath),
      device: info.dev.toString(),
      inode: info.ino.toString(),
    },
  );
  if (!info.isDirectory()
    || !linkInfo.isDirectory()
    || linkInfo.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((linkInfo.mode & 0o777) !== 0o700
        || (typeof process.getuid === 'function'
          && linkInfo.uid !== process.getuid())))
    || actualIdentity !== binding.expectedRootIdentity) {
    throw new WorkspacePathGuardError(
      'The candidate workspace root identity changed.',
    );
  }
}

function sameIdentity(
  left: ExistingPathIdentity,
  right: ExistingPathIdentity,
): boolean {
  return left.path === right.path
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.isDirectory === right.isDirectory;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
