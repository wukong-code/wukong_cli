import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  buildSnapshotMaterializationContainer,
  SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS,
  SNAPSHOT_MATERIALIZATION_LIMITS,
  SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  SNAPSHOT_MATERIALIZATION_POLICY_VERSION,
  validateSnapshotMaterializationSourceBinding,
  type BuiltSnapshotMaterializationContainerV1,
  type SnapshotMaterializationEntryInputV1,
} from './snapshot-materialization';
import {
  inspectSourceSnapshot,
  sourceSnapshotMatches,
  validateSourceSnapshot,
  type SourceSnapshotV1,
} from './source-snapshot';
import {
  injectSourceSnapshotSealerTestFault,
  validateSourceSnapshotSealerTestFaultCapability,
  type SourceSnapshotSealerTestFaultCapabilityV1,
} from './source-snapshot-sealer-test-fault';

export type SourceSnapshotSealErrorCodeV1 =
  | 'source_snapshot_seal_invalid_input'
  | 'source_snapshot_seal_drift'
  | 'source_snapshot_seal_git_failed'
  | 'source_snapshot_seal_unsafe_file'
  | 'source_snapshot_seal_binding_failed';

export class SourceSnapshotSealError extends Error {
  constructor(
    readonly reasonCode: SourceSnapshotSealErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SourceSnapshotSealError';
  }
}

export interface SealSourceSnapshotOptionsV1 {
  readonly cwd?: string;
  readonly snapshot: SourceSnapshotV1;
  /**
   * Process-crash test seam. Production callers cannot construct this.
   */
  readonly testFault?: SourceSnapshotSealerTestFaultCapabilityV1;
}

export interface SealedSourceSnapshotV1
  extends BuiltSnapshotMaterializationContainerV1 {
  readonly materializationPolicyVersion:
    typeof SNAPSHOT_MATERIALIZATION_POLICY_VERSION;
  readonly materializationPolicyDigest: string;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
}

interface IndexEntry {
  readonly mode: '100644' | '100755';
  readonly objectId: string;
  readonly stage: 0;
}

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_GIT_RUNTIME_MS = 30_000;
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const MAX_PORTABLE_PATH_BYTES = 4_096;
const MAX_PORTABLE_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * Reads the exact index/worktree postimages bound by a previously inspected
 * SourceSnapshotV1. This is still read-only: it does not create a lease,
 * worktree, candidate, run, or ordinary durable record.
 */
export async function sealSourceSnapshot(
  options: SealSourceSnapshotOptionsV1,
): Promise<SealedSourceSnapshotV1> {
  if (!isRecord(options)
    || !hasExactKeys(options, ['snapshot'], ['cwd', 'testFault'])
    || !validateSourceSnapshot(options.snapshot)
    || options.snapshot.exclusions.length > 0
    || (options.testFault !== undefined
      && !validateSourceSnapshotSealerTestFaultCapability(
        options.testFault,
      ))) {
    fail(
      'source_snapshot_seal_invalid_input',
      'Only a valid ready source snapshot without exclusions can be sealed.',
    );
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  await assertSnapshotCurrent(options.snapshot, cwd);
  await injectSourceSnapshotSealerTestFault(
    options.testFault,
    'source_snapshot_sealer_after_initial_validation',
  );
  const root = await resolveRepositoryRoot(cwd);
  const entries = await readMaterializationEntries(root, options.snapshot);
  await injectSourceSnapshotSealerTestFault(
    options.testFault,
    'source_snapshot_sealer_after_entries_read',
  );
  const built = buildSnapshotMaterializationContainer({
    sourceSnapshotDigest: options.snapshot.snapshotDigest,
    snapshotPolicyDigest: options.snapshot.snapshotPolicyDigest,
    materializationPolicyDigest: SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
    entries,
  });
  if (!validateSnapshotMaterializationSourceBinding(
    options.snapshot,
    built.manifest,
    extractPayloadBytes(built),
  )) {
    fail(
      'source_snapshot_seal_binding_failed',
      'The sealed bytes do not reproduce the approved source snapshot.',
    );
  }
  await injectSourceSnapshotSealerTestFault(
    options.testFault,
    'source_snapshot_sealer_after_container_built',
  );
  await assertSnapshotCurrent(options.snapshot, cwd);
  await injectSourceSnapshotSealerTestFault(
    options.testFault,
    'source_snapshot_sealer_after_final_validation',
  );
  return {
    ...built,
    materializationPolicyVersion: SNAPSHOT_MATERIALIZATION_POLICY_VERSION,
    materializationPolicyDigest: SNAPSHOT_MATERIALIZATION_POLICY_DIGEST,
  };
}

async function assertSnapshotCurrent(
  snapshot: SourceSnapshotV1,
  cwd: string,
): Promise<void> {
  const inspected = await inspectSourceSnapshot({
    cwd,
    selectedUntrackedPaths: snapshot.includedUntracked.map(
      (entry) => entry.canonicalRelativePath,
    ),
    limits: snapshot.snapshotLimits,
  });
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null
    || !sourceSnapshotMatches(snapshot, inspected.proposedSnapshot)) {
    fail(
      'source_snapshot_seal_drift',
      'The source workspace no longer matches the approved snapshot.',
    );
  }
}

async function resolveRepositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) {
    fail('source_snapshot_seal_git_failed', 'Unable to resolve the source repository.');
  }
  const root = await realpath(singleLine(result.stdout));
  const actualCwd = await realpath(cwd);
  if (!isInside(root, actualCwd)) {
    fail('source_snapshot_seal_unsafe_file', 'The source path escaped its repository.');
  }
  return root;
}

async function readMaterializationEntries(
  root: string,
  snapshot: SourceSnapshotV1,
): Promise<readonly SnapshotMaterializationEntryInputV1[]> {
  const [indexResult, stagedResult, unstagedResult] = await Promise.all([
    runGit(root, ['ls-files', '--stage', '-z']),
    runGit(root, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--name-only', '-z', '--cached', 'HEAD', '--',
    ]),
    runGit(root, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--name-only', '-z', '--',
    ]),
  ]);
  if ([indexResult, stagedResult, unstagedResult].some(
    (result) => result.exitCode !== 0,
  )) {
    fail('source_snapshot_seal_git_failed', 'Unable to read the frozen Git state.');
  }
  const index = parseIndex(indexResult.stdout);
  const changedPaths = [...new Set([
    ...parseNulPaths(stagedResult.stdout),
    ...parseNulPaths(unstagedResult.stdout),
  ])].toSorted(comparePaths);
  const changedPathSet = new Set(changedPaths);
  let compatibilityBytes = 0;
  for (const [path, entry] of index) {
    if (changedPathSet.has(path)) continue;
    const worktree = await readStableRegularFile(
      root,
      path,
      false,
      SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS.maxBaseBlobBytes,
    );
    if (worktree === null) {
      fail(
        'source_snapshot_seal_drift',
        'A clean tracked source file disappeared before sealing.',
      );
    }
    compatibilityBytes += worktree.content.byteLength;
    if (compatibilityBytes
      > SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS.maxBaseTotalBytes) {
      fail(
        'source_snapshot_seal_unsafe_file',
        'The clean tracked compatibility projection exceeds its fixed limit.',
      );
    }
    if (digestGitBlob(worktree.content, entry.objectId.length) !== entry.objectId
      || worktree.mode !== Number.parseInt(entry.mode, 8)) {
      fail(
        'source_snapshot_seal_binding_failed',
        'A clean tracked source postimage requires unsupported Git conversion.',
      );
    }
    assertNotLfsPointer(worktree.content);
  }
  const entries: SnapshotMaterializationEntryInputV1[] = [];
  for (const path of changedPaths) {
    const indexEntry = index.get(path) ?? null;
    const indexContent = indexEntry === null
      ? null
      : await readGitBlob(root, indexEntry.objectId);
    const worktree = await readStableRegularFile(
      root,
      path,
      true,
      SNAPSHOT_MATERIALIZATION_LIMITS.maxImageBytes,
    );
    entries.push({
      canonicalRelativePath: path,
      selectedUntracked: false,
      indexObjectId: indexEntry?.objectId ?? null,
      indexImage: indexEntry === null || indexContent === null
        ? null
        : {
            mode: Number.parseInt(indexEntry.mode, 8) as 0o100644 | 0o100755,
            content: indexContent,
          },
      worktreeImage: worktree,
    });
  }
  for (const selected of snapshot.includedUntracked) {
    const worktree = await readStableRegularFile(
      root,
      selected.canonicalRelativePath,
      false,
      SNAPSHOT_MATERIALIZATION_LIMITS.maxImageBytes,
    );
    if (worktree === null) {
      fail(
        'source_snapshot_seal_drift',
        'A selected untracked source file disappeared before sealing.',
      );
    }
    entries.push({
      canonicalRelativePath: selected.canonicalRelativePath,
      selectedUntracked: true,
      indexObjectId: null,
      indexImage: null,
      worktreeImage: worktree,
    });
  }
  return entries;
}

async function readGitBlob(root: string, objectId: string): Promise<Uint8Array> {
  if (!isGitObjectId(objectId)) {
    fail('source_snapshot_seal_git_failed', 'The Git index object is invalid.');
  }
  const result = await runGit(root, ['cat-file', 'blob', objectId]);
  if (result.exitCode !== 0) {
    fail('source_snapshot_seal_git_failed', 'Unable to read an index blob.');
  }
  assertNotLfsPointer(result.stdout);
  return Uint8Array.from(result.stdout);
}

async function readStableRegularFile(
  root: string,
  path: string,
  allowMissing: boolean,
  maxBytes: number,
): Promise<{ readonly mode: 0o100644 | 0o100755; readonly content: Uint8Array } | null> {
  assertPortableRelativePath(path);
  const absolutePath = resolve(root, path);
  if (!isInside(root, absolutePath)) {
    fail('source_snapshot_seal_unsafe_file', 'A source file escaped its repository.');
  }
  await assertParentSegmentsAreDirectories(root, path);
  let before;
  try {
    before = await lstat(absolutePath);
  } catch (error) {
    if (allowMissing && isNodeError(error, 'ENOENT')) return null;
    throw sealReadError(error);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    fail(
      'source_snapshot_seal_unsafe_file',
      'A source postimage is not a single-link regular file.',
    );
  }
  if (before.size > maxBytes) {
    fail('source_snapshot_seal_unsafe_file', 'A source postimage exceeds its fixed limit.');
  }
  const resolvedPath = await realpath(absolutePath);
  if (!isInside(root, resolvedPath)) {
    fail('source_snapshot_seal_unsafe_file', 'A source file resolved outside its repository.');
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1) {
      fail('source_snapshot_seal_unsafe_file', 'A source file changed identity while opening.');
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const linked = await lstat(absolutePath);
    if (!sameFile(opened, after)
      || !sameFile(opened, linked)
      || content.byteLength !== after.size) {
      fail('source_snapshot_seal_drift', 'A source file changed while it was being sealed.');
    }
    if (content.byteLength > maxBytes) {
      fail('source_snapshot_seal_unsafe_file', 'A source postimage exceeds its fixed limit.');
    }
    assertNotLfsPointer(content);
    return {
      mode: (after.mode & 0o111) === 0 ? 0o100644 : 0o100755,
      content: Uint8Array.from(content),
    };
  } finally {
    await handle.close();
  }
}

async function assertParentSegmentsAreDirectories(
  root: string,
  path: string,
): Promise<void> {
  const segments = path.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(
        'source_snapshot_seal_unsafe_file',
        'A source path contains an unsafe parent segment.',
      );
    }
  }
}

function extractPayloadBytes(
  built: BuiltSnapshotMaterializationContainerV1,
): Uint8Array {
  const bytes = Buffer.from(built.containerBytes);
  const manifestLength = bytes.readUInt32BE(12);
  return Uint8Array.from(bytes.subarray(24 + manifestLength));
}

function parseIndex(input: Buffer): ReadonlyMap<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const record of parseNulRecords(input)) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      fail('source_snapshot_seal_git_failed', 'The Git index record is invalid.');
    }
    const fields = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    assertPortableRelativePath(path);
    const [mode, objectId, stageText] = fields;
    if (fields.length !== 3
      || (mode !== '100644' && mode !== '100755')
      || !isGitObjectId(objectId)
      || stageText !== '0'
      || entries.has(path)) {
      fail('source_snapshot_seal_git_failed', 'The Git index is unsupported.');
    }
    entries.set(path, { mode, objectId, stage: 0 });
  }
  return entries;
}

function parseNulPaths(input: Buffer): readonly string[] {
  const paths = parseNulRecords(input);
  for (const path of paths) assertPortableRelativePath(path);
  const portable = new Set<string>();
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase();
    if (portable.has(key)) {
      fail('source_snapshot_seal_git_failed', 'The Git path set is not unique.');
    }
    portable.add(key);
  }
  return paths;
}

function parseNulRecords(input: Buffer): string[] {
  const text = input.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(input)) {
    fail('source_snapshot_seal_git_failed', 'Git returned a non-UTF-8 path.');
  }
  if (text.length === 0) return [];
  const records = text.split('\0');
  if (records.at(-1) !== '') {
    fail('source_snapshot_seal_git_failed', 'Git returned an unterminated path.');
  }
  records.pop();
  return records;
}

function assertPortableRelativePath(path: string): void {
  if (path.length === 0
    || path !== path.normalize('NFC')
    || path.includes('\0')
    || path.includes('\\')
    || isAbsolute(path)
    || /[\u0000-\u001F\u007F]/u.test(path)
    || Buffer.byteLength(path, 'utf8') > MAX_PORTABLE_PATH_BYTES) {
    fail('source_snapshot_seal_unsafe_file', 'A source path is not portable.');
  }
  const segments = path.split('/');
  if (segments.some((segment) =>
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.toLowerCase() === '.git'
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || WINDOWS_RESERVED_CHARACTERS.test(segment)
    || WINDOWS_RESERVED_DEVICE.test(segment)
    || Buffer.byteLength(segment, 'utf8') > MAX_PORTABLE_SEGMENT_BYTES)) {
    fail('source_snapshot_seal_unsafe_file', 'A source path is not portable.');
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      'git',
      [
        '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false',
        '-c', `core.attributesFile=${GIT_NULL_DEVICE}`,
        '-c', 'maintenance.auto=false',
        ...args,
      ],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: MAX_GIT_RUNTIME_MS,
        env: sanitizedGitEnvironment(),
      },
      (error, stdout) => {
        if (error === null) {
          resolveResult({
            exitCode: 0,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          });
          return;
        }
        if (typeof error.code !== 'number') {
          rejectResult(error);
          return;
        }
        resolveResult({
          exitCode: error.code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        });
      },
    );
  });
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        !key.toUpperCase().startsWith('GIT_')),
    ),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && Number(left.mode) === Number(right.mode)
    && Number(left.nlink) === Number(right.nlink);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function singleLine(input: Buffer): string {
  return input.toString('utf8').trim();
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string'
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function digestGitBlob(content: Uint8Array, objectIdLength: number): string {
  const algorithm = objectIdLength === 40 ? 'sha1' : objectIdLength === 64 ? 'sha256' : null;
  if (algorithm === null) return '';
  return createHash(algorithm)
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function assertNotLfsPointer(content: Uint8Array): void {
  const prefix = Buffer.from(content).subarray(0, 256).toString('utf8');
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:/u.test(prefix)) {
    fail(
      'source_snapshot_seal_unsafe_file',
      'Git LFS pointer materialization is unsupported.',
    );
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sealReadError(error: unknown): SourceSnapshotSealError {
  return new SourceSnapshotSealError(
    'source_snapshot_seal_drift',
    'Unable to read a source postimage while sealing.',
    { cause: error },
  );
}

function fail(code: SourceSnapshotSealErrorCodeV1, message: string): never {
  throw new SourceSnapshotSealError(code, message);
}
