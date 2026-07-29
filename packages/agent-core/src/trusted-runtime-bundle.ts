import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import { canonicalDigest } from '@wukong/verification';

const MAX_BUNDLE_ENTRIES = 20_000;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const bundleBindings =
  new WeakMap<TrustedRuntimeBundleHandleV1, RuntimeBundleBinding>();

export type TrustedRuntimeBundleErrorCode =
  | 'trusted_runtime_bundle_invalid_input'
  | 'trusted_runtime_bundle_path_unsafe'
  | 'trusted_runtime_bundle_limit'
  | 'trusted_runtime_bundle_identity_changed';

export class TrustedRuntimeBundleError extends Error {
  constructor(
    readonly reasonCode: TrustedRuntimeBundleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TrustedRuntimeBundleError';
  }
}

export interface TrustedRuntimeBundleIdentityV1 {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly entryRelativePath: string;
  readonly entryCount: number;
  readonly totalFileBytes: number;
  readonly rootPathDigest: string;
  readonly treeDigest: string;
  readonly bundleIdentityDigest: string;
}

interface RuntimeBundleBinding {
  readonly rootPath: string;
  readonly entryScriptPath: string;
  readonly forbiddenRoots: readonly string[];
}

interface BundleEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly mode: number;
  readonly sizeBytes: number;
  readonly contentDigest: string | null;
  readonly linkTarget: string | null;
}

export class TrustedRuntimeBundleHandleV1 {
  private constructor(
    readonly identity: TrustedRuntimeBundleIdentityV1,
    binding: RuntimeBundleBinding,
  ) {
    bundleBindings.set(this, binding);
    Object.freeze(this);
  }

  static create(
    identity: TrustedRuntimeBundleIdentityV1,
    binding: RuntimeBundleBinding,
  ): TrustedRuntimeBundleHandleV1 {
    return new TrustedRuntimeBundleHandleV1(identity, binding);
  }

  toJSON(): Record<string, unknown> {
    return {
      identity: this.identity,
      rootPath: '[PRIVATE]',
      entryScriptPath: '[PRIVATE]',
    };
  }
}

export async function inspectTrustedRuntimeBundle(input: {
  readonly rootPath: string;
  readonly entryScriptPath: string;
  readonly packageName: string;
  readonly forbiddenRoots: readonly string[];
}): Promise<TrustedRuntimeBundleHandleV1> {
  assertInput(input);
  const [rootPath, entryScriptPath] = await Promise.all([
    realpath(resolve(input.rootPath)),
    realpath(resolve(input.entryScriptPath)),
  ]);
  if (!isInside(rootPath, entryScriptPath)) {
    fail(
      'trusted_runtime_bundle_path_unsafe',
      'The runtime entry script is outside its package bundle.',
    );
  }
  await assertOutsideForbiddenRoots(rootPath, input.forbiddenRoots);
  const packageJson = JSON.parse(
    await readFile(join(rootPath, 'package.json'), 'utf8'),
  ) as unknown;
  if (!isRecord(packageJson)
    || packageJson['name'] !== input.packageName) {
    fail(
      'trusted_runtime_bundle_path_unsafe',
      'The runtime package identity is not the expected package.',
    );
  }
  const inspected = await fingerprintBundle(rootPath);
  const entryRelativePath = portableRelative(
    rootPath,
    entryScriptPath,
  );
  if (!inspected.entries.some(
    (entry) =>
      entry.path === entryRelativePath
      && entry.kind === 'file',
  )) {
    fail(
      'trusted_runtime_bundle_path_unsafe',
      'The runtime entry script is not one frozen regular bundle file.',
    );
  }
  const core = {
    schemaVersion: 1 as const,
    packageName: input.packageName,
    entryRelativePath,
    entryCount: inspected.entries.length,
    totalFileBytes: inspected.totalFileBytes,
    rootPathDigest: canonicalDigest(
      'wukong/private-path/v1',
      rootPath,
    ),
    treeDigest: inspected.treeDigest,
  };
  const identity = Object.freeze({
    ...core,
    bundleIdentityDigest: canonicalDigest(
      'wukong/trusted-runtime-bundle-identity/v1',
      core,
    ),
  });
  return TrustedRuntimeBundleHandleV1.create(
    identity,
    Object.freeze({
      rootPath,
      entryScriptPath,
      forbiddenRoots: Object.freeze([...input.forbiddenRoots]),
    }),
  );
}

export async function withTrustedRuntimeBundle<Result>(
  handle: TrustedRuntimeBundleHandleV1,
  callback: (view: {
    readonly rootPath: string;
    readonly entryScriptPath: string;
  }) => Promise<Result> | Result,
): Promise<Result> {
  if (!(handle instanceof TrustedRuntimeBundleHandleV1)
    || typeof callback !== 'function') {
    fail(
      'trusted_runtime_bundle_invalid_input',
      'An authentic trusted runtime bundle is required.',
    );
  }
  const binding = bundleBindings.get(handle);
  if (binding === undefined) {
    fail(
      'trusted_runtime_bundle_invalid_input',
      'The trusted runtime bundle handle is not authentic.',
    );
  }
  await assertRuntimeBundleMatches(handle, binding);
  try {
    return await callback(Object.freeze({
      rootPath: binding.rootPath,
      entryScriptPath: binding.entryScriptPath,
    }));
  } finally {
    await assertRuntimeBundleMatches(handle, binding);
  }
}

async function assertRuntimeBundleMatches(
  handle: TrustedRuntimeBundleHandleV1,
  binding: RuntimeBundleBinding,
): Promise<void> {
  await assertOutsideForbiddenRoots(
    binding.rootPath,
    binding.forbiddenRoots,
  );
  const [actualRoot, actualEntry, inspected] = await Promise.all([
    realpath(binding.rootPath),
    realpath(binding.entryScriptPath),
    fingerprintBundle(binding.rootPath),
  ]);
  if (actualRoot !== binding.rootPath
    || actualEntry !== binding.entryScriptPath
    || portableRelative(actualRoot, actualEntry)
      !== handle.identity.entryRelativePath
    || inspected.entries.length !== handle.identity.entryCount
    || inspected.totalFileBytes
      !== handle.identity.totalFileBytes
    || inspected.treeDigest !== handle.identity.treeDigest) {
    fail(
      'trusted_runtime_bundle_identity_changed',
      'The trusted runtime package bundle changed.',
    );
  }
}

async function fingerprintBundle(rootPath: string): Promise<{
  readonly entries: readonly BundleEntry[];
  readonly totalFileBytes: number;
  readonly treeDigest: string;
}> {
  const entries: BundleEntry[] = [];
  let totalFileBytes = 0;
  const visit = async (absoluteDirectory: string): Promise<void> => {
    const children = await readdir(absoluteDirectory, {
      withFileTypes: true,
    });
    children.sort((left, right) =>
      left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= MAX_BUNDLE_ENTRIES) {
        fail(
          'trusted_runtime_bundle_limit',
          'The runtime package bundle has too many entries.',
        );
      }
      const absolutePath = join(absoluteDirectory, child.name);
      const path = portableRelative(rootPath, absolutePath);
      const info = await lstat(absolutePath);
      if (info.isDirectory()) {
        entries.push({
          path,
          kind: 'directory',
          mode: info.mode,
          sizeBytes: 0,
          contentDigest: null,
          linkTarget: null,
        });
        await visit(absolutePath);
        continue;
      }
      if (info.isSymbolicLink()) {
        const linkTarget = await readlink(absolutePath);
        const resolvedTarget = await realpath(resolve(
          absoluteDirectory,
          linkTarget,
        ));
        if (!isInside(rootPath, resolvedTarget)) {
          fail(
            'trusted_runtime_bundle_path_unsafe',
            'The runtime package bundle contains an external symlink.',
          );
        }
        entries.push({
          path,
          kind: 'symlink',
          mode: info.mode,
          sizeBytes: Buffer.byteLength(linkTarget),
          contentDigest: canonicalDigest(
            'wukong/trusted-runtime-bundle-symlink/v1',
            linkTarget,
          ),
          linkTarget,
        });
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        fail(
          'trusted_runtime_bundle_path_unsafe',
          'The runtime package bundle contains an unsafe file node.',
        );
      }
      totalFileBytes += info.size;
      if (totalFileBytes > MAX_BUNDLE_BYTES) {
        fail(
          'trusted_runtime_bundle_limit',
          'The runtime package bundle is too large.',
        );
      }
      const bytes = await readStableRegularFile(absolutePath, info);
      entries.push({
        path,
        kind: 'file',
        mode: info.mode,
        sizeBytes: bytes.byteLength,
        contentDigest: canonicalDigest(
          'wukong/trusted-runtime-bundle-file/v1',
          bytes.toString('base64'),
        ),
        linkTarget: null,
      });
    }
  };
  await visit(rootPath);
  return Object.freeze({
    entries: Object.freeze(entries),
    totalFileBytes,
    treeDigest: canonicalDigest(
      'wukong/trusted-runtime-bundle-tree/v1',
      entries,
    ),
  });
}

async function readStableRegularFile(
  path: string,
  expected: Awaited<ReturnType<typeof lstat>>,
): Promise<Buffer> {
  const noFollow = process.platform === 'win32'
    ? 0
    : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.nlink !== 1
      || before.dev !== expected.dev
      || before.ino !== expected.ino
      || before.size !== expected.size) {
      fail(
        'trusted_runtime_bundle_identity_changed',
        'A runtime bundle file changed before reading.',
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || bytes.byteLength !== after.size) {
      fail(
        'trusted_runtime_bundle_identity_changed',
        'A runtime bundle file changed while reading.',
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertOutsideForbiddenRoots(
  bundleRoot: string,
  forbiddenRoots: readonly string[],
): Promise<void> {
  for (const root of forbiddenRoots) {
    const actualRoot = await realpath(resolve(root));
    if (isInside(actualRoot, bundleRoot)) {
      fail(
        'trusted_runtime_bundle_path_unsafe',
        'The runtime package bundle is inside a forbidden root.',
      );
    }
  }
}

function assertInput(input: {
  readonly rootPath: string;
  readonly entryScriptPath: string;
  readonly packageName: string;
  readonly forbiddenRoots: readonly string[];
}): void {
  if (!isRecord(input)
    || typeof input.rootPath !== 'string'
    || !isAbsolute(input.rootPath)
    || resolve(input.rootPath) !== input.rootPath
    || typeof input.entryScriptPath !== 'string'
    || !isAbsolute(input.entryScriptPath)
    || resolve(input.entryScriptPath) !== input.entryScriptPath
    || typeof input.packageName !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.packageName)
    || !Array.isArray(input.forbiddenRoots)
    || input.forbiddenRoots.some(
      (root) =>
        typeof root !== 'string'
        || !isAbsolute(root)
        || resolve(root) !== root,
    )) {
    fail(
      'trusted_runtime_bundle_invalid_input',
      'The trusted runtime package bundle input is invalid.',
    );
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).replaceAll('\\', '/');
  if (value.length === 0
    || value === '..'
    || value.startsWith('../')) {
    fail(
      'trusted_runtime_bundle_path_unsafe',
      'A runtime bundle path is outside its root.',
    );
  }
  return value;
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === ''
    || (value !== '..'
      && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      && !isAbsolute(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function fail(
  reasonCode: TrustedRuntimeBundleErrorCode,
  message: string,
): never {
  throw new TrustedRuntimeBundleError(reasonCode, message);
}
