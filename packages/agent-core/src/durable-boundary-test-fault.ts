export type DurableBoundaryTestFaultPointV1 =
  | 'snapshot_candidate_after_record_synced'
  | 'candidate_writer_after_temporary_synced'
  | 'candidate_writer_after_final_leaf_check'
  | 'candidate_writer_after_atomic_replace'
  | 'promotion_apply_before_target_mutation'
  | 'promotion_apply_after_final_leaf_check'
  | 'promotion_apply_after_atomic_leaf_mutation'
  | 'promotion_apply_after_target_mutation'
  | 'promotion_apply_after_outcome_recorded'
  | 'target_final_gate_after_evidence_recorded'
  | 'target_completion_after_artifacts_synced';

const FACTORY_AUTHORITY =
  Symbol('durable-boundary-test-fault-factory');
const callbacks = new WeakMap<
  DurableBoundaryTestFaultCapabilityV1,
  (point: DurableBoundaryTestFaultPointV1) => Promise<void> | void
>();

/**
 * Unforgeable test-only pause capability for process crash injection.
 *
 * This type is deliberately not exported from the package index. Production
 * callers must never import this module or supply this capability.
 */
export class DurableBoundaryTestFaultCapabilityV1 {
  private constructor(
    callback: (
      point: DurableBoundaryTestFaultPointV1,
    ) => Promise<void> | void,
    authority: symbol,
  ) {
    if (authority !== FACTORY_AUTHORITY
      || typeof callback !== 'function') {
      throw new TypeError(
        'Durable boundary test fault capability is invalid.',
      );
    }
    callbacks.set(this, callback);
    Object.freeze(this);
  }

  static create(
    callback: (
      point: DurableBoundaryTestFaultPointV1,
    ) => Promise<void> | void,
    authority: symbol,
  ): DurableBoundaryTestFaultCapabilityV1 {
    return new DurableBoundaryTestFaultCapabilityV1(
      callback,
      authority,
    );
  }

  toJSON(): Record<string, string> {
    return { authority: '[TEST-ONLY]' };
  }
}

export function validateDurableBoundaryTestFaultCapability(
  value: unknown,
): value is DurableBoundaryTestFaultCapabilityV1 {
  return value instanceof DurableBoundaryTestFaultCapabilityV1
    && callbacks.has(value);
}

export async function injectDurableBoundaryTestFault(
  capability: DurableBoundaryTestFaultCapabilityV1 | undefined,
  point: DurableBoundaryTestFaultPointV1,
): Promise<void> {
  if (capability === undefined) return;
  const callback = callbacks.get(capability);
  if (callback === undefined) {
    throw new TypeError(
      'Durable boundary test fault capability is invalid.',
    );
  }
  await callback(point);
}

export const __testing = Object.freeze({
  createDurableBoundaryTestFaultCapability: (
    callback: (
      point: DurableBoundaryTestFaultPointV1,
    ) => Promise<void> | void,
  ): DurableBoundaryTestFaultCapabilityV1 =>
    DurableBoundaryTestFaultCapabilityV1.create(
      callback,
      FACTORY_AUTHORITY,
    ),
});
