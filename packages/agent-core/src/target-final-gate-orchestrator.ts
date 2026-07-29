import {
  createTargetFinalGateAttemptResult,
  validateTargetFinalGateEvidenceSnapshot,
  type TargetFinalGateEvidenceSnapshotV1,
} from '@wukong/verification';

import {
  TargetFinalGateAttemptStore,
  type TargetFinalGateAttemptStateV1,
} from './target-final-gate-attempt-store';
import {
  injectDurableBoundaryTestFault,
  validateDurableBoundaryTestFaultCapability,
  type DurableBoundaryTestFaultCapabilityV1,
} from './durable-boundary-test-fault';
import {
  type TargetPromotionExclusiveLeaseViewV1,
  TargetPromotionLeaseBindingV1,
  TargetPromotionLeaseStore,
} from './target-promotion-lease-store';

export interface TargetFinalGateEvidenceProducerV1 {
  produce(input: {
    readonly view: TargetPromotionExclusiveLeaseViewV1;
    readonly preparedAttempt: TargetFinalGateAttemptStateV1;
  }): Promise<TargetFinalGateEvidenceSnapshotV1>;
}

/**
 * Holds the target-global final-verification lease while an existing Goal Gate
 * implementation runs, then durably joins its canonical target evidence and a
 * deterministic terminal outcome. Completion sealing and the terminal record
 * remain later commit points.
 */
export class TargetFinalGateOrchestrator {
  private readonly now: () => Date;
  private readonly testFaultCapability:
    | DurableBoundaryTestFaultCapabilityV1
    | undefined;

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
      throw new TypeError(
        'Target Final Gate orchestrator options are invalid.',
      );
    }
    this.now = options?.now ?? (() => new Date());
    this.testFaultCapability =
      options?._testFaultCapability;
  }

  async run(input: {
    readonly targetPromotionLeaseStore:
      TargetPromotionLeaseStore;
    readonly targetPromotionBinding:
      TargetPromotionLeaseBindingV1;
    readonly attemptStore: TargetFinalGateAttemptStore;
    readonly initialize: Parameters<
      TargetFinalGateAttemptStore['initialize']
    >[1];
    readonly evidenceProducer: TargetFinalGateEvidenceProducerV1;
  }): Promise<TargetFinalGateAttemptStateV1> {
    if (!(input.targetPromotionLeaseStore
        instanceof TargetPromotionLeaseStore)
      || !(input.targetPromotionBinding
        instanceof TargetPromotionLeaseBindingV1)
      || !(input.attemptStore
        instanceof TargetFinalGateAttemptStore)
      || typeof input.evidenceProducer?.produce !== 'function') {
      throw new TypeError(
        'Target Final Gate orchestration input is invalid.',
      );
    }
    return input.targetPromotionLeaseStore.withExclusiveLease(
      input.targetPromotionBinding,
      'final_verifying',
      async (view) => {
        const prepared = await input.attemptStore.initialize(
          view,
          input.initialize,
        );
        if (prepared.state === 'completed') return prepared;
        const evidence = prepared.state === 'evidence_recorded'
          ? prepared.evidence
          : await input.evidenceProducer.produce({
            view,
            preparedAttempt: prepared,
          });
        if (evidence === null
          || !validateTargetFinalGateEvidenceSnapshot(evidence)) {
          throw new TypeError(
            'Target Final Gate producer returned invalid evidence.',
          );
        }
        const recorded = prepared.state === 'evidence_recorded'
          ? prepared
          : await input.attemptStore.recordEvidence(
            view,
            prepared,
            evidence,
          );
        if (prepared.state !== 'evidence_recorded') {
          await injectDurableBoundaryTestFault(
            this.testFaultCapability,
            'target_final_gate_after_evidence_recorded',
          );
        }
        const decision = decideOutcome(evidence);
        const completedAt = timestampAfter(
          this.now(),
          evidence.finalGateCompletedAt,
        );
        return input.attemptStore.complete(
          view,
          recorded,
          createTargetFinalGateAttemptResult({
            evidence,
            requestedOutcome: decision.outcome,
            reasonCode: decision.reasonCode,
            blockerKeys: decision.blockerKeys,
            completedAt,
          }),
        );
      },
    );
  }
}

function decideOutcome(
  evidence: TargetFinalGateEvidenceSnapshotV1,
): {
  readonly outcome: 'PASS' | 'NEEDS_WORK' | 'ERROR';
  readonly reasonCode: string;
  readonly blockerKeys: readonly string[];
} {
  const checkErrors = evidence.orderedCheckResults
    .filter(({ status }) => status === 'error')
    .map(({ checkId }) => `check:${checkId}:error`);
  const checkFailures = evidence.orderedCheckResults
    .filter(({ status }) => status === 'failed')
    .map(({ checkId }) => `check:${checkId}:failed`);
  const infrastructureError = checkErrors.length > 0
    || evidence.builtinRiskScanStatus === 'error'
    || evidence.criteriaStatus === 'error'
    || evidence.freshReviewerStatus === 'INCONCLUSIVE';
  const blockerKeys = [
    ...checkErrors,
    ...checkFailures,
    ...(evidence.builtinRiskScanStatus === 'blocking'
      ? ['builtin-risk-scan:blocking']
      : evidence.builtinRiskScanStatus === 'error'
        ? ['builtin-risk-scan:error']
        : []),
    ...(evidence.criteriaStatus === 'unsatisfied'
      ? ['acceptance-criteria:unsatisfied']
      : evidence.criteriaStatus === 'error'
        ? ['acceptance-criteria:error']
        : []),
    ...(evidence.freshReviewerStatus === 'NEEDS_WORK'
      ? ['fresh-reviewer:needs-work']
      : evidence.freshReviewerStatus === 'INCONCLUSIVE'
        ? ['fresh-reviewer:inconclusive']
        : []),
  ].toSorted();
  if (infrastructureError) {
    return {
      outcome: 'ERROR',
      reasonCode: 'target_final_gate_error',
      blockerKeys,
    };
  }
  if (blockerKeys.length > 0) {
    return {
      outcome: 'NEEDS_WORK',
      reasonCode: 'target_final_gate_needs_work',
      blockerKeys,
    };
  }
  return {
    outcome: 'PASS',
    reasonCode: 'target_final_gate_passed',
    blockerKeys: [],
  };
}

function timestampAfter(now: Date, after: string): string {
  const minimum = Date.parse(after) + 1;
  const time = Math.max(now.getTime(), minimum);
  if (!Number.isFinite(time)) {
    throw new TypeError(
      'Target Final Gate completion timestamp is invalid.',
    );
  }
  return new Date(time).toISOString();
}
