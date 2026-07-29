import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  mkdir as mkdirAsync,
  open,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  canonicalJson,
} from '@wukong/verification';

import {
  requireValidatedTargetCompletionSeal,
} from '../../src/target-completion-seal-store';
import {
  TargetLoopTerminalFinalizer,
} from '../../src/target-loop-terminal-finalizer';
import {
  type TargetPromotionLeaseBindingV1,
  TargetPromotionLeaseStore,
} from '../../src/target-promotion-lease-store';
import {
  createSignalFinalGateEvidence,
  createTargetDurableSignalFixture,
  prepareSignalApplyJournal,
  prepareSignalCompletedGate,
  signalFinalGateInitializeInput,
  targetCompletionDirectory,
  TARGET_SIGNAL_IDS,
  TARGET_SIGNAL_REDACTION_POLICY,
  type TargetDurableSignalBoundary,
} from './target-durable-signal-fixture';

class PauseBeforeReleaseTargetPromotionLeaseStore
  extends TargetPromotionLeaseStore {
  override async transition(
    binding: TargetPromotionLeaseBindingV1,
    toState: Parameters<TargetPromotionLeaseStore['transition']>[1],
  ): ReturnType<TargetPromotionLeaseStore['transition']> {
    if (toState === 'released') {
      ready('terminal_recorded');
      setInterval(() => {}, 60_000);
      await new Promise<never>(() => {});
    }
    return super.transition(binding, toState);
  }
}

const root = process.argv[2];
const boundary = process.argv[3] as
  | TargetDurableSignalBoundary
  | undefined;
if (root === undefined || !isBoundary(boundary)) {
  throw new Error('A target durable signal root and boundary are required.');
}
const absoluteRoot = resolve(root);
const targetStore = boundary === 'terminal_recorded'
  ? new PauseBeforeReleaseTargetPromotionLeaseStore({
      registryRootDirectory: resolve(absoluteRoot, 'registry'),
      now: monotonicClock(),
    })
  : undefined;
const fixture = await createTargetDurableSignalFixture({
  root: absoluteRoot,
  finalVerifying: !boundary.startsWith('apply_'),
  targetStore,
});

if (boundary.startsWith('apply_')) {
  await fixture.targetStore.withExclusiveLease(
    fixture.applying.binding,
    'applying',
    async (view) => {
      await prepareSignalApplyJournal({
        view,
        journalStore: fixture.journalStore,
        manifest: fixture.manifest,
      });
    },
  );
  ready(boundary);
  await waitForever();
}

const finalVerifying = fixture.finalVerifying;
if (finalVerifying === null) {
  throw new Error('The Final Gate fixture has no final-verifying lease.');
}

if (boundary === 'final_gate_evidence') {
  await fixture.targetStore.withExclusiveLease(
    finalVerifying.binding,
    'final_verifying',
    async (view) => {
      const prepared = await fixture.attemptStore.initialize(
        view,
        signalFinalGateInitializeInput(),
      );
      await fixture.attemptStore.recordEvidence(
        view,
        prepared,
        createSignalFinalGateEvidence(prepared),
      );
    },
  );
  ready(boundary);
  await waitForever();
}

const completedGate =
  await fixture.targetStore.withExclusiveLease(
    finalVerifying.binding,
    'final_verifying',
    async (view) => {
      const completed = await prepareSignalCompletedGate({
        view,
        attemptStore: fixture.attemptStore,
        manifest: fixture.manifest,
      });
      if (boundary !== 'completion_partial') {
        const seal = await fixture.completionStore.sealAndReopen(
          view,
          {
            completionSealId:
              TARGET_SIGNAL_IDS.completionSeal,
            journal: completed.journal,
            finalGateState: completed.completed,
            redactionPolicyVersion:
              TARGET_SIGNAL_REDACTION_POLICY,
          },
        );
        return { ...completed, seal };
      }
      return { ...completed, seal: null };
    },
  );

if (boundary === 'completion_partial') {
  const directory = targetCompletionDirectory(
    absoluteRoot,
    finalVerifying.lease.targetRegistryKey,
  );
  await mkdirAsync(directory, {
    recursive: true,
    mode: 0o700,
  });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
  }
  await Promise.all([
    writePrivate(
      resolve(directory, 'journal.json'),
      canonicalJson(completedGate.journal),
    ),
    writePrivate(
      resolve(directory, 'evidence.json'),
      canonicalJson(completedGate.completed.evidence),
    ),
  ]);
  ready(boundary);
  await waitForever();
}

if (completedGate.seal === null) {
  throw new Error('The completion seal was not created.');
}
if (boundary === 'completion_sealed') {
  ready(boundary);
  await waitForever();
}

const terminalRecordPath = fixture.terminalRecordPath;
const finalizer = new TargetLoopTerminalFinalizer();
await finalizer.commit({
  targetPromotionLeaseStore: fixture.targetStore,
  targetPromotionBinding: finalVerifying.binding,
  completionSealStore: fixture.completionStore,
  completionSealId: completedGate.seal.completionSealId,
  expectedCompletionSealDigest:
    completedGate.seal.completionSealDigest,
  terminalRecorder: {
    recordIsolatedLoopTerminal: (input) => {
      const seal = requireValidatedTargetCompletionSeal(
        input.completionAuthorization,
      );
      const record = {
        runId: seal.runId,
        contractId: seal.contractId,
        status: seal.finalGateOutcome,
        targetCompletionSealDigest:
          seal.completionSealDigest,
      };
      try {
        writeDurableTerminal(
          terminalRecordPath,
          canonicalJson(record),
        );
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        return JSON.parse(
          readFileSync(terminalRecordPath, 'utf8'),
        ) as typeof record;
      }
      return record;
    },
  },
});
throw new Error('The terminal signal fixture unexpectedly released.');

async function writePrivate(
  path: string,
  content: string,
): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function writeDurableTerminal(
  path: string,
  content: string,
): void {
  const handle = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(handle, content, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  if (process.platform === 'win32') return;
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function ready(boundary: TargetDurableSignalBoundary): void {
  process.stdout.write(`ready:${boundary}\n`);
}

function waitForever(): Promise<never> {
  setInterval(() => {}, 60_000);
  return new Promise<never>(() => {});
}

function monotonicClock(): () => Date {
  let tick = 0;
  const base = Date.parse('2026-07-29T18:00:00.000Z');
  return () => new Date(base + tick++ * 1_000);
}

function isBoundary(
  value: string | undefined,
): value is TargetDurableSignalBoundary {
  return value === 'apply_prepared'
    || value === 'final_gate_evidence'
    || value === 'completion_partial'
    || value === 'completion_sealed'
    || value === 'terminal_recorded';
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}
