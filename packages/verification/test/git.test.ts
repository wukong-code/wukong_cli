import { describe, expect, it } from 'vitest';

import { inspectGit } from '../src/git';
import { gitAdd, gitCommit, gitMove, makeTempDir, makeTempRepo, writeRepoFile } from './helpers';

describe('inspectGit', () => {
  it('reports non-git directories without failing', async () => {
    const cwd = await makeTempDir('wukong-git-none-');

    const inspection = await inspectGit(cwd);

    expect(inspection.isRepo).toBe(false);
    expect(inspection.changedFiles).toEqual([]);
    expect(inspection.diffText).toBe('');
  });

  it('combines staged and unstaged changes in one inspection', async () => {
    const cwd = await makeTempRepo('wukong-git-mixed-');
    await writeRepoFile(cwd, 'src/tracked.ts', 'export const a = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');

    // Unstaged: modify a tracked file. Staged: add a new file.
    await writeRepoFile(cwd, 'src/tracked.ts', 'export const a = 2;\n');
    await writeRepoFile(cwd, 'src/staged.ts', 'export const b = 1;\n');
    await gitAdd(cwd, 'src/staged.ts');

    const inspection = await inspectGit(cwd);

    expect(inspection.isRepo).toBe(true);
    const paths = inspection.changedFiles.map((file) => file.path).sort();
    expect(paths).toEqual(['src/staged.ts', 'src/tracked.ts']);
    expect(inspection.diffText).toContain('export const a = 2;');
    expect(inspection.diffText).toContain('export const b = 1;');
    expect(inspection.diffStat).toContain('src/tracked.ts');
    expect(inspection.diffStat).toContain('src/staged.ts');
  });

  it('uses the new path for renamed files', async () => {
    const cwd = await makeTempRepo('wukong-git-rename-');
    await writeRepoFile(cwd, 'src/old-name.ts', 'export const a = 1;\n');
    await gitAdd(cwd);
    await gitCommit(cwd, 'base');
    await gitMove(cwd, 'src/old-name.ts', 'src/new-name.ts');

    const inspection = await inspectGit(cwd);

    expect(inspection.changedFiles).toHaveLength(1);
    expect(inspection.changedFiles[0]?.path).toBe('src/new-name.ts');
    expect(inspection.changedFiles[0]?.status).toBe('R');
  });
});
