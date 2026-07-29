import { resolve } from 'node:path';

import {
  applyNextPromotionChange,
} from '../../src/promotion-change-applier';
import {
  PromotionApplyJournalStore,
} from '../../src/promotion-apply-journal-store';
import {
  TargetCompletionSealStore,
} from '../../src/target-completion-seal-store';
import {
  __testing as durableFaultTesting,
  type DurableBoundaryTestFaultPointV1,
} from '../../src/durable-boundary-test-fault';
import {
  TargetFinalGateAttemptStore,
} from '../../src/target-final-gate-attempt-store';
import {
  TargetFinalGateOrchestrator,
} from '../../src/target-final-gate-orchestrator';
import {
  TargetPromotionLeaseStore,
} from '../../src/target-promotion-lease-store';
import {
  createSignalApplyJournal,
  createSignalFinalGateEvidence,
  createTargetDurableSignalFixture,
  prepareSignalCompletedGate,
  signalFinalGateInitializeInput,
  TARGET_SIGNAL_IDS,
  TARGET_SIGNAL_REDACTION_POLICY,
} from './target-durable-signal-fixture';

export type TargetProductionSignalBoundary =
  | 'production_apply'
  | 'production_apply_atomic'
  | 'production_apply_outcome'
  | 'production_final_gate'
  | 'production_completion';

const root = process.argv[2];
const boundary = process.argv[3] as
  | TargetProductionSignalBoundary
  | undefined;
if (root === undefined || !isBoundary(boundary)) {
  throw new Error(
    'A target production signal root and boundary are required.',
  );
}
const expectedPoint = faultPointFor(boundary);
const faultCapability =
  durableFaultTesting.createDurableBoundaryTestFaultCapability(
    async (point) => {
      if (point === 'promotion_apply_before_target_mutation') {
        return;
      }
      if (point === 'promotion_apply_after_final_leaf_check'
        || (point === 'promotion_apply_after_atomic_leaf_mutation'
          && point !== expectedPoint)
        || (point === 'promotion_apply_after_target_mutation'
          && point !== expectedPoint)) {
        return;
      }
      if (point !== expectedPoint) {
        throw new Error(
          `Unexpected production fault point ${point}.`,
        );
      }
      process.stdout.write(`ready:${boundary}\n`);
      setInterval(() => {}, 60_000);
      await new Promise<never>(() => {});
    },
  );
const absoluteRoot = resolve(root);
const targetStore = new TargetPromotionLeaseStore({
  registryRootDirectory: resolve(absoluteRoot, 'registry'),
  now: monotonicClock(),
  _testFaultCapability: faultCapability,
});
const fixture = await createTargetDurableSignalFixture({
  root: absoluteRoot,
  finalVerifying: !boundary.startsWith('production_apply'),
  targetStore,
});

if (boundary === 'production_apply'
  || boundary === 'production_apply_atomic'
  || boundary === 'production_apply_outcome') {
  await targetStore.withExclusiveLease(
    fixture.applying.binding,
    'applying',
    async (view) => {
      const journalStore = new PromotionApplyJournalStore({
        now: () => new Date('2026-07-29T18:00:03.000Z'),
      });
      const journal = await journalStore.createOrLoad(
        view,
        createSignalApplyJournal(view, fixture.manifest),
      );
      await applyNextPromotionChange({
        view,
        journalStore,
        journal,
        manifest: fixture.manifest,
        targetDirectory: fixture.targetDirectory,
        candidateDirectory: fixture.candidateDirectory,
        now: () => new Date('2026-07-29T18:00:04.000Z'),
        _testFaultCapability: faultCapability,
      });
    },
  );
  throw new Error('Production Apply fault point did not pause.');
}

const finalVerifying = fixture.finalVerifying;
if (finalVerifying === null) {
  throw new Error('The production fixture has no Final Gate lease.');
}
if (boundary === 'production_final_gate') {
  await new TargetFinalGateOrchestrator({
    now: () => new Date('2026-07-29T18:00:05.000Z'),
    _testFaultCapability: faultCapability,
  }).run({
    targetPromotionLeaseStore: targetStore,
    targetPromotionBinding: finalVerifying.binding,
    attemptStore: new TargetFinalGateAttemptStore({
      now: () => new Date('2026-07-29T18:00:04.000Z'),
    }),
    initialize: signalFinalGateInitializeInput(),
    evidenceProducer: {
      produce: ({ preparedAttempt }) =>
        Promise.resolve(
          createSignalFinalGateEvidence(preparedAttempt),
        ),
    },
  });
  throw new Error('Production Final Gate fault point did not pause.');
}

await targetStore.withExclusiveLease(
  finalVerifying.binding,
  'final_verifying',
  async (view) => {
    const completed = await prepareSignalCompletedGate({
      view,
      attemptStore: fixture.attemptStore,
      manifest: fixture.manifest,
    });
    await new TargetCompletionSealStore({
      now: () => new Date('2026-07-29T18:00:06.000Z'),
      _testFaultCapability: faultCapability,
    }).sealAndReopen(view, {
      completionSealId: TARGET_SIGNAL_IDS.completionSeal,
      journal: completed.journal,
      finalGateState: completed.completed,
      redactionPolicyVersion:
        TARGET_SIGNAL_REDACTION_POLICY,
    });
  },
);
throw new Error('Production completion fault point did not pause.');

function faultPointFor(
  value: TargetProductionSignalBoundary,
): DurableBoundaryTestFaultPointV1 {
  if (value === 'production_apply') {
    return 'promotion_apply_after_target_mutation';
  }
  if (value === 'production_apply_atomic') {
    return 'promotion_apply_after_atomic_leaf_mutation';
  }
  if (value === 'production_apply_outcome') {
    return 'promotion_apply_after_outcome_recorded';
  }
  if (value === 'production_final_gate') {
    return 'target_final_gate_after_evidence_recorded';
  }
  return 'target_completion_after_artifacts_synced';
}

function isBoundary(
  value: string | undefined,
): value is TargetProductionSignalBoundary {
  return value === 'production_apply'
    || value === 'production_apply_atomic'
    || value === 'production_apply_outcome'
    || value === 'production_final_gate'
    || value === 'production_completion';
}

function monotonicClock(): () => Date {
  let tick = 0;
  const base = Date.parse('2026-07-29T18:00:00.000Z');
  return () => new Date(base + tick++ * 1_000);
}
