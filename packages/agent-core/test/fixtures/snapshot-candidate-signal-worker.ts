import { execFile } from 'node:child_process';
import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  canonicalDigest,
  inspectSourceSnapshot,
  sealSourceSnapshot,
} from '@wukong/verification';

import {
  __testing as durableFaultTesting,
} from '../../src/durable-boundary-test-fault';
import {
  SnapshotBlobLeaseStore,
} from '../../src/snapshot-blob-lease-store';
import {
  SnapshotCandidateMaterializer,
} from '../../src/snapshot-candidate-materializer';
import {
  WorktreeLeaseStore,
} from '../../src/worktree-lease-store';

const execFileAsync = promisify(execFile);
const inputRoot = process.argv[2];
if (inputRoot === undefined) {
  throw new Error('A snapshot candidate signal root is required.');
}
const root = resolve(inputRoot);
const repository = join(root, 'repository');
const candidatesRoot = join(root, 'candidates');
const blobRoot = join(root, 'snapshot-blobs');
const baseTime = Date.parse('2026-07-30T01:00:00.000Z');
let clockTick = 0;
const now = () => new Date(baseTime + clockTick++ * 1_000);

await mkdir(repository, { recursive: true });
await git(repository, ['init']);
await writeRepoFile(
  repository,
  'src/index.ts',
  'export const value = 1;\n',
);
await writeRepoFile(
  repository,
  'src/deleted.ts',
  'export const deleted = true;\n',
);
await git(repository, ['add', '.']);
await git(repository, [
  '-c', 'user.name=Wukong Signal Test',
  '-c', 'user.email=signal@example.test',
  'commit', '-m', 'base',
]);
await writeRepoFile(
  repository,
  'src/index.ts',
  'export const value = 2;\n',
);
await git(repository, ['add', 'src/index.ts']);
await writeRepoFile(
  repository,
  'src/index.ts',
  'export const value = 3;\n',
);
await git(repository, ['rm', 'src/deleted.ts']);
await writeRepoFile(
  repository,
  'src/new.ts',
  'export const added = true;\n',
);

const sourceSnapshotCwd = join(repository, 'src');
const inspected = await inspectSourceSnapshot({
  cwd: sourceSnapshotCwd,
  selectedUntrackedPaths: ['src/new.ts'],
});
if (inspected.status !== 'ready'
  || inspected.proposedSnapshot === null) {
  throw new Error('Unable to inspect the signal source snapshot.');
}
const sourceSnapshot = inspected.proposedSnapshot;
const sealed = await sealSourceSnapshot({
  cwd: sourceSnapshotCwd,
  snapshot: sourceSnapshot,
});
const blobStore = new SnapshotBlobLeaseStore({
  rootDirectory: blobRoot,
  now,
});
const staged = await blobStore.stageAndSeal({
  containerBytes: sealed.containerBytes,
  sourceSnapshot,
  createdByRunId: 'signal_creator',
  ownerRunId: 'signal_owner',
  expiresAt: '2030-07-30T01:00:00.000Z',
});
const confirmed = await blobStore.confirm(staged.binding);
const worktreeStore = new WorktreeLeaseStore({
  candidatesRootDirectory: candidatesRoot,
  now,
});
const reserved = await worktreeStore.reserve({
  sourceRepositoryRoot: repository,
  sourceSnapshot,
  snapshotBlobLease: confirmed.lease,
  goalId: 'goal_signal',
  contractId: 'contract_signal',
  runId: 'run_signal',
  ownerRunId: 'signal_owner',
  bootstrapPlanDigest: digest('bootstrap'),
  gatePlanDigest: digest('gate'),
  criteriaSelectionDigest: null,
  expiresAt: '2030-07-30T01:00:00.000Z',
});
const faultCapability =
  durableFaultTesting.createDurableBoundaryTestFaultCapability(
    async (point) => {
      if (point !== 'snapshot_candidate_after_record_synced') {
        throw new Error(`Unexpected materializer fault point ${point}.`);
      }
      process.stdout.write(`${JSON.stringify({
        candidateId: reserved.lease.candidateId,
        blobLeaseId: confirmed.lease.blobLeaseId,
        sourceSnapshot,
      })}\n`);
      setInterval(() => {}, 60_000);
      await new Promise<never>(() => {});
    },
  );
await new SnapshotCandidateMaterializer({
  now,
  testFault: faultCapability,
}).materialize({
  sourceRepositoryRoot: repository,
  sourceSnapshot,
  leaseStore: blobStore,
  confirmedBinding: confirmed.binding,
  worktreeLeaseStore: worktreeStore,
  worktreeLeaseBinding: reserved.binding,
});
throw new Error('Snapshot candidate signal fault did not pause.');

async function writeRepoFile(
  repositoryRoot: string,
  path: string,
  content: string,
): Promise<void> {
  const absolutePath = join(repositoryRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}

function digest(label: string): string {
  return canonicalDigest(
    'wukong/test/snapshot-candidate-hard-signal/v1',
    label,
  );
}
