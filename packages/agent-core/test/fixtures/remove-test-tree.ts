import {
  chmod,
  lstat,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

export async function removeTestTree(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await makeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeOwnerWritable(absolutePath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }
  if (stats.isSymbolicLink()) return;

  await chmod(
    absolutePath,
    (stats.mode & 0o777) | (stats.isDirectory() ? 0o700 : 0o600),
  );
  if (!stats.isDirectory()) return;

  for (const name of await readdir(absolutePath)) {
    await makeOwnerWritable(join(absolutePath, name));
  }
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'EACCES' || error.code === 'EPERM');
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT';
}
