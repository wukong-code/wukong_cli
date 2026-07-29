import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  sealerSignalRepositoryDigest,
} from './fixtures/source-snapshot-sealer-signal-fixture';

const roots: string[] = [];
const children = new Set<ChildProcess>();
type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
const signals: readonly TerminationSignal[] =
  process.platform === 'win32'
    ? ['SIGKILL']
    : ['SIGINT', 'SIGTERM'];
const boundaries = [
  'initial_validation',
  'entries_read',
  'container_built',
  'final_validation',
] as const;

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('Source Snapshot sealer hard-signal behavior', () => {
  it.each(boundaries.flatMap((boundary) =>
    signals.map((signal) => [boundary, signal] as const)))(
    'leaves the approved source unchanged at %s after %s',
    async (boundary, signal) => {
      const parent = await mkdtemp(join(
        tmpdir(),
        'wukong-source-sealer-signal-',
      ));
      roots.push(parent);
      const root = join(parent, 'source');
      const workerPath = new URL(
        './fixtures/source-snapshot-sealer-signal-worker.ts',
        import.meta.url,
      );
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(workerPath),
          root,
          boundary,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      children.add(child);
      const lines = createInterface({ input: child.stdout });
      const ready = JSON.parse(
        await waitForReady(child, lines),
      ) as {
        readonly boundary: string;
        readonly digest: string;
      };
      expect(ready.boundary).toBe(boundary);
      expect(child.kill(signal)).toBe(true);
      const [exitCode, exitSignal] = await once(child, 'exit');
      children.delete(child);
      if (process.platform !== 'win32') {
        expect(exitCode).toBeNull();
        expect(exitSignal).toBe(signal);
      }
      expect(await sealerSignalRepositoryDigest(root))
        .toBe(ready.digest);
      expect((await readdir(parent)).toSorted()).toEqual(['source']);
    },
    30_000,
  );
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => undefined);
}

function waitForReady(
  child: ChildProcess,
  lines: ReadlineInterface,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Source Snapshot sealer worker did not become ready. stderr=${stderr}`,
      ));
    }, 10_000);
    const onLine = (line: string): void => {
      cleanup();
      resolve(line);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      reject(new Error(
        `Source Snapshot sealer worker exited before ready `
        + `(code=${String(code)}, signal=${String(signal)}). `
        + `stderr=${stderr}`,
      ));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderr += chunk.toString();
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      lines.off('line', onLine);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stderr?.off('data', onStderr);
    };
    lines.once('line', onLine);
    child.once('exit', onExit);
    child.once('error', onError);
    child.stderr?.on('data', onStderr);
  });
}
