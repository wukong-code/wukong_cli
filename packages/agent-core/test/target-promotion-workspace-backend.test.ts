import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  type CandidateProjectionEntryV1,
} from '@wukong/verification';

import {
  prepareAgentIsolatedLoopPromotion,
  promoteAgentIsolatedLoopCandidate,
} from '../src/isolated-loop-runtime';
import {
  inspectTargetPromotionWorkspaceBackendCapability,
  TargetPromotionWorkspaceBackend,
} from '../src/target-promotion-workspace-backend';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('Target promotion workspace backend', () => {
  it('blocks Windows when protected private-root ACL primitives are unavailable', () => {
    const resolveNative = vi.fn();
    const resolveWindowsHandleNative = vi.fn();

    expect(inspectTargetPromotionWorkspaceBackendCapability({
      platform: 'win32',
      resolveNative,
      resolveWindowsPrivateRootSecurity: () => {
        throw new Error('advapi32 unavailable');
      },
      resolveWindowsHandleNative,
    })).toEqual({
      available: false,
      platform: 'win32',
      backend: null,
      reasonCode:
        'target_promotion_atomic_backend_windows_private_root_unavailable',
    });
    expect(resolveNative).not.toHaveBeenCalled();
    expect(resolveWindowsHandleNative).not.toHaveBeenCalled();
  });

  it('blocks Windows when handle-relative transaction primitives are unavailable', () => {
    expect(inspectTargetPromotionWorkspaceBackendCapability({
      platform: 'win32',
      resolveWindowsPrivateRootSecurity: () => {},
      resolveWindowsHandleNative: () => {
        throw new Error('ntdll unavailable');
      },
    })).toEqual({
      available: false,
      platform: 'win32',
      backend: null,
      reasonCode:
        'target_promotion_atomic_backend_windows_handle_unavailable',
    });
  });

  it('freezes the Windows Target transaction capability contract after both preflights', () => {
    expect(inspectTargetPromotionWorkspaceBackendCapability({
      platform: 'win32',
      resolveWindowsPrivateRootSecurity: () => {},
      resolveWindowsHandleNative: () => {},
    })).toEqual({
      available: true,
      platform: 'win32',
      backend: 'windows-nt-handle-transaction-v1',
      reasonCode: null,
    });
  });

  it('reports a stable unavailable capability when POSIX primitives cannot load', () => {
    expect(inspectTargetPromotionWorkspaceBackendCapability({
      platform: 'linux',
      resolveNative: () => {
        throw new Error('native runtime unavailable');
      },
    })).toEqual({
      available: false,
      platform: 'linux',
      backend: null,
      reasonCode:
        'target_promotion_atomic_backend_native_unavailable',
    });
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'resolves the packaged POSIX Target Apply primitive set',
    () => {
      expect(inspectTargetPromotionWorkspaceBackendCapability())
        .toMatchObject({
          available: true,
          platform: process.platform,
          backend: 'posix-openat-atomic-rename-v2',
          reasonCode: null,
        });
    },
  );

  it('blocks both Windows promotion entries before Agent access or durable writes', async () => {
    const root = await mkdtemp(join(
      tmpdir(),
      'wukong-target-promotion-windows-',
    ));
    roots.push(root);
    const accesses: PropertyKey[] = [];
    const agent = new Proxy(
      {
        homedir: join(root, 'session'),
        wukongHomeDir: join(root, 'wukong-home'),
      },
      {
        get(target, property, receiver) {
          accesses.push(property);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const platformDescriptor =
      Object.getOwnPropertyDescriptor(process, 'platform');
    if (platformDescriptor === undefined) {
      throw new Error('process.platform descriptor is unavailable.');
    }
    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: 'win32',
    });
    try {
      const expected = {
        message:
          'The Target promotion file backend is unavailable: target_promotion_atomic_backend_windows_private_root_unavailable.',
      };
      await expect(prepareAgentIsolatedLoopPromotion(
        agent as never,
        {
          schemaVersion: 1,
          sourceRepositoryRoot: join(root, 'repository'),
          sourceSnapshotCwd: join(root, 'repository'),
          sourceSnapshot: {},
        } as never,
      )).rejects.toMatchObject(expected);
      await expect(promoteAgentIsolatedLoopCandidate(
        agent as never,
        {
          schemaVersion: 1,
          sourceRepositoryRoot: join(root, 'repository'),
          sourceSnapshotCwd: join(root, 'repository'),
          sourceSnapshot: {},
          proposalDigest: `sha256:${'a'.repeat(64)}`,
        } as never,
        new AbortController().signal,
      )).rejects.toMatchObject(expected);
    } finally {
      Object.defineProperty(
        process,
        'platform',
        platformDescriptor,
      );
    }

    expect(accesses).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  describe.runIf(
    process.platform === 'darwin' || process.platform === 'linux',
  )('crash-safe transaction cleanup', () => {
    it.each([
      'prepared',
      'quarantined',
      'artifact-removed',
      'marker-removed',
    ] as const)(
      'resumes cleanup interrupted after %s',
      async (boundary) => {
        const root = await mkdtemp(join(
          tmpdir(),
          'wukong-target-cleanup-',
        ));
        roots.push(root);
        await writeFile(join(root, 'update.txt'), 'before\n');
        const before = await projectionEntry(
          root,
          'update.txt',
          Buffer.from('before\n'),
        );
        const after = await projectionEntry(
          root,
          'update.txt',
          Buffer.from('after\n'),
        );
        const transactionId = `sha256:${'c'.repeat(64)}`;
        let interrupted = false;
        const crash = () => {
          if (interrupted) return;
          interrupted = true;
          throw new Error(`cleanup interrupted after ${boundary}`);
        };
        const backend = new TargetPromotionWorkspaceBackend(root, {
          afterTransactionCleanupPrepared:
            boundary === 'prepared' ? crash : undefined,
          afterTransactionCleanupQuarantined:
            boundary === 'quarantined' ? crash : undefined,
          afterTransactionCleanupArtifactRemoved:
            boundary === 'artifact-removed' ? crash : undefined,
          afterTransactionCleanupMarkerRemoved:
            boundary === 'marker-removed' ? crash : undefined,
        });
        try {
          await backend.replaceExact(
            after,
            Buffer.from('after\n'),
            before,
            transactionId,
          );
          await expect(backend.finalizeReplace(
            after,
            before,
            transactionId,
          )).rejects.toThrow(
            `cleanup interrupted after ${boundary}`,
          );
        } finally {
          backend.close();
        }
        expect(interrupted).toBe(true);
        expect((await readdir(root)).some((name) =>
          name.startsWith('.wukong-apply-'))).toBe(true);

        const recovered = new TargetPromotionWorkspaceBackend(root);
        try {
          await recovered.finalizeReplace(
            after,
            before,
            transactionId,
          );
        } finally {
          recovered.close();
        }
        expect(await readFile(join(root, 'update.txt'), 'utf8'))
          .toBe('after\n');
        expect((await readdir(root)).filter((name) =>
          name.startsWith('.wukong-apply-'))).toEqual([]);
      },
    );

    it('fails closed on a tampered cleanup manifest', async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        'wukong-target-cleanup-tamper-',
      ));
      roots.push(root);
      await writeFile(join(root, 'update.txt'), 'before\n');
      const before = await projectionEntry(
        root,
        'update.txt',
        Buffer.from('before\n'),
      );
      const after = await projectionEntry(
        root,
        'update.txt',
        Buffer.from('after\n'),
      );
      const transactionId = `sha256:${'d'.repeat(64)}`;
      const interrupted = new TargetPromotionWorkspaceBackend(root, {
        afterTransactionCleanupPrepared: () => {
          throw new Error('cleanup prepared');
        },
      });
      try {
        await interrupted.replaceExact(
          after,
          Buffer.from('after\n'),
          before,
          transactionId,
        );
        await expect(interrupted.finalizeReplace(
          after,
          before,
          transactionId,
        )).rejects.toThrow('cleanup prepared');
      } finally {
        interrupted.close();
      }
      const transaction = (await readdir(root)).find((name) =>
        name.startsWith('.wukong-apply-'));
      expect(transaction).toBeDefined();
      await writeFile(join(root, transaction!, 'cleanup'), 'tampered\n');

      const recovered = new TargetPromotionWorkspaceBackend(root);
      try {
        await expect(recovered.finalizeReplace(
          after,
          before,
          transactionId,
        )).rejects.toMatchObject({
          reasonCode: 'target_promotion_atomic_artifact_conflict',
        });
      } finally {
        recovered.close();
      }
      expect(await readFile(join(root, 'update.txt'), 'utf8'))
        .toBe('after\n');
      expect((await readdir(root)).filter((name) =>
        name.startsWith('.wukong-apply-'))).toHaveLength(1);
    });
  });
});

async function projectionEntry(
  root: string,
  relativePath: string,
  bytes: Buffer,
): Promise<CandidateProjectionEntryV1> {
  const existing = await stat(join(root, relativePath));
  const contentDigest = `sha256:${createHash('sha256')
    .update('wukong/candidate-projection-file/v1')
    .update('\0')
    .update(bytes)
    .digest('hex')}`;
  const mode = (existing.mode & 0o111) === 0
    ? 0o100644 as const
    : 0o100755 as const;
  return Object.freeze({
    schemaVersion: 1,
    canonicalRelativePath: relativePath,
    mode,
    sizeBytes: bytes.byteLength,
    contentDigest,
    entryDigest: `sha256:${createHash('sha256')
      .update('wukong/test-target-cleanup-entry/v1')
      .update('\0')
      .update(relativePath)
      .update('\0')
      .update(String(mode))
      .update('\0')
      .update(contentDigest)
      .digest('hex')}`,
  });
}
