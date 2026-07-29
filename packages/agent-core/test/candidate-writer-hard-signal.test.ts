import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';
import { fileURLToPath } from 'node:url';

import { canonicalDigest } from '@wukong/verification';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  CandidateWorkspaceFileBackend,
} from '../src/tools/support/candidate-workspace-file-backend';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const signals = ['SIGINT', 'SIGTERM'] as const;
const boundaries = [
  'temporary_synced',
  'final_leaf_check',
  'atomic_replace',
] as const;

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

const describePosix = process.platform === 'win32'
  ? describe.skip
  : describe;
const describeWindows = process.platform === 'win32'
  ? describe
  : describe.skip;

describePosix('Candidate Writer atomic file hard-signal behavior', () => {
  it.each(boundaries.flatMap((boundary) =>
    signals.map((signal) => [boundary, signal] as const)))(
    'preserves one complete leaf at %s after %s',
    async (boundary, signal) => {
      const parent = await mkdtemp(join(
        tmpdir(),
        'wukong-candidate-writer-signal-',
      ));
      roots.push(parent);
      const root = join(parent, 'candidate');
      const workerPath = new URL(
        './fixtures/candidate-writer-signal-worker.ts',
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
      const line = await waitForReady(child, lines);
      expect(line).toBe(`ready:${boundary}`);
      expect(child.kill(signal)).toBe(true);
      const [exitCode, exitSignal] = await once(child, 'exit');
      children.delete(child);
      expect(exitCode).toBeNull();
      expect(exitSignal).toBe(signal);

      const target = join(root, 'target.txt');
      expect(await readFile(target, 'utf8')).toBe(
        boundary === 'atomic_replace' ? 'after\n' : 'before\n',
      );
      const temporaryNames = (await readdir(root))
        .filter((name) =>
          /^\.wukong-candidate-[a-f0-9]{32}\.tmp$/u.test(name));
      expect(temporaryNames).toHaveLength(
        boundary === 'atomic_replace' ? 0 : 1,
      );

      const backend = new CandidateWorkspaceFileBackend({
        rootDirectory: root,
        expectedRootIdentity: await candidateRootIdentity(root),
      });
      const visible = await backend.run(
        root,
        'search',
        async (io) => (await io.listFiles(root, {
          includeIgnored: true,
        })).map((entry) => entry.relativePath),
      );
      expect(visible).toEqual(['target.txt']);
    },
    30_000,
  );
});

describeWindows(
  'Windows Candidate Writer forced-termination recovery',
  () => {
    it.each(boundaries)(
      'preserves one complete leaf at %s after TerminateProcess',
      async (boundary) => {
        const parent = await mkdtemp(join(
          tmpdir(),
          'wukong-windows-candidate-writer-signal-',
        ));
        roots.push(parent);
        const root = join(parent, 'candidate');
        const workerPath = fileURLToPath(new URL(
          './fixtures/candidate-writer-signal-worker.ts',
          import.meta.url,
        ));
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', workerPath, root, boundary],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
        children.add(child);
        child.once('exit', () => children.delete(child));
        if (child.stdout === null) {
          throw new Error(
            'Windows Candidate Writer worker stdout is unavailable.',
          );
        }
        const lines = createInterface({ input: child.stdout });
        expect(await waitForReady(child, lines))
          .toBe(`ready:${boundary}`);
        const exit = once(child, 'exit');
        expect(child.kill('SIGKILL')).toBe(true);
        await exit;

        const target = join(root, 'target.txt');
        expect(await readFile(target, 'utf8')).toBe(
          boundary === 'atomic_replace' ? 'after\n' : 'before\n',
        );
        const temporaryNames = (await readdir(root))
          .filter((name) =>
            /^\.wukong-candidate-[a-f0-9]{32}\.tmp$/u.test(name));
        expect(temporaryNames).toHaveLength(
          boundary === 'atomic_replace' ? 0 : 1,
        );

        const backend = new CandidateWorkspaceFileBackend({
          rootDirectory: root,
          expectedRootIdentity: await candidateRootIdentity(root),
        });
        const visible = await backend.run(
          root,
          'search',
          async (io) => (await io.listFiles(root, {
            includeIgnored: true,
          })).map((entry) => entry.relativePath),
        );
        expect(visible).toEqual(['target.txt']);
      },
      60_000,
    );
  },
);

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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => undefined);
}

async function waitForReady(
  child: ChildProcess,
  lines: ReadlineInterface,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Candidate Writer signal worker did not become ready. stderr=${stderr}`,
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
        `Candidate Writer signal worker exited before ready `
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
