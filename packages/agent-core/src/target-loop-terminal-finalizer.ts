import type {
  TargetFinalGateOutcomeV1,
} from '@wukong/verification';

import {
  requireValidatedTargetCompletionSeal,
  TargetCompletionSealStore,
  type TargetCompletionSealAuthorizationV1,
} from './target-completion-seal-store';
import {
  type TargetPromotionLeaseAuthorityV1,
  TargetPromotionLeaseBindingV1,
  TargetPromotionLeaseStore,
} from './target-promotion-lease-store';

export interface IsolatedLoopTerminalRecordV1 {
  readonly runId: string;
  readonly contractId: string;
  readonly status: TargetFinalGateOutcomeV1;
  readonly targetCompletionSealDigest?: string;
}

export interface IsolatedLoopTerminalRecorder {
  recordIsolatedLoopTerminal(input: {
    readonly status: TargetFinalGateOutcomeV1;
    readonly reasonCode: string;
    readonly blockerKeys?: readonly string[];
    readonly completionAuthorization:
      TargetCompletionSealAuthorizationV1;
  }): IsolatedLoopTerminalRecordV1 | null;
}

export interface TargetLoopTerminalFinalizationResultV1 {
  readonly terminal: IsolatedLoopTerminalRecordV1;
  readonly releasedAuthority: TargetPromotionLeaseAuthorityV1;
}

export class TargetLoopTerminalFinalizer {
  async commit(input: {
    readonly targetPromotionLeaseStore: TargetPromotionLeaseStore;
    readonly targetPromotionBinding: TargetPromotionLeaseBindingV1;
    readonly completionSealStore: TargetCompletionSealStore;
    readonly completionSealId: string;
    readonly expectedCompletionSealDigest: string;
    readonly terminalRecorder: IsolatedLoopTerminalRecorder;
  }): Promise<TargetLoopTerminalFinalizationResultV1> {
    if (!(input.targetPromotionLeaseStore
        instanceof TargetPromotionLeaseStore)
      || !(input.targetPromotionBinding
        instanceof TargetPromotionLeaseBindingV1)
      || !(input.completionSealStore instanceof TargetCompletionSealStore)
      || typeof input.terminalRecorder?.recordIsolatedLoopTerminal
        !== 'function') {
      throw new TypeError(
        'Target Loop terminal finalization input is invalid.',
      );
    }
    const terminal =
      await input.targetPromotionLeaseStore.withExclusiveLease(
        input.targetPromotionBinding,
        'final_verifying',
        async (view) =>
          input.completionSealStore.withValidatedTerminalSeal(
            view,
            {
              completionSealId: input.completionSealId,
              expectedSealDigest:
                input.expectedCompletionSealDigest,
            },
            (authorization) => {
              const seal = requireValidatedTargetCompletionSeal(
                authorization,
              );
              const record =
                input.terminalRecorder.recordIsolatedLoopTerminal({
                  status: seal.finalGateOutcome,
                  reasonCode: reasonCodeFor(seal.finalGateOutcome),
                  completionAuthorization: authorization,
                });
              if (record === null
                || record.runId !== seal.runId
                || record.contractId !== seal.contractId
                || record.status !== seal.finalGateOutcome
                || record.targetCompletionSealDigest
                  !== seal.completionSealDigest) {
                throw new Error(
                  'Target Loop terminal recorder rejected the completion join.',
                );
              }
              return record;
            },
          ),
      );
    const releasedAuthority =
      await input.targetPromotionLeaseStore.transition(
        input.targetPromotionBinding,
        'released',
      );
    return { terminal, releasedAuthority };
  }
}

function reasonCodeFor(
  outcome: TargetFinalGateOutcomeV1,
): string {
  if (outcome === 'PASS') return 'target_final_gate_passed';
  if (outcome === 'NEEDS_WORK') {
    return 'target_final_gate_needs_work';
  }
  return 'target_final_gate_error';
}
