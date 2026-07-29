import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createSealerSignalRepository(
  root: string,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await runGit(root, ['init', '--quiet']);
  await runGit(root, ['config', 'user.email', 'test@wukong.local']);
  await runGit(root, ['config', 'user.name', 'Wukong Test']);
  await writeFile(root + '/tracked.ts', 'export const value = 1;\n', {
    mode: 0o600,
  });
  await runGit(root, ['add', 'tracked.ts']);
  await runGit(root, ['commit', '--quiet', '-m', 'base']);
  await writeFile(root + '/tracked.ts', 'export const value = 2;\n');
  await runGit(root, ['add', 'tracked.ts']);
  await writeFile(root + '/tracked.ts', 'export const value = 3;\n');
  await writeFile(root + '/selected.ts', 'export const selected = true;\n', {
    mode: 0o600,
  });
}

export async function sealerSignalRepositoryDigest(
  root: string,
): Promise<string> {
  const [head, index, status, tracked, selected, trackedInfo, selectedInfo] =
    await Promise.all([
      runGit(root, ['rev-parse', 'HEAD']),
      runGit(root, ['ls-files', '--stage', '-z']),
      runGit(root, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]),
      readFile(root + '/tracked.ts'),
      readFile(root + '/selected.ts'),
      stat(root + '/tracked.ts'),
      stat(root + '/selected.ts'),
    ]);
  return createHash('sha256')
    .update(JSON.stringify({
      head,
      index,
      status,
      tracked: tracked.toString('base64'),
      selected: selected.toString('base64'),
      trackedMode: trackedInfo.mode & 0o777,
      selectedMode: selectedInfo.mode & 0o777,
      names: (await readdir(root)).toSorted(),
    }))
    .digest('hex');
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}
