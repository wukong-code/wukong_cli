import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalDigest,
  type CandidateProjectionEntryV1,
} from '@wukong/verification';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectTargetPromotionWorkspaceBackendCapability,
  TargetPromotionWorkspaceBackend,
} from '../src/target-promotion-workspace-backend';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')(
  'Windows Target handle-relative transactions',
  () => {
    it('applies and finalizes create, update, delete, and rename', async () => {
      const root = await targetRoot();
      await writeFile(join(root, 'update.txt'), 'before\n');
      await writeFile(join(root, 'delete.txt'), 'delete\n');
      await writeFile(join(root, 'rename-old.txt'), 'rename\n');
      const updateBefore = await entry(root, 'update.txt');
      const updateAfter = await replacementEntry(
        updateBefore,
        'after\n',
      );
      const deleteBefore = await entry(root, 'delete.txt');
      const renameBefore = await entry(root, 'rename-old.txt');
      const createAfter = await replacementEntry(
        updateBefore,
        'created\n',
        'create-边界-\u0100.txt',
      );
      const backend = new TargetPromotionWorkspaceBackend(root);
      try {
        await backend.replaceExact(
          updateAfter,
          Buffer.from('after\n'),
          updateBefore,
          transactionId('update'),
        );
        await backend.finalizeReplace(
          updateAfter,
          updateBefore,
          transactionId('update'),
        );
        await backend.replaceExact(
          createAfter,
          Buffer.from('created\n'),
          null,
          transactionId('create'),
        );
        await backend.finalizeReplace(
          createAfter,
          null,
          transactionId('create'),
        );
        await backend.unlinkExact(
          deleteBefore,
          transactionId('delete'),
        );
        await backend.finalizeDelete(
          deleteBefore,
          transactionId('delete'),
        );
        await backend.renameExact(
          renameBefore,
          'rename-new.txt',
          transactionId('rename'),
        );
        await backend.finalizeRename(
          renameBefore,
          'rename-new.txt',
          transactionId('rename'),
        );
      } finally {
        backend.close();
      }

      expect(await readFile(join(root, 'update.txt'), 'utf8'))
        .toBe('after\n');
      expect(await readFile(
        join(root, 'create-边界-\u0100.txt'),
        'utf8',
      ))
        .toBe('created\n');
      await expect(readFile(join(root, 'delete.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(root, 'rename-old.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(root, 'rename-new.txt'), 'utf8'))
        .toBe('rename\n');
    });

    it('recovers an update after the preimage entered quarantine', async () => {
      const root = await targetRoot();
      await writeFile(join(root, 'update.txt'), 'before\n');
      const before = await entry(root, 'update.txt');
      const after = await replacementEntry(before, 'after\n');
      let mutations = 0;
      const interrupted = new TargetPromotionWorkspaceBackend(
        root,
        {
          afterAtomicMutation: () => {
            mutations += 1;
            if (mutations === 1) {
              throw new Error('simulated termination');
            }
            return Promise.resolve();
          },
        },
      );
      await expect(interrupted.replaceExact(
        after,
        Buffer.from('after\n'),
        before,
        transactionId('recover'),
      )).rejects.toThrow(/simulated termination/u);
      interrupted.close();

      const recovered = new TargetPromotionWorkspaceBackend(root);
      try {
        await recovered.recoverReplace(
          after,
          before,
          transactionId('recover'),
        );
        await recovered.replaceExact(
          after,
          Buffer.from('after\n'),
          before,
          transactionId('recover'),
        );
        await recovered.finalizeReplace(
          after,
          before,
          transactionId('recover'),
        );
      } finally {
        recovered.close();
      }
      expect(await readFile(join(root, 'update.txt'), 'utf8'))
        .toBe('after\n');
    });

    it('preserves an external destination that appears during quarantine', async () => {
      const root = await targetRoot();
      await writeFile(join(root, 'update.txt'), 'before\n');
      const before = await entry(root, 'update.txt');
      const after = await replacementEntry(before, 'after\n');
      let mutations = 0;
      const backend = new TargetPromotionWorkspaceBackend(root, {
        afterAtomicMutation: async () => {
          mutations += 1;
          if (mutations === 1) {
            await writeFile(
              join(root, 'update.txt'),
              'external\n',
            );
          }
        },
      });
      try {
        await expect(backend.replaceExact(
          after,
          Buffer.from('after\n'),
          before,
          transactionId('external'),
        )).rejects.toMatchObject({
          reasonCode: 'target_promotion_atomic_leaf_changed',
        });
      } finally {
        backend.close();
      }
      expect(await readFile(join(root, 'update.txt'), 'utf8'))
        .toBe('external\n');
    });

    it('rejects a junction parent without touching its destination', async () => {
      const root = await targetRoot();
      const outside = await targetRoot();
      await writeFile(join(outside, 'outside.txt'), 'outside\n');
      await symlink(outside, join(root, 'junction'), 'junction');
      const after = projectionEntry(
        'junction/outside.txt',
        Buffer.from('changed\n'),
        0o100644,
      );
      const backend = new TargetPromotionWorkspaceBackend(root);
      try {
        await expect(backend.replaceExact(
          after,
          Buffer.from('changed\n'),
          null,
          transactionId('junction'),
        )).rejects.toMatchObject({
          reasonCode: 'target_promotion_atomic_path_unsafe',
        });
      } finally {
        backend.close();
      }
      expect(await readFile(join(outside, 'outside.txt'), 'utf8'))
        .toBe('outside\n');
    });

    it('resolves the real packaged Windows Target primitive set', () => {
      expect(inspectTargetPromotionWorkspaceBackendCapability())
        .toMatchObject({
          available: true,
          platform: 'win32',
          backend: 'windows-nt-handle-transaction-v1',
          reasonCode: null,
        });
    });
  },
);

async function targetRoot(): Promise<string> {
  const created = await mkdtemp(
    join(tmpdir(), 'wukong-windows-target-'),
  );
  const root = await realpath(created);
  roots.push(root);
  return root;
}

async function entry(
  root: string,
  relativePath: string,
): Promise<CandidateProjectionEntryV1> {
  const bytes = await readFile(join(root, relativePath));
  const info = await stat(join(root, relativePath));
  return projectionEntry(
    relativePath,
    bytes,
    (info.mode & 0o111) === 0 ? 0o100644 : 0o100755,
  );
}

async function replacementEntry(
  template: CandidateProjectionEntryV1,
  content: string,
  relativePath = template.canonicalRelativePath,
): Promise<CandidateProjectionEntryV1> {
  return projectionEntry(
    relativePath,
    Buffer.from(content),
    template.mode,
  );
}

function projectionEntry(
  relativePath: string,
  bytes: Buffer,
  mode: 0o100644 | 0o100755,
): CandidateProjectionEntryV1 {
  const contentDigest = `sha256:${createHash('sha256')
    .update('wukong/candidate-projection-file/v1')
    .update('\0')
    .update(bytes)
    .digest('hex')}`;
  return {
    schemaVersion: 1,
    canonicalRelativePath: relativePath,
    mode,
    sizeBytes: bytes.byteLength,
    contentDigest,
    entryDigest: canonicalDigest(
      'wukong/test-windows-target-entry/v1',
      {
        relativePath,
        mode,
        sizeBytes: bytes.byteLength,
        contentDigest,
      },
    ),
  };
}

function transactionId(label: string): string {
  return canonicalDigest(
    'wukong/test-windows-target-transaction/v1',
    label,
  );
}
