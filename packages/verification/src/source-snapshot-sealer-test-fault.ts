export type SourceSnapshotSealerTestFaultPointV1 =
  | 'source_snapshot_sealer_after_initial_validation'
  | 'source_snapshot_sealer_after_entries_read'
  | 'source_snapshot_sealer_after_container_built'
  | 'source_snapshot_sealer_after_final_validation';

const FACTORY_AUTHORITY =
  Symbol('source-snapshot-sealer-test-fault-factory');
const callbacks = new WeakMap<
  SourceSnapshotSealerTestFaultCapabilityV1,
  (point: SourceSnapshotSealerTestFaultPointV1) => Promise<void> | void
>();

/**
 * Unforgeable process-crash test capability.
 *
 * This module is deliberately absent from the package index. Production
 * callers cannot construct the capability accepted by the sealer.
 */
export class SourceSnapshotSealerTestFaultCapabilityV1 {
  private constructor(
    callback: (
      point: SourceSnapshotSealerTestFaultPointV1,
    ) => Promise<void> | void,
    authority: symbol,
  ) {
    if (authority !== FACTORY_AUTHORITY
      || typeof callback !== 'function') {
      throw new TypeError(
        'Source Snapshot sealer test fault capability is invalid.',
      );
    }
    callbacks.set(this, callback);
    Object.freeze(this);
  }

  static create(
    callback: (
      point: SourceSnapshotSealerTestFaultPointV1,
    ) => Promise<void> | void,
    authority: symbol,
  ): SourceSnapshotSealerTestFaultCapabilityV1 {
    return new SourceSnapshotSealerTestFaultCapabilityV1(
      callback,
      authority,
    );
  }

  toJSON(): Record<string, string> {
    return { authority: '[TEST-ONLY]' };
  }
}

export function validateSourceSnapshotSealerTestFaultCapability(
  value: unknown,
): value is SourceSnapshotSealerTestFaultCapabilityV1 {
  return value instanceof SourceSnapshotSealerTestFaultCapabilityV1
    && callbacks.has(value);
}

export async function injectSourceSnapshotSealerTestFault(
  capability: SourceSnapshotSealerTestFaultCapabilityV1 | undefined,
  point: SourceSnapshotSealerTestFaultPointV1,
): Promise<void> {
  if (capability === undefined) return;
  const callback = callbacks.get(capability);
  if (callback === undefined) {
    throw new TypeError(
      'Source Snapshot sealer test fault capability is invalid.',
    );
  }
  await callback(point);
}

export const __testing = Object.freeze({
  createSourceSnapshotSealerTestFaultCapability: (
    callback: (
      point: SourceSnapshotSealerTestFaultPointV1,
    ) => Promise<void> | void,
  ): SourceSnapshotSealerTestFaultCapabilityV1 =>
    SourceSnapshotSealerTestFaultCapabilityV1.create(
      callback,
      FACTORY_AUTHORITY,
    ),
});
