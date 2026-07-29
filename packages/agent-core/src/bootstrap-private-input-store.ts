import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  digestCandidateBootstrapArgv,
  digestCandidateBootstrapEnvironment,
  validateCandidateBootstrapPlan,
  validateCandidateBootstrapStep,
  validateTrustedExecutableIdentity,
  validateWorktreeLease,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapStepV1,
  type TrustedExecutableIdentityV1,
  type WorktreeLeaseV1,
} from '@wukong/verification';
import lockfile from 'proper-lockfile';

import {
  TrustedExecutableHandleV1,
  withTrustedExecutablePath,
} from './trusted-executable';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PRIVATE_RECORD_BYTES = 2 * 1024 * 1024;
const LOCK_SENTINEL = '.bootstrap-private.lock';
const handleRecords = new WeakMap<BootstrapStepPrivateInputsHandleV1, {
  readonly storeRoot: string;
  readonly recordPath: string;
}>();

export type BootstrapPrivateInputStoreErrorCode =
  | 'bootstrap_private_invalid_input'
  | 'bootstrap_private_root_unsafe'
  | 'bootstrap_private_integrity_failed'
  | 'bootstrap_private_not_found'
  | 'bootstrap_private_expired'
  | 'bootstrap_private_stale_handle'
  | 'bootstrap_private_destroyed'
  | 'bootstrap_private_lock_failed';

export class BootstrapPrivateInputStoreError extends Error {
  constructor(
    readonly reasonCode: BootstrapPrivateInputStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BootstrapPrivateInputStoreError';
  }
}

export interface BootstrapPrivateInputStoreOptions {
  readonly rootDirectory: string;
  readonly now?: () => Date;
}

export interface StageBootstrapStepPrivateInputsV1 {
  readonly worktreeLease: WorktreeLeaseV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly step: CandidateBootstrapStepV1;
  readonly argv: readonly string[];
  readonly effectiveEnvironment: Readonly<Record<string, string>>;
  readonly trustedExecutable: TrustedExecutableHandleV1;
  readonly expiresAt: string;
}

export interface BootstrapStepPrivateInputsViewV1 {
  readonly argv: readonly string[];
  readonly effectiveEnvironment: Readonly<Record<string, string>>;
  readonly executablePath: string;
}

interface BootstrapStepPrivateInputsRecordV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly bootstrapPlanDigest: string;
  readonly stepId: string;
  readonly stepDigest: string;
  readonly exactArgvPrivateRef: string;
  readonly argvDigest: string;
  readonly effectiveEnvironmentPrivateRef: string;
  readonly effectiveEnvironmentDigest: string;
  readonly executableIdentity: TrustedExecutableIdentityV1;
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly effectiveEnvironment: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly recordDigest: string;
}

interface BootstrapStepPrivateInputsTombstoneV1 {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly candidateId: string;
  readonly bootstrapPlanDigest: string;
  readonly stepId: string;
  readonly stepDigest: string;
  readonly destroyedRecordDigest: string;
  readonly destroyedAt: string;
  readonly tombstoneDigest: string;
}

export class BootstrapStepPrivateInputsHandleV1 {
  readonly leaseId: string;
  readonly candidateId: string;
  readonly bootstrapPlanDigest: string;
  readonly stepId: string;
  readonly stepDigest: string;
  readonly recordDigest: string;
  readonly expiresAt: string;

  private constructor(
    record: BootstrapStepPrivateInputsRecordV1,
    storeRoot: string,
    recordPath: string,
  ) {
    this.leaseId = record.leaseId;
    this.candidateId = record.candidateId;
    this.bootstrapPlanDigest = record.bootstrapPlanDigest;
    this.stepId = record.stepId;
    this.stepDigest = record.stepDigest;
    this.recordDigest = record.recordDigest;
    this.expiresAt = record.expiresAt;
    handleRecords.set(this, { storeRoot, recordPath });
    Object.freeze(this);
  }

  static create(
    record: BootstrapStepPrivateInputsRecordV1,
    storeRoot: string,
    recordPath: string,
  ): BootstrapStepPrivateInputsHandleV1 {
    return new BootstrapStepPrivateInputsHandleV1(
      record,
      storeRoot,
      recordPath,
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      leaseId: this.leaseId,
      candidateId: this.candidateId,
      bootstrapPlanDigest: this.bootstrapPlanDigest,
      stepId: this.stepId,
      stepDigest: this.stepDigest,
      recordDigest: this.recordDigest,
      expiresAt: this.expiresAt,
      argv: '[PRIVATE]',
      effectiveEnvironment: '[PRIVATE]',
      executablePath: '[PRIVATE]',
    };
  }
}

export class BootstrapPrivateInputStore {
  private readonly rootDirectory: string;
  private readonly lockPath: string;
  private readonly now: () => Date;

  constructor(options: BootstrapPrivateInputStoreOptions) {
    if (!isRecord(options)
      || typeof options.rootDirectory !== 'string'
      || options.rootDirectory.length === 0
      || (options.now !== undefined && typeof options.now !== 'function')) {
      fail(
        'bootstrap_private_invalid_input',
        'A private bootstrap input root is required.',
      );
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.lockPath = join(this.rootDirectory, LOCK_SENTINEL);
    this.now = options.now ?? (() => new Date());
  }

  async stage(
    input: StageBootstrapStepPrivateInputsV1,
  ): Promise<BootstrapStepPrivateInputsHandleV1> {
    return this.withStoreLock(() => this.stageLocked(input));
  }

  private async stageLocked(
    input: StageBootstrapStepPrivateInputsV1,
  ): Promise<BootstrapStepPrivateInputsHandleV1> {
    assertStageInput(input);
    const paths = this.paths(input.step.stepDigest);
    await assertNotDestroyed(paths.tombstone);
    const createdAt = canonicalNow(this.now);
    if (!isCanonicalTimestamp(input.expiresAt)
      || Date.parse(input.expiresAt) <= Date.parse(createdAt)
      || Date.parse(input.expiresAt)
        > Date.parse(input.worktreeLease.expiresAt)) {
      fail(
        'bootstrap_private_invalid_input',
        'The private bootstrap input expiry is invalid.',
      );
    }
    const argv = Object.freeze([...input.argv]);
    const effectiveEnvironment = freezeEnvironment(
      input.effectiveEnvironment,
    );
    if (input.bootstrapPlan.injectedEnvironmentNames.some(
      (name) => !Object.hasOwn(effectiveEnvironment, name),
    )) {
      fail(
        'bootstrap_private_invalid_input',
        'A frozen bootstrap environment input is missing.',
      );
    }
    if (digestCandidateBootstrapArgv(argv) !== input.step.argvDigest
      || digestCandidateBootstrapEnvironment(effectiveEnvironment)
        !== input.step.effectiveEnvironmentDigest) {
      fail(
        'bootstrap_private_invalid_input',
        'The private bootstrap inputs do not match the frozen step digests.',
      );
    }
    return withTrustedExecutablePath(
      input.trustedExecutable,
      async (executablePath) => {
        if (input.trustedExecutable.identity.executableIdentityDigest
          !== input.step.executableIdentity
          || input.trustedExecutable.identity.runtimeVersionDigest
            !== input.step.runtimeVersionDigest) {
          fail(
            'bootstrap_private_invalid_input',
            'The trusted executable does not match the frozen bootstrap step.',
          );
        }
        const existing = await readRecordOrNull(paths.record);
        const recordCore = {
          schemaVersion: 1 as const,
          leaseId: input.worktreeLease.leaseId,
          candidateId: input.worktreeLease.candidateId,
          bootstrapPlanDigest: input.bootstrapPlan.bootstrapPlanDigest,
          stepId: input.step.stepId,
          stepDigest: input.step.stepDigest,
          exactArgvPrivateRef: input.step.exactArgvPrivateRef,
          argvDigest: input.step.argvDigest,
          effectiveEnvironmentPrivateRef:
            input.step.effectiveEnvironmentPrivateRef,
          effectiveEnvironmentDigest:
            input.step.effectiveEnvironmentDigest,
          executableIdentity: input.trustedExecutable.identity,
          executablePath,
          argv,
          effectiveEnvironment,
          createdAt: existing?.createdAt ?? createdAt,
          expiresAt: input.expiresAt,
        };
        const record: BootstrapStepPrivateInputsRecordV1 = Object.freeze({
          ...recordCore,
          recordDigest: canonicalDigest(
            'wukong/bootstrap-step-private-inputs/v1',
            recordCore,
          ),
        });
        if (existing !== null) {
          if (canonicalJson(existing) !== canonicalJson(record)) {
            fail(
              'bootstrap_private_stale_handle',
              'Different private inputs already exist for this bootstrap step.',
            );
          }
          return BootstrapStepPrivateInputsHandleV1.create(
            existing,
            this.rootDirectory,
            paths.record,
          );
        }
        await writePrivateExclusive(paths.record, canonicalJson(record));
        await syncDirectory(this.rootDirectory);
        return BootstrapStepPrivateInputsHandleV1.create(
          record,
          this.rootDirectory,
          paths.record,
        );
      },
    );
  }

  async resume(
    worktreeLease: WorktreeLeaseV1,
    bootstrapPlan: CandidateBootstrapPlanV1,
    step: CandidateBootstrapStepV1,
  ): Promise<BootstrapStepPrivateInputsHandleV1> {
    return this.withStoreLock(
      () => this.resumeLocked(worktreeLease, bootstrapPlan, step),
    );
  }

  private async resumeLocked(
    worktreeLease: WorktreeLeaseV1,
    bootstrapPlan: CandidateBootstrapPlanV1,
    step: CandidateBootstrapStepV1,
  ): Promise<BootstrapStepPrivateInputsHandleV1> {
    assertLeasePlanStep(worktreeLease, bootstrapPlan, step);
    const paths = this.paths(step.stepDigest);
    await assertNotDestroyed(paths.tombstone);
    const record = await readRecord(paths.record);
    assertRecordBinding(record, worktreeLease, bootstrapPlan, step);
    return BootstrapStepPrivateInputsHandleV1.create(
      record,
      this.rootDirectory,
      paths.record,
    );
  }

  async withInputs<Result>(
    handle: BootstrapStepPrivateInputsHandleV1,
    callback: (
      view: BootstrapStepPrivateInputsViewV1,
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    return this.withStoreLock(() => this.withInputsLocked(handle, callback));
  }

  private async withInputsLocked<Result>(
    handle: BootstrapStepPrivateInputsHandleV1,
    callback: (
      view: BootstrapStepPrivateInputsViewV1,
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    const privateHandle = this.assertHandle(handle);
    if (typeof callback !== 'function') {
      fail(
        'bootstrap_private_invalid_input',
        'A private bootstrap input callback is required.',
      );
    }
    await assertNotDestroyed(this.paths(handle.stepDigest).tombstone);
    const record = await readRecord(privateHandle.recordPath);
    assertHandleMatchesRecord(handle, record);
    if (Date.parse(record.expiresAt)
      <= Date.parse(canonicalNow(this.now))) {
      fail(
        'bootstrap_private_expired',
        'The private bootstrap inputs expired.',
      );
    }
    const executable = TrustedExecutableHandleV1.create(
      record.executablePath,
      record.executableIdentity,
    );
    const result = await withTrustedExecutablePath(
      executable,
      (executablePath) => callback(Object.freeze({
        argv: Object.freeze([...record.argv]),
        effectiveEnvironment: freezeEnvironment(
          record.effectiveEnvironment,
        ),
        executablePath,
      })),
    );
    const after = await readRecord(privateHandle.recordPath);
    if (after.recordDigest !== record.recordDigest
      || canonicalJson(after) !== canonicalJson(record)) {
      fail(
        'bootstrap_private_integrity_failed',
        'The private bootstrap inputs changed during use.',
      );
    }
    return result;
  }

  async destroy(
    handle: BootstrapStepPrivateInputsHandleV1,
  ): Promise<void> {
    return this.withStoreLock(() => this.destroyLocked(handle));
  }

  private async destroyLocked(
    handle: BootstrapStepPrivateInputsHandleV1,
  ): Promise<void> {
    const privateHandle = this.assertHandle(handle);
    const paths = this.paths(handle.stepDigest);
    const existingTombstone = await readTombstoneOrNull(paths.tombstone);
    if (existingTombstone !== null) {
      if (existingTombstone.destroyedRecordDigest !== handle.recordDigest) {
        fail(
          'bootstrap_private_integrity_failed',
          'The bootstrap private-input tombstone does not match.',
        );
      }
      const remaining = await readRecordOrNull(privateHandle.recordPath);
      if (remaining !== null) {
        assertHandleMatchesRecord(handle, remaining);
        await unlinkExactPrivateFile(
          privateHandle.recordPath,
          remaining.recordDigest,
        );
        await syncDirectory(this.rootDirectory);
      }
      return;
    }
    const record = await readRecord(privateHandle.recordPath);
    assertHandleMatchesRecord(handle, record);
    const destroyedAt = canonicalNow(this.now);
    const tombstoneCore = {
      schemaVersion: 1 as const,
      leaseId: record.leaseId,
      candidateId: record.candidateId,
      bootstrapPlanDigest: record.bootstrapPlanDigest,
      stepId: record.stepId,
      stepDigest: record.stepDigest,
      destroyedRecordDigest: record.recordDigest,
      destroyedAt,
    };
    const tombstone: BootstrapStepPrivateInputsTombstoneV1 = {
      ...tombstoneCore,
      tombstoneDigest: canonicalDigest(
        'wukong/bootstrap-step-private-inputs-tombstone/v1',
        tombstoneCore,
      ),
    };
    await writePrivateExclusive(
      paths.tombstone,
      canonicalJson(tombstone),
    );
    await syncDirectory(this.rootDirectory);
    await unlinkExactPrivateFile(
      privateHandle.recordPath,
      record.recordDigest,
    );
    await syncDirectory(this.rootDirectory);
  }

  private async withStoreLock<Result>(
    callback: () => Promise<Result>,
  ): Promise<Result> {
    await assertPrivateDirectory(this.rootDirectory);
    try {
      await writePrivateExclusive(this.lockPath, '');
      await syncDirectory(this.rootDirectory);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    await readPrivateFile(this.lockPath);
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.lockPath, {
        realpath: true,
        retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
        stale: 30_000,
        update: 10_000,
      });
    } catch (error) {
      throw new BootstrapPrivateInputStoreError(
        'bootstrap_private_lock_failed',
        'Unable to lock the private bootstrap input store.',
        { cause: error },
      );
    }
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  private assertHandle(
    handle: BootstrapStepPrivateInputsHandleV1,
  ): { readonly storeRoot: string; readonly recordPath: string } {
    if (!(handle instanceof BootstrapStepPrivateInputsHandleV1)) {
      fail(
        'bootstrap_private_stale_handle',
        'The private bootstrap input handle is not authentic.',
      );
    }
    const value = handleRecords.get(handle);
    if (value === undefined || value.storeRoot !== this.rootDirectory) {
      fail(
        'bootstrap_private_stale_handle',
        'The private bootstrap input handle belongs to another store.',
      );
    }
    return value;
  }

  private paths(stepDigest: string): {
    readonly record: string;
    readonly tombstone: string;
  } {
    if (!isDigest(stepDigest)) {
      fail(
        'bootstrap_private_invalid_input',
        'The private bootstrap step digest is invalid.',
      );
    }
    const suffix = stepDigest.slice('sha256:'.length);
    return {
      record: join(this.rootDirectory, `step-${suffix}.json`),
      tombstone: join(
        this.rootDirectory,
        `step-${suffix}.destroyed.json`,
      ),
    };
  }
}

function assertStageInput(input: StageBootstrapStepPrivateInputsV1): void {
  if (!isRecord(input)
    || !(input.trustedExecutable instanceof TrustedExecutableHandleV1)
    || !Array.isArray(input.argv)
    || !isRecord(input.effectiveEnvironment)) {
    fail(
      'bootstrap_private_invalid_input',
      'The private bootstrap stage input is invalid.',
    );
  }
  assertLeasePlanStep(
    input.worktreeLease,
    input.bootstrapPlan,
    input.step,
  );
}

function assertLeasePlanStep(
  worktreeLease: WorktreeLeaseV1,
  bootstrapPlan: CandidateBootstrapPlanV1,
  step: CandidateBootstrapStepV1,
): void {
  if (!validateWorktreeLease(worktreeLease)
    || worktreeLease.state !== 'bootstrapping'
    || !validateCandidateBootstrapPlan(bootstrapPlan)
    || !validateCandidateBootstrapStep(step)
    || worktreeLease.bootstrapPlanDigest
      !== bootstrapPlan.bootstrapPlanDigest
    || worktreeLease.sourceSnapshotDigest
      !== bootstrapPlan.sourceSnapshotDigest
    || worktreeLease.gatePlanDigest !== bootstrapPlan.gatePlanDigest
    || !bootstrapPlan.steps.some(
      (candidate) => candidate.stepDigest === step.stepDigest,
    )) {
    fail(
      'bootstrap_private_invalid_input',
      'The private bootstrap input binding is invalid.',
    );
  }
}

function assertRecordBinding(
  record: BootstrapStepPrivateInputsRecordV1,
  lease: WorktreeLeaseV1,
  plan: CandidateBootstrapPlanV1,
  step: CandidateBootstrapStepV1,
): void {
  if (record.leaseId !== lease.leaseId
    || record.candidateId !== lease.candidateId
    || record.bootstrapPlanDigest !== plan.bootstrapPlanDigest
    || record.stepId !== step.stepId
    || record.stepDigest !== step.stepDigest
    || record.exactArgvPrivateRef !== step.exactArgvPrivateRef
    || record.argvDigest !== step.argvDigest
    || record.effectiveEnvironmentPrivateRef
      !== step.effectiveEnvironmentPrivateRef
    || record.effectiveEnvironmentDigest
      !== step.effectiveEnvironmentDigest
    || record.executableIdentity.executableIdentityDigest
      !== step.executableIdentity
    || record.executableIdentity.runtimeVersionDigest
      !== step.runtimeVersionDigest) {
    fail(
      'bootstrap_private_stale_handle',
      'The persisted private bootstrap inputs have a stale binding.',
    );
  }
}

function assertHandleMatchesRecord(
  handle: BootstrapStepPrivateInputsHandleV1,
  record: BootstrapStepPrivateInputsRecordV1,
): void {
  if (handle.leaseId !== record.leaseId
    || handle.candidateId !== record.candidateId
    || handle.bootstrapPlanDigest !== record.bootstrapPlanDigest
    || handle.stepId !== record.stepId
    || handle.stepDigest !== record.stepDigest
    || handle.recordDigest !== record.recordDigest
    || handle.expiresAt !== record.expiresAt) {
    fail(
      'bootstrap_private_stale_handle',
      'The private bootstrap input handle is stale.',
    );
  }
}

function freezeEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const names = Object.keys(value).toSorted();
  return Object.freeze(Object.fromEntries(
    names.map((name) => [name, value[name]!]),
  )) as Readonly<Record<string, string>>;
}

async function readRecord(
  path: string,
): Promise<BootstrapStepPrivateInputsRecordV1> {
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      fail(
        'bootstrap_private_not_found',
        'The private bootstrap input record was not found.',
      );
    }
    throw error;
  }
  const value = parseJson(bytes);
  if (!validateRecord(value)) {
    integrity('The private bootstrap input record is invalid.');
  }
  return value;
}

async function readRecordOrNull(
  path: string,
): Promise<BootstrapStepPrivateInputsRecordV1 | null> {
  try {
    return await readRecord(path);
  } catch (error) {
    if (error instanceof BootstrapPrivateInputStoreError
      && error.reasonCode === 'bootstrap_private_not_found') {
      return null;
    }
    throw error;
  }
}

function validateRecord(
  value: unknown,
): value is BootstrapStepPrivateInputsRecordV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'argv',
      'argvDigest',
      'bootstrapPlanDigest',
      'candidateId',
      'createdAt',
      'effectiveEnvironment',
      'effectiveEnvironmentDigest',
      'effectiveEnvironmentPrivateRef',
      'exactArgvPrivateRef',
      'executableIdentity',
      'executablePath',
      'expiresAt',
      'leaseId',
      'recordDigest',
      'schemaVersion',
      'stepDigest',
      'stepId',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || typeof value['leaseId'] !== 'string'
    || typeof value['candidateId'] !== 'string'
    || !isDigest(value['bootstrapPlanDigest'])
    || typeof value['stepId'] !== 'string'
    || !isDigest(value['stepDigest'])
    || typeof value['exactArgvPrivateRef'] !== 'string'
    || !isDigest(value['argvDigest'])
    || typeof value['effectiveEnvironmentPrivateRef'] !== 'string'
    || !isDigest(value['effectiveEnvironmentDigest'])
    || !validateTrustedExecutableIdentity(value['executableIdentity'])
    || typeof value['executablePath'] !== 'string'
    || !Array.isArray(value['argv'])
    || !isRecord(value['effectiveEnvironment'])
    || !isCanonicalTimestamp(value['createdAt'])
    || !isCanonicalTimestamp(value['expiresAt'])
    || Date.parse(value['createdAt']) >= Date.parse(value['expiresAt'])
    || !isDigest(value['recordDigest'])) {
    return false;
  }
  let argvDigest: string;
  let environmentDigest: string;
  try {
    argvDigest = digestCandidateBootstrapArgv(
      value['argv'] as readonly string[],
    );
    environmentDigest = digestCandidateBootstrapEnvironment(
      value['effectiveEnvironment'] as Record<string, string>,
    );
  } catch {
    return false;
  }
  if (argvDigest !== value['argvDigest']
    || environmentDigest !== value['effectiveEnvironmentDigest']) {
    return false;
  }
  const { recordDigest, ...core } =
    value as unknown as BootstrapStepPrivateInputsRecordV1;
  return canonicalDigest('wukong/bootstrap-step-private-inputs/v1', core)
    === recordDigest;
}

async function readTombstoneOrNull(
  path: string,
): Promise<BootstrapStepPrivateInputsTombstoneV1 | null> {
  try {
    const value = parseJson(await readPrivateFile(path));
    if (!validateTombstone(value)) {
      integrity('The bootstrap private-input tombstone is invalid.');
    }
    return value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function assertNotDestroyed(path: string): Promise<void> {
  if (await readTombstoneOrNull(path) !== null) {
    fail(
      'bootstrap_private_destroyed',
      'The bootstrap private inputs were already destroyed.',
    );
  }
}

function validateTombstone(
  value: unknown,
): value is BootstrapStepPrivateInputsTombstoneV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'bootstrapPlanDigest',
      'candidateId',
      'destroyedAt',
      'destroyedRecordDigest',
      'leaseId',
      'schemaVersion',
      'stepDigest',
      'stepId',
      'tombstoneDigest',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || typeof value['leaseId'] !== 'string'
    || typeof value['candidateId'] !== 'string'
    || !isDigest(value['bootstrapPlanDigest'])
    || typeof value['stepId'] !== 'string'
    || !isDigest(value['stepDigest'])
    || !isDigest(value['destroyedRecordDigest'])
    || !isCanonicalTimestamp(value['destroyedAt'])
    || !isDigest(value['tombstoneDigest'])) {
    return false;
  }
  const { tombstoneDigest, ...core } =
    value as unknown as BootstrapStepPrivateInputsTombstoneV1;
  return canonicalDigest(
    'wukong/bootstrap-step-private-inputs-tombstone/v1',
    core,
  ) === tombstoneDigest;
}

async function readPrivateFile(path: string): Promise<Buffer> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertPrivateFile(before);
    if (before.size > MAX_PRIVATE_RECORD_BYTES) {
      integrity('A private bootstrap input record is oversized.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, after) || bytes.byteLength !== after.size) {
      integrity('A private bootstrap input record changed while reading.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePrivateExclusive(
  path: string,
  content: string,
): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkExactPrivateFile(
  path: string,
  expectedRecordDigest: string,
): Promise<void> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertPrivateFile(opened);
    const bytes = await handle.readFile();
    const record = parseJson(bytes);
    if (!validateRecord(record)
      || record.recordDigest !== expectedRecordDigest) {
      integrity('The private bootstrap input selected for deletion changed.');
    }
    const linked = await lstat(path);
    if (!sameFileIdentity(opened, linked)) {
      integrity('The private bootstrap input path changed before deletion.');
    }
    await unlink(path);
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      'bootstrap_private_root_unsafe',
      'The private bootstrap root is not a directory.',
    );
  }
  if (process.platform !== 'win32'
    && ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      || (typeof process.getuid === 'function'
        && info.uid !== process.getuid()))) {
    fail(
      'bootstrap_private_root_unsafe',
      'The private bootstrap root is not mode 0700 for the current owner.',
    );
  }
}

function assertPrivateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    integrity('A private bootstrap input file has an unsafe identity.');
  }
  if (process.platform !== 'win32'
    && ((info.mode & 0o777) !== PRIVATE_FILE_MODE
      || (typeof process.getuid === 'function'
        && info.uid !== process.getuid()))) {
    integrity('A private bootstrap input file is not mode 0600.');
  }
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

function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = Buffer.from(bytes).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
      integrity('A private bootstrap input file is not valid UTF-8.');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof BootstrapPrivateInputStoreError) throw error;
    throw new BootstrapPrivateInputStoreError(
      'bootstrap_private_integrity_failed',
      'A private bootstrap input file is not valid JSON.',
      { cause: error },
    );
  }
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      'bootstrap_private_invalid_input',
      'The private bootstrap input clock is invalid.',
    );
  }
  return value.toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function sameFile(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integrity(message: string): never {
  fail('bootstrap_private_integrity_failed', message);
}

function fail(
  code: BootstrapPrivateInputStoreErrorCode,
  message: string,
): never {
  throw new BootstrapPrivateInputStoreError(code, message);
}
