import { canonicalDigest } from './finish-line';

export interface TrustedExecutableIdentityV1 {
  readonly schemaVersion: 1;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly architecture: string;
  readonly realPathDigest: string;
  readonly device: string;
  readonly inode: string;
  readonly sizeBytes: number;
  readonly mode: number;
  readonly contentDigest: string;
  readonly runtimeVersionDigest: string;
  readonly executableIdentityDigest: string;
}

export interface CreateTrustedExecutableIdentityInputV1 {
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly architecture: string;
  readonly realPathDigest: string;
  readonly device: string;
  readonly inode: string;
  readonly sizeBytes: number;
  readonly mode: number;
  readonly contentDigest: string;
  readonly runtimeVersionDigest: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARCHITECTURE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const KEYS = [
  'schemaVersion',
  'platform',
  'architecture',
  'realPathDigest',
  'device',
  'inode',
  'sizeBytes',
  'mode',
  'contentDigest',
  'runtimeVersionDigest',
  'executableIdentityDigest',
] as const;

export function createTrustedExecutableIdentity(
  input: CreateTrustedExecutableIdentityInputV1,
): TrustedExecutableIdentityV1 {
  const core = {
    schemaVersion: 1 as const,
    platform: input.platform,
    architecture: input.architecture,
    realPathDigest: input.realPathDigest,
    device: input.device,
    inode: input.inode,
    sizeBytes: input.sizeBytes,
    mode: input.mode,
    contentDigest: input.contentDigest,
    runtimeVersionDigest: input.runtimeVersionDigest,
  };
  const identity = Object.freeze({
    ...core,
    executableIdentityDigest: canonicalDigest(
      'wukong/trusted-executable-identity/v1',
      core,
    ),
  });
  if (!validateTrustedExecutableIdentity(identity)) {
    throw new TypeError('The trusted executable identity is invalid.');
  }
  return identity;
}

export function validateTrustedExecutableIdentity(
  value: unknown,
): value is TrustedExecutableIdentityV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, KEYS)
    || value['schemaVersion'] !== 1
    || (value['platform'] !== 'darwin'
      && value['platform'] !== 'linux'
      && value['platform'] !== 'win32')
    || typeof value['architecture'] !== 'string'
    || !ARCHITECTURE.test(value['architecture'])
    || !isDigest(value['realPathDigest'])
    || typeof value['device'] !== 'string'
    || !UNSIGNED_INTEGER.test(value['device'])
    || typeof value['inode'] !== 'string'
    || !UNSIGNED_INTEGER.test(value['inode'])
    || typeof value['sizeBytes'] !== 'number'
    || !Number.isSafeInteger(value['sizeBytes'])
    || value['sizeBytes'] <= 0
    || typeof value['mode'] !== 'number'
    || !Number.isSafeInteger(value['mode'])
    || value['mode'] < 0
    || value['mode'] > 0o177777
    || !isDigest(value['contentDigest'])
    || !isDigest(value['runtimeVersionDigest'])
    || !isDigest(value['executableIdentityDigest'])) {
    return false;
  }
  const { executableIdentityDigest, ...core } =
    value as unknown as TrustedExecutableIdentityV1;
  return canonicalDigest('wukong/trusted-executable-identity/v1', core)
    === executableIdentityDigest;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
