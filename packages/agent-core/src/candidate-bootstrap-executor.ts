import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  canonicalDigest,
  validateBootstrapBudget,
  validateCandidateBootstrapPlan,
  validateCandidateBootstrapStep,
  validateWorktreeLease,
  type BootstrapBudgetV1,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapStepV1,
} from '@wukong/verification';

import {
  BootstrapPrivateInputStore,
  BootstrapPrivateInputStoreError,
  type StageBootstrapStepPrivateInputsV1,
} from './bootstrap-private-input-store';
import {
  resolveCandidateBootstrapEnvironment,
} from './candidate-bootstrap-environment';
import {
  CandidateBootstrapStateStore,
  type CandidateBootstrapStateV1,
} from './candidate-bootstrap-state-store';
import {
  withTrustedExecutablePath,
  type TrustedExecutableHandleV1,
} from './trusted-executable';
import {
  type BootstrappingCandidateViewV1,
  type WorktreeLeaseAuthorityV1,
  type WorktreeLeaseStore,
} from './worktree-lease-store';

const KILL_GRACE_MS = 250;
const MAX_SCOPE_ENTRIES = 200_000;
const MAX_FINGERPRINT_BYTES = 16 * 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export type CandidateBootstrapExecutorErrorCode =
  | 'candidate_bootstrap_executor_invalid_input'
  | 'candidate_bootstrap_executor_unsupported'
  | 'candidate_bootstrap_executor_path_unsafe'
  | 'candidate_bootstrap_executor_integrity_failed';

export class CandidateBootstrapExecutorError extends Error {
  constructor(
    readonly reasonCode: CandidateBootstrapExecutorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateBootstrapExecutorError';
  }
}

export interface CandidateBootstrapExecutorOptions {
  readonly worktreeLeaseStore: Pick<
    WorktreeLeaseStore,
    'withBootstrappingCandidate'
  >;
  readonly monotonicNow?: () => number;
}

export interface ExecuteCandidateBootstrapStepV1 {
  readonly worktreeAuthority: WorktreeLeaseAuthorityV1;
  readonly bootstrapPlan: CandidateBootstrapPlanV1;
  readonly bootstrapBudget: BootstrapBudgetV1;
  readonly journalId: string;
  readonly step: CandidateBootstrapStepV1;
  readonly trustedExecutable: TrustedExecutableHandleV1;
  readonly argv: readonly string[];
  readonly effectiveEnvironment: Readonly<Record<string, string>>;
  readonly privateInputsExpiresAt: string;
  readonly reservationId: string;
  readonly reserveBudgetEventId: string;
  readonly prepareJournalEventId: string;
  readonly startBudgetEventId: string;
  readonly startJournalEventId: string;
  readonly finishBudgetEventId: string;
  readonly finishJournalEventId: string;
  readonly reservedWallClockMs: number;
  readonly reservedGeneratedBytes: number;
  readonly reservedOutputBytes: number;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface CandidateBootstrapStepExecutionResultV1 {
  readonly recovered: boolean;
  readonly status: 'observed' | 'failed' | 'retained_unknown';
  readonly exitCode: number | null;
  readonly timedOut: boolean | null;
  readonly aborted: boolean | null;
  readonly outputLimitExceeded: boolean | null;
  readonly protectedProjectionChanged: boolean | null;
  readonly wallClockMs: number;
  readonly generatedBytes: number;
  readonly outputBytes: number;
  readonly generatedScopeFingerprint: string;
  readonly stdoutDigest: string | null;
  readonly stderrDigest: string | null;
  readonly bootstrapStateDigest: string;
}

interface ProcessResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  readonly processGroupGone: boolean;
  readonly wallClockMs: number;
  readonly outputBytes: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
}

interface TreeFingerprint {
  readonly fingerprint: string;
  readonly totalFileBytes: number;
  readonly entryCount: number;
}

interface FingerprintEntry {
  readonly path: string;
  readonly kind: 'missing' | 'directory' | 'file';
  readonly mode: number | null;
  readonly sizeBytes: number;
  readonly contentDigest: string | null;
}

export class CandidateBootstrapExecutor {
  private readonly worktreeLeaseStore: Pick<
    WorktreeLeaseStore,
    'withBootstrappingCandidate'
  >;
  private readonly monotonicNow: () => number;

  constructor(options: CandidateBootstrapExecutorOptions) {
    if (!isRecord(options)
      || typeof options.worktreeLeaseStore?.withBootstrappingCandidate
        !== 'function'
      || (options.monotonicNow !== undefined
        && typeof options.monotonicNow !== 'function')) {
      invalidInput('A Worktree Lease bootstrap authority is required.');
    }
    this.worktreeLeaseStore = options.worktreeLeaseStore;
    this.monotonicNow = options.monotonicNow
      ?? (() => performance.now());
  }

  async executeStep(
    input: ExecuteCandidateBootstrapStepV1,
  ): Promise<CandidateBootstrapStepExecutionResultV1> {
    assertExecutionInput(input);
    if (process.platform === 'win32') {
      fail(
        'candidate_bootstrap_executor_unsupported',
        'P0 bootstrap execution requires POSIX process-group termination.',
      );
    }
    return this.worktreeLeaseStore.withBootstrappingCandidate(
      input.worktreeAuthority.binding,
      (view) => this.executeInsideCandidate(input, view),
    );
  }

  private async executeInsideCandidate(
    input: ExecuteCandidateBootstrapStepV1,
    view: BootstrappingCandidateViewV1,
  ): Promise<CandidateBootstrapStepExecutionResultV1> {
    const lease = input.worktreeAuthority.lease;
    const cwd = await resolveSafeCandidateCwd(
      view.candidateDirectory,
      input.step.candidateRelativeCwd,
    );
    const stateStore = new CandidateBootstrapStateStore({
      rootDirectory: view.bootstrapPrivateDirectory,
    });
    const privateStore = new BootstrapPrivateInputStore({
      rootDirectory: view.bootstrapPrivateDirectory,
    });
    const initialState = await stateStore.initialize({
      worktreeLease: lease,
      bootstrapPlan: input.bootstrapPlan,
      bootstrapBudget: input.bootstrapBudget,
      journalId: input.journalId,
    });
    const recovered = await recoverCommittedExecution(
      stateStore,
      initialState,
      input,
      view.candidateDirectory,
    );
    if (recovered !== null) {
      await destroyRecoveredPrivateInputs(
        privateStore,
        lease,
        input.bootstrapPlan,
        input.step,
      );
      return recovered;
    }
    const privateHandle = await privateStore.stage({
      worktreeLease: lease,
      bootstrapPlan: input.bootstrapPlan,
      step: input.step,
      argv: input.argv,
      effectiveEnvironment: input.effectiveEnvironment,
      trustedExecutable: input.trustedExecutable,
      expiresAt: input.privateInputsExpiresAt,
    } satisfies StageBootstrapStepPrivateInputsV1);
    const protectedBefore = await fingerprintCandidateProjection(
      view.candidateDirectory,
      input.step.generatedPathScopes,
    );
    await stateStore.prepareStep({
      worktreeLease: lease,
      bootstrapPlan: input.bootstrapPlan,
      step: input.step,
      reservationId: input.reservationId,
      budgetEventId: input.reserveBudgetEventId,
      journalEventId: input.prepareJournalEventId,
      reservedWallClockMs: input.reservedWallClockMs,
      reservedGeneratedBytes: input.reservedGeneratedBytes,
      reservedOutputBytes: input.reservedOutputBytes,
      idempotencyKey: input.idempotencyKey,
    });
    await stateStore.startStep({
      worktreeLease: lease,
      bootstrapPlan: input.bootstrapPlan,
      step: input.step,
      reservationId: input.reservationId,
      budgetEventId: input.startBudgetEventId,
      journalEventId: input.startJournalEventId,
      idempotencyKey: input.idempotencyKey,
    });

    let processResult: ProcessResult;
    try {
      processResult = await withTrustedExecutablePath(
        input.trustedExecutable,
        (trustedExecutablePath) => privateStore.withInputs(
          privateHandle,
          (privateInputs) => {
            if (privateInputs.executablePath
              !== trustedExecutablePath) {
              integrity(
                'The private executable path changed after staging.',
              );
            }
            return runExactProcess({
              executablePath: privateInputs.executablePath,
              argv: privateInputs.argv,
              environment: resolveCandidateBootstrapEnvironment(
                privateInputs.effectiveEnvironment,
                cwd,
              ),
              cwd,
              timeoutMs: input.step.timeoutMs,
              outputLimitBytes: input.reservedOutputBytes,
              signal: input.signal,
              monotonicNow: this.monotonicNow,
            });
          },
        ),
      );
    } catch {
      processResult = {
        exitCode: -1,
        timedOut: false,
        aborted: input.signal?.aborted === true,
        outputLimitExceeded: false,
        processGroupGone: false,
        wallClockMs: 0,
        outputBytes: 0,
        stdoutDigest: emptyOutputDigest('stdout'),
        stderrDigest: emptyOutputDigest('stderr'),
      };
    }

    const [protectedAfter, generatedAfter] = await Promise.all([
      fingerprintCandidateProjection(
        view.candidateDirectory,
        input.step.generatedPathScopes,
      ),
      fingerprintGeneratedScopes(
        view.candidateDirectory,
        input.step.generatedPathScopes,
      ),
    ]);
    const protectedProjectionChanged =
      protectedBefore.fingerprint !== protectedAfter.fingerprint;
    const usageKnown = processResult.processGroupGone
      && processResult.wallClockMs <= input.reservedWallClockMs
      && generatedAfter.totalFileBytes
        <= input.reservedGeneratedBytes
      && processResult.outputBytes <= input.reservedOutputBytes;
    let state: CandidateBootstrapStateV1;
    let status: CandidateBootstrapStepExecutionResultV1['status'];
    if (!usageKnown) {
      state = await stateStore.retainUnknown({
        worktreeLease: lease,
        bootstrapPlan: input.bootstrapPlan,
        step: input.step,
        reservationId: input.reservationId,
        budgetEventId: input.finishBudgetEventId,
      });
      status = 'retained_unknown';
    } else {
      const successful = processResult.exitCode === 0
        && !processResult.timedOut
        && !processResult.aborted
        && !processResult.outputLimitExceeded
        && !protectedProjectionChanged;
      state = await stateStore.finishStep({
        worktreeLease: lease,
        bootstrapPlan: input.bootstrapPlan,
        step: input.step,
        reservationId: input.reservationId,
        budgetEventId: input.finishBudgetEventId,
        journalEventId: input.finishJournalEventId,
        eventType: successful ? 'observed' : 'failed',
        generatedScopeFingerprint: generatedAfter.fingerprint,
        exitCode: successful
          ? 0
          : processResult.exitCode === 0 ? -1 : processResult.exitCode,
        actualWallClockMs: processResult.wallClockMs,
        actualGeneratedBytes: generatedAfter.totalFileBytes,
        actualOutputBytes: processResult.outputBytes,
        idempotencyKey: input.idempotencyKey,
      });
      status = successful ? 'observed' : 'failed';
    }
    await privateStore.destroy(privateHandle);
    return Object.freeze({
      recovered: false,
      status,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      aborted: processResult.aborted,
      outputLimitExceeded: processResult.outputLimitExceeded,
      protectedProjectionChanged,
      wallClockMs: processResult.wallClockMs,
      generatedBytes: generatedAfter.totalFileBytes,
      outputBytes: processResult.outputBytes,
      generatedScopeFingerprint: generatedAfter.fingerprint,
      stdoutDigest: processResult.stdoutDigest,
      stderrDigest: processResult.stderrDigest,
      bootstrapStateDigest: state.stateDigest,
    });
  }
}

async function recoverCommittedExecution(
  stateStore: CandidateBootstrapStateStore,
  initialState: CandidateBootstrapStateV1,
  input: ExecuteCandidateBootstrapStepV1,
  candidateDirectory: string,
): Promise<CandidateBootstrapStepExecutionResultV1 | null> {
  const terminal = initialState.journalEvents.findLast((event) =>
    event.stepId === input.step.stepId
    && (event.eventType === 'observed'
      || event.eventType === 'reconciled'
      || event.eventType === 'failed'));
  const reservation = initialState.reservations.find(
    (candidate) => candidate.reservationId === input.reservationId,
  );
  if (terminal !== undefined) {
    const generated = await fingerprintGeneratedScopes(
      candidateDirectory,
      input.step.generatedPathScopes,
    );
    if (reservation === undefined
      || terminal.reservationId !== reservation.reservationId
      || terminal.generatedScopeFingerprint === null
      || terminal.exitCode === null
      || generated.fingerprint
        !== terminal.generatedScopeFingerprint
      || (reservation.actualGeneratedBytes !== null
        && generated.totalFileBytes
          !== reservation.actualGeneratedBytes)) {
      integrity('The completed bootstrap step recovery binding is invalid.');
    }
    return recoveredResult(
      initialState,
      terminal.eventType === 'observed'
        || terminal.eventType === 'reconciled'
        ? 'observed'
        : 'failed',
      terminal.exitCode,
      terminal.generatedScopeFingerprint,
      reservation.actualWallClockMs ?? 0,
      reservation.actualGeneratedBytes ?? 0,
      reservation.actualOutputBytes ?? 0,
    );
  }
  if (initialState.journal.activeStepId !== input.step.stepId) return null;
  if (reservation === undefined
    || reservation.stepId !== input.step.stepId) {
    integrity('The in-flight bootstrap step has no exact reservation.');
  }
  const generated = await fingerprintGeneratedScopes(
    candidateDirectory,
    input.step.generatedPathScopes,
  );
  if (initialState.journal.state === 'step_prepared'
    && reservation.state === 'reserved') {
    const failed = await stateStore.failPrepared({
      worktreeLease: input.worktreeAuthority.lease,
      bootstrapPlan: input.bootstrapPlan,
      step: input.step,
      reservationId: input.reservationId,
      budgetEventId: input.finishBudgetEventId,
      journalEventId: input.finishJournalEventId,
      generatedScopeFingerprint: generated.fingerprint,
      idempotencyKey: input.idempotencyKey,
    });
    return recoveredResult(
      failed,
      'failed',
      -1,
      generated.fingerprint,
      0,
      generated.totalFileBytes,
      0,
    );
  }
  if (initialState.journal.state === 'step_running'
    && (reservation.state === 'running'
      || reservation.state === 'retained_unknown')) {
    const unknown = reservation.state === 'running'
      ? await stateStore.retainUnknown({
          worktreeLease: input.worktreeAuthority.lease,
          bootstrapPlan: input.bootstrapPlan,
          step: input.step,
          reservationId: input.reservationId,
          budgetEventId: input.finishBudgetEventId,
        })
      : initialState;
    return recoveredResult(
      unknown,
      'retained_unknown',
      null,
      generated.fingerprint,
      reservation.reservedWallClockMs,
      generated.totalFileBytes,
      reservation.reservedOutputBytes,
    );
  }
  integrity('The in-flight bootstrap state cannot be reconciled safely.');
}

function recoveredResult(
  state: CandidateBootstrapStateV1,
  status: CandidateBootstrapStepExecutionResultV1['status'],
  exitCode: number | null,
  generatedScopeFingerprint: string,
  wallClockMs: number,
  generatedBytes: number,
  outputBytes: number,
): CandidateBootstrapStepExecutionResultV1 {
  return Object.freeze({
    recovered: true,
    status,
    exitCode,
    timedOut: null,
    aborted: null,
    outputLimitExceeded: null,
    protectedProjectionChanged: null,
    wallClockMs,
    generatedBytes,
    outputBytes,
    generatedScopeFingerprint,
    stdoutDigest: null,
    stderrDigest: null,
    bootstrapStateDigest: state.stateDigest,
  });
}

async function destroyRecoveredPrivateInputs(
  privateStore: BootstrapPrivateInputStore,
  lease: ExecuteCandidateBootstrapStepV1['worktreeAuthority']['lease'],
  plan: CandidateBootstrapPlanV1,
  step: CandidateBootstrapStepV1,
): Promise<void> {
  try {
    const handle = await privateStore.resume(lease, plan, step);
    await privateStore.destroy(handle);
  } catch (error) {
    if (error instanceof BootstrapPrivateInputStoreError
      && (error.reasonCode === 'bootstrap_private_not_found'
        || error.reasonCode === 'bootstrap_private_destroyed')) {
      return;
    }
    throw error;
  }
}

async function runExactProcess(input: {
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly signal?: AbortSignal;
  readonly monotonicNow: () => number;
}): Promise<ProcessResult> {
  const startedAt = input.monotonicNow();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.executablePath, [...input.argv], {
      cwd: input.cwd,
      env: { ...input.environment },
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new CandidateBootstrapExecutorError(
      'candidate_bootstrap_executor_integrity_failed',
      'Unable to spawn the frozen bootstrap executable.',
      { cause: error },
    );
  }
  // A process may exit before consuming stdin. Treat EPIPE/early close as an
  // expected consequence of the exact no-input contract, not as an unhandled
  // stream error.
  child.stdin.on('error', () => {});
  child.stdin.end();
  const stdout = createHash('sha256')
    .update('wukong/bootstrap-process-stdout/v1')
    .update('\0');
  const stderr = createHash('sha256')
    .update('wukong/bootstrap-process-stderr/v1')
    .update('\0');
  let outputBytes = 0;
  let timedOut = false;
  let aborted = false;
  let outputLimitExceeded = false;
  let terminating = false;
  let forceTimer: NodeJS.Timeout | null = null;
  const terminate = (reason: 'timeout' | 'abort' | 'output'): void => {
    if (reason === 'timeout') timedOut = true;
    if (reason === 'abort') aborted = true;
    if (reason === 'output') outputLimitExceeded = true;
    if (terminating) return;
    terminating = true;
    signalProcessGroup(child, 'SIGTERM');
    forceTimer = setTimeout(
      () => {
        signalProcessGroup(child, 'SIGKILL');
      },
      KILL_GRACE_MS,
    );
    forceTimer.unref();
  };
  const collect = (
    hash: ReturnType<typeof createHash>,
    chunk: Buffer,
  ): void => {
    hash.update(chunk);
    outputBytes += chunk.byteLength;
    if (outputBytes > input.outputLimitBytes) terminate('output');
  };
  child.stdout.on('data', (chunk: Buffer) => {
    collect(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    collect(stderr, chunk);
  });
  const timeout = setTimeout(() => {
    terminate('timeout');
  }, input.timeoutMs);
  const onAbort = (): void => {
    terminate('abort');
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted === true) onAbort();
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      resolveExit(code ?? signalExitCode(signal));
    });
  }).finally(() => {
    clearTimeout(timeout);
    if (forceTimer !== null) clearTimeout(forceTimer);
    input.signal?.removeEventListener('abort', onAbort);
  });
  const processGroupGone = await terminateRemainingProcessGroup(child);
  const endedAt = input.monotonicNow();
  const elapsed = Math.max(0, Math.ceil(endedAt - startedAt));
  return {
    exitCode,
    timedOut,
    aborted,
    outputLimitExceeded,
    processGroupGone,
    wallClockMs: Number.isSafeInteger(elapsed)
      ? elapsed
      : Number.MAX_SAFE_INTEGER,
    outputBytes,
    stdoutDigest: `sha256:${stdout.digest('hex')}`,
    stderrDigest: `sha256:${stderr.digest('hex')}`,
  };
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isNodeError(error, 'ESRCH')) {
      try {
        child.kill(signal);
      } catch {}
    }
  }
}

async function terminateRemainingProcessGroup(
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> {
  if (child.pid === undefined) return false;
  if (!processGroupExists(child.pid)) return true;
  signalProcessGroup(child, 'SIGTERM');
  await delay(KILL_GRACE_MS);
  if (!processGroupExists(child.pid)) return true;
  signalProcessGroup(child, 'SIGKILL');
  await delay(KILL_GRACE_MS);
  return !processGroupExists(child.pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return -1;
  const numbers: Readonly<Record<string, number>> = {
    SIGABRT: 6,
    SIGALRM: 14,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGHUP: 1,
    SIGILL: 4,
    SIGINT: 2,
    SIGKILL: 9,
    SIGPIPE: 13,
    SIGQUIT: 3,
    SIGSEGV: 11,
    SIGTERM: 15,
    SIGTRAP: 5,
  };
  return -(numbers[signal] ?? 1);
}

function emptyOutputDigest(stream: 'stdout' | 'stderr'): string {
  return `sha256:${createHash('sha256')
    .update(`wukong/bootstrap-process-${stream}/v1`)
    .update('\0')
    .digest('hex')}`;
}

async function resolveSafeCandidateCwd(
  candidateDirectory: string,
  candidateRelativeCwd: string,
): Promise<string> {
  const candidateRoot = await realpath(candidateDirectory);
  const cwd = candidateRelativeCwd === '.'
    ? candidateRoot
    : resolve(candidateRoot, candidateRelativeCwd);
  if (!isInside(candidateRoot, cwd)
    || await realpath(cwd) !== cwd
    || !(await lstat(cwd)).isDirectory()) {
    fail(
      'candidate_bootstrap_executor_path_unsafe',
      'The bootstrap cwd escaped or traversed a candidate symlink.',
    );
  }
  return cwd;
}

export async function fingerprintGeneratedScopes(
  candidateDirectory: string,
  scopes: readonly string[],
): Promise<TreeFingerprint> {
  return fingerprintTree(candidateDirectory, scopes, false);
}

export async function fingerprintCandidateProjection(
  candidateDirectory: string,
  excludedScopes: readonly string[],
): Promise<TreeFingerprint> {
  return fingerprintTree(candidateDirectory, excludedScopes, true);
}

async function fingerprintTree(
  candidateDirectory: string,
  scopes: readonly string[],
  projection: boolean,
): Promise<TreeFingerprint> {
  const root = await realpath(candidateDirectory);
  const entries: FingerprintEntry[] = [];
  let totalFileBytes = 0;
  const scopeSet = new Set(scopes);
  const walk = async (relativePath: string): Promise<void> => {
    if (entries.length >= MAX_SCOPE_ENTRIES) {
      integrity('The bootstrap fingerprint exceeded its entry limit.');
    }
    const path = relativePath === '.' ? root : join(root, relativePath);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        entries.push({
          path: relativePath,
          kind: 'missing',
          mode: null,
          sizeBytes: 0,
          contentDigest: null,
        });
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      integrity('A bootstrap fingerprint scope contains a symlink.');
    }
    if (info.isDirectory()) {
      entries.push({
        path: relativePath,
        kind: 'directory',
        mode: info.mode & 0o777,
        sizeBytes: 0,
        contentDigest: null,
      });
      const children = (await readdir(path)).toSorted();
      for (const child of children) {
        const next = relativePath === '.' ? child : `${relativePath}/${child}`;
        if (projection && (next === '.git' || isWithinAny(next, scopeSet))) {
          continue;
        }
        await walk(next);
      }
      return;
    }
    if (!info.isFile() || info.nlink !== 1) {
      integrity('A bootstrap fingerprint scope contains an unsafe file.');
    }
    totalFileBytes += info.size;
    if (!Number.isSafeInteger(totalFileBytes)
      || totalFileBytes > MAX_FINGERPRINT_BYTES) {
      integrity('The bootstrap fingerprint exceeded its byte limit.');
    }
    entries.push({
      path: relativePath,
      kind: 'file',
      mode: info.mode & 0o777,
      sizeBytes: info.size,
      contentDigest: await digestExactFile(path, info),
    });
  };
  if (projection) {
    await walk('.');
  } else {
    for (const scope of scopes) {
      const absolute = resolve(root, scope);
      if (!isInside(root, absolute)) {
        invalidInput('A generated bootstrap scope escaped the candidate.');
      }
      await assertNoSymlinkAncestry(root, absolute);
      await walk(scope);
    }
  }
  return Object.freeze({
    fingerprint: canonicalDigest(
      projection
        ? 'wukong/candidate-source-projection/v1'
        : 'wukong/bootstrap-generated-scopes/v1',
      entries,
    ),
    totalFileBytes,
    entryCount: entries.length,
  });
}

async function assertNoSymlinkAncestry(
  root: string,
  path: string,
): Promise<void> {
  const segments = relative(root, path).split(/[\\/]/u).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      integrity('A generated bootstrap scope has unsafe ancestry.');
    }
  }
}

async function digestExactFile(path: string, linked: Stats): Promise<string> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  const hash = createHash('sha256')
    .update('wukong/bootstrap-generated-file/v1')
    .update('\0');
  try {
    const before = await handle.stat();
    if (!sameFileIdentity(before, linked)) {
      integrity('A bootstrap fingerprint file changed before reading.');
    }
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - position),
        position,
      );
      if (bytesRead === 0) {
        integrity('A bootstrap fingerprint file ended early.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFile(before, after)) {
      integrity('A bootstrap fingerprint file changed while reading.');
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest('hex')}`;
}

function isWithinAny(path: string, scopes: ReadonlySet<string>): boolean {
  for (const scope of scopes) {
    if (path === scope || path.startsWith(`${scope}/`)) return true;
  }
  return false;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function sameFile(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertExecutionInput(
  input: ExecuteCandidateBootstrapStepV1,
): void {
  if (!isRecord(input)
    || !isRecord(input.worktreeAuthority)
    || !validateWorktreeLease(input.worktreeAuthority.lease)
    || input.worktreeAuthority.lease.state !== 'bootstrapping'
    || !validateCandidateBootstrapPlan(input.bootstrapPlan)
    || !validateBootstrapBudget(input.bootstrapBudget)
    || !validateCandidateBootstrapStep(input.step)
    || input.worktreeAuthority.lease.bootstrapPlanDigest
      !== input.bootstrapPlan.bootstrapPlanDigest
    || input.bootstrapPlan.bootstrapBudgetDigest
      !== input.bootstrapBudget.budgetDigest
    || !input.bootstrapPlan.steps.some(
      (step) => step.stepDigest === input.step.stepDigest,
    )
    || input.reservedWallClockMs < input.step.timeoutMs
    || input.reservedGeneratedBytes < 0
    || input.reservedOutputBytes < 0
    || input.step.lifecycleScripts !== 'deny'
    || (input.bootstrapPlan.networkPolicy === 'deny'
      ? input.bootstrapPlan.allowedRegistryEndpointDigests.length > 0
      : input.bootstrapPlan.allowedRegistryEndpointDigests.length === 0)) {
    invalidInput('The candidate bootstrap execution input is invalid.');
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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

function invalidInput(message: string): never {
  fail('candidate_bootstrap_executor_invalid_input', message);
}

function integrity(message: string): never {
  fail('candidate_bootstrap_executor_integrity_failed', message);
}

function fail(
  reasonCode: CandidateBootstrapExecutorErrorCode,
  message: string,
): never {
  throw new CandidateBootstrapExecutorError(reasonCode, message);
}
