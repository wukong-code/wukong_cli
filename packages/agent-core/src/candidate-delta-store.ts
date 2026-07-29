import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  createCandidateDelta,
  createCandidateProjection,
  validateCandidateBootstrapPlan,
  validateCandidateChangeManifest,
  validateCandidateDelta,
  validateCandidateProjection,
  type CandidateBootstrapPlanV1,
  type CandidateChangeManifestV1,
  type CandidateDeltaV1,
  type CandidateProjectionV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

import {
  CandidateRootCapabilityV1,
  WorktreeLeaseStore,
} from './worktree-lease-store';
import {
  CandidateWorkspaceFileBackend,
  CandidateWorkspaceFileBackendError,
} from './tools/support/candidate-workspace-file-backend';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BASELINE_FILE = 'candidate-baseline.json';
const DELTA_FILE_PATTERN = /^candidate-delta-([0-9]{12})\.json$/u;
const LOCK_FILE = '.candidate-delta.lock';
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024 * 1024;

export type CandidateDeltaStoreErrorCode =
  | 'candidate_delta_invalid_input'
  | 'candidate_delta_root_unsafe'
  | 'candidate_delta_not_found'
  | 'candidate_delta_conflict'
  | 'candidate_delta_integrity_failed'
  | 'candidate_delta_stale_binding'
  | 'candidate_delta_invalid_state'
  | 'candidate_delta_limit'
  | 'candidate_delta_lock_failed';

export class CandidateDeltaStoreError extends Error {
  constructor(
    readonly reasonCode: CandidateDeltaStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateDeltaStoreError';
  }
}

export interface CandidateDeltaStoreOptions {
  /** Existing Wukong-owned 0700 directory outside the source workspace. */
  readonly privateRootDirectory: string;
  /** Exact source repository root; private artifacts may never be placed here. */
  readonly sourceRepositoryRoot: string;
  readonly now?: () => Date;
}

export interface CandidateBaselineRecordV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly sourceSnapshotDigest: string;
  readonly materializedSourceDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly generatedScopesDigest: string;
  readonly projection: CandidateProjectionV1;
  readonly createdAt: string;
  readonly recordDigest: string;
}

export interface CandidateDeltaSealV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly leaseCasRevision: number;
  readonly verifyingLeaseDigest: string;
  readonly baselineRecordDigest: string;
  readonly manifest: CandidateChangeManifestV1;
  readonly delta: CandidateDeltaV1;
  readonly sealedAt: string;
  readonly sealDigest: string;
}

export class CandidateDeltaStore {
  private readonly privateRootDirectory: string;
  private readonly sourceRepositoryRoot: string;
  private readonly now: () => Date;

  constructor(options: CandidateDeltaStoreOptions) {
    if (!isRecord(options)
      || typeof options.privateRootDirectory !== 'string'
      || !isAbsolute(options.privateRootDirectory)
      || typeof options.sourceRepositoryRoot !== 'string'
      || !isAbsolute(options.sourceRepositoryRoot)
      || (options.now !== undefined && typeof options.now !== 'function')) {
      invalidInput('Candidate delta store options are invalid.');
    }
    this.privateRootDirectory = resolve(options.privateRootDirectory);
    this.sourceRepositoryRoot = resolve(options.sourceRepositoryRoot);
    this.now = options.now ?? (() => new Date());
  }

  async initializeBaseline(input: {
    readonly worktreeLeaseStore: WorktreeLeaseStore;
    readonly rootCapability: CandidateRootCapabilityV1;
    readonly bootstrapPlan: CandidateBootstrapPlanV1;
  }): Promise<CandidateBaselineRecordV1> {
    assertOperationInput(input);
    return input.worktreeLeaseStore.withCandidateRoot(
      input.rootCapability,
      async (view) => {
        const lease = await input.worktreeLeaseStore.inspect(
          input.rootCapability.candidateId,
        );
        assertLeasePlan(lease, input.bootstrapPlan, 'active');
        const paths = await this.preparePaths(
          lease.candidateId,
          view.candidateDirectory,
        );
        return this.withLock(paths, async () => {
          const existing = await readBaselineOrNull(paths.baseline);
          if (existing !== null) {
            assertBaselineBinding(existing, lease, input.bootstrapPlan);
            return existing;
          }
          const generatedScopes = generatedScopesFor(input.bootstrapPlan);
          const projection = await scanCandidateProjection({
            candidateDirectory: view.candidateDirectory,
            expectedRootIdentity: input.rootCapability.worktreeIdentity,
            lease,
            bootstrapPlan: input.bootstrapPlan,
            generatedScopes,
          });
          const createdAt = canonicalTimestamp(this.now());
          const core = {
            schemaVersion: 1 as const,
            candidateId: lease.candidateId,
            leaseId: lease.leaseId,
            sourceSnapshotDigest: lease.sourceSnapshotDigest,
            materializedSourceDigest: lease.materializedSourceDigest!,
            bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
            generatedScopesDigest: projection.generatedScopesDigest,
            projection,
            createdAt,
          };
          const record = Object.freeze({
            ...core,
            recordDigest: canonicalDigest(
              'wukong/candidate-baseline-record/v1',
              core,
            ),
          });
          await writePrivateAtomic(paths.baseline, canonicalJson(record));
          return record;
        });
      },
    );
  }

  async sealDelta(input: {
    readonly worktreeLeaseStore: WorktreeLeaseStore;
    readonly rootCapability: CandidateRootCapabilityV1;
    readonly bootstrapPlan: CandidateBootstrapPlanV1;
  }): Promise<CandidateDeltaSealV1> {
    assertOperationInput(input);
    return input.worktreeLeaseStore.withCandidateRoot(
      input.rootCapability,
      async (view) => {
        const lease = await input.worktreeLeaseStore.inspect(
          input.rootCapability.candidateId,
        );
        assertLeasePlan(lease, input.bootstrapPlan, 'verifying');
        const paths = await this.preparePaths(
          lease.candidateId,
          view.candidateDirectory,
        );
        return this.withLock(paths, async () => {
          const baseline = await readBaseline(paths.baseline);
          assertBaselineBinding(baseline, lease, input.bootstrapPlan);
          const projection = await scanCandidateProjection({
            candidateDirectory: view.candidateDirectory,
            expectedRootIdentity: input.rootCapability.worktreeIdentity,
            lease,
            bootstrapPlan: input.bootstrapPlan,
            generatedScopes: generatedScopesFor(input.bootstrapPlan),
          });
          const bundle = createCandidateDelta(
            baseline.projection,
            projection,
          );
          const deltaPath = join(
            paths.directory,
            deltaFilename(lease.casRevision),
          );
          const existing = await readDeltaOrNull(deltaPath);
          if (existing !== null) {
            if (existing.leaseCasRevision !== lease.casRevision
              || existing.verifyingLeaseDigest !== lease.leaseDigest
              || existing.baselineRecordDigest !== baseline.recordDigest
              || canonicalJson(existing.manifest)
                !== canonicalJson(bundle.manifest)
              || canonicalJson(existing.delta) !== canonicalJson(bundle.delta)) {
              conflict('The sealed candidate changed after its delta was recorded.');
            }
            return existing;
          }
          const sealedAt = canonicalTimestamp(this.now());
          const core = {
            schemaVersion: 1 as const,
            candidateId: lease.candidateId,
            leaseId: lease.leaseId,
            leaseCasRevision: lease.casRevision,
            verifyingLeaseDigest: lease.leaseDigest,
            baselineRecordDigest: baseline.recordDigest,
            manifest: bundle.manifest,
            delta: bundle.delta,
            sealedAt,
          };
          const seal = Object.freeze({
            ...core,
            sealDigest: canonicalDigest(
              'wukong/candidate-delta-seal/v1',
              core,
            ),
          });
          await writePrivateAtomic(deltaPath, canonicalJson(seal));
          return seal;
        });
      },
    );
  }

  async inspect(candidateId: string): Promise<{
    readonly baseline: CandidateBaselineRecordV1;
    readonly seal: CandidateDeltaSealV1 | null;
  }> {
    if (!isUuid(candidateId)) invalidInput('Candidate id is invalid.');
    const paths = await this.preparePaths(candidateId);
    return this.withLock(paths, async () => ({
      baseline: await readBaseline(paths.baseline),
      seal: await readLatestDelta(paths.directory),
    }));
  }

  private async preparePaths(
    candidateId: string,
    candidateDirectory?: string,
  ): Promise<{
    readonly directory: string;
    readonly baseline: string;
    readonly lock: string;
  }> {
    const [privateRoot, sourceRoot] = await Promise.all([
      realpath(this.privateRootDirectory),
      realpath(this.sourceRepositoryRoot),
    ]);
    await assertPrivateDirectory(privateRoot);
    if (isInside(sourceRoot, privateRoot)) {
      unsafeRoot('Candidate delta artifacts cannot be stored in the source workspace.');
    }
    if (candidateDirectory !== undefined) {
      const candidateRoot = await realpath(candidateDirectory);
      if (isInside(candidateRoot, privateRoot)) {
        unsafeRoot('Candidate delta artifacts cannot be stored in the candidate workspace.');
      }
    }
    const directory = join(privateRoot, candidateId);
    let created = false;
    try {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    if (process.platform === 'win32' && created) {
      protectWindowsPrivateRootSecurity(directory);
    }
    await assertPrivateDirectory(directory);
    return {
      directory,
      baseline: join(directory, BASELINE_FILE),
      lock: join(directory, LOCK_FILE),
    };
  }

  private async withLock<Result>(
    paths: {
      readonly directory: string;
      readonly lock: string;
    },
    callback: () => Promise<Result>,
  ): Promise<Result> {
    try {
      await writePrivateExclusive(paths.lock, '');
      await syncDirectory(paths.directory);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    await readPrivateFile(paths.lock, 1);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(paths.lock, {
        realpath: true,
        retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      throw new CandidateDeltaStoreError(
        'candidate_delta_lock_failed',
        'Unable to lock the candidate delta store.',
        { cause: error },
      );
    }
    try {
      return await callback();
    } finally {
      await release();
    }
  }
}

async function scanCandidateProjection(input: {
  readonly candidateDirectory: string;
  readonly expectedRootIdentity: string;
  readonly lease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly generatedScopes: readonly string[];
}): Promise<CandidateProjectionV1> {
  const backend = new CandidateWorkspaceFileBackend({
    rootDirectory: input.candidateDirectory,
    expectedRootIdentity: input.expectedRootIdentity,
    generatedPathScopes: input.generatedScopes,
  });
  let entries: Array<{
    readonly canonicalRelativePath: string;
    readonly mode: 0o100644 | 0o100755;
    readonly sizeBytes: number;
    readonly contentDigest: string;
  }>;
  try {
    entries = await backend.run(
      input.candidateDirectory,
      'search',
      async (io) => {
        const files = await io.listFiles(input.candidateDirectory, {
          includeIgnored: true,
        });
        let totalBytes = 0;
        const projectionEntries: typeof entries = [];
        for (const file of files) {
          if (!Number.isSafeInteger(file.stat.stSize)
            || file.stat.stSize < 0
            || file.stat.stSize > MAX_FILE_BYTES) {
            limit('A candidate projection file exceeds the size limit.');
          }
          totalBytes += file.stat.stSize;
          if (projectionEntries.length >= MAX_ENTRIES
            || totalBytes > MAX_TOTAL_BYTES) {
            limit('The candidate projection exceeds its bounded limits.');
          }
          const bytes = await io.readBytes(file.path);
          if (bytes.byteLength !== file.stat.stSize) {
            integrity('A candidate projection file changed while reading.');
          }
          projectionEntries.push({
            canonicalRelativePath: file.relativePath.split('\\').join('/'),
            mode: process.platform !== 'win32'
              && (file.stat.stMode & 0o111) !== 0
              ? 0o100755
              : 0o100644,
            sizeBytes: file.stat.stSize,
            contentDigest: digestProjectionFile(bytes),
          });
        }
        return projectionEntries;
      },
    );
  } catch (error) {
    if (error instanceof CandidateDeltaStoreError) throw error;
    if (error instanceof CandidateWorkspaceFileBackendError
      && (error.code.includes('limit')
        || error.code.includes('oversized'))) {
      limit('The candidate projection exceeds its bounded limits.');
    }
    throw new CandidateDeltaStoreError(
      'candidate_delta_integrity_failed',
      'The candidate projection could not be read through its bound directory descriptor.',
      { cause: error },
    );
  }
  const generatedScopesDigest = canonicalDigest(
    'wukong/candidate-generated-scopes/v1',
    input.generatedScopes,
  );
  return createCandidateProjection({
    candidateId: input.lease.candidateId,
    leaseId: input.lease.leaseId,
    sourceSnapshotDigest: input.lease.sourceSnapshotDigest,
    materializedSourceDigest: input.lease.materializedSourceDigest!,
    bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
    generatedScopesDigest,
    entries,
  });
}

function digestProjectionFile(bytes: Buffer): string {
  return `sha256:${createHash('sha256')
    .update('wukong/candidate-projection-file/v1')
    .update('\0')
    .update(bytes)
    .digest('hex')}`;
}

function generatedScopesFor(
  plan: CandidateBootstrapPlanV1,
): readonly string[] {
  return [...new Set(plan.steps.flatMap(({ generatedPathScopes }) =>
    generatedPathScopes))].toSorted();
}

function assertOperationInput(input: {
  readonly worktreeLeaseStore: WorktreeLeaseStore;
  readonly rootCapability: CandidateRootCapabilityV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
}): void {
  if (!(input.worktreeLeaseStore instanceof WorktreeLeaseStore)
    || !(input.rootCapability instanceof CandidateRootCapabilityV1)
    || !validateCandidateBootstrapPlan(input.bootstrapPlan)) {
    invalidInput('Candidate delta operation input is invalid.');
  }
}

function assertLeasePlan(
  lease: WorktreeLeaseV1,
  plan: CandidateBootstrapPlanV1,
  expectedState: 'active' | 'verifying',
): void {
  if (lease.state !== expectedState
    || lease.materializedSourceDigest === null
    || lease.bootstrapPlanDigest !== plan.bootstrapPlanDigest
    || lease.sourceSnapshotDigest !== plan.sourceSnapshotDigest
    || lease.gatePlanDigest !== plan.gatePlanDigest) {
    throw new CandidateDeltaStoreError(
      'candidate_delta_invalid_state',
      `Candidate delta requires an exact ${expectedState} lease/plan binding.`,
    );
  }
}

function assertBaselineBinding(
  baseline: CandidateBaselineRecordV1,
  lease: WorktreeLeaseV1,
  plan: CandidateBootstrapPlanV1,
): void {
  if (baseline.candidateId !== lease.candidateId
    || baseline.leaseId !== lease.leaseId
    || baseline.sourceSnapshotDigest !== lease.sourceSnapshotDigest
    || baseline.materializedSourceDigest !== lease.materializedSourceDigest
    || baseline.bootstrapPlanDigest !== plan.bootstrapPlanDigest
    || baseline.projection.generatedScopesDigest
      !== canonicalDigest(
        'wukong/candidate-generated-scopes/v1',
        generatedScopesFor(plan),
      )) {
    throw new CandidateDeltaStoreError(
      'candidate_delta_stale_binding',
      'The candidate baseline does not match the current lease and plan.',
    );
  }
}

async function readBaseline(path: string): Promise<CandidateBaselineRecordV1> {
  const value = await readJsonOrNull(path);
  if (value === null) {
    throw new CandidateDeltaStoreError(
      'candidate_delta_not_found',
      'The candidate baseline has not been initialized.',
    );
  }
  if (!validateBaseline(value)) {
    integrity('The candidate baseline record is invalid.');
  }
  return value;
}

async function readBaselineOrNull(
  path: string,
): Promise<CandidateBaselineRecordV1 | null> {
  const value = await readJsonOrNull(path);
  if (value === null) return null;
  if (!validateBaseline(value)) {
    integrity('The candidate baseline record is invalid.');
  }
  return value;
}

async function readDeltaOrNull(
  path: string,
): Promise<CandidateDeltaSealV1 | null> {
  const value = await readJsonOrNull(path);
  if (value === null) return null;
  if (!validateCandidateDeltaSeal(value)) {
    integrity('The candidate delta seal is invalid.');
  }
  return value;
}

function validateBaseline(value: unknown): value is CandidateBaselineRecordV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'bootstrapPlanDigest',
      'candidateId',
      'createdAt',
      'generatedScopesDigest',
      'leaseId',
      'materializedSourceDigest',
      'projection',
      'recordDigest',
      'schemaVersion',
      'sourceSnapshotDigest',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['candidateId'])
    || !isUuid(value['leaseId'])
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['materializedSourceDigest'])
    || !isDigest(value['bootstrapPlanDigest'])
    || !isDigest(value['generatedScopesDigest'])
    || !validateCandidateProjection(value['projection'])
    || !isCanonicalTimestamp(value['createdAt'])
    || !isDigest(value['recordDigest'])) {
    return false;
  }
  const baseline = value as unknown as CandidateBaselineRecordV1;
  const { recordDigest, ...core } = baseline;
  return baseline.projection.candidateId === baseline.candidateId
    && baseline.projection.leaseId === baseline.leaseId
    && baseline.projection.sourceSnapshotDigest
      === baseline.sourceSnapshotDigest
    && baseline.projection.materializedSourceDigest
      === baseline.materializedSourceDigest
    && baseline.projection.bootstrapPlanDigest === baseline.bootstrapPlanDigest
    && baseline.projection.generatedScopesDigest
      === baseline.generatedScopesDigest
    && canonicalDigest('wukong/candidate-baseline-record/v1', core)
      === recordDigest;
}

export function validateCandidateDeltaSeal(
  value: unknown,
): value is CandidateDeltaSealV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'baselineRecordDigest',
      'candidateId',
      'delta',
      'leaseCasRevision',
      'leaseId',
      'manifest',
      'schemaVersion',
      'sealDigest',
      'sealedAt',
      'verifyingLeaseDigest',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['candidateId'])
    || !isUuid(value['leaseId'])
    || !Number.isSafeInteger(value['leaseCasRevision'])
    || Number(value['leaseCasRevision']) < 0
    || !isDigest(value['verifyingLeaseDigest'])
    || !isDigest(value['baselineRecordDigest'])
    || !validateCandidateChangeManifest(value['manifest'])
    || !validateCandidateDelta(value['delta'])
    || !isCanonicalTimestamp(value['sealedAt'])
    || !isDigest(value['sealDigest'])) {
    return false;
  }
  const seal = value as unknown as CandidateDeltaSealV1;
  const { sealDigest, ...core } = seal;
  return seal.manifest.candidateId === seal.candidateId
    && seal.manifest.leaseId === seal.leaseId
    && seal.delta.candidateId === seal.candidateId
    && seal.delta.leaseId === seal.leaseId
    && seal.manifest.orderedChangeManifestDigest
      === seal.delta.orderedChangeManifestDigest
    && seal.manifest.candidateWorkspaceDigest
      === seal.delta.candidateWorkspaceDigest
    && canonicalJson(seal.manifest.changedPaths)
      === canonicalJson(seal.delta.changedPaths)
    && canonicalDigest('wukong/candidate-delta-seal/v1', core)
      === sealDigest;
}

async function readLatestDelta(
  directory: string,
): Promise<CandidateDeltaSealV1 | null> {
  const revisions = (await readdir(directory))
    .flatMap((name) => {
      const match = DELTA_FILE_PATTERN.exec(name);
      return match === null ? [] : [Number(match[1])];
    })
    .filter((revision) => Number.isSafeInteger(revision))
    .toSorted((left, right) => right - left);
  const latest = revisions[0];
  return latest === undefined
    ? null
    : readDeltaOrNull(join(directory, deltaFilename(latest)));
}

function deltaFilename(casRevision: number): string {
  if (!Number.isSafeInteger(casRevision)
    || casRevision < 0
    || casRevision > 999_999_999_999) {
    invalidInput('Candidate delta lease revision is invalid.');
  }
  return `candidate-delta-${String(casRevision).padStart(12, '0')}.json`;
}

async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readPrivateFile(path, MAX_RECORD_BYTES)).toString('utf8'));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    if (error instanceof SyntaxError) {
      integrity('A candidate delta record is not valid JSON.');
    }
    throw error;
  }
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const linked = await lstat(path);
  if (!linked.isFile()
    || linked.isSymbolicLink()
    || linked.nlink !== 1
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== PRIVATE_FILE_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))
    || linked.size > maxBytes) {
    integrity('A candidate delta private file is unsafe.');
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY
      | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
  );
  try {
    const before = await handle.stat();
    if (!sameFile(before, linked)) {
      integrity('A candidate delta private file changed before reading.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.length > maxBytes) {
      integrity('A candidate delta private file changed while reading.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivateExclusive(path: string, content: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const filename = path.slice(directory.length + 1);
  const temporary = join(
    directory,
    `.${filename}.${randomBytes(8).toString('hex')}.tmp`,
  );
  await writePrivateExclusive(temporary, content);
  await rename(temporary, path);
  await syncDirectory(directory);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const [actual, linked] = await Promise.all([
    stat(path),
    lstat(path),
  ]);
  if (!actual.isDirectory()
    || !linked.isDirectory()
    || linked.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))) {
    unsafeRoot('Candidate delta state directory is not private.');
  }
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch {
      unsafeRoot(
        'Candidate delta state directory has an unsafe Windows ACL.',
      );
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function canonicalTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) invalidInput('Current time is invalid.');
  return now.toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function invalidInput(message: string): never {
  throw new CandidateDeltaStoreError('candidate_delta_invalid_input', message);
}

function unsafeRoot(message: string): never {
  throw new CandidateDeltaStoreError('candidate_delta_root_unsafe', message);
}

function conflict(message: string): never {
  throw new CandidateDeltaStoreError('candidate_delta_conflict', message);
}

function integrity(message: string): never {
  throw new CandidateDeltaStoreError('candidate_delta_integrity_failed', message);
}

function limit(message: string): never {
  throw new CandidateDeltaStoreError('candidate_delta_limit', message);
}
