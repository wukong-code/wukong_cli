import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  validateSourceSnapshot,
  type SourceSnapshotV1,
} from '@wukong/verification';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  captureProcessLivenessProof,
} from '../src/process-liveness-proof';
import {
  SnapshotBlobLeaseStore,
} from '../src/snapshot-blob-lease-store';
import {
  SnapshotCandidateMaterializer,
} from '../src/snapshot-candidate-materializer';
import {
  WorktreeLeaseStore,
} from '../src/worktree-lease-store';

const roots: string[] = [];
const children = new Set<ChildProcess>();
type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
const signals: readonly TerminationSignal[] =
  process.platform === 'win32'
    ? ['SIGKILL']
    : ['SIGINT', 'SIGTERM'];
const BASE_TIME = Date.parse('2026-07-30T01:00:00.000Z');

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('snapshot candidate materializer hard-signal recovery', () => {
  it.each(signals)(
    're-verifies the candidate and destroys the stranded Blob after %s',
    async (signal) => {
      const root = await mkdtemp(join(
        tmpdir(),
        'wukong-snapshot-candidate-signal-',
      ));
      roots.push(root);
      const workerPath = new URL(
        './fixtures/snapshot-candidate-signal-worker.ts',
        import.meta.url,
      );
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(workerPath), root],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      children.add(child);
      const lines = createInterface({ input: child.stdout });
      const [line] = await once(lines, 'line') as [string];
      const metadata = parseMetadata(line);
      expect(child.kill(signal)).toBe(true);
      const [exitCode, exitSignal] = await once(child, 'exit');
      children.delete(child);
      if (process.platform !== 'win32') {
        expect(exitCode).toBeNull();
        expect(exitSignal).toBe(signal);
      }

      const worktreeStore = new WorktreeLeaseStore({
        candidatesRootDirectory: join(root, 'candidates'),
        now: () => new Date(BASE_TIME + 60_000),
      });
      const crashed = await worktreeStore.inspect(
        metadata.candidateId,
      );
      expect(crashed.state).toBe('materializing');
      const adopted = await worktreeStore.adoptDeadOwner({
        candidateId: crashed.candidateId,
        runId: crashed.runId,
        ownerRunId: crashed.ownerRunId,
        expectedLeaseDigest: crashed.leaseDigest,
        nextProcessLivenessProof:
          await captureProcessLivenessProof(),
      });
      const blobStore = new SnapshotBlobLeaseStore({
        rootDirectory: join(root, 'snapshot-blobs'),
        now: () => new Date(BASE_TIME + 61_000),
      });
      expect((await blobStore.inspect(metadata.blobLeaseId)).state)
        .toBe('materializing');

      const recovered = await new SnapshotCandidateMaterializer({
        now: () => new Date(BASE_TIME + 62_000),
      }).recoverMaterialized({
        snapshotBlobLeaseStore: blobStore,
        worktreeLeaseStore: worktreeStore,
        worktreeLeaseBinding: adopted.binding,
        sourceSnapshot: metadata.sourceSnapshot,
      });

      expect(recovered.lease.state).toBe('bootstrapping');
      expect((await blobStore.inspect(metadata.blobLeaseId)).state)
        .toBe('destroyed');
      await expect(access(join(
        root,
        'snapshot-blobs',
        metadata.blobLeaseId,
        'payload.bin',
      ))).rejects.toMatchObject({ code: 'ENOENT' });
      const candidate = join(
        root,
        'candidates',
        metadata.candidateId,
        'worktree',
      );
      expect(await readFile(join(candidate, 'src/index.ts'), 'utf8'))
        .toBe('export const value = 3;\n');
      expect(await readFile(join(candidate, 'src/new.ts'), 'utf8'))
        .toBe('export const added = true;\n');
    },
    60_000,
  );
});

function parseMetadata(value: string): {
  readonly candidateId: string;
  readonly blobLeaseId: string;
  readonly sourceSnapshot: SourceSnapshotV1;
} {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object'
    || parsed === null) {
    throw new Error('The snapshot candidate signal metadata is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  const sourceSnapshot = record['sourceSnapshot'] as SourceSnapshotV1;
  if (typeof record['candidateId'] !== 'string'
    || typeof record['blobLeaseId'] !== 'string'
    || !validateSourceSnapshot(sourceSnapshot)) {
    throw new Error('The snapshot candidate signal metadata is invalid.');
  }
  return {
    candidateId: record['candidateId'],
    blobLeaseId: record['blobLeaseId'],
    sourceSnapshot,
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => undefined);
}
