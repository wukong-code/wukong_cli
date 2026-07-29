import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  canonicalDigest,
  createTrustedExecutableIdentity,
  validateTrustedExecutableIdentity,
  type TrustedExecutableIdentityV1,
} from '@wukong/verification';

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;
interface TrustedExecutablePrivateBinding {
  readonly absoluteRealPath: string;
  readonly validateRuntimeInputs?: () => Promise<void>;
}

const executableBindings =
  new WeakMap<TrustedExecutableHandleV1, TrustedExecutablePrivateBinding>();

export type TrustedExecutableErrorCode =
  | 'trusted_executable_invalid_input'
  | 'trusted_executable_path_unsafe'
  | 'trusted_executable_file_unsafe'
  | 'trusted_executable_forbidden_root'
  | 'trusted_executable_version_failed'
  | 'trusted_executable_identity_changed';

export class TrustedExecutableError extends Error {
  constructor(
    readonly reasonCode: TrustedExecutableErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TrustedExecutableError';
  }
}

export interface InspectTrustedExecutableInputV1 {
  readonly executablePath: string;
  readonly versionProbeArgs: readonly string[];
  readonly forbiddenRoots: readonly string[];
  readonly timeoutMs?: number;
}

export class TrustedExecutableHandleV1 {
  readonly identity: TrustedExecutableIdentityV1;

  private constructor(
    absoluteRealPath: string,
    identity: TrustedExecutableIdentityV1,
    validateRuntimeInputs?: () => Promise<void>,
  ) {
    this.identity = identity;
    executableBindings.set(this, {
      absoluteRealPath,
      validateRuntimeInputs,
    });
    Object.freeze(this);
  }

  static create(
    absoluteRealPath: string,
    identity: TrustedExecutableIdentityV1,
    validateRuntimeInputs?: () => Promise<void>,
  ): TrustedExecutableHandleV1 {
    return new TrustedExecutableHandleV1(
      absoluteRealPath,
      identity,
      validateRuntimeInputs,
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      identity: this.identity,
      absoluteRealPath: '[PRIVATE]',
    };
  }
}

interface ExecutableFileInspection {
  readonly absoluteRealPath: string;
  readonly device: string;
  readonly inode: string;
  readonly sizeBytes: number;
  readonly mode: number;
  readonly contentDigest: string;
  readonly parentDevice: string;
  readonly parentInode: string;
}

export async function inspectTrustedExecutable(
  input: InspectTrustedExecutableInputV1,
): Promise<TrustedExecutableHandleV1> {
  assertInspectionInput(input);
  const requestedPath = resolve(input.executablePath);
  if (!isAbsolute(input.executablePath) || requestedPath !== input.executablePath) {
    fail(
      'trusted_executable_path_unsafe',
      'The trusted executable path must be absolute and normalized.',
    );
  }
  const before = await inspectExecutableFile(requestedPath);
  if (before.absoluteRealPath !== requestedPath) {
    fail(
      'trusted_executable_path_unsafe',
      'The trusted executable path or one of its parents is a symlink.',
    );
  }
  await assertOutsideForbiddenRoots(
    before.absoluteRealPath,
    input.forbiddenRoots,
  );
  const probe = await runVersionProbe(
    before.absoluteRealPath,
    input.versionProbeArgs,
    input.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS,
  );
  const after = await inspectExecutableFile(before.absoluteRealPath);
  if (!sameExecutableFile(before, after)) {
    fail(
      'trusted_executable_identity_changed',
      'The executable changed during its version probe.',
    );
  }
  const runtimeVersionDigest = canonicalDigest(
    'wukong/trusted-executable-runtime-version/v1',
    {
      argv: input.versionProbeArgs,
      stdout: probe.stdout,
      stderr: probe.stderr,
    },
  );
  return TrustedExecutableHandleV1.create(
    before.absoluteRealPath,
    createTrustedExecutableIdentity({
      platform: supportedPlatform(),
      architecture: process.arch,
      realPathDigest: canonicalDigest(
        'wukong/private-path/v1',
        before.absoluteRealPath,
      ),
      device: before.device,
      inode: before.inode,
      sizeBytes: before.sizeBytes,
      mode: before.mode,
      contentDigest: before.contentDigest,
      runtimeVersionDigest,
    }),
  );
}

export async function withTrustedExecutablePath<Result>(
  handle: TrustedExecutableHandleV1,
  callback: (absoluteRealPath: string) => Promise<Result> | Result,
): Promise<Result> {
  if (!(handle instanceof TrustedExecutableHandleV1)
    || !validateTrustedExecutableIdentity(handle.identity)
    || typeof callback !== 'function') {
    fail(
      'trusted_executable_invalid_input',
      'An authentic trusted executable handle is required.',
    );
  }
  const binding = executableBindings.get(handle);
  if (binding === undefined) {
    fail(
      'trusted_executable_invalid_input',
      'The trusted executable handle is not authentic.',
    );
  }
  await binding.validateRuntimeInputs?.();
  await assertExecutableMatches(
    binding.absoluteRealPath,
    handle.identity,
  );
  try {
    return await callback(binding.absoluteRealPath);
  } finally {
    await assertExecutableMatches(
      binding.absoluteRealPath,
      handle.identity,
    );
    await binding.validateRuntimeInputs?.();
  }
}

export async function bindTrustedExecutableRuntimeInputs(input: {
  readonly executable: TrustedExecutableHandleV1;
  readonly runtimeVersionDigest: string;
  readonly validateRuntimeInputs: () => Promise<void>;
}): Promise<TrustedExecutableHandleV1> {
  if (!(input.executable instanceof TrustedExecutableHandleV1)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.runtimeVersionDigest)
    || typeof input.validateRuntimeInputs !== 'function') {
    fail(
      'trusted_executable_invalid_input',
      'The trusted runtime-input binding is invalid.',
    );
  }
  return withTrustedExecutablePath(
    input.executable,
    async (absoluteRealPath) => {
      await input.validateRuntimeInputs();
      const identity = createTrustedExecutableIdentity({
        platform: input.executable.identity.platform,
        architecture: input.executable.identity.architecture,
        realPathDigest:
          input.executable.identity.realPathDigest,
        device: input.executable.identity.device,
        inode: input.executable.identity.inode,
        sizeBytes: input.executable.identity.sizeBytes,
        mode: input.executable.identity.mode,
        contentDigest:
          input.executable.identity.contentDigest,
        runtimeVersionDigest: input.runtimeVersionDigest,
      });
      return TrustedExecutableHandleV1.create(
        absoluteRealPath,
        identity,
        input.validateRuntimeInputs,
      );
    },
  );
}

async function assertExecutableMatches(
  path: string,
  identity: TrustedExecutableIdentityV1,
): Promise<void> {
  const inspected = await inspectExecutableFile(path);
  const actualCore = {
    platform: supportedPlatform(),
    architecture: process.arch,
    realPathDigest: canonicalDigest('wukong/private-path/v1', path),
    device: inspected.device,
    inode: inspected.inode,
    sizeBytes: inspected.sizeBytes,
    mode: inspected.mode,
    contentDigest: inspected.contentDigest,
  };
  if (actualCore.platform !== identity.platform
    || actualCore.architecture !== identity.architecture
    || actualCore.realPathDigest !== identity.realPathDigest
    || actualCore.device !== identity.device
    || actualCore.inode !== identity.inode
    || actualCore.sizeBytes !== identity.sizeBytes
    || actualCore.mode !== identity.mode
    || actualCore.contentDigest !== identity.contentDigest) {
    fail(
      'trusted_executable_identity_changed',
      'The trusted executable identity changed.',
    );
  }
}

async function inspectExecutableFile(
  requestedPath: string,
): Promise<ExecutableFileInspection> {
  let linkInfo;
  let absoluteRealPath: string;
  try {
    [linkInfo, absoluteRealPath] = await Promise.all([
      lstat(requestedPath),
      realpath(requestedPath),
    ]);
  } catch (error) {
    throw new TrustedExecutableError(
      'trusted_executable_path_unsafe',
      'The trusted executable path is unavailable.',
      { cause: error },
    );
  }
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    fail(
      'trusted_executable_file_unsafe',
      'The trusted executable must be a regular non-symlink file.',
    );
  }
  if (process.platform !== 'win32' && (linkInfo.mode & 0o111) === 0) {
    fail(
      'trusted_executable_file_unsafe',
      'The trusted executable has no executable mode bit.',
    );
  }
  if (linkInfo.nlink !== 1 || linkInfo.size <= 0
    || linkInfo.size > MAX_EXECUTABLE_BYTES) {
    fail(
      'trusted_executable_file_unsafe',
      'The trusted executable has an unsafe file identity or size.',
    );
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(
    absoluteRealPath,
    fsConstants.O_RDONLY | noFollow,
  );
  let bytes: Buffer;
  let before;
  let after;
  try {
    before = await handle.stat();
    if (!before.isFile()
      || before.nlink !== 1
      || before.size !== linkInfo.size
      || String(before.dev) !== String(linkInfo.dev)
      || String(before.ino) !== String(linkInfo.ino)) {
      fail(
        'trusted_executable_file_unsafe',
        'The executable file identity changed before reading.',
      );
    }
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  if (!sameStat(before, after) || bytes.byteLength !== after.size) {
    fail(
      'trusted_executable_identity_changed',
      'The executable changed while reading.',
    );
  }
  assertNativeExecutableFormat(bytes);
  const parentInfo = await stat(resolve(absoluteRealPath, '..'), {
    bigint: true,
  });
  if (!parentInfo.isDirectory()) {
    fail(
      'trusted_executable_path_unsafe',
      'The trusted executable parent is not a directory.',
    );
  }
  return {
    absoluteRealPath,
    device: String(after.dev),
    inode: String(after.ino),
    sizeBytes: after.size,
    mode: after.mode,
    contentDigest: digestExecutableContent(bytes),
    parentDevice: parentInfo.dev.toString(),
    parentInode: parentInfo.ino.toString(),
  };
}

async function assertOutsideForbiddenRoots(
  executablePath: string,
  forbiddenRoots: readonly string[],
): Promise<void> {
  for (const root of forbiddenRoots) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      fail(
        'trusted_executable_invalid_input',
        'A forbidden executable root is invalid.',
      );
    }
    let actualRoot: string;
    try {
      actualRoot = await realpath(resolve(root));
    } catch (error) {
      throw new TrustedExecutableError(
        'trusted_executable_invalid_input',
        'A forbidden executable root is unavailable.',
        { cause: error },
      );
    }
    if (isInside(actualRoot, executablePath)) {
      fail(
        'trusted_executable_forbidden_root',
        'The executable is inside a candidate, source, Git, or generated root.',
      );
    }
  }
}

async function runVersionProbe(
  executablePath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const probeHome = await mkdtemp(join(
    tmpdir(),
    'wukong-runtime-probe-',
  ));
  try {
    return await new Promise((resolveResult, rejectResult) => {
      execFile(
        executablePath,
        [...args],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: MAX_VERSION_OUTPUT_BYTES,
          windowsHide: true,
          env: sanitizedProbeEnvironment(probeHome),
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            rejectResult(new TrustedExecutableError(
              'trusted_executable_version_failed',
              'The trusted executable version probe failed.',
              { cause: error },
            ));
            return;
          }
          resolveResult({
            stdout: normalizeProbeOutput(stdout),
            stderr: normalizeProbeOutput(stderr),
          });
        },
      );
    });
  } finally {
    await rm(probeHome, { recursive: true, force: true });
  }
}

function sanitizedProbeEnvironment(
  probeHome: string,
): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env['SystemRoot'],
          WINDIR: process.env['WINDIR'],
        }
      : {}),
    PATH: '',
    HOME: probeHome,
    USERPROFILE: probeHome,
    LC_ALL: 'C',
    LANG: 'C',
    NO_COLOR: '1',
    CI: '1',
  };
}

function normalizeProbeOutput(value: string): string {
  if (value.includes('\0')) {
    fail(
      'trusted_executable_version_failed',
      'The executable version output contains a NUL byte.',
    );
  }
  return value.replaceAll('\r\n', '\n').trim();
}

function digestExecutableContent(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update('wukong/trusted-executable-content/v1')
    .update('\0')
    .update(bytes)
    .digest('hex')}`;
}

function assertNativeExecutableFormat(bytes: Uint8Array): void {
  const native = process.platform === 'linux'
    ? bytes.byteLength >= 4
      && bytes[0] === 0x7f
      && bytes[1] === 0x45
      && bytes[2] === 0x4c
      && bytes[3] === 0x46
    : process.platform === 'darwin'
      ? hasMachOMagic(bytes)
      : process.platform === 'win32'
        ? bytes.byteLength >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a
        : false;
  if (!native) {
    fail(
      'trusted_executable_file_unsafe',
      'P0 bootstrap accepts only native executables; script interpreters and shims require a separate frozen artifact identity.',
    );
  }
}

function hasMachOMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const magic = (
    (bytes[0]! << 24)
    | (bytes[1]! << 16)
    | (bytes[2]! << 8)
    | bytes[3]!
  ) >>> 0;
  return magic === 0xfeedface
    || magic === 0xfeedfacf
    || magic === 0xcefaedfe
    || magic === 0xcffaedfe
    || magic === 0xcafebabe
    || magic === 0xbebafeca
    || magic === 0xcafebabf
    || magic === 0xbfbafeca;
}

function sameExecutableFile(
  left: ExecutableFileInspection,
  right: ExecutableFileInspection,
): boolean {
  return left.absoluteRealPath === right.absoluteRealPath
    && left.device === right.device
    && left.inode === right.inode
    && left.sizeBytes === right.sizeBytes
    && left.mode === right.mode
    && left.contentDigest === right.contentDigest
    && left.parentDevice === right.parentDevice
    && left.parentInode === right.parentInode;
}

function sameStat(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function supportedPlatform(): 'darwin' | 'linux' | 'win32' {
  if (process.platform === 'darwin'
    || process.platform === 'linux'
    || process.platform === 'win32') {
    return process.platform;
  }
  fail(
    'trusted_executable_invalid_input',
    `Unsupported executable platform: ${process.platform}.`,
  );
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function assertInspectionInput(
  input: InspectTrustedExecutableInputV1,
): void {
  if (!isRecord(input)
    || typeof input.executablePath !== 'string'
    || !Array.isArray(input.versionProbeArgs)
    || input.versionProbeArgs.length > 16
    || input.versionProbeArgs.some((argument) =>
      typeof argument !== 'string'
      || argument.includes('\0')
      || Buffer.byteLength(argument, 'utf8') > 4_096)
    || !Array.isArray(input.forbiddenRoots)
    || input.forbiddenRoots.length > 64
    || (input.timeoutMs !== undefined
      && (!Number.isSafeInteger(input.timeoutMs)
        || input.timeoutMs < 100
        || input.timeoutMs > 30_000))) {
    fail(
      'trusted_executable_invalid_input',
      'The trusted executable inspection input is invalid.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: TrustedExecutableErrorCode, message: string): never {
  throw new TrustedExecutableError(code, message);
}
