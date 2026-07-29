import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyNextPromotionChange,
} from '../src/promotion-change-applier';
import {
  __testing as durableFaultTesting,
} from '../src/durable-boundary-test-fault';
import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  PromotionApplyJournalStore,
} from '../src/promotion-apply-journal-store';
import {
  requireValidatedTargetCompletionSeal,
  TargetCompletionSealStore,
  type TargetCompletionSealAuthorizationV1,
} from '../src/target-completion-seal-store';
import {
  TargetFinalGateAttemptStore,
} from '../src/target-final-gate-attempt-store';
import {
  TargetFinalGateOrchestrator,
} from '../src/target-final-gate-orchestrator';
import {
  TargetLoopTerminalFinalizer,
} from '../src/target-loop-terminal-finalizer';
import {
  type TargetPromotionLeaseAuthorityV1,
  TargetPromotionLeaseStore,
} from '../src/target-promotion-lease-store';
import {
  createSignalApplyJournal,
  createSignalCandidateDeltaBundle,
  prepareSignalCompletedGate,
  signalFinalGateInitializeInput,
  targetCompletionDirectory,
  TARGET_SIGNAL_IDS,
  TARGET_SIGNAL_OWNER_RUN_ID,
  TARGET_SIGNAL_REDACTION_POLICY,
  type TargetDurableSignalBoundary,
} from './fixtures/target-durable-signal-fixture';

const roots: string[] = [];
const children = new Set<ChildProcess>();
type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
const signals: readonly TerminationSignal[] =
  process.platform === 'win32'
    ? ['SIGKILL']
    : ['SIGINT', 'SIGTERM'];
type TargetProductionSignalBoundary =
  | 'production_apply'
  | 'production_apply_atomic'
  | 'production_apply_outcome'
  | 'production_final_gate'
  | 'production_completion';

vi.setConfig({ testTimeout: 60_000 });

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('target durable hard-signal recovery', () => {
  it.each(signals)(
    'resumes an Apply prepared boundary after %s without duplicate mutation',
    async (signal) => {
      const crashed = await crashAt('apply_prepared', signal);
      const adopted = await adopt(crashed, 'applying');
      const result = await resumeApply(crashed, adopted);

      expect(result.events).toHaveLength(2);
      expect(result.events.map(({ eventType }) => eventType))
        .toEqual(['prepared', 'applied']);
      expect(result.targetFencingTokenLineage).toEqual([
        crashed.lease.fencingTokenDigest,
        adopted.lease.fencingTokenDigest,
      ]);
      expect(await readFile(
        join(crashed.root, 'target', 'update.txt'),
        'utf8',
      )).toBe('after\n');
    },
  );

  it.each(signals)(
    'reuses durable Final Gate evidence after %s without rerunning checks',
    async (signal) => {
      const crashed = await crashAt(
        'final_gate_evidence',
        signal,
      );
      const adopted = await adopt(crashed, 'final_verifying');
      const producer = vi.fn(() => Promise.reject(
        new Error('durable evidence must not rerun'),
      ));
      const completed = await new TargetFinalGateOrchestrator({
        now: () => new Date('2026-07-29T18:10:04.000Z'),
      }).run({
        targetPromotionLeaseStore: crashed.store,
        targetPromotionBinding: adopted.binding,
        attemptStore: new TargetFinalGateAttemptStore({
          now: () => new Date('2026-07-29T18:10:03.000Z'),
        }),
        initialize: signalFinalGateInitializeInput(),
        evidenceProducer: { produce: producer },
      });

      expect(producer).not.toHaveBeenCalled();
      expect(completed).toMatchObject({
        state: 'completed',
        casRevision: 3,
        result: {
          outcome: 'PASS',
          reasonCode: 'target_final_gate_passed',
        },
      });
      expect(completed.targetFencingTokenLineage).toEqual([
        crashed.lease.fencingTokenDigest,
        adopted.lease.fencingTokenDigest,
      ]);
      expect(completed.evidence?.targetFencingTokenDigest)
        .toBe(crashed.lease.fencingTokenDigest);
    },
  );

  it.each(signals)(
    'finishes a partial completion artifact set after %s',
    async (signal) => {
      const crashed = await crashAt('completion_partial', signal);
      const adopted = await adopt(crashed, 'final_verifying');
      const { seal } = await reopenCompletion(crashed, adopted);
      const directory = targetCompletionDirectory(
        crashed.root,
        crashed.lease.targetRegistryKey,
      );

      expect((await readdir(directory)).toSorted()).toEqual([
        'attempt.json',
        'evidence.json',
        'journal.json',
        'seal.json',
      ]);
      expect(seal.targetFencingTokenDigest)
        .toBe(adopted.lease.fencingTokenDigest);
      expect(seal.finalGateOutcome).toBe('PASS');
    },
  );

  it.each(signals)(
    'reopens the exact durable completion seal after %s',
    async (signal) => {
      const crashed = await crashAt('completion_sealed', signal);
      const sealPath = join(
        targetCompletionDirectory(
          crashed.root,
          crashed.lease.targetRegistryKey,
        ),
        'seal.json',
      );
      const before = await readFile(sealPath, 'utf8');
      const adopted = await adopt(crashed, 'final_verifying');
      const { seal } = await reopenCompletion(crashed, adopted);

      expect(await readFile(sealPath, 'utf8')).toBe(before);
      expect(seal.targetFencingTokenDigest)
        .toBe(crashed.lease.fencingTokenDigest);
      expect(seal.finalGateOutcome).toBe('PASS');
    },
  );

  it.each(signals)(
    'joins one durable terminal and releases after %s',
    async (signal) => {
      const crashed = await crashAt('terminal_recorded', signal);
      const terminalPath = join(crashed.root, 'terminal.json');
      const before = await readFile(terminalPath, 'utf8');
      const adopted = await adopt(crashed, 'final_verifying');
      const reopened = await reopenCompletion(crashed, adopted);
      let writes = 0;
      const terminal = JSON.parse(before) as {
        readonly runId: string;
        readonly contractId: string;
        readonly status: 'PASS';
        readonly targetCompletionSealDigest: string;
      };
      const committed = await new TargetLoopTerminalFinalizer()
        .commit({
          targetPromotionLeaseStore: crashed.store,
          targetPromotionBinding: adopted.binding,
          completionSealStore: reopened.completionStore,
          completionSealId: reopened.seal.completionSealId,
          expectedCompletionSealDigest:
            reopened.seal.completionSealDigest,
          terminalRecorder: {
            recordIsolatedLoopTerminal: ({
              completionAuthorization,
            }: {
              readonly completionAuthorization:
                TargetCompletionSealAuthorizationV1;
            }) => {
              writes += 1;
              const seal = requireValidatedTargetCompletionSeal(
                completionAuthorization,
              );
              expect(terminal.targetCompletionSealDigest)
                .toBe(seal.completionSealDigest);
              return terminal;
            },
          },
        });

      expect(writes).toBe(1);
      expect(await readFile(terminalPath, 'utf8')).toBe(before);
      expect(committed.terminal).toEqual(terminal);
      expect(committed.releasedAuthority.lease.state)
        .toBe('released');
    },
  );
});

describe('target production-path hard-signal recovery', () => {
  it.each(signals)(
    'reconciles production Apply after %s without a late or duplicate write',
    async (signal) => {
      const crashed = await crashAt('production_apply', signal);
      const adopted = await adopt(crashed, 'applying');
      const result = await resumeApply(crashed, adopted);

      expect(result.events.map(({ eventType }) => eventType))
        .toEqual(['prepared', 'reconciled']);
      expect(result.targetFencingTokenLineage).toEqual([
        crashed.lease.fencingTokenDigest,
        adopted.lease.fencingTokenDigest,
      ]);
      expect(await readFile(
        join(crashed.root, 'target', 'update.txt'),
        'utf8',
      )).toBe('after\n');
    },
  );

  it.each(signals)(
    'recovers the atomic Apply transaction after %s before recording outcome',
    async (signal) => {
      const crashed = await crashAt(
        'production_apply_atomic',
        signal,
      );
      const adopted = await adopt(crashed, 'applying');
      const result = await resumeApply(crashed, adopted);

      expect(result.events.map(({ eventType }) => eventType))
        .toEqual(['prepared', 'reconciled']);
      expect(await readFile(
        join(crashed.root, 'target', 'update.txt'),
        'utf8',
      )).toBe('after\n');
      expect((await readdir(join(crashed.root, 'target')))
        .filter((name) => name.startsWith('.wukong-apply-')))
        .toEqual([]);
    },
  );

  it.each(signals)(
    'finalizes the committed Apply receipt after %s once outcome is durable',
    async (signal) => {
      const crashed = await crashAt(
        'production_apply_outcome',
        signal,
      );
      expect((await readdir(join(crashed.root, 'target')))
        .filter((name) => name.startsWith('.wukong-apply-')))
        .toHaveLength(1);
      const adopted = await adopt(crashed, 'applying');
      const result = await resumeApply(crashed, adopted);

      expect(result.events.map(({ eventType }) => eventType))
        .toEqual(['prepared', 'applied']);
      expect(await readFile(
        join(crashed.root, 'target', 'update.txt'),
        'utf8',
      )).toBe('after\n');
      expect((await readdir(join(crashed.root, 'target')))
        .filter((name) => name.startsWith('.wukong-apply-')))
        .toEqual([]);
    },
  );

  it.each(signals)(
    'resumes production Final Gate after %s without false PASS or rerun',
    async (signal) => {
      const crashed = await crashAt(
        'production_final_gate',
        signal,
      );
      const beforeRecovery = JSON.parse(await readFile(
        join(
          crashed.root,
          'registry',
          crashed.lease.targetRegistryKey.slice('sha256:'.length),
          'target-final-gate-attempts',
          TARGET_SIGNAL_IDS.finalGateAttempt,
          'attempt.json',
        ),
        'utf8',
      )) as {
        readonly state: string;
        readonly result: unknown;
      };
      expect(beforeRecovery).toMatchObject({
        state: 'evidence_recorded',
        result: null,
      });
      const adopted = await adopt(crashed, 'final_verifying');
      const producer = vi.fn(() => Promise.reject(
        new Error('production evidence must not rerun'),
      ));
      const completed = await new TargetFinalGateOrchestrator({
        now: () => new Date('2026-07-29T18:10:04.000Z'),
      }).run({
        targetPromotionLeaseStore: crashed.store,
        targetPromotionBinding: adopted.binding,
        attemptStore: new TargetFinalGateAttemptStore({
          now: () => new Date('2026-07-29T18:10:03.000Z'),
        }),
        initialize: signalFinalGateInitializeInput(),
        evidenceProducer: { produce: producer },
      });

      expect(producer).not.toHaveBeenCalled();
      expect(completed).toMatchObject({
        state: 'completed',
        casRevision: 3,
        result: {
          outcome: 'PASS',
          reasonCode: 'target_final_gate_passed',
        },
      });
      expect(completed.targetFencingTokenLineage).toEqual([
        crashed.lease.fencingTokenDigest,
        adopted.lease.fencingTokenDigest,
      ]);
    },
  );

  it.each(signals)(
    'seals production completion artifacts after %s without false terminal',
    async (signal) => {
      const crashed = await crashAt(
        'production_completion',
        signal,
      );
      const directory = targetCompletionDirectory(
        crashed.root,
        crashed.lease.targetRegistryKey,
      );
      expect((await readdir(directory)).toSorted()).toEqual([
        'attempt.json',
        'evidence.json',
        'journal.json',
      ]);
      const adopted = await adopt(crashed, 'final_verifying');
      const { seal } = await reopenCompletion(crashed, adopted);

      expect((await readdir(directory)).toSorted()).toEqual([
        'attempt.json',
        'evidence.json',
        'journal.json',
        'seal.json',
      ]);
      expect(seal.targetFencingTokenDigest)
        .toBe(adopted.lease.fencingTokenDigest);
      expect(seal.finalGateOutcome).toBe('PASS');
    },
  );
});

interface CrashedBoundary {
  readonly root: string;
  readonly store: TargetPromotionLeaseStore;
  readonly lease: Awaited<
    ReturnType<TargetPromotionLeaseStore['inspect']>
  >;
}

async function crashAt(
  boundary:
    | TargetDurableSignalBoundary
    | TargetProductionSignalBoundary,
  signal: typeof signals[number],
): Promise<CrashedBoundary> {
  const root = await mkdtemp(join(
    tmpdir(),
    `wukong-target-${boundary}-`,
  ));
  roots.push(root);
  const workerPath = new URL(
    boundary.startsWith('production_')
      ? './fixtures/target-production-signal-worker.ts'
      : './fixtures/target-durable-signal-worker.ts',
    import.meta.url,
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(workerPath), root, boundary],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  const ready = await waitForReady(child);
  expect(ready).toBe(`ready:${boundary}`);
  const exit = once(child, 'exit');
  expect(child.kill(signal)).toBe(true);
  const [exitCode, exitSignal] = await exit;
  if (process.platform !== 'win32') {
    expect(exitCode).toBeNull();
    expect(exitSignal).toBe(signal);
  }

  const registryEntries = await readdir(join(root, 'registry'));
  expect(registryEntries).toHaveLength(1);
  const targetRegistryKey = `sha256:${registryEntries[0]!}`;
  let tick = 0;
  const commonOptions = {
    registryRootDirectory: join(root, 'registry'),
    now: () => new Date(
      Date.parse('2026-07-29T18:10:00.000Z')
        + tick++ * 1_000,
    ),
  };
  const store = boundary.startsWith('production_')
    ? new TargetPromotionLeaseStore({
        ...commonOptions,
        _testFaultCapability:
          durableFaultTesting
            .createDurableBoundaryTestFaultCapability(() => {}),
      })
    : new TargetPromotionLeaseStore(commonOptions);
  const lease = await store.inspect(targetRegistryKey);
  return { root, store, lease };
}

async function waitForReady(child: ChildProcess): Promise<string> {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('Target signal worker pipes are unavailable.');
  }
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  return Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(
        `Target signal worker exited before ready `
        + `(code=${String(code)}, signal=${String(signal)}): `
        + Buffer.concat(stderr).toString('utf8'),
      );
    }),
  ]);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}

async function adopt(
  crashed: CrashedBoundary,
  state: 'applying' | 'final_verifying',
): Promise<TargetPromotionLeaseAuthorityV1> {
  expect(crashed.lease.state).toBe(state);
  const input = {
    targetRegistryKey: crashed.lease.targetRegistryKey,
    ownerRunId: TARGET_SIGNAL_OWNER_RUN_ID,
    expectedLeaseDigest: crashed.lease.leaseDigest,
    nextProcessLivenessProof:
      await captureProcessLivenessProof(),
  };
  return state === 'applying'
    ? crashed.store.adoptApplying(input)
    : crashed.store.adoptFinalVerifying(input);
}

async function resumeApply(
  crashed: CrashedBoundary,
  adopted: TargetPromotionLeaseAuthorityV1,
) {
  const bundle = createSignalCandidateDeltaBundle();
  const journalStore = new PromotionApplyJournalStore({
    now: () => new Date('2026-07-29T18:10:02.000Z'),
  });
  return crashed.store.withExclusiveLease(
    adopted.binding,
    'applying',
    async (view) => {
      const journal = await journalStore.createOrLoad(
        view,
        createSignalApplyJournal(view, bundle.manifest),
      );
      return applyNextPromotionChange({
        view,
        journalStore,
        journal,
        manifest: bundle.manifest,
        targetDirectory: join(crashed.root, 'target'),
        candidateDirectory: join(crashed.root, 'candidate'),
        now: () => new Date('2026-07-29T18:10:03.000Z'),
      });
    },
  );
}

async function reopenCompletion(
  crashed: CrashedBoundary,
  adopted: TargetPromotionLeaseAuthorityV1,
) {
  const bundle = createSignalCandidateDeltaBundle();
  const attemptStore = new TargetFinalGateAttemptStore({
    now: () => new Date('2026-07-29T18:10:03.000Z'),
  });
  const completionStore = new TargetCompletionSealStore({
    now: () => new Date('2026-07-29T18:10:04.000Z'),
  });
  const seal = await crashed.store.withExclusiveLease(
    adopted.binding,
    'final_verifying',
    async (view) => {
      const completed = await prepareSignalCompletedGate({
        view,
        attemptStore,
        manifest: bundle.manifest,
        journalFencingTokenDigest:
          crashed.lease.fencingTokenDigest,
      });
      return completionStore.sealAndReopen(view, {
        completionSealId: TARGET_SIGNAL_IDS.completionSeal,
        journal: completed.journal,
        finalGateState: completed.completed,
        redactionPolicyVersion:
          TARGET_SIGNAL_REDACTION_POLICY,
      });
    },
  );
  return { seal, completionStore };
}
