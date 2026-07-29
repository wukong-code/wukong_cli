import { resolve } from 'node:path';

import {
  sealSourceSnapshot,
} from '../../src/source-snapshot-sealer';
import {
  __testing as sealerFaultTesting,
  type SourceSnapshotSealerTestFaultPointV1,
} from '../../src/source-snapshot-sealer-test-fault';
import { inspectSourceSnapshot } from '../../src/source-snapshot';
import {
  createSealerSignalRepository,
  sealerSignalRepositoryDigest,
} from './source-snapshot-sealer-signal-fixture';

const boundaries = [
  'initial_validation',
  'entries_read',
  'container_built',
  'final_validation',
] as const;
type SealerSignalBoundary = typeof boundaries[number];

const inputRoot = process.argv[2];
const boundary = process.argv[3];
if (inputRoot === undefined || !isBoundary(boundary)) {
  throw new Error(
    'A Source Snapshot sealer signal root and boundary are required.',
  );
}
const root = resolve(inputRoot);
await createSealerSignalRepository(root);
const inspected = await inspectSourceSnapshot({
  cwd: root,
  selectedUntrackedPaths: ['selected.ts'],
});
if (inspected.status !== 'ready'
  || inspected.proposedSnapshot === null) {
  throw new Error('Unable to inspect the sealer signal snapshot.');
}
const expectedPoint = pointFor(boundary);
const faultCapability =
  sealerFaultTesting.createSourceSnapshotSealerTestFaultCapability(
    async (point) => {
      if (point !== expectedPoint) return;
      const digest = await sealerSignalRepositoryDigest(root);
      process.stdout.write(JSON.stringify({
        boundary,
        digest,
      }) + '\n');
      setInterval(() => {}, 60_000);
      await new Promise<never>(() => {});
    },
  );
await sealSourceSnapshot({
  cwd: root,
  snapshot: inspected.proposedSnapshot,
  testFault: faultCapability,
});
throw new Error('Source Snapshot sealer signal fault did not pause.');

function isBoundary(
  value: string | undefined,
): value is SealerSignalBoundary {
  return boundaries.some((boundary) => boundary === value);
}

function pointFor(
  value: SealerSignalBoundary,
): SourceSnapshotSealerTestFaultPointV1 {
  switch (value) {
    case 'initial_validation':
      return 'source_snapshot_sealer_after_initial_validation';
    case 'entries_read':
      return 'source_snapshot_sealer_after_entries_read';
    case 'container_built':
      return 'source_snapshot_sealer_after_container_built';
    case 'final_validation':
      return 'source_snapshot_sealer_after_final_validation';
  }
}
