import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { canonicalDigest } from '@wukong/verification';

const require = createRequire(import.meta.url);
const PROBE_TIMEOUT_MS = 5_000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const ERROR_INVALID_PARAMETER = 87;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x0000_0102;

export type SupportedProcessLivenessPlatform =
  | 'darwin'
  | 'linux'
  | 'win32';
export type ProcessPresence = 'present' | 'absent' | 'unknown';
export type ProcessLivenessOutcome = 'live' | 'dead' | 'unknown';

export interface ProcessLivenessProofV1 {
  readonly schemaVersion: 1;
  readonly platform: SupportedProcessLivenessPlatform;
  readonly processId: number;
  readonly startMarkerDigest: string;
  readonly proofDigest: string;
}

export interface ProcessLivenessProbeDependencies {
  readonly platform?: NodeJS.Platform;
  readonly readStartMarker?: (
    processId: number,
  ) => Promise<string>;
  readonly processPresence?: (
    processId: number,
  ) => ProcessPresence;
}

interface WindowsProcessObservation {
  readonly presence: ProcessPresence;
  readonly startMarker?: string;
}

interface KoffiLibrary {
  func(
    convention: string,
    name: string,
    result: string,
    arguments_: readonly unknown[],
  ): (...args: readonly unknown[]) => unknown;
}

interface KoffiModule {
  load(path: string): KoffiLibrary;
  struct(
    definition: Readonly<Record<string, string>>,
  ): unknown;
  pointer(type: unknown): unknown;
  out(type: unknown): unknown;
}

interface WindowsProcessFunctions {
  readonly openProcess: (
    desiredAccess: number,
    inheritHandle: boolean,
    processId: number,
  ) => unknown;
  readonly getProcessTimes: (
    processHandle: unknown,
    creationTime: Record<string, unknown>,
    exitTime: Record<string, unknown>,
    kernelTime: Record<string, unknown>,
    userTime: Record<string, unknown>,
  ) => boolean;
  readonly waitForSingleObject: (
    processHandle: unknown,
    milliseconds: number,
  ) => number;
  readonly closeHandle: (
    processHandle: unknown,
  ) => boolean;
  readonly getLastError: () => number;
}

export class ProcessLivenessProofError extends Error {
  constructor(
    readonly reasonCode:
      | 'process_liveness_invalid_input'
      | 'process_liveness_unsupported'
      | 'process_liveness_unavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessLivenessProofError';
  }
}

export async function captureProcessLivenessProof(
  processId = process.pid,
  dependencies: ProcessLivenessProbeDependencies = {},
): Promise<ProcessLivenessProofV1> {
  const platform = supportedPlatform(
    dependencies.platform ?? process.platform,
  );
  if (!isProcessId(processId)) {
    throw new ProcessLivenessProofError(
      'process_liveness_invalid_input',
      'Process liveness proof input is invalid.',
    );
  }
  if (platform === 'win32'
    && dependencies.processPresence === undefined
    && dependencies.readStartMarker === undefined) {
    let observation: WindowsProcessObservation;
    try {
      observation = windowsProcessNative().observe(processId);
    } catch (error) {
      throw new ProcessLivenessProofError(
        'process_liveness_unavailable',
        'The Windows process liveness observation is unavailable.',
        { cause: error },
      );
    }
    if (observation.presence !== 'present'
      || observation.startMarker === undefined) {
      throw new ProcessLivenessProofError(
        'process_liveness_unavailable',
        'The process is not provably live.',
      );
    }
    return buildProcessLivenessProof(
      platform,
      processId,
      observation.startMarker,
    );
  }
  const presence = (dependencies.processPresence ?? processPresence)(
    processId,
  );
  if (presence !== 'present') {
    throw new ProcessLivenessProofError(
      'process_liveness_unavailable',
      'The process is not provably live.',
    );
  }
  let marker: string;
  try {
    marker = await (dependencies.readStartMarker
      ?? ((pid) => readDefaultStartMarker(pid, platform)))(processId);
  } catch (error) {
    throw new ProcessLivenessProofError(
      'process_liveness_unavailable',
      'The process start marker is unavailable.',
      { cause: error },
    );
  }
  if (marker.length === 0) {
    throw new ProcessLivenessProofError(
      'process_liveness_unavailable',
      'The process start marker is empty.',
    );
  }
  return buildProcessLivenessProof(platform, processId, marker);
}

function buildProcessLivenessProof(
  platform: SupportedProcessLivenessPlatform,
  processId: number,
  marker: string,
): ProcessLivenessProofV1 {
  const core = {
    schemaVersion: 1 as const,
    platform,
    processId,
    startMarkerDigest: canonicalDigest(
      'wukong/process-start-marker/v1',
      marker,
    ),
  };
  return Object.freeze({
    ...core,
    proofDigest: canonicalDigest(
      'wukong/process-liveness-proof/v1',
      core,
    ),
  });
}

export async function probeProcessLiveness(
  proof: ProcessLivenessProofV1,
  dependencies: ProcessLivenessProbeDependencies = {},
): Promise<ProcessLivenessOutcome> {
  if (!validateProcessLivenessProof(proof)) {
    throw new ProcessLivenessProofError(
      'process_liveness_invalid_input',
      'Process liveness proof is invalid.',
    );
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform !== proof.platform) return 'unknown';
  if (proof.platform === 'win32'
    && dependencies.processPresence === undefined
    && dependencies.readStartMarker === undefined) {
    let observation: WindowsProcessObservation;
    try {
      observation = windowsProcessNative().observe(
        proof.processId,
      );
    } catch {
      return 'unknown';
    }
    if (observation.presence === 'absent') return 'dead';
    if (observation.presence !== 'present'
      || observation.startMarker === undefined) {
      return 'unknown';
    }
    const observedDigest = canonicalDigest(
      'wukong/process-start-marker/v1',
      observation.startMarker,
    );
    return observedDigest === proof.startMarkerDigest
      ? 'live'
      : 'dead';
  }
  const checkPresence =
    dependencies.processPresence ?? processPresence;
  const before = checkPresence(proof.processId);
  if (before === 'absent') return 'dead';
  if (before === 'unknown') return 'unknown';
  let marker: string;
  try {
    marker = await (dependencies.readStartMarker
      ?? ((pid) => readDefaultStartMarker(pid, proof.platform)))(
      proof.processId,
    );
  } catch {
    const after = checkPresence(proof.processId);
    return after === 'absent' ? 'dead' : 'unknown';
  }
  const observedDigest = canonicalDigest(
    'wukong/process-start-marker/v1',
    marker,
  );
  return observedDigest === proof.startMarkerDigest
    ? 'live'
    : 'dead';
}

export function validateProcessLivenessProof(
  value: unknown,
): value is ProcessLivenessProofV1 {
  if (!isRecord(value)
    || Object.keys(value).toSorted().join(',') !== [
      'platform',
      'processId',
      'proofDigest',
      'schemaVersion',
      'startMarkerDigest',
    ].toSorted().join(',')
    || value['schemaVersion'] !== 1
    || (value['platform'] !== 'darwin'
      && value['platform'] !== 'linux'
      && value['platform'] !== 'win32')
    || !isProcessId(value['processId'])
    || !isDigest(value['startMarkerDigest'])
    || !isDigest(value['proofDigest'])) {
    return false;
  }
  const proof = value as unknown as ProcessLivenessProofV1;
  const { proofDigest, ...core } = proof;
  return canonicalDigest(
    'wukong/process-liveness-proof/v1',
    core,
  ) === proofDigest;
}

function supportedPlatform(
  platform: NodeJS.Platform,
): SupportedProcessLivenessPlatform {
  if (platform === 'darwin'
    || platform === 'linux'
    || platform === 'win32') {
    return platform;
  }
  throw new ProcessLivenessProofError(
    'process_liveness_unsupported',
    `Process liveness proof is unsupported on ${platform}.`,
  );
}

async function readDefaultStartMarker(
  processId: number,
  platform: SupportedProcessLivenessPlatform,
): Promise<string> {
  if (platform !== 'win32') {
    return readPosixStartMarker(processId, platform);
  }
  const observation = windowsProcessNative().observe(processId);
  if (observation.presence !== 'present'
    || observation.startMarker === undefined) {
    throw new Error(
      'The Windows process start marker is unavailable.',
    );
  }
  return observation.startMarker;
}

async function readPosixStartMarker(
  processId: number,
  platform: Exclude<SupportedProcessLivenessPlatform, 'win32'>,
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);
  const result = await execFileAsync(
    '/bin/ps',
    ['-p', String(processId), '-o', 'lstart='],
    {
      encoding: 'utf8',
      env: {
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
      maxBuffer: 16 * 1024,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const marker = result.stdout.trim().replaceAll(/\s+/gu, ' ');
  if (marker.length === 0) {
    throw new Error('The process start marker is empty.');
  }
  return `${platform}:${marker}`;
}

class WindowsProcessNative {
  private constructor(
    private readonly functions: WindowsProcessFunctions,
  ) {}

  static create(): WindowsProcessNative {
    if (process.platform !== 'win32') {
      throw new Error(
        'The Windows process liveness backend is unavailable on this platform.',
      );
    }
    const koffi = require('koffi') as KoffiModule;
    const kernel32 = koffi.load('kernel32.dll');
    const fileTime = koffi.struct({
      dwLowDateTime: 'uint32_t',
      dwHighDateTime: 'uint32_t',
    });
    const outFileTime = koffi.out(koffi.pointer(fileTime));
    const asFunction = (
      name: string,
      result: string,
      arguments_: readonly unknown[],
    ): ((...args: readonly unknown[]) => unknown) =>
      kernel32.func('__stdcall', name, result, arguments_);
    const functions: WindowsProcessFunctions = {
      openProcess: asFunction(
        'OpenProcess',
        'void *',
        ['uint32_t', 'bool', 'uint32_t'],
      ) as WindowsProcessFunctions['openProcess'],
      getProcessTimes: asFunction(
        'GetProcessTimes',
        'bool',
        [
          'void *',
          outFileTime,
          outFileTime,
          outFileTime,
          outFileTime,
        ],
      ) as WindowsProcessFunctions['getProcessTimes'],
      waitForSingleObject: asFunction(
        'WaitForSingleObject',
        'uint32_t',
        ['void *', 'uint32_t'],
      ) as WindowsProcessFunctions['waitForSingleObject'],
      closeHandle: asFunction(
        'CloseHandle',
        'bool',
        ['void *'],
      ) as WindowsProcessFunctions['closeHandle'],
      getLastError: asFunction(
        'GetLastError',
        'uint32_t',
        [],
      ) as WindowsProcessFunctions['getLastError'],
    };
    return new WindowsProcessNative(functions);
  }

  observe(processId: number): WindowsProcessObservation {
    const handle = this.functions.openProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      false,
      processId,
    );
    if (handle === null) {
      return this.functions.getLastError() === ERROR_INVALID_PARAMETER
        ? { presence: 'absent' }
        : { presence: 'unknown' };
    }
    let observation: WindowsProcessObservation;
    try {
      const before = this.functions.waitForSingleObject(handle, 0);
      if (before === WAIT_OBJECT_0) {
        observation = { presence: 'absent' };
      } else if (before !== WAIT_TIMEOUT) {
        observation = { presence: 'unknown' };
      } else {
        const creationTime: Record<string, unknown> = {};
        const exitTime: Record<string, unknown> = {};
        const kernelTime: Record<string, unknown> = {};
        const userTime: Record<string, unknown> = {};
        const read = this.functions.getProcessTimes(
          handle,
          creationTime,
          exitTime,
          kernelTime,
          userTime,
        );
        const after = this.functions.waitForSingleObject(handle, 0);
        const marker = read
          ? fileTimeMarker(creationTime)
          : null;
        observation = after === WAIT_OBJECT_0
          ? { presence: 'absent' }
          : after !== WAIT_TIMEOUT || marker === null
            ? { presence: 'unknown' }
            : {
                presence: 'present',
                startMarker: `win32:${marker}`,
              };
      }
    } catch {
      observation = { presence: 'unknown' };
    }
    try {
      if (!this.functions.closeHandle(handle)) {
        return { presence: 'unknown' };
      }
    } catch {
      return { presence: 'unknown' };
    }
    return observation;
  }
}

let cachedWindowsProcessNative: WindowsProcessNative | undefined;

function windowsProcessNative(): WindowsProcessNative {
  cachedWindowsProcessNative ??= WindowsProcessNative.create();
  return cachedWindowsProcessNative;
}

function fileTimeMarker(
  value: Readonly<Record<string, unknown>>,
): string | null {
  const low = value['dwLowDateTime'];
  const high = value['dwHighDateTime'];
  if (!isUint32(low) || !isUint32(high)) return null;
  return `${high.toString(16).padStart(8, '0')}${
    low.toString(16).padStart(8, '0')
  }`;
}

function processPresence(processId: number): ProcessPresence {
  try {
    process.kill(processId, 0);
    return 'present';
  } catch (error) {
    if (isNodeError(error, 'ESRCH')) return 'absent';
    return 'unknown';
  }
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 0xffff_ffff;
}

function isProcessId(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code;
}
