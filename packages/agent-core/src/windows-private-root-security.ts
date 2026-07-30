import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

import { canonicalDigest } from '@wukong/verification';

const require = createRequire(import.meta.url);

export type WindowsPrivateRootSecurityBackendCapabilityV1 =
  | Readonly<{
      available: true;
      platform: 'win32';
      backend: 'windows-protected-owner-dacl-v1';
      reasonCode: null;
    }>
  | Readonly<{
      available: false;
      platform: NodeJS.Platform;
      backend: null;
      reasonCode:
        | 'windows_private_root_platform_unsupported'
        | 'windows_private_root_native_unavailable';
    }>;

export interface WindowsPrivateRootSecurityProbeDependenciesV1 {
  readonly platform?: NodeJS.Platform;
  /**
   * Read-only test injection. Product callers resolve the exact Windows
   * security descriptor inspection primitive set.
   */
  readonly resolveNative?: () => void;
}

export interface WindowsPrivateRootSecurityObservationV1 {
  readonly openedHandleRelative: true;
  readonly finalPathMatches: true;
  readonly fileType: 'directory';
  readonly reparsePoint: false;
  readonly ownerSidMatchesCurrentUser: true;
  readonly daclPresent: true;
  readonly daclNull: false;
  readonly daclProtected: true;
  readonly allowedPrincipals:
    readonly ['CURRENT_USER', 'LOCAL_SYSTEM'];
  readonly inheritableToChildren: true;
}

export interface WindowsPrivateRootSddlInputV1 {
  readonly sddl: string;
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly daclPresent: boolean;
}

interface KoffiLibrary {
  func(
    definition: string,
  ): (...args: readonly unknown[]) => unknown;
  func(
    convention: string,
    name: string,
    result: string,
    arguments_: readonly unknown[],
  ): (...args: readonly unknown[]) => unknown;
}

interface KoffiModule {
  load(path: string): KoffiLibrary;
  out(type: unknown): unknown;
  pointer(type: unknown, depth?: number): unknown;
  decode(value: unknown, type: unknown): unknown;
  address(value: unknown): bigint;
}

interface WindowsPrivateRootFunctions {
  readonly createFile: (
    path: string,
    desiredAccess: number,
    shareAccess: number,
    securityAttributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ) => unknown;
  readonly closeHandle: (handle: unknown) => number;
  readonly getLastError: () => number;
  readonly getFinalPathName: (
    handle: unknown,
    output: Buffer,
    outputCharacters: number,
    flags: number,
  ) => number;
  readonly getFileInformation: (
    handle: unknown,
    informationClass: number,
    output: Buffer,
    outputBytes: number,
  ) => number;
  readonly getSecurityInfo: (
    handle: unknown,
    objectType: number,
    securityInformation: number,
    ownerSid: unknown[],
    groupSid: null,
    dacl: unknown[],
    sacl: null,
    descriptor: unknown[],
  ) => number;
  readonly setSecurityInfo: (
    handle: unknown,
    objectType: number,
    securityInformation: number,
    ownerSid: null,
    groupSid: null,
    dacl: unknown,
    sacl: null,
  ) => number;
  readonly descriptorFromString: (
    sddl: string,
    revision: number,
    descriptor: unknown[],
    descriptorBytes: unknown[],
  ) => number;
  readonly descriptorDacl: (
    descriptor: unknown,
    present: unknown[],
    dacl: unknown[],
    defaulted: unknown[],
  ) => number;
  readonly descriptorToString: (
    descriptor: unknown,
    revision: number,
    securityInformation: number,
    output: unknown[],
    outputCharacters: unknown[],
  ) => number;
  readonly openProcessToken: (
    process: unknown,
    desiredAccess: number,
    outputToken: unknown[],
  ) => number;
  readonly getCurrentProcess: () => unknown;
  readonly getTokenInformation: (
    token: unknown,
    informationClass: number,
    output: Buffer | null,
    outputBytes: number,
    requiredBytes: unknown[],
  ) => number;
  readonly sidToString: (
    sid: unknown,
    output: unknown[],
  ) => number;
  readonly localFree: (value: unknown) => unknown;
}

const WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const WINDOWS_READ_CONTROL = 0x0002_0000;
const WINDOWS_WRITE_DAC = 0x0004_0000;
const WINDOWS_SYNCHRONIZE = 0x0010_0000;
const WINDOWS_SHARE_ALL = 0x0000_0007;
const WINDOWS_OPEN_EXISTING = 3;
const WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const WINDOWS_FILE_ATTRIBUTE_TAG_INFO = 9;
const WINDOWS_SE_FILE_OBJECT = 1;
const WINDOWS_OWNER_SECURITY_INFORMATION = 0x0000_0001;
const WINDOWS_DACL_SECURITY_INFORMATION = 0x0000_0004;
const WINDOWS_PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const WINDOWS_SDDL_REVISION_1 = 1;
const WINDOWS_TOKEN_QUERY = 0x0000_0008;
const WINDOWS_TOKEN_USER = 1;

const proofPathDigests = new WeakMap<
  WindowsPrivateRootSecurityProofV1,
  string
>();
const PROOF_AUTHORITY = Symbol('windows-private-root-security-proof');

/**
 * Opaque attestation issued only after a handle-relative Windows directory
 * observation proves an exact owner-only protected DACL.
 */
export class WindowsPrivateRootSecurityProofV1 {
  private constructor(
    rootPathDigest: string,
    authority: symbol,
  ) {
    if (authority !== PROOF_AUTHORITY) {
      throw new TypeError(
        'The Windows private root security proof is invalid.',
      );
    }
    proofPathDigests.set(this, rootPathDigest);
    Object.freeze(this);
  }

  static create(
    rootPathDigest: string,
    authority: symbol,
  ): WindowsPrivateRootSecurityProofV1 {
    return new WindowsPrivateRootSecurityProofV1(
      rootPathDigest,
      authority,
    );
  }

  toJSON(): Record<string, string> {
    return {
      schemaVersion: 'windows-private-root-security-proof-v1',
      rootPath: '[REDACTED]',
    };
  }
}

/**
 * Resolves only native symbols. It must not create, chmod, open, or otherwise
 * mutate a durable path, so an unavailable Windows backend remains zero-write.
 */
export function inspectWindowsPrivateRootSecurityBackendCapability(
  dependencies: WindowsPrivateRootSecurityProbeDependenciesV1 = {},
): WindowsPrivateRootSecurityBackendCapabilityV1 {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    return Object.freeze({
      available: false,
      platform,
      backend: null,
      reasonCode: 'windows_private_root_platform_unsupported',
    });
  }
  try {
    (
      dependencies.resolveNative
      ?? resolveWindowsPrivateRootSecurityNative
    )();
  } catch {
    return Object.freeze({
      available: false,
      platform,
      backend: null,
      reasonCode: 'windows_private_root_native_unavailable',
    });
  }
  return Object.freeze({
    available: true,
    platform,
    backend: 'windows-protected-owner-dacl-v1',
    reasonCode: null,
  });
}

export function attestWindowsPrivateRootSecurity(
  rootDirectory: string,
  observation: WindowsPrivateRootSecurityObservationV1,
): WindowsPrivateRootSecurityProofV1 {
  if (!isAbsolute(rootDirectory)
    || resolve(rootDirectory) !== rootDirectory
    || !isExactPrivateRootObservation(observation)) {
    throw new TypeError(
      'The Windows private root security observation is invalid.',
    );
  }
  return WindowsPrivateRootSecurityProofV1.create(
    privateRootPathDigest(rootDirectory),
    PROOF_AUTHORITY,
  );
}

export function assertWindowsPrivateRootSecurityProof(
  proof: WindowsPrivateRootSecurityProofV1,
  rootDirectory: string,
): void {
  if (!isAbsolute(rootDirectory)
    || resolve(rootDirectory) !== rootDirectory
    || proofPathDigests.get(proof)
      !== privateRootPathDigest(rootDirectory)) {
    throw new TypeError(
      'The Windows private root security proof does not bind this root.',
    );
  }
}

/**
 * Validates the exact protected private-root descriptor emitted by the
 * Windows backend. Only the current user and LocalSystem may receive
 * inheritable full access; deny, inherited, object-specific, and extra ACEs
 * fail closed.
 */
export function assertExactWindowsPrivateRootSddl(
  input: WindowsPrivateRootSddlInputV1,
): void {
  const { sddl, currentUserSid, ownerSid, daclPresent } = input;
  if (!daclPresent
    || !isSid(currentUserSid)
    || ownerSid !== currentUserSid
    || typeof sddl !== 'string'
    || sddl === '') {
    return invalidPrivateRootSddl();
  }
  const owner = sectionValue(sddl, 'O');
  const dacl = sectionValue(sddl, 'D');
  if (owner !== currentUserSid || dacl === null) {
    return invalidPrivateRootSddl();
  }
  const firstAce = dacl.indexOf('(');
  const flags = firstAce === -1 ? dacl : dacl.slice(0, firstAce);
  const aceText = firstAce === -1 ? '' : dacl.slice(firstAce);
  if (flags !== 'P' && flags !== 'PAI') {
    return invalidPrivateRootSddl();
  }
  const matches = [...aceText.matchAll(/\(([^()]*)\)/gu)];
  if (matches.length !== 2
    || matches.map((match) => match[0]).join('') !== aceText) {
    return invalidPrivateRootSddl();
  }
  const principals = new Set<string>();
  for (const match of matches) {
    const fields = match[1]?.split(';') ?? [];
    if (fields.length !== 6
      || fields[0] !== 'A'
      || !hasExactInheritanceFlags(fields[1] ?? '')
      || !isFullAccess(fields[2] ?? '')
      || fields[3] !== ''
      || fields[4] !== '') {
      return invalidPrivateRootSddl();
    }
    const principal = normalizePrincipal(fields[5] ?? '');
    if (principal !== currentUserSid
      && principal !== 'S-1-5-18') {
      return invalidPrivateRootSddl();
    }
    principals.add(principal);
  }
  if (principals.size !== 2
    || !principals.has(currentUserSid)
    || !principals.has('S-1-5-18')) {
    return invalidPrivateRootSddl();
  }
}

/**
 * Applies and re-attests the exact private-root DACL on an existing directory.
 * Callers must invoke this after directory creation and before writing private
 * state. The handle is opened with OPEN_REPARSE_POINT and its final path is
 * verified before the ACL is changed.
 */
export function protectWindowsPrivateRootSecurity(
  rootDirectory: string,
): WindowsPrivateRootSecurityProofV1 {
  if (process.platform !== 'win32') {
    throw new TypeError(
      'The Windows private root security backend is unavailable.',
    );
  }
  const requestedRoot = resolve(rootDirectory);
  if (!isAbsolute(rootDirectory) || requestedRoot !== rootDirectory) {
    throw new TypeError(
      'The Windows private root path is invalid.',
    );
  }
  const canonicalRoot = realpathSync.native(requestedRoot);
  const { koffi, functions } = loadWindowsPrivateRootNative();
  const handle = functions.createFile(
    canonicalRoot,
    WINDOWS_READ_CONTROL
      | WINDOWS_WRITE_DAC
      | WINDOWS_SYNCHRONIZE,
    WINDOWS_SHARE_ALL,
    null,
    WINDOWS_OPEN_EXISTING,
    WINDOWS_FILE_FLAG_BACKUP_SEMANTICS
      | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  if (isInvalidHandle(koffi, handle)) {
    return windowsNativeFailure(
      'CreateFileW',
      functions.getLastError(),
    );
  }
  try {
    assertExactRootHandle(
      functions,
      handle,
      canonicalRoot,
    );
    const currentUserSid = readCurrentUserSid(
      koffi,
      functions,
    );
    applyPrivateRootDacl(
      functions,
      handle,
      currentUserSid,
    );
    return attestRootHandle(
      koffi,
      functions,
      handle,
      canonicalRoot,
      currentUserSid,
    );
  } finally {
    functions.closeHandle(handle);
  }
}

/**
 * Re-opens and validates a Windows private root without changing its ACL.
 */
export function attestWindowsPrivateRootPathSecurity(
  rootDirectory: string,
): WindowsPrivateRootSecurityProofV1 {
  if (process.platform !== 'win32') {
    throw new TypeError(
      'The Windows private root security backend is unavailable.',
    );
  }
  const requestedRoot = resolve(rootDirectory);
  if (!isAbsolute(rootDirectory) || requestedRoot !== rootDirectory) {
    throw new TypeError(
      'The Windows private root path is invalid.',
    );
  }
  const canonicalRoot = realpathSync.native(requestedRoot);
  const { koffi, functions } = loadWindowsPrivateRootNative();
  const handle = functions.createFile(
    canonicalRoot,
    WINDOWS_READ_CONTROL | WINDOWS_SYNCHRONIZE,
    WINDOWS_SHARE_ALL,
    null,
    WINDOWS_OPEN_EXISTING,
    WINDOWS_FILE_FLAG_BACKUP_SEMANTICS
      | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  if (isInvalidHandle(koffi, handle)) {
    return windowsNativeFailure(
      'CreateFileW',
      functions.getLastError(),
    );
  }
  try {
    assertExactRootHandle(
      functions,
      handle,
      canonicalRoot,
    );
    return attestRootHandle(
      koffi,
      functions,
      handle,
      canonicalRoot,
      readCurrentUserSid(koffi, functions),
    );
  } finally {
    functions.closeHandle(handle);
  }
}

/**
 * Validates a private root through an already-open Windows HANDLE without
 * taking ownership of that handle. This keeps the security proof bound to the
 * same non-reparse directory capability used by a handle-relative backend.
 */
export function attestWindowsPrivateRootHandleSecurity(
  handleAddress: bigint,
  rootDirectory: string,
): WindowsPrivateRootSecurityProofV1 {
  if (process.platform !== 'win32') {
    throw new TypeError(
      'The Windows private root security backend is unavailable.',
    );
  }
  const requestedRoot = resolve(rootDirectory);
  if (!isAbsolute(rootDirectory)
    || requestedRoot !== rootDirectory
    || handleAddress <= 0n) {
    throw new TypeError(
      'The Windows private root handle or path is invalid.',
    );
  }
  const canonicalRoot = realpathSync.native(requestedRoot);
  const { koffi, functions } = loadWindowsPrivateRootNative();
  if (isInvalidHandle(koffi, handleAddress)) {
    throw new TypeError(
      'The Windows private root handle is invalid.',
    );
  }
  assertExactRootHandle(
    functions,
    handleAddress,
    canonicalRoot,
  );
  return attestRootHandle(
    koffi,
    functions,
    handleAddress,
    canonicalRoot,
    readCurrentUserSid(koffi, functions),
  );
}

function resolveWindowsPrivateRootSecurityNative(): void {
  if (process.platform !== 'win32') {
    throw new TypeError(
      'The Windows private root security backend is unavailable.',
    );
  }
  const koffi = require('koffi') as KoffiModule;
  const advapi32 = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const outPointer = koffi.out(koffi.pointer('void *'));
  const definitions = [
    [
      advapi32,
      'ConvertStringSecurityDescriptorToSecurityDescriptorW',
      'bool',
      ['str16', 'uint32_t', outPointer, koffi.out(koffi.pointer('uint32_t'))],
    ],
    [
      advapi32,
      'ConvertSecurityDescriptorToStringSecurityDescriptorW',
      'bool',
      [
        'void *',
        'uint32_t',
        'uint32_t',
        outPointer,
        koffi.out(koffi.pointer('uint32_t')),
      ],
    ],
    [
      advapi32,
      'GetSecurityInfo',
      'uint32_t',
      [
        'void *',
        'uint32_t',
        'uint32_t',
        outPointer,
        outPointer,
        outPointer,
        outPointer,
        outPointer,
      ],
    ],
    [
      advapi32,
      'SetSecurityInfo',
      'uint32_t',
      [
        'void *',
        'uint32_t',
        'uint32_t',
        'void *',
        'void *',
        'void *',
        'void *',
      ],
    ],
    [
      advapi32,
      'GetSecurityDescriptorDacl',
      'bool',
      [
        'void *',
        koffi.out(koffi.pointer('int')),
        outPointer,
        koffi.out(koffi.pointer('int')),
      ],
    ],
    [
      advapi32,
      'GetSecurityDescriptorControl',
      'bool',
      [
        'void *',
        koffi.out(koffi.pointer('uint16_t')),
        koffi.out(koffi.pointer('uint32_t')),
      ],
    ],
    [
      advapi32,
      'OpenProcessToken',
      'bool',
      ['void *', 'uint32_t', outPointer],
    ],
    [
      advapi32,
      'GetTokenInformation',
      'bool',
      ['void *', 'uint32_t', 'void *', 'uint32_t', koffi.out(
        koffi.pointer('uint32_t'),
      )],
    ],
    [
      advapi32,
      'ConvertSidToStringSidW',
      'bool',
      ['void *', outPointer],
    ],
    [
      kernel32,
      'GetCurrentProcess',
      'void *',
      [],
    ],
    [
      kernel32,
      'LocalFree',
      'void *',
      ['void *'],
    ],
    [
      kernel32,
      'CloseHandle',
      'bool',
      ['void *'],
    ],
    [
      kernel32,
      'CreateFileW',
      'void *',
      [
        'str16',
        'uint32_t',
        'uint32_t',
        'void *',
        'uint32_t',
        'uint32_t',
        'void *',
      ],
    ],
    [
      kernel32,
      'GetFinalPathNameByHandleW',
      'uint32_t',
      ['void *', 'uint16_t *', 'uint32_t', 'uint32_t'],
    ],
    [
      kernel32,
      'GetFileInformationByHandleEx',
      'bool',
      ['void *', 'int', 'void *', 'uint32_t'],
    ],
    [
      kernel32,
      'GetLastError',
      'uint32_t',
      [],
    ],
  ] as const;
  for (const [library, name, result, arguments_] of definitions) {
    if (typeof library.func(
      '__stdcall',
      name,
      result,
      arguments_,
    ) !== 'function') {
      throw new TypeError(
        `The required Windows security function ${name} is unavailable.`,
      );
    }
  }
}

function loadWindowsPrivateRootNative(): {
  readonly koffi: KoffiModule;
  readonly functions: WindowsPrivateRootFunctions;
} {
  const koffi = require('koffi') as KoffiModule;
  const advapi32 = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const functions: WindowsPrivateRootFunctions = {
    createFile: kernel32.func(
      'void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)',
    ) as WindowsPrivateRootFunctions['createFile'],
    closeHandle: kernel32.func(
      'int __stdcall CloseHandle(void *)',
    ) as WindowsPrivateRootFunctions['closeHandle'],
    getLastError: kernel32.func(
      'uint32_t __stdcall GetLastError()',
    ) as WindowsPrivateRootFunctions['getLastError'],
    getFinalPathName: kernel32.func(
      'uint32_t __stdcall GetFinalPathNameByHandleW(void *, uint16_t *, uint32_t, uint32_t)',
    ) as WindowsPrivateRootFunctions['getFinalPathName'],
    getFileInformation: kernel32.func(
      'int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)',
    ) as WindowsPrivateRootFunctions['getFileInformation'],
    getSecurityInfo: advapi32.func(
      'uint32_t __stdcall GetSecurityInfo(void *, uint32_t, uint32_t, _Out_ void **, void **, _Out_ void **, void **, _Out_ void **)',
    ) as WindowsPrivateRootFunctions['getSecurityInfo'],
    setSecurityInfo: advapi32.func(
      'uint32_t __stdcall SetSecurityInfo(void *, uint32_t, uint32_t, void *, void *, void *, void *)',
    ) as WindowsPrivateRootFunctions['setSecurityInfo'],
    descriptorFromString: advapi32.func(
      'int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, _Out_ void **, _Out_ uint32_t *)',
    ) as WindowsPrivateRootFunctions['descriptorFromString'],
    descriptorDacl: advapi32.func(
      'int __stdcall GetSecurityDescriptorDacl(void *, _Out_ int *, _Out_ void **, _Out_ int *)',
    ) as WindowsPrivateRootFunctions['descriptorDacl'],
    descriptorToString: advapi32.func(
      'int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *, uint32_t, uint32_t, _Out_ void **, _Out_ uint32_t *)',
    ) as WindowsPrivateRootFunctions['descriptorToString'],
    openProcessToken: advapi32.func(
      'int __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)',
    ) as WindowsPrivateRootFunctions['openProcessToken'],
    getCurrentProcess: kernel32.func(
      'void * __stdcall GetCurrentProcess()',
    ) as WindowsPrivateRootFunctions['getCurrentProcess'],
    getTokenInformation: advapi32.func(
      'int __stdcall GetTokenInformation(void *, uint32_t, void *, uint32_t, _Out_ uint32_t *)',
    ) as WindowsPrivateRootFunctions['getTokenInformation'],
    sidToString: advapi32.func(
      'int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)',
    ) as WindowsPrivateRootFunctions['sidToString'],
    localFree: kernel32.func(
      'void * __stdcall LocalFree(void *)',
    ) as WindowsPrivateRootFunctions['localFree'],
  };
  for (const [name, value] of Object.entries(functions)) {
    if (typeof value !== 'function') {
      throw new TypeError(
        `The required Windows security function ${name} is unavailable.`,
      );
    }
  }
  return { koffi, functions };
}

function assertExactRootHandle(
  functions: WindowsPrivateRootFunctions,
  handle: unknown,
  canonicalRoot: string,
): void {
  const attributes = Buffer.alloc(8);
  if (functions.getFileInformation(
    handle,
    WINDOWS_FILE_ATTRIBUTE_TAG_INFO,
    attributes,
    attributes.byteLength,
  ) === 0) {
    return windowsNativeFailure(
      'GetFileInformationByHandleEx',
      functions.getLastError(),
    );
  }
  const value = attributes.readUInt32LE(0);
  if ((value & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) === 0
    || (value & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    throw new TypeError(
      'The Windows private root is not a non-reparse directory.',
    );
  }
  const output = Buffer.alloc(65_536);
  const characters = functions.getFinalPathName(
    handle,
    output,
    output.byteLength / 2,
    0,
  );
  if (characters <= 0
    || characters >= output.byteLength / 2) {
    return windowsNativeFailure(
      'GetFinalPathNameByHandleW',
      functions.getLastError(),
    );
  }
  const finalPath = output.toString(
    'utf16le',
    0,
    characters * 2,
  );
  if (normalizeWindowsPath(finalPath)
    !== normalizeWindowsPath(canonicalRoot)) {
    throw new TypeError(
      'The Windows private root final path changed.',
    );
  }
}

function applyPrivateRootDacl(
  functions: WindowsPrivateRootFunctions,
  handle: unknown,
  currentUserSid: string,
): void {
  const descriptor: unknown[] = [null];
  const descriptorBytes: unknown[] = [0];
  const sddl = `D:P(A;OICI;FA;;;${currentUserSid})`
    + '(A;OICI;FA;;;SY)';
  if (functions.descriptorFromString(
    sddl,
    WINDOWS_SDDL_REVISION_1,
    descriptor,
    descriptorBytes,
  ) === 0) {
    return windowsNativeFailure(
      'ConvertStringSecurityDescriptorToSecurityDescriptorW',
      functions.getLastError(),
    );
  }
  const descriptorValue = descriptor[0];
  try {
    const present: unknown[] = [0];
    const dacl: unknown[] = [null];
    const defaulted: unknown[] = [0];
    if (functions.descriptorDacl(
      descriptorValue,
      present,
      dacl,
      defaulted,
    ) === 0
      || Number(present[0]) !== 1
      || dacl[0] === null
      || dacl[0] === undefined) {
      throw new TypeError(
        'The generated Windows private root DACL is invalid.',
      );
    }
    const result = functions.setSecurityInfo(
      handle,
      WINDOWS_SE_FILE_OBJECT,
      WINDOWS_DACL_SECURITY_INFORMATION
        | WINDOWS_PROTECTED_DACL_SECURITY_INFORMATION,
      null,
      null,
      dacl[0],
      null,
    );
    if (result !== 0) {
      return windowsNativeFailure('SetSecurityInfo', result);
    }
  } finally {
    if (descriptorValue !== null
      && descriptorValue !== undefined) {
      functions.localFree(descriptorValue);
    }
  }
}

function attestRootHandle(
  koffi: KoffiModule,
  functions: WindowsPrivateRootFunctions,
  handle: unknown,
  canonicalRoot: string,
  currentUserSid: string,
): WindowsPrivateRootSecurityProofV1 {
  const ownerSid: unknown[] = [null];
  const dacl: unknown[] = [null];
  const descriptor: unknown[] = [null];
  const result = functions.getSecurityInfo(
    handle,
    WINDOWS_SE_FILE_OBJECT,
    WINDOWS_OWNER_SECURITY_INFORMATION
      | WINDOWS_DACL_SECURITY_INFORMATION,
    ownerSid,
    null,
    dacl,
    null,
    descriptor,
  );
  if (result !== 0) {
    return windowsNativeFailure('GetSecurityInfo', result);
  }
  const descriptorValue = descriptor[0];
  try {
    assertExactWindowsPrivateRootSddl({
      sddl: readDescriptorSddl(
        koffi,
        functions,
        descriptorValue,
      ),
      currentUserSid,
      ownerSid: readSidString(
        koffi,
        functions,
        ownerSid[0],
      ),
      daclPresent: dacl[0] !== null
        && dacl[0] !== undefined,
    });
    return attestWindowsPrivateRootSecurity(
      canonicalRoot,
      {
        openedHandleRelative: true,
        finalPathMatches: true,
        fileType: 'directory',
        reparsePoint: false,
        ownerSidMatchesCurrentUser: true,
        daclPresent: true,
        daclNull: false,
        daclProtected: true,
        allowedPrincipals: [
          'CURRENT_USER',
          'LOCAL_SYSTEM',
        ],
        inheritableToChildren: true,
      },
    );
  } finally {
    if (descriptorValue !== null
      && descriptorValue !== undefined) {
      functions.localFree(descriptorValue);
    }
  }
}

function readCurrentUserSid(
  koffi: KoffiModule,
  functions: WindowsPrivateRootFunctions,
): string {
  const token: unknown[] = [null];
  if (functions.openProcessToken(
    functions.getCurrentProcess(),
    WINDOWS_TOKEN_QUERY,
    token,
  ) === 0) {
    return windowsNativeFailure(
      'OpenProcessToken',
      functions.getLastError(),
    );
  }
  try {
    const required: unknown[] = [0];
    functions.getTokenInformation(
      token[0],
      WINDOWS_TOKEN_USER,
      null,
      0,
      required,
    );
    const requiredBytes = Number(required[0]);
    if (!Number.isSafeInteger(requiredBytes)
      || requiredBytes <= 0
      || requiredBytes > 64 * 1024) {
      throw new TypeError(
        'The Windows token user record size is invalid.',
      );
    }
    const output = Buffer.alloc(requiredBytes);
    if (functions.getTokenInformation(
      token[0],
      WINDOWS_TOKEN_USER,
      output,
      output.byteLength,
      required,
    ) === 0) {
      return windowsNativeFailure(
        'GetTokenInformation',
        functions.getLastError(),
      );
    }
    return readSidString(
      koffi,
      functions,
      koffi.decode(output, 'void *'),
    );
  } finally {
    if (token[0] !== null && token[0] !== undefined) {
      functions.closeHandle(token[0]);
    }
  }
}

function readSidString(
  koffi: KoffiModule,
  functions: WindowsPrivateRootFunctions,
  sid: unknown,
): string {
  const output: unknown[] = [null];
  if (sid === null
    || sid === undefined
    || functions.sidToString(sid, output) === 0) {
    return windowsNativeFailure(
      'ConvertSidToStringSidW',
      functions.getLastError(),
    );
  }
  try {
    const value = koffi.decode(output[0], 'str16');
    if (typeof value !== 'string' || !isSid(value)) {
      throw new TypeError('The Windows SID is invalid.');
    }
    return value;
  } finally {
    if (output[0] !== null && output[0] !== undefined) {
      functions.localFree(output[0]);
    }
  }
}

function readDescriptorSddl(
  koffi: KoffiModule,
  functions: WindowsPrivateRootFunctions,
  descriptor: unknown,
): string {
  const output: unknown[] = [null];
  const characters: unknown[] = [0];
  if (functions.descriptorToString(
    descriptor,
    WINDOWS_SDDL_REVISION_1,
    WINDOWS_OWNER_SECURITY_INFORMATION
      | WINDOWS_DACL_SECURITY_INFORMATION,
    output,
    characters,
  ) === 0) {
    return windowsNativeFailure(
      'ConvertSecurityDescriptorToStringSecurityDescriptorW',
      functions.getLastError(),
    );
  }
  try {
    const value = koffi.decode(output[0], 'str16');
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(
        'The Windows private root SDDL is invalid.',
      );
    }
    return value;
  } finally {
    if (output[0] !== null && output[0] !== undefined) {
      functions.localFree(output[0]);
    }
  }
}

function isInvalidHandle(
  koffi: KoffiModule,
  handle: unknown,
): boolean {
  if (handle === null || handle === undefined) return true;
  try {
    const address = typeof handle === 'bigint'
      ? handle
      : koffi.address(handle);
    const invalid = process.arch === 'ia32'
      ? 0xffff_ffffn
      : 0xffff_ffff_ffff_ffffn;
    return address === 0n || address === invalid;
  } catch {
    return true;
  }
}

function normalizeWindowsPath(value: string): string {
  let normalized = value.replaceAll('/', '\\');
  if (normalized.startsWith('\\\\?\\UNC\\')) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }
  if (!/^[A-Za-z]:\\$/u.test(normalized)
    && !/^\\\\[^\\]+\\[^\\]+\\$/u.test(normalized)) {
    normalized = normalized.replace(/\\+$/u, '');
  }
  return normalized.toLowerCase();
}

function windowsNativeFailure(
  syscall: string,
  code: number,
): never {
  throw Object.assign(
    new TypeError(
      `The Windows private root ${syscall} operation failed.`,
    ),
    {
      code: `WIN32_${String(code)}`,
      errno: code,
      syscall,
    },
  );
}

function isExactPrivateRootObservation(
  value: unknown,
): value is WindowsPrivateRootSecurityObservationV1 {
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const exactKeys = [
    'openedHandleRelative',
    'finalPathMatches',
    'fileType',
    'reparsePoint',
    'ownerSidMatchesCurrentUser',
    'daclPresent',
    'daclNull',
    'daclProtected',
    'allowedPrincipals',
    'inheritableToChildren',
  ];
  return Object.keys(record).length === exactKeys.length
    && exactKeys.every((key) => key in record)
    && record['openedHandleRelative'] === true
    && record['finalPathMatches'] === true
    && record['fileType'] === 'directory'
    && record['reparsePoint'] === false
    && record['ownerSidMatchesCurrentUser'] === true
    && record['daclPresent'] === true
    && record['daclNull'] === false
    && record['daclProtected'] === true
    && Array.isArray(record['allowedPrincipals'])
    && record['allowedPrincipals'].length === 2
    && record['allowedPrincipals'][0] === 'CURRENT_USER'
    && record['allowedPrincipals'][1] === 'LOCAL_SYSTEM'
    && record['inheritableToChildren'] === true;
}

function privateRootPathDigest(path: string): string {
  return canonicalDigest(
    'wukong/windows-private-root-path/v1',
    path,
  );
}

function sectionValue(
  sddl: string,
  section: 'O' | 'D',
): string | null {
  const marker = `${section}:`;
  const start = sddl.indexOf(marker);
  if (start === -1) return null;
  const valueStart = start + marker.length;
  const remainder = sddl.slice(valueStart);
  const next = remainder.search(/[OGDS]:/u);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function isSid(value: string): boolean {
  return /^S-\d(?:-\d+)+$/u.test(value);
}

function normalizePrincipal(value: string): string {
  return value === 'SY' ? 'S-1-5-18' : value;
}

function hasExactInheritanceFlags(value: string): boolean {
  const flags = value.match(/[A-Z]{2}/gu);
  return flags !== null
    && flags.length === 2
    && new Set(flags).size === 2
    && flags.includes('OI')
    && flags.includes('CI')
    && flags.join('').length === value.length;
}

function isFullAccess(value: string): boolean {
  return value === 'FA'
    || value.toLowerCase() === '0x001f01ff';
}

function invalidPrivateRootSddl(): never {
  throw new TypeError(
    'The Windows private root security descriptor is invalid.',
  );
}
