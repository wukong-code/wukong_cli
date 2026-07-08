import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function makeTempRepo(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  await execFileAsync('git', ['init'], { cwd: dir });
  return dir;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeRepoFile(root: string, relative: string, content: string): Promise<void> {
  const fullPath = join(root, relative);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

export async function gitAdd(root: string, path = '.'): Promise<void> {
  await execFileAsync('git', ['add', path], { cwd: root });
}

export async function gitCommit(root: string, message = 'test commit'): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.name=Wukong Test', '-c', 'user.email=test@wukong.local', 'commit', '-m', message],
    { cwd: root },
  );
}

export async function gitMove(root: string, from: string, to: string): Promise<void> {
  await execFileAsync('git', ['mv', from, to], { cwd: root });
}
