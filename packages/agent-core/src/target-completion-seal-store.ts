import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  stat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  containsSensitiveText,
  createCompletionArtifactRef,
  createTargetGateCompletionSeal,
  validatePromotionApplyJournal,
  validateTargetFinalGateAttemptResult,
  validateTargetFinalGateEvidenceSnapshot,
  validateTargetGateCompletionSeal,
  type CompletionArtifactKindV1,
  type PromotionApplyJournalV1,
  type TargetFinalGateAttemptResultV1,
  type TargetFinalGateEvidenceSnapshotV1,
  type TargetGateCompletionSealV1,
} from '@wukong/verification';

import {
  validateTargetFinalGateAttemptState,
  type TargetFinalGateAttemptStateV1,
} from './target-final-gate-attempt-store';
import {
  injectDurableBoundaryTestFault,
  validateDurableBoundaryTestFaultCapability,
  type DurableBoundaryTestFaultCapabilityV1,
} from './durable-boundary-test-fault';
import type {
  TargetPromotionExclusiveLeaseViewV1,
} from './target-promotion-lease-store';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from './windows-private-root-security';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const COMPLETIONS_DIRECTORY = 'target-completions';
const SEAL_FILE = 'seal.json';
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const EXPECTED_FILES = new Set([
  'attempt.json',
  'evidence.json',
  'journal.json',
  SEAL_FILE,
]);
const AUTHORIZATION_FACTORY = Symbol('target-completion-authorization');
const validatedSealAuthorizations = new WeakMap<
  TargetCompletionSealAuthorizationV1,
  {
    readonly seal: TargetGateCompletionSealV1;
    active: boolean;
  }
>();

export type TargetCompletionSealStoreErrorCode =
  | 'target_completion_invalid_input'
  | 'target_completion_not_found'
  | 'target_completion_stale_binding'
  | 'target_completion_integrity_failed'
  | 'target_completion_root_unsafe';

export class TargetCompletionSealStoreError extends Error {
  constructor(
    readonly reasonCode: TargetCompletionSealStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TargetCompletionSealStoreError';
  }
}

export class TargetCompletionSealAuthorizationV1 {
  readonly completionSealId: string;
  readonly completionSealDigest: string;

  private constructor(seal: TargetGateCompletionSealV1) {
    this.completionSealId = seal.completionSealId;
    this.completionSealDigest = seal.completionSealDigest;
    validatedSealAuthorizations.set(this, { seal, active: true });
    Object.freeze(this);
  }

  static create(
    seal: TargetGateCompletionSealV1,
    authority: symbol,
  ): TargetCompletionSealAuthorizationV1 {
    if (authority !== AUTHORIZATION_FACTORY
      || !validateTargetGateCompletionSeal(seal)) {
      stale('Target completion authorization factory is invalid.');
    }
    return new TargetCompletionSealAuthorizationV1(seal);
  }

  toJSON(): Record<string, unknown> {
    return {
      completionSealId: this.completionSealId,
      completionSealDigest: this.completionSealDigest,
      validationAuthority: '[SCOPED]',
    };
  }
}

export function requireValidatedTargetCompletionSeal(
  authorization: TargetCompletionSealAuthorizationV1,
): TargetGateCompletionSealV1 {
  if (!(authorization instanceof TargetCompletionSealAuthorizationV1)) {
    stale('Target completion authorization is not authentic.');
  }
  const value = validatedSealAuthorizations.get(authorization);
  if (value === undefined || !value.active) {
    stale('Target completion authorization expired.');
  }
  return value.seal;
}

interface CompletionPaths {
  readonly directory: string;
  readonly journal: string;
  readonly evidence: string;
  readonly attempt: string;
  readonly seal: string;
}

export class TargetCompletionSealStore {
  private readonly now: () => Date;
  private readonly testFaultCapability:
    | DurableBoundaryTestFaultCapabilityV1
    | undefined;
  private readonly historicalSealAuthorities = new Map<string, {
    readonly sealDigest: string;
    readonly currentFencingTokenDigest: string;
    readonly historicalFencingTokenDigest: string;
  }>();

  constructor(options?: {
    readonly now?: () => Date;
    /**
     * Process-crash test seam. Production callers must never supply this.
     */
    readonly _testFaultCapability?:
      DurableBoundaryTestFaultCapabilityV1;
  }) {
    if ((options?.now !== undefined
        && typeof options.now !== 'function')
      || (options?._testFaultCapability !== undefined
        && !validateDurableBoundaryTestFaultCapability(
          options._testFaultCapability,
        ))) {
      invalid('Target completion seal store options are invalid.');
    }
    this.now = options?.now ?? (() => new Date());
    this.testFaultCapability =
      options?._testFaultCapability;
  }

  async sealAndReopen(
    view: TargetPromotionExclusiveLeaseViewV1,
    input: {
      readonly completionSealId: string;
      readonly journal: PromotionApplyJournalV1;
      readonly finalGateState: TargetFinalGateAttemptStateV1;
      readonly redactionPolicyVersion: string;
    },
  ): Promise<TargetGateCompletionSealV1> {
    assertSealInput(view, input);
    await view.assertAuthority();
    const paths = await preparePaths(
      view.registryDirectory,
      input.completionSealId,
    );
    const existing = await readSealOrNull(paths.seal);
    if (existing !== null) {
      const seal = await this.inspectAndValidateInternal(
        view,
        input.completionSealId,
        existing.completionSealDigest,
        input.finalGateState.targetFencingTokenLineage,
      );
      this.historicalSealAuthorities.set(input.completionSealId, {
        sealDigest: seal.completionSealDigest,
        currentFencingTokenDigest:
          view.lease.fencingTokenDigest,
        historicalFencingTokenDigest:
          seal.targetFencingTokenDigest,
      });
      return seal;
    }
    const evidence = input.finalGateState.evidence!;
    const attempt = input.finalGateState.result!;
    const artifacts = [
      artifact(
        input.completionSealId,
        'promotion_apply_journal',
        input.journal,
        'journal',
      ),
      artifact(
        input.completionSealId,
        'final_gate_evidence_snapshot',
        evidence,
        'evidence',
      ),
      artifact(
        input.completionSealId,
        'final_gate_attempt_result',
        attempt,
        'attempt',
      ),
    ] as const;
    await writeOrVerifyPrivate(paths.journal, artifacts[0].bytes);
    await writeOrVerifyPrivate(paths.evidence, artifacts[1].bytes);
    await writeOrVerifyPrivate(paths.attempt, artifacts[2].bytes);
    await syncDirectory(paths.directory);
    await injectDurableBoundaryTestFault(
      this.testFaultCapability,
      'target_completion_after_artifacts_synced',
    );
    const seal = createTargetGateCompletionSeal({
      completionSealId: input.completionSealId,
      runId: input.finalGateState.runId,
      contractId: input.finalGateState.contractId,
      acceptanceContractDigest:
        input.finalGateState.acceptanceContractDigest,
      gatePlanDigest: input.finalGateState.gatePlanDigest,
      criteriaSelectionDigest:
        input.finalGateState.criteriaSelectionDigest,
      promotionId: input.finalGateState.promotionId,
      candidateId: input.finalGateState.candidateId,
      sourceSnapshotDigest:
        input.finalGateState.sourceSnapshotDigest,
      candidateDeltaDigest:
        input.finalGateState.candidateDeltaDigest,
      promotionJournalId:
        input.finalGateState.promotionJournalId,
      promotionJournalHeadDigest:
        input.finalGateState.promotionJournalHeadDigest,
      targetPromotionLeaseId:
        input.finalGateState.targetPromotionLeaseId,
      targetFencingTokenDigest:
        input.finalGateState.targetFencingTokenDigest,
      targetAfterFingerprintDigest:
        input.finalGateState.targetAfterFingerprintDigest,
      finalGateAttemptId:
        input.finalGateState.finalGateAttemptId,
      finalGateEvidenceSnapshotId: evidence.evidenceSnapshotId,
      finalGateEvidenceDigest: evidence.evidenceDigest,
      requiredGateCoverageDigest:
        evidence.requiredGateCoverageDigest,
      finalGateAttemptResultDigest: attempt.resultDigest,
      finalGateOutcome: attempt.outcome,
      orderedArtifacts: artifacts.map(({ ref }) => ref),
      redactionPolicyVersion: input.redactionPolicyVersion,
      finalGateCompletedAt: attempt.completedAt,
      sealedAt: timestamp(this.now(), attempt.completedAt),
    });
    await writePrivateExclusive(paths.seal, canonicalJson(seal));
    await syncDirectory(paths.directory);
    await view.assertAuthority();
    return this.inspectAndValidate(
      view,
      input.completionSealId,
      seal.completionSealDigest,
    );
  }

  async inspectAndValidate(
    view: TargetPromotionExclusiveLeaseViewV1,
    completionSealId: string,
    expectedSealDigest?: string,
  ): Promise<TargetGateCompletionSealV1> {
    const historical =
      this.historicalSealAuthorities.get(completionSealId);
    const allowedHistoricalFencingTokens =
      historical !== undefined
        && historical.currentFencingTokenDigest
          === view.lease.fencingTokenDigest
        && (expectedSealDigest === undefined
          || historical.sealDigest === expectedSealDigest)
        ? [historical.historicalFencingTokenDigest]
        : [];
    return this.inspectAndValidateInternal(
      view,
      completionSealId,
      expectedSealDigest,
      allowedHistoricalFencingTokens,
    );
  }

  private async inspectAndValidateInternal(
    view: TargetPromotionExclusiveLeaseViewV1,
    completionSealId: string,
    expectedSealDigest: string | undefined,
    allowedHistoricalFencingTokens: readonly string[],
  ): Promise<TargetGateCompletionSealV1> {
    if (!isUuid(completionSealId)
      || (expectedSealDigest !== undefined
        && !isDigest(expectedSealDigest))) {
      invalid('Target completion inspection input is invalid.');
    }
    await view.assertAuthority();
    const paths = await preparePaths(
      view.registryDirectory,
      completionSealId,
      false,
    );
    const names = await readdir(paths.directory);
    if (names.length !== EXPECTED_FILES.size
      || names.some((name) => !EXPECTED_FILES.has(name))) {
      integrity('Target completion directory has missing or unknown files.');
    }
    const [seal, journalBytes, evidenceBytes, attemptBytes] =
      await Promise.all([
        readRequiredSeal(paths.seal),
        readPrivateBytes(paths.journal),
        readPrivateBytes(paths.evidence),
        readPrivateBytes(paths.attempt),
      ]);
    if ((expectedSealDigest !== undefined
        && seal.completionSealDigest !== expectedSealDigest)
      || seal.completionSealId !== completionSealId) {
      stale('Target completion seal digest is stale.');
    }
    assertSealLease(
      seal,
      view,
      allowedHistoricalFencingTokens,
    );
    const journal = parseJson(journalBytes);
    const evidence = parseJson(evidenceBytes);
    const attempt = parseJson(attemptBytes);
    if (!validatePromotionApplyJournal(journal)
      || journal.state !== 'applied'
      || !validateTargetFinalGateEvidenceSnapshot(evidence)
      || !validateTargetFinalGateAttemptResult(attempt)) {
      integrity('Target completion artifact schema is invalid.');
    }
    assertArtifactRefs(seal, [
      artifact(
        completionSealId,
        'promotion_apply_journal',
        journal,
        'journal',
      ).ref,
      artifact(
        completionSealId,
        'final_gate_evidence_snapshot',
        evidence,
        'evidence',
      ).ref,
      artifact(
        completionSealId,
        'final_gate_attempt_result',
        attempt,
        'attempt',
      ).ref,
    ]);
    assertArtifactLineage(seal, journal, evidence, attempt);
    await view.assertAuthority();
    return seal;
  }

  async withValidatedTerminalSeal<Result>(
    view: TargetPromotionExclusiveLeaseViewV1,
    input: {
      readonly completionSealId: string;
      readonly expectedSealDigest: string;
    },
    callback: (
      authorization: TargetCompletionSealAuthorizationV1,
    ) => Promise<Result> | Result,
  ): Promise<Result> {
    if (typeof callback !== 'function') {
      invalid('Target completion terminal callback is invalid.');
    }
    const seal = await this.inspectAndValidate(
      view,
      input.completionSealId,
      input.expectedSealDigest,
    );
    const authorization =
      TargetCompletionSealAuthorizationV1.create(
        seal,
        AUTHORIZATION_FACTORY,
      );
    try {
      return await callback(authorization);
    } finally {
      const scoped = validatedSealAuthorizations.get(authorization);
      if (scoped !== undefined) scoped.active = false;
      await view.assertAuthority();
    }
  }
}

function artifact(
  completionSealId: string,
  kind: CompletionArtifactKindV1,
  value: unknown,
  name: 'journal' | 'evidence' | 'attempt',
): {
  readonly bytes: Buffer;
  readonly ref: ReturnType<typeof createCompletionArtifactRef>;
} {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    invalid('Target completion artifact exceeds the size limit.');
  }
  if (!isUuid(completionSealId)
    || (!validatePromotionApplyJournal(value)
      && !validateTargetFinalGateEvidenceSnapshot(value)
      && !validateTargetFinalGateAttemptResult(value))) {
    invalid('Target completion artifact value is invalid.');
  }
  return {
    bytes,
    ref: createCompletionArtifactRef({
      kind,
      privateRef:
        `private/target-completion/${completionSealId}/${name}.json`,
      byteLength: bytes.byteLength,
      contentDigest: canonicalDigest(
        'wukong/completion-artifact-content/v1',
        bytes.toString('base64'),
      ),
    }),
  };
}

function assertSealInput(
  view: TargetPromotionExclusiveLeaseViewV1,
  input: Parameters<TargetCompletionSealStore['sealAndReopen']>[1],
): void {
  if (typeof view?.assertAuthority !== 'function'
    || view.lease.state !== 'final_verifying'
    || !isUuid(input.completionSealId)
    || !validatePromotionApplyJournal(input.journal)
    || input.journal.state !== 'applied'
    || !validateTargetFinalGateAttemptState(input.finalGateState)
    || input.finalGateState.state !== 'completed'
    || input.finalGateState.evidence === null
    || input.finalGateState.result === null
    || !isIdentifier(input.redactionPolicyVersion)) {
    invalid('Target completion seal input is invalid.');
  }
  assertStateLease(input.finalGateState, view);
  assertInputLineage(input.journal, input.finalGateState);
}

function assertStateLease(
  state: TargetFinalGateAttemptStateV1,
  view: TargetPromotionExclusiveLeaseViewV1,
): void {
  if (state.promotionId !== view.lease.promotionId
    || state.candidateId !== view.lease.candidateId
    || state.candidateDeltaDigest !== view.lease.candidateDeltaDigest
    || state.targetPromotionLeaseId
      !== view.lease.targetPromotionLeaseId
    || state.targetRegistryKey !== view.lease.targetRegistryKey
    || state.targetFencingTokenDigest
      !== view.lease.fencingTokenDigest) {
    stale('Target completion state lease is stale.');
  }
}

function assertInputLineage(
  journal: PromotionApplyJournalV1,
  state: TargetFinalGateAttemptStateV1,
): void {
  if (journal.promotionId !== state.promotionId
    || journal.candidateId !== state.candidateId
    || journal.candidateDeltaDigest !== state.candidateDeltaDigest
    || journal.journalId !== state.promotionJournalId
    || journal.journalHeadDigest
      !== state.promotionJournalHeadDigest
    || journal.targetPromotionLeaseId
      !== state.targetPromotionLeaseId
    || !state.targetFencingTokenLineage.includes(
      journal.currentTargetFencingTokenDigest,
    )
    || journal.targetAfterFingerprintDigest
      !== state.targetAfterFingerprintDigest) {
    stale('Target completion Apply lineage is stale.');
  }
}

function assertArtifactRefs(
  seal: TargetGateCompletionSealV1,
  expected: readonly ReturnType<
    typeof createCompletionArtifactRef
  >[],
): void {
  if (canonicalJson(seal.orderedArtifacts)
    !== canonicalJson(expected)) {
    integrity('Target completion artifact references do not match bytes.');
  }
}

function assertArtifactLineage(
  seal: TargetGateCompletionSealV1,
  journal: PromotionApplyJournalV1,
  evidence: TargetFinalGateEvidenceSnapshotV1,
  attempt: TargetFinalGateAttemptResultV1,
): void {
  if (seal.promotionId !== journal.promotionId
    || seal.candidateId !== journal.candidateId
    || seal.candidateDeltaDigest !== journal.candidateDeltaDigest
    || seal.promotionJournalId !== journal.journalId
    || seal.promotionJournalHeadDigest !== journal.journalHeadDigest
    || seal.targetPromotionLeaseId
      !== journal.targetPromotionLeaseId
    || journal.currentTargetFencingTokenDigest
      !== evidence.targetFencingTokenDigest
    || attempt.targetFencingTokenDigest
      !== evidence.targetFencingTokenDigest
    || seal.targetAfterFingerprintDigest
      !== journal.targetAfterFingerprintDigest
    || seal.finalGateAttemptId !== evidence.finalGateAttemptId
    || seal.finalGateEvidenceSnapshotId
      !== evidence.evidenceSnapshotId
    || seal.finalGateEvidenceDigest !== evidence.evidenceDigest
    || seal.requiredGateCoverageDigest
      !== evidence.requiredGateCoverageDigest
    || seal.finalGateAttemptResultDigest !== attempt.resultDigest
    || seal.finalGateOutcome !== attempt.outcome
    || attempt.evidenceDigest !== evidence.evidenceDigest
    || attempt.requiredGateCoverageDigest
      !== evidence.requiredGateCoverageDigest) {
    integrity('Target completion artifact lineage is invalid.');
  }
}

function assertSealLease(
  seal: TargetGateCompletionSealV1,
  view: TargetPromotionExclusiveLeaseViewV1,
  allowedHistoricalFencingTokens: readonly string[] = [],
): void {
  if (view.lease.state !== 'final_verifying'
    || seal.promotionId !== view.lease.promotionId
    || seal.candidateId !== view.lease.candidateId
    || seal.candidateDeltaDigest !== view.lease.candidateDeltaDigest
    || seal.targetPromotionLeaseId
      !== view.lease.targetPromotionLeaseId
    || (seal.targetFencingTokenDigest
        !== view.lease.fencingTokenDigest
      && !allowedHistoricalFencingTokens.includes(
        seal.targetFencingTokenDigest,
      ))) {
    stale('Target completion seal lease is stale.');
  }
}

async function preparePaths(
  registryDirectory: string,
  completionSealId: string,
  create = true,
): Promise<CompletionPaths> {
  const root = join(registryDirectory, COMPLETIONS_DIRECTORY);
  if (create) await ensurePrivateDirectory(root);
  else await assertPrivateDirectory(root);
  const directory = join(root, completionSealId);
  if (create) await ensurePrivateDirectory(directory);
  else await assertPrivateDirectory(directory);
  return {
    directory,
    journal: join(directory, 'journal.json'),
    evidence: join(directory, 'evidence.json'),
    attempt: join(directory, 'attempt.json'),
    seal: join(directory, SEAL_FILE),
  };
}

async function readSealOrNull(
  path: string,
): Promise<TargetGateCompletionSealV1 | null> {
  try {
    return await readRequiredSeal(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function readRequiredSeal(
  path: string,
): Promise<TargetGateCompletionSealV1> {
  const value = parseJson(await readPrivateBytes(path));
  if (!validateTargetGateCompletionSeal(value)) {
    integrity('Target completion seal schema is invalid.');
  }
  return value;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const text = Buffer.from(bytes).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
      integrity('Target completion artifact is not valid UTF-8.');
    }
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof TargetCompletionSealStoreError) throw error;
    integrity('Target completion artifact is not valid JSON.', error);
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
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const [actual, linked] = await Promise.all([stat(path), lstat(path)]);
  if (!actual.isDirectory()
    || !linked.isDirectory()
    || linked.isSymbolicLink()
    || (process.platform !== 'win32'
      && ((linked.mode & 0o777) !== DIRECTORY_MODE
        || (typeof process.getuid === 'function'
          && linked.uid !== process.getuid())))) {
    fail(
      'target_completion_root_unsafe',
      'Target completion directory is unsafe.',
    );
  }
  if (process.platform === 'win32') {
    try {
      attestWindowsPrivateRootPathSecurity(resolve(path));
    } catch {
      fail(
        'target_completion_root_unsafe',
        'Target completion directory has an unsafe Windows ACL.',
      );
    }
  }
}

async function writePrivateExclusive(
  path: string,
  bytes: Uint8Array | string,
): Promise<void> {
  const handle = await open(path, 'wx', FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeOrVerifyPrivate(
  path: string,
  bytes: Uint8Array | string,
): Promise<void> {
  try {
    await writePrivateExclusive(path, bytes);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    const existing = await readPrivateBytes(path);
    if (!existing.equals(Buffer.from(bytes))) {
      integrity('Target completion artifact already has different bytes.');
    }
  }
}

async function readPrivateBytes(path: string): Promise<Buffer> {
  const linked = await lstat(path);
  if (!linked.isFile()
    || linked.isSymbolicLink()
    || linked.nlink !== 1
    || linked.size > MAX_ARTIFACT_BYTES
    || (process.platform !== 'win32'
      && (linked.mode & 0o777) !== FILE_MODE)) {
    integrity('Target completion private file is unsafe.');
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY
      | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
  );
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(before, linked)
      || !sameFile(before, after)
      || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      integrity('Target completion file changed while reading.');
    }
    return bytes;
  } finally {
    await handle.close();
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

function sameFile(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function timestamp(now: Date, minimum?: string): string {
  if (!Number.isFinite(now.getTime())) {
    invalid('Target completion time is invalid.');
  }
  return new Date(Math.max(
    now.getTime(),
    minimum === undefined ? 0 : Date.parse(minimum),
  )).toISOString();
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
    && !containsSensitiveText(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function invalid(message: string): never {
  fail('target_completion_invalid_input', message);
}

function stale(message: string): never {
  fail('target_completion_stale_binding', message);
}

function integrity(message: string, cause?: unknown): never {
  fail('target_completion_integrity_failed', message, cause);
}

function fail(
  reasonCode: TargetCompletionSealStoreErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new TargetCompletionSealStoreError(
    reasonCode,
    message,
    cause === undefined ? undefined : { cause },
  );
}
