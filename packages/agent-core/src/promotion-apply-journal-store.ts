import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  adoptPromotionApplyJournalOwnership,
  canonicalDigest,
  canonicalJson,
  validatePromotionApplyJournal,
  type PromotionApplyJournalV1,
} from '@wukong/verification';

import type {
  TargetPromotionExclusiveLeaseViewV1,
} from './target-promotion-lease-store';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const JOURNALS_DIRECTORY = 'apply-journals';
const STATE_FILE = 'journal.json';
const RECORDS_DIRECTORY = 'records';
const RECORD_PATTERN = /^([0-9]{12})\.json$/u;
const MAX_BYTES = 128 * 1024 * 1024;

export type PromotionApplyJournalStoreErrorCode =
  | 'promotion_journal_invalid_input'
  | 'promotion_journal_not_found'
  | 'promotion_journal_conflict'
  | 'promotion_journal_integrity_failed'
  | 'promotion_journal_root_unsafe';

export class PromotionApplyJournalStoreError extends Error {
  constructor(
    readonly reasonCode: PromotionApplyJournalStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PromotionApplyJournalStoreError';
  }
}

interface PromotionApplyJournalRecordV1 {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly sequence: number;
  readonly previousRecordDigest: string | null;
  readonly previousJournalHeadDigest: string | null;
  readonly nextJournal: PromotionApplyJournalV1;
  readonly occurredAt: string;
  readonly recordDigest: string;
}

interface JournalPaths {
  readonly directory: string;
  readonly state: string;
  readonly records: string;
}

export class PromotionApplyJournalStore {
  private readonly now: () => Date;

  constructor(options?: { readonly now?: () => Date }) {
    if (options?.now !== undefined && typeof options.now !== 'function') {
      fail(
        'promotion_journal_invalid_input',
        'Promotion journal store options are invalid.',
      );
    }
    this.now = options?.now ?? (() => new Date());
  }

  async createOrLoad(
    view: TargetPromotionExclusiveLeaseViewV1,
    proposed: PromotionApplyJournalV1,
  ): Promise<PromotionApplyJournalV1> {
    assertViewAndJournal(view, proposed);
    await view.assertAuthority();
    const paths = await preparePaths(view, proposed.journalId);
    const loaded = await loadOrRecover(paths);
    if (loaded !== null) {
      if (!sameJournalScope(loaded.journal, proposed)) {
        fail(
          'promotion_journal_conflict',
          'An existing Apply journal has different immutable bindings.',
        );
      }
      if (loaded.journal.currentTargetFencingTokenDigest
          !== view.lease.fencingTokenDigest) {
        if (loaded.journal.state === 'applied'
          && view.lease.state === 'final_verifying') {
          await view.assertAuthority();
          return loaded.journal;
        }
        let adopted: PromotionApplyJournalV1;
        try {
          adopted = adoptPromotionApplyJournalOwnership(
            loaded.journal,
            {
              expectedTargetFencingTokenDigest:
                loaded.journal.currentTargetFencingTokenDigest,
              nextTargetFencingTokenDigest:
                view.lease.fencingTokenDigest,
            },
          );
        } catch (error) {
          fail(
            'promotion_journal_conflict',
            'The Apply journal cannot adopt the current target owner.',
            error,
          );
        }
        await persistNext(
          paths,
          loaded.lastRecord,
          adopted,
          timestamp(this.now(), loaded.lastRecord.occurredAt),
        );
        await view.assertAuthority();
        return adopted;
      }
      assertJournalLease(view, loaded.journal);
      await view.assertAuthority();
      return loaded.journal;
    }
    await persistNext(paths, null, proposed, timestamp(this.now()));
    await view.assertAuthority();
    return proposed;
  }

  async append(
    view: TargetPromotionExclusiveLeaseViewV1,
    expectedJournalHeadDigest: string,
    next: PromotionApplyJournalV1,
  ): Promise<PromotionApplyJournalV1> {
    if (!isDigest(expectedJournalHeadDigest)) {
      fail(
        'promotion_journal_invalid_input',
        'Expected Apply journal head is invalid.',
      );
    }
    assertViewAndJournal(view, next);
    await view.assertAuthority();
    const paths = await preparePaths(view, next.journalId);
    const loaded = await loadOrRecover(paths);
    if (loaded === null) {
      fail(
        'promotion_journal_not_found',
        'Apply journal was not found.',
      );
    }
    if (loaded.journal.journalHeadDigest !== expectedJournalHeadDigest
      || !validSuccessor(loaded.journal, next)) {
      fail(
        'promotion_journal_conflict',
        'Apply journal CAS or successor validation failed.',
      );
    }
    await persistNext(
      paths,
      loaded.lastRecord,
      next,
      timestamp(this.now(), loaded.lastRecord.occurredAt),
    );
    await view.assertAuthority();
    return next;
  }

  async inspect(
    view: TargetPromotionExclusiveLeaseViewV1,
    journalId: string,
  ): Promise<PromotionApplyJournalV1> {
    if (!isUuid(journalId)) {
      fail(
        'promotion_journal_invalid_input',
        'Apply journal id is invalid.',
      );
    }
    await view.assertAuthority();
    const paths = await preparePaths(view, journalId);
    const loaded = await loadOrRecover(paths);
    if (loaded === null) {
      fail(
        'promotion_journal_not_found',
        'Apply journal was not found.',
      );
    }
    assertJournalLease(view, loaded.journal);
    await view.assertAuthority();
    return loaded.journal;
  }
}

async function preparePaths(
  view: TargetPromotionExclusiveLeaseViewV1,
  journalId: string,
): Promise<JournalPaths> {
  if (!isAbsolute(view.registryDirectory) || !isUuid(journalId)) {
    fail(
      'promotion_journal_invalid_input',
      'Apply journal path input is invalid.',
    );
  }
  const root = join(view.registryDirectory, JOURNALS_DIRECTORY);
  await ensurePrivateDirectory(root);
  const directory = join(root, journalId);
  await ensurePrivateDirectory(directory);
  const records = join(directory, RECORDS_DIRECTORY);
  await ensurePrivateDirectory(records);
  return {
    directory,
    state: join(directory, STATE_FILE),
    records,
  };
}

async function loadOrRecover(paths: JournalPaths): Promise<{
  readonly journal: PromotionApplyJournalV1;
  readonly lastRecord: PromotionApplyJournalRecordV1;
} | null> {
  const [persisted, records] = await Promise.all([
    readJournalOrNull(paths.state),
    readRecords(paths.records),
  ]);
  if (persisted === null && records.length === 0) return null;
  if (records.length === 0) integrity('Apply journal records are missing.');
  validateRecordChain(records);
  const last = records.at(-1)!;
  if (persisted === null
    || (records.length >= 2
      && persisted.journalHeadDigest
        === records.at(-2)!.nextJournal.journalHeadDigest)) {
    await writePrivateAtomic(
      paths.state,
      canonicalJson(last.nextJournal),
    );
  } else if (persisted.journalHeadDigest
      !== last.nextJournal.journalHeadDigest) {
    integrity('Apply journal state diverges from its record chain.');
  }
  return {
    journal: last.nextJournal,
    lastRecord: last,
  };
}

async function persistNext(
  paths: JournalPaths,
  previous: PromotionApplyJournalRecordV1 | null,
  nextJournal: PromotionApplyJournalV1,
  occurredAt: string,
): Promise<void> {
  const core = {
    schemaVersion: 1 as const,
    recordId: randomUUID(),
    sequence: previous === null ? 0 : previous.sequence + 1,
    previousRecordDigest: previous?.recordDigest ?? null,
    previousJournalHeadDigest:
      previous?.nextJournal.journalHeadDigest ?? null,
    nextJournal,
    occurredAt,
  };
  const record = Object.freeze({
    ...core,
    recordDigest: canonicalDigest(
      'wukong/promotion-apply-journal-record/v1',
      core,
    ),
  });
  await writePrivateExclusive(
    join(
      paths.records,
      `${String(record.sequence).padStart(12, '0')}.json`,
    ),
    canonicalJson(record),
  );
  await syncDirectory(paths.records);
  await writePrivateAtomic(paths.state, canonicalJson(nextJournal));
}

async function readRecords(
  directory: string,
): Promise<readonly PromotionApplyJournalRecordV1[]> {
  const entries = await readdir(directory);
  if (entries.some((name) => !RECORD_PATTERN.test(name))) {
    integrity('Apply journal record directory contains an unknown entry.');
  }
  const records: PromotionApplyJournalRecordV1[] = [];
  for (const name of entries.toSorted()) {
    const value = JSON.parse(await readPrivateFile(
      join(directory, name),
    )) as unknown;
    if (!validateRecord(value)) {
      integrity('Apply journal record is invalid.');
    }
    records.push(value);
  }
  return records;
}

function validateRecordChain(
  records: readonly PromotionApplyJournalRecordV1[],
): void {
  let previous: PromotionApplyJournalRecordV1 | undefined;
  for (const record of records) {
    if (record.sequence !== (previous?.sequence ?? -1) + 1
      || record.previousRecordDigest
        !== (previous?.recordDigest ?? null)
      || record.previousJournalHeadDigest
        !== (previous?.nextJournal.journalHeadDigest ?? null)
      || (previous !== undefined
        && !validSuccessor(previous.nextJournal, record.nextJournal))) {
      integrity('Apply journal record chain is invalid.');
    }
    previous = record;
  }
}

function validateRecord(
  value: unknown,
): value is PromotionApplyJournalRecordV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'nextJournal',
      'occurredAt',
      'previousJournalHeadDigest',
      'previousRecordDigest',
      'recordDigest',
      'recordId',
      'schemaVersion',
      'sequence',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || !isUuid(value['recordId'])
    || !isNonNegativeInteger(value['sequence'])
    || !isNullableDigest(value['previousRecordDigest'])
    || !isNullableDigest(value['previousJournalHeadDigest'])
    || !validatePromotionApplyJournal(value['nextJournal'])
    || !isTimestamp(value['occurredAt'])
    || !isDigest(value['recordDigest'])) {
    return false;
  }
  const record = value as unknown as PromotionApplyJournalRecordV1;
  const { recordDigest, ...core } = record;
  return canonicalDigest(
    'wukong/promotion-apply-journal-record/v1',
    core,
  ) === recordDigest;
}

function validSuccessor(
  current: PromotionApplyJournalV1,
  next: PromotionApplyJournalV1,
): boolean {
  if (!sameJournalIdentity(current, next)
    || current.journalHeadDigest === next.journalHeadDigest) {
    return false;
  }
  if (next.events.length === current.events.length) {
    const ownershipAdoption =
      (current.state === 'applying' || current.state === 'applied')
      && next.targetFencingTokenLineage.length
        === current.targetFencingTokenLineage.length + 1
      && next.targetFencingTokenLineage.slice(0, -1).every(
        (digest, index) =>
          digest === current.targetFencingTokenLineage[index],
      )
      && next.currentTargetFencingTokenDigest
        === next.targetFencingTokenLineage.at(-1)
      && next.currentTargetFencingTokenDigest
        !== current.currentTargetFencingTokenDigest
      && next.state === current.state
      && next.targetAfterFingerprintDigest
        === current.targetAfterFingerprintDigest;
    if (ownershipAdoption) return true;
  }
  if (current.state !== 'applying') return false;
  if (next.events.length === current.events.length + 1) {
    return sameFencingLineage(current, next)
      && next.currentTargetFencingTokenDigest
        === current.currentTargetFencingTokenDigest
      && next.events.slice(0, -1).every(
        (event, index) =>
          event.eventDigest === current.events[index]?.eventDigest,
      );
  }
  if (next.events.length !== current.events.length) return false;
  return sameFencingLineage(current, next)
    && next.currentTargetFencingTokenDigest
      === current.currentTargetFencingTokenDigest
    && next.state === 'applied'
    && next.targetAfterFingerprintDigest !== null
    && current.targetAfterFingerprintDigest === null;
}

function sameJournalIdentity(
  left: PromotionApplyJournalV1,
  right: PromotionApplyJournalV1,
): boolean {
  return sameJournalScope(left, right)
    && left.promotionId === right.promotionId
    && left.targetPromotionLeaseId === right.targetPromotionLeaseId
    && left.targetRegistryKey === right.targetRegistryKey
    && left.createdByTargetFencingTokenDigest
      === right.createdByTargetFencingTokenDigest;
}

function sameJournalScope(
  left: PromotionApplyJournalV1,
  right: PromotionApplyJournalV1,
): boolean {
  return left.journalId === right.journalId
    && left.promotionId === right.promotionId
    && left.targetPromotionLeaseId === right.targetPromotionLeaseId
    && left.targetRegistryKey === right.targetRegistryKey
    && left.candidateId === right.candidateId
    && left.candidateDeltaDigest === right.candidateDeltaDigest
    && left.orderedChangeManifestDigest
      === right.orderedChangeManifestDigest
    && left.changeCount === right.changeCount
    && left.targetBeforeFingerprintDigest
      === right.targetBeforeFingerprintDigest
    && left.targetBeforeContentDigest === right.targetBeforeContentDigest
    && left.materializedSourceDigest === right.materializedSourceDigest
    && left.agentDeltaDigest === right.agentDeltaDigest;
}

function sameFencingLineage(
  left: PromotionApplyJournalV1,
  right: PromotionApplyJournalV1,
): boolean {
  return left.targetFencingTokenLineage.length
      === right.targetFencingTokenLineage.length
    && left.targetFencingTokenLineage.every(
      (digest, index) =>
        digest === right.targetFencingTokenLineage[index],
    );
}

function assertViewAndJournal(
  view: TargetPromotionExclusiveLeaseViewV1,
  journal: PromotionApplyJournalV1,
): void {
  if (!validatePromotionApplyJournal(journal)
    || typeof view?.assertAuthority !== 'function') {
    fail(
      'promotion_journal_invalid_input',
      'Apply journal operation input is invalid.',
    );
  }
  assertJournalLease(view, journal);
}

function assertJournalLease(
  view: TargetPromotionExclusiveLeaseViewV1,
  journal: PromotionApplyJournalV1,
): void {
  if (journal.promotionId !== view.lease.promotionId
    || journal.targetPromotionLeaseId
      !== view.lease.targetPromotionLeaseId
    || journal.targetRegistryKey !== view.lease.targetRegistryKey
    || journal.currentTargetFencingTokenDigest
      !== view.lease.fencingTokenDigest
    || journal.candidateId !== view.lease.candidateId
    || journal.candidateDeltaDigest
      !== view.lease.candidateDeltaDigest) {
    fail(
      'promotion_journal_conflict',
      'Apply journal does not match the exclusive target lease.',
    );
  }
}

async function readJournalOrNull(
  path: string,
): Promise<PromotionApplyJournalV1 | null> {
  try {
    const value = JSON.parse(await readPrivateFile(path)) as unknown;
    if (!validatePromotionApplyJournal(value)) {
      integrity('Apply journal state is invalid.');
    }
    return value;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  if (process.platform === 'win32' && created) {
    protectWindowsPrivateRootSecurity(path);
  }
  const [actual, linked] = await Promise.all([stat(path), lstat(path)]);
  if (!actual.isDirectory()
    || !linked.isDirectory()
    || linked.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== DIRECTORY_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))) {
    fail(
      'promotion_journal_root_unsafe',
      'Apply journal directory is unsafe.',
    );
  }
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch {
      fail(
        'promotion_journal_root_unsafe',
        'Apply journal directory has an unsafe Windows ACL.',
      );
    }
  }
}

async function writePrivateExclusive(
  path: string,
  content: string,
): Promise<void> {
  const handle = await open(path, 'wx', FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateAtomic(
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, FILE_MODE);
  await syncDirectory(resolve(path, '..'));
}

async function readPrivateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()
    || info.isSymbolicLink()
    || info.nlink !== 1
    || info.size > MAX_BYTES
    || (process.platform !== 'win32'
      && (info.mode & 0o777) !== FILE_MODE)) {
    integrity('Apply journal private file is unsafe.');
  }
  return readFile(path, 'utf8');
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

function timestamp(now: Date, minimum?: string): string {
  if (!Number.isFinite(now.getTime())) {
    fail(
      'promotion_journal_invalid_input',
      'Apply journal time is invalid.',
    );
  }
  return new Date(Math.max(
    now.getTime(),
    minimum === undefined ? 0 : Date.parse(minimum),
  )).toISOString();
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function fail(
  reasonCode: PromotionApplyJournalStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new PromotionApplyJournalStoreError(
    reasonCode,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function integrity(message: string, cause?: unknown): never {
  fail('promotion_journal_integrity_failed', message, cause);
}
