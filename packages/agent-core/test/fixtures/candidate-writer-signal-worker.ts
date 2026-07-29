import {
  chmod,
  mkdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalDigest } from '@wukong/verification';

import {
  __testing as durableFaultTesting,
  type DurableBoundaryTestFaultPointV1,
} from '../../src/durable-boundary-test-fault';
import {
  CandidateWorkspaceFileBackend,
} from '../../src/tools/support/candidate-workspace-file-backend';
import {
  protectWindowsPrivateRootSecurity,
} from '../../src/windows-private-root-security';

type CandidateWriterSignalBoundary =
  | 'temporary_synced'
  | 'final_leaf_check'
  | 'atomic_replace';

const inputRoot = process.argv[2];
const boundary = process.argv[3] as
  CandidateWriterSignalBoundary | undefined;
if (inputRoot === undefined || !isBoundary(boundary)) {
  throw new Error(
    'A candidate Writer signal root and boundary are required.',
  );
}
const root = resolve(inputRoot);
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
if (process.platform === 'win32') {
  protectWindowsPrivateRootSecurity(root);
}
const target = join(root, 'target.txt');
await writeFile(target, 'before\n', { mode: 0o600 });
const expectedPoint = pointFor(boundary);
const faultCapability =
  durableFaultTesting.createDurableBoundaryTestFaultCapability(
    async (point) => {
      if (point !== expectedPoint) return;
      process.stdout.write(`ready:${boundary}\n`);
      setInterval(() => {}, 60_000);
      await new Promise<never>(() => {});
    },
  );
const backend = new CandidateWorkspaceFileBackend({
  rootDirectory: root,
  expectedRootIdentity: await candidateRootIdentity(root),
  testFault: faultCapability,
});
await backend.run(target, 'write', (io) =>
  io.writeText(target, 'after\n'));
throw new Error('Candidate Writer signal fault did not pause.');

async function candidateRootIdentity(path: string): Promise<string> {
  const [canonicalRoot, info] = await Promise.all([
    realpath(path),
    stat(path, { bigint: true }),
  ]);
  return canonicalDigest('wukong/candidate-path-identity/v1', {
    pathDigest: canonicalDigest(
      'wukong/private-path/v1',
      canonicalRoot,
    ),
    device: info.dev.toString(),
    inode: info.ino.toString(),
  });
}

function isBoundary(
  value: string | undefined,
): value is CandidateWriterSignalBoundary {
  return value === 'temporary_synced'
    || value === 'final_leaf_check'
    || value === 'atomic_replace';
}

function pointFor(
  value: CandidateWriterSignalBoundary,
): DurableBoundaryTestFaultPointV1 {
  switch (value) {
    case 'temporary_synced':
      return 'candidate_writer_after_temporary_synced';
    case 'final_leaf_check':
      return 'candidate_writer_after_final_leaf_check';
    case 'atomic_replace':
      return 'candidate_writer_after_atomic_replace';
  }
}
