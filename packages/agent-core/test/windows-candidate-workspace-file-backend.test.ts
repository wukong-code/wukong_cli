import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalDigest } from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CandidateWorkspaceFileBackend,
} from '../src/tools/support/candidate-workspace-file-backend';
import {
  inspectCandidateWorkspaceBackendCapability,
} from '../src/candidate-workspace-backend-capability';
import {
  attestWindowsPrivateRootPathSecurity,
  protectWindowsPrivateRootSecurity,
} from '../src/windows-private-root-security';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')(
  'Windows Candidate handle-relative backend',
  () => {
    it('resolves the packaged native and protected-root capabilities', () => {
      const root = privateRoot();

      expect(inspectCandidateWorkspaceBackendCapability())
        .toMatchObject({
          available: true,
          platform: 'win32',
          backend: 'windows-nt-handle-v1',
          reasonCode: null,
        });
      expect(() => {
        attestWindowsPrivateRootPathSecurity(root);
      }).not.toThrow();
    });

    it('reads, atomically replaces, creates, and enumerates under handles', async () => {
      const root = privateRoot();
      const file = join(root, 'file.txt');
      const nested = join(root, 'nested');
      const nestedFile = join(nested, 'new.txt');
      const unicodeFile = join(nested, '边界-\u0100.txt');
      writeFileSync(file, 'old', 'utf8');
      const backend = candidateBackend(root);

      await backend.run(file, 'write', async (io) => {
        await io.writeText(file, 'new');
      });
      await backend.run(nestedFile, 'write', async (io) => {
        await io.writeText(nestedFile, 'nested');
      });
      await backend.run(unicodeFile, 'write', async (io) => {
        await io.writeText(unicodeFile, 'unicode');
      });
      const entries = await backend.run(
        root,
        'search',
        async (io) => io.listFiles(root),
      );

      expect(readFileSync(file, 'utf8')).toBe('new');
      expect(readFileSync(nestedFile, 'utf8')).toBe('nested');
      expect(readFileSync(unicodeFile, 'utf8')).toBe('unicode');
      expect(entries.map((entry) => entry.relativePath).toSorted())
        .toEqual([
          'file.txt',
          join('nested', 'new.txt'),
          join('nested', '边界-\u0100.txt'),
        ].toSorted());
    });

    it('rejects a directory junction before traversing it', async () => {
      const root = privateRoot();
      const outside = privateRoot();
      const junction = join(root, 'junction');
      writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');
      symlinkSync(outside, junction, 'junction');
      const backend = candidateBackend(root);

      await expect(backend.run(
        junction,
        'read',
        async (io) => io.stat(junction),
      )).rejects.toMatchObject({
        code: 'candidate_atomic_path_unsafe',
      });
    });
  },
);

function privateRoot(): string {
  const created = mkdtempSync(
    join(tmpdir(), 'wukong-windows-candidate-'),
  );
  const root = realpathSync(created);
  roots.push(root);
  protectWindowsPrivateRootSecurity(root);
  return root;
}

function candidateBackend(
  root: string,
): CandidateWorkspaceFileBackend {
  const info = statSync(root, { bigint: true });
  const expectedRootIdentity = canonicalDigest(
    'wukong/candidate-path-identity/v1',
    {
      pathDigest: canonicalDigest(
        'wukong/private-path/v1',
        root,
      ),
      device: info.dev.toString(),
      inode: info.ino.toString(),
    },
  );
  return new CandidateWorkspaceFileBackend({
    rootDirectory: root,
    expectedRootIdentity,
  });
}
