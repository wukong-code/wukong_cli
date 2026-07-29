import { canonicalDigest } from './finish-line';

export const CANDIDATE_BOOTSTRAP_PREFLIGHT_POLICY_VERSION =
  'candidate-bootstrap-preflight/1';

export type CandidateBootstrapEcosystemV1 =
  | 'go'
  | 'node'
  | 'python'
  | 'rust';

export type CandidateBootstrapPreflightReasonCodeV1 =
  | 'candidate_bootstrap_not_required'
  | 'candidate_bootstrap_confirmation_required'
  | 'candidate_bootstrap_lockfile_required'
  | 'candidate_bootstrap_lockfile_ambiguous'
  | 'candidate_bootstrap_lockfile_unsupported'
  | 'candidate_bootstrap_manifest_invalid'
  | 'candidate_bootstrap_runtime_unavailable'
  | 'candidate_bootstrap_native_build_unsupported';

export interface CandidateBootstrapRecipeDefinitionV1 {
  readonly schemaVersion: 1;
  readonly ecosystem: CandidateBootstrapEcosystemV1;
  readonly recipeRef: string;
  readonly recipeVersion: string;
  readonly manifestName: string;
  readonly lockfileName: string;
  readonly executableName: string;
  readonly versionProbeArgv: readonly string[];
  readonly installArgv: readonly string[];
  readonly generatedPathScopes: readonly string[];
  readonly networkPolicy: 'explicit_once';
  readonly registryEndpoints: readonly string[];
  readonly lifecycleScripts: 'deny';
  readonly nativeBuildHooks: 'deny';
  readonly postInstallCommands: 'deny';
  readonly timeoutMs: number;
  readonly reservedGeneratedBytes: number;
  readonly reservedOutputBytes: number;
  readonly recipeDigest: string;
}

export interface CandidateBootstrapPreflightEntryV1 {
  readonly schemaVersion: 1;
  readonly ecosystem: CandidateBootstrapEcosystemV1;
  readonly ecosystemRef: string;
  readonly candidateRelativeCwd: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly lockfilePath: string | null;
  readonly lockfileDigest: string | null;
  readonly status: 'ready' | 'not_required' | 'unsupported';
  readonly reasonCode: CandidateBootstrapPreflightReasonCodeV1;
  readonly recipe: CandidateBootstrapRecipeDefinitionV1 | null;
  readonly entryDigest: string;
}

export interface CandidateBootstrapPreflightV1 {
  readonly schemaVersion: 1;
  readonly policyVersion:
    typeof CANDIDATE_BOOTSTRAP_PREFLIGHT_POLICY_VERSION;
  readonly sourceSnapshotDigest: string;
  readonly gatePlanDigest: string;
  readonly entries: readonly CandidateBootstrapPreflightEntryV1[];
  readonly status: 'ready' | 'not_required' | 'unsupported';
  readonly reasonCode: CandidateBootstrapPreflightReasonCodeV1;
  readonly requiresExplicitNetworkConsent: boolean;
  readonly preflightDigest: string;
}

export interface CreateCandidateBootstrapPreflightEntryInputV1 {
  readonly ecosystem: CandidateBootstrapEcosystemV1;
  readonly ecosystemRef: string;
  readonly candidateRelativeCwd: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly lockfilePath: string | null;
  readonly lockfileDigest: string | null;
  readonly status: CandidateBootstrapPreflightEntryV1['status'];
  readonly reasonCode: CandidateBootstrapPreflightReasonCodeV1;
  readonly recipe: CandidateBootstrapRecipeDefinitionV1 | null;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,191}$/u;
const ENDPOINT = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/.*)?$/u;
const MAX_ENTRIES = 16;
const MAX_ARGV = 32;
const MAX_SCOPES = 16;
const MAX_ENDPOINTS = 8;

const RECIPE_KEYS = [
  'schemaVersion',
  'ecosystem',
  'recipeRef',
  'recipeVersion',
  'manifestName',
  'lockfileName',
  'executableName',
  'versionProbeArgv',
  'installArgv',
  'generatedPathScopes',
  'networkPolicy',
  'registryEndpoints',
  'lifecycleScripts',
  'nativeBuildHooks',
  'postInstallCommands',
  'timeoutMs',
  'reservedGeneratedBytes',
  'reservedOutputBytes',
  'recipeDigest',
] as const;

const ENTRY_KEYS = [
  'schemaVersion',
  'ecosystem',
  'ecosystemRef',
  'candidateRelativeCwd',
  'manifestPath',
  'manifestDigest',
  'lockfilePath',
  'lockfileDigest',
  'status',
  'reasonCode',
  'recipe',
  'entryDigest',
] as const;

const PREFLIGHT_KEYS = [
  'schemaVersion',
  'policyVersion',
  'sourceSnapshotDigest',
  'gatePlanDigest',
  'entries',
  'status',
  'reasonCode',
  'requiresExplicitNetworkConsent',
  'preflightDigest',
] as const;

const RECIPE_INPUTS = [
  {
    ecosystem: 'node',
    recipeRef: 'builtin:node:npm-ci',
    recipeVersion: '2',
    manifestName: 'package.json',
    lockfileName: 'package-lock.json',
    executableName: 'npm',
    versionProbeArgv: ['--version'],
    installArgv: [
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      '.wukong-bootstrap/npm-cache',
    ],
    generatedPathScopes: [
      '.wukong-bootstrap',
      'node_modules',
    ],
    registryEndpoints: ['https://registry.npmjs.org/'],
    timeoutMs: 10 * 60_000,
    reservedGeneratedBytes: 2 * 1024 * 1024 * 1024,
    reservedOutputBytes: 8 * 1024 * 1024,
  },
  {
    ecosystem: 'python',
    recipeRef: 'builtin:python:pip-hashed-wheels',
    recipeVersion: '2',
    manifestName: 'pyproject.toml',
    lockfileName: 'requirements.txt',
    executableName: 'python3',
    versionProbeArgv: ['--version'],
    installArgv: [
      '-m',
      'pip',
      'install',
      '--require-hashes',
      '--only-binary=:all:',
      '--no-input',
      '--disable-pip-version-check',
      '--target',
      '.wukong-bootstrap/python-site',
      '-r',
      'requirements.txt',
    ],
    generatedPathScopes: ['.wukong-bootstrap'],
    registryEndpoints: [
      'https://pypi.org/simple/',
      'https://files.pythonhosted.org/',
    ],
    timeoutMs: 10 * 60_000,
    reservedGeneratedBytes: 2 * 1024 * 1024 * 1024,
    reservedOutputBytes: 8 * 1024 * 1024,
  },
  {
    ecosystem: 'rust',
    recipeRef: 'builtin:rust:cargo-fetch',
    recipeVersion: '2',
    manifestName: 'Cargo.toml',
    lockfileName: 'Cargo.lock',
    executableName: 'cargo',
    versionProbeArgv: ['--version'],
    installArgv: ['fetch', '--locked'],
    generatedPathScopes: [
      '.wukong-bootstrap',
      'target',
    ],
    registryEndpoints: [
      'https://index.crates.io/',
      'https://static.crates.io/',
    ],
    timeoutMs: 10 * 60_000,
    reservedGeneratedBytes: 4 * 1024 * 1024 * 1024,
    reservedOutputBytes: 8 * 1024 * 1024,
  },
  {
    ecosystem: 'go',
    recipeRef: 'builtin:go:mod-vendor',
    recipeVersion: '2',
    manifestName: 'go.mod',
    lockfileName: 'go.sum',
    executableName: 'go',
    versionProbeArgv: ['version'],
    installArgv: ['mod', 'vendor'],
    generatedPathScopes: [
      '.wukong-bootstrap',
      'vendor',
    ],
    registryEndpoints: [
      'https://proxy.golang.org/',
      'https://sum.golang.org/',
    ],
    timeoutMs: 10 * 60_000,
    reservedGeneratedBytes: 4 * 1024 * 1024 * 1024,
    reservedOutputBytes: 8 * 1024 * 1024,
  },
] as const;

export const CANDIDATE_BOOTSTRAP_RECIPE_REGISTRY: readonly
CandidateBootstrapRecipeDefinitionV1[] = Object.freeze(
  RECIPE_INPUTS.map((input) => createRecipe(input)),
);

export function candidateBootstrapRecipeFor(
  ecosystem: CandidateBootstrapEcosystemV1,
  lockfileName: string,
): CandidateBootstrapRecipeDefinitionV1 | null {
  return CANDIDATE_BOOTSTRAP_RECIPE_REGISTRY.find(
    (recipe) =>
      recipe.ecosystem === ecosystem
      && recipe.lockfileName === lockfileName,
  ) ?? null;
}

export function createCandidateBootstrapPreflightEntry(
  input: CreateCandidateBootstrapPreflightEntryInputV1,
): CandidateBootstrapPreflightEntryV1 {
  const core = {
    schemaVersion: 1 as const,
    ecosystem: input.ecosystem,
    ecosystemRef: input.ecosystemRef,
    candidateRelativeCwd: input.candidateRelativeCwd,
    manifestPath: input.manifestPath,
    manifestDigest: input.manifestDigest,
    lockfilePath: input.lockfilePath,
    lockfileDigest: input.lockfileDigest,
    status: input.status,
    reasonCode: input.reasonCode,
    recipe: input.recipe,
  };
  const entry = Object.freeze({
    ...core,
    entryDigest: canonicalDigest(
      'wukong/candidate-bootstrap-preflight-entry/v1',
      core,
    ),
  });
  if (!validateCandidateBootstrapPreflightEntry(entry)) {
    throw new TypeError('The candidate bootstrap preflight entry is invalid.');
  }
  return entry;
}

export function createCandidateBootstrapPreflight(input: {
  readonly sourceSnapshotDigest: string;
  readonly gatePlanDigest: string;
  readonly entries: readonly CandidateBootstrapPreflightEntryV1[];
}): CandidateBootstrapPreflightV1 {
  const entries = Object.freeze([...input.entries].toSorted(
    (left, right) =>
      left.candidateRelativeCwd.localeCompare(right.candidateRelativeCwd)
      || left.ecosystem.localeCompare(right.ecosystem),
  ));
  const unsupported = entries.find((entry) => entry.status === 'unsupported');
  const ready = entries.some((entry) => entry.status === 'ready');
  const status = unsupported !== undefined
    ? 'unsupported'
    : ready ? 'ready' : 'not_required';
  const reasonCode = unsupported?.reasonCode
    ?? (ready
      ? 'candidate_bootstrap_confirmation_required'
      : 'candidate_bootstrap_not_required');
  const core = {
    schemaVersion: 1 as const,
    policyVersion: CANDIDATE_BOOTSTRAP_PREFLIGHT_POLICY_VERSION,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    gatePlanDigest: input.gatePlanDigest,
    entries,
    status,
    reasonCode,
    requiresExplicitNetworkConsent: status === 'ready',
  };
  const preflight = Object.freeze({
    ...core,
    preflightDigest: canonicalDigest(
      'wukong/candidate-bootstrap-preflight/v1',
      core,
    ),
  });
  if (!validateCandidateBootstrapPreflight(preflight)) {
    throw new TypeError('The candidate bootstrap preflight is invalid.');
  }
  return preflight;
}

export function validateCandidateBootstrapRecipeDefinition(
  value: unknown,
): value is CandidateBootstrapRecipeDefinitionV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, RECIPE_KEYS)
    || value['schemaVersion'] !== 1
    || !isEcosystem(value['ecosystem'])
    || !isOpaque(value['recipeRef'])
    || !isOpaque(value['recipeVersion'])
    || !isPortableFileName(value['manifestName'])
    || !isPortableFileName(value['lockfileName'])
    || !isPortableFileName(value['executableName'])
    || !isArgv(value['versionProbeArgv'])
    || !isArgv(value['installArgv'])
    || !isScopes(value['generatedPathScopes'])
    || value['networkPolicy'] !== 'explicit_once'
    || !isSortedUniqueEndpoints(value['registryEndpoints'])
    || value['lifecycleScripts'] !== 'deny'
    || value['nativeBuildHooks'] !== 'deny'
    || value['postInstallCommands'] !== 'deny'
    || !isPositiveSafeInteger(value['timeoutMs'])
    || !isPositiveSafeInteger(value['reservedGeneratedBytes'])
    || !isPositiveSafeInteger(value['reservedOutputBytes'])
    || !isDigest(value['recipeDigest'])) {
    return false;
  }
  const { recipeDigest, ...core } =
    value as unknown as CandidateBootstrapRecipeDefinitionV1;
  return canonicalDigest('wukong/candidate-bootstrap-recipe/v1', core)
    === recipeDigest;
}

export function validateCandidateBootstrapPreflightEntry(
  value: unknown,
): value is CandidateBootstrapPreflightEntryV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, ENTRY_KEYS)
    || value['schemaVersion'] !== 1
    || !isEcosystem(value['ecosystem'])
    || !isOpaque(value['ecosystemRef'])
    || !isPortableRelativeCwd(value['candidateRelativeCwd'])
    || !isPortablePath(value['manifestPath'])
    || !isDigest(value['manifestDigest'])
    || (value['lockfilePath'] !== null
      && !isPortablePath(value['lockfilePath']))
    || (value['lockfileDigest'] !== null
      && !isDigest(value['lockfileDigest']))
    || (value['status'] !== 'ready'
      && value['status'] !== 'not_required'
      && value['status'] !== 'unsupported')
    || !isReasonCode(value['reasonCode'])
    || (value['recipe'] !== null
      && !validateCandidateBootstrapRecipeDefinition(value['recipe']))
    || !isDigest(value['entryDigest'])) {
    return false;
  }
  if ((value['lockfilePath'] === null)
      !== (value['lockfileDigest'] === null)
    || (value['status'] === 'ready') !== (value['recipe'] !== null)
    || (value['status'] === 'ready'
      && (value['lockfilePath'] === null
        || value['reasonCode']
          !== 'candidate_bootstrap_confirmation_required'))
    || (value['status'] === 'not_required'
      && value['reasonCode'] !== 'candidate_bootstrap_not_required')) {
    return false;
  }
  const { entryDigest, ...core } =
    value as unknown as CandidateBootstrapPreflightEntryV1;
  return canonicalDigest(
    'wukong/candidate-bootstrap-preflight-entry/v1',
    core,
  ) === entryDigest;
}

export function validateCandidateBootstrapPreflight(
  value: unknown,
): value is CandidateBootstrapPreflightV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, PREFLIGHT_KEYS)
    || value['schemaVersion'] !== 1
    || value['policyVersion']
      !== CANDIDATE_BOOTSTRAP_PREFLIGHT_POLICY_VERSION
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['gatePlanDigest'])
    || !Array.isArray(value['entries'])
    || value['entries'].length > MAX_ENTRIES
    || value['entries'].some(
      (entry) => !validateCandidateBootstrapPreflightEntry(entry),
    )
    || !isSortedEntries(
      value['entries'] as readonly CandidateBootstrapPreflightEntryV1[],
    )
    || (value['status'] !== 'ready'
      && value['status'] !== 'not_required'
      && value['status'] !== 'unsupported')
    || !isReasonCode(value['reasonCode'])
    || typeof value['requiresExplicitNetworkConsent'] !== 'boolean'
    || !isDigest(value['preflightDigest'])) {
    return false;
  }
  const entries =
    value['entries'] as readonly CandidateBootstrapPreflightEntryV1[];
  const unsupported = entries.find((entry) => entry.status === 'unsupported');
  const ready = entries.some((entry) => entry.status === 'ready');
  const expectedStatus = unsupported !== undefined
    ? 'unsupported'
    : ready ? 'ready' : 'not_required';
  const expectedReason = unsupported?.reasonCode
    ?? (ready
      ? 'candidate_bootstrap_confirmation_required'
      : 'candidate_bootstrap_not_required');
  if (value['status'] !== expectedStatus
    || value['reasonCode'] !== expectedReason
    || value['requiresExplicitNetworkConsent'] !== (expectedStatus === 'ready')) {
    return false;
  }
  const { preflightDigest, ...core } =
    value as unknown as CandidateBootstrapPreflightV1;
  return canonicalDigest(
    'wukong/candidate-bootstrap-preflight/v1',
    core,
  ) === preflightDigest;
}

function createRecipe(
  input: Omit<
    CandidateBootstrapRecipeDefinitionV1,
    | 'schemaVersion'
    | 'networkPolicy'
    | 'lifecycleScripts'
    | 'nativeBuildHooks'
    | 'postInstallCommands'
    | 'recipeDigest'
  >,
): CandidateBootstrapRecipeDefinitionV1 {
  const core = {
    schemaVersion: 1 as const,
    ecosystem: input.ecosystem,
    recipeRef: input.recipeRef,
    recipeVersion: input.recipeVersion,
    manifestName: input.manifestName,
    lockfileName: input.lockfileName,
    executableName: input.executableName,
    versionProbeArgv: Object.freeze([...input.versionProbeArgv]),
    installArgv: Object.freeze([...input.installArgv]),
    generatedPathScopes:
      Object.freeze([...input.generatedPathScopes].toSorted()),
    networkPolicy: 'explicit_once' as const,
    registryEndpoints:
      Object.freeze([...input.registryEndpoints].toSorted()),
    lifecycleScripts: 'deny' as const,
    nativeBuildHooks: 'deny' as const,
    postInstallCommands: 'deny' as const,
    timeoutMs: input.timeoutMs,
    reservedGeneratedBytes: input.reservedGeneratedBytes,
    reservedOutputBytes: input.reservedOutputBytes,
  };
  const recipe = Object.freeze({
    ...core,
    recipeDigest: canonicalDigest(
      'wukong/candidate-bootstrap-recipe/v1',
      core,
    ),
  });
  if (!validateCandidateBootstrapRecipeDefinition(recipe)) {
    throw new TypeError('The built-in candidate bootstrap recipe is invalid.');
  }
  return recipe;
}

function isSortedEntries(
  entries: readonly CandidateBootstrapPreflightEntryV1[],
): boolean {
  const keys = entries.map(
    (entry) => `${entry.candidateRelativeCwd}\0${entry.ecosystem}`,
  );
  return keys.every((key, index) => index === 0 || keys[index - 1]! < key);
}

function isEcosystem(value: unknown): value is CandidateBootstrapEcosystemV1 {
  return value === 'node'
    || value === 'python'
    || value === 'rust'
    || value === 'go';
}

function isReasonCode(
  value: unknown,
): value is CandidateBootstrapPreflightReasonCodeV1 {
  return typeof value === 'string'
    && [
      'candidate_bootstrap_not_required',
      'candidate_bootstrap_confirmation_required',
      'candidate_bootstrap_lockfile_required',
      'candidate_bootstrap_lockfile_ambiguous',
      'candidate_bootstrap_lockfile_unsupported',
      'candidate_bootstrap_manifest_invalid',
      'candidate_bootstrap_runtime_unavailable',
      'candidate_bootstrap_native_build_unsupported',
    ].includes(value);
}

function isArgv(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_ARGV
    && value.every((argument) =>
      typeof argument === 'string'
      && argument.length > 0
      && !argument.includes('\0'));
}

function isScopes(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_SCOPES
    && value.every((scope, index) =>
      isPortablePath(scope)
      && (index === 0 || value[index - 1] < scope));
}

function isSortedUniqueEndpoints(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_ENDPOINTS
    && value.every((endpoint, index) =>
      typeof endpoint === 'string'
      && ENDPOINT.test(endpoint)
      && (index === 0 || value[index - 1] < endpoint));
}

function isPortableRelativeCwd(value: unknown): value is string {
  return value === '.' || isPortablePath(value);
}

function isPortableFileName(value: unknown): value is string {
  return typeof value === 'string'
    && !value.includes('/')
    && isPortablePath(value);
}

function isPortablePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4_096
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((segment) =>
      segment.length > 0
      && segment !== '.'
      && segment !== '..'
      && !segment.endsWith(' ')
      && !segment.endsWith('.'));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE.test(value);
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
