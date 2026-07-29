import { canonicalDigest } from './finish-line';

export type CandidateBootstrapNetworkPolicyV1 = 'deny' | 'explicit_once';

export interface CandidateBootstrapStepV1 {
  readonly schemaVersion: 1;
  readonly stepId: string;
  readonly recipeRef: string;
  readonly recipeVersion: string;
  readonly executableIdentity: string;
  readonly runtimeVersionDigest: string;
  readonly exactArgvPrivateRef: string;
  readonly argvDigest: string;
  readonly effectiveEnvironmentPrivateRef: string;
  readonly effectiveEnvironmentDigest: string;
  readonly candidateRelativeCwd: string;
  readonly generatedPathScopes: readonly string[];
  readonly timeoutMs: number;
  readonly lifecycleScripts: 'deny';
  readonly stepDigest: string;
}

export interface CandidateBootstrapPlanV1 {
  readonly schemaVersion: 1;
  readonly bootstrapPlanId: string;
  readonly sourceSnapshotDigest: string;
  readonly gatePlanDigest: string;
  readonly ecosystemRefs: readonly string[];
  readonly lockfileDigests: readonly string[];
  readonly steps: readonly CandidateBootstrapStepV1[];
  readonly injectedEnvironmentNames: readonly string[];
  readonly networkPolicy: CandidateBootstrapNetworkPolicyV1;
  readonly allowedRegistryEndpointDigests: readonly string[];
  readonly permissionDigest: string;
  readonly bootstrapBudgetDigest: string;
  readonly bootstrapPlanDigest: string;
}

export interface CreateCandidateBootstrapStepInputV1 {
  readonly stepId: string;
  readonly recipeRef: string;
  readonly recipeVersion: string;
  readonly executableIdentity: string;
  readonly runtimeVersionDigest: string;
  readonly exactArgvPrivateRef: string;
  readonly argvDigest: string;
  readonly effectiveEnvironmentPrivateRef: string;
  readonly effectiveEnvironmentDigest: string;
  readonly candidateRelativeCwd: string;
  readonly generatedPathScopes: readonly string[];
  readonly timeoutMs: number;
}

export interface CreateCandidateBootstrapPlanInputV1 {
  readonly bootstrapPlanId: string;
  readonly sourceSnapshotDigest: string;
  readonly gatePlanDigest: string;
  readonly ecosystemRefs: readonly string[];
  readonly lockfileDigests: readonly string[];
  readonly steps: readonly CandidateBootstrapStepV1[];
  readonly injectedEnvironmentNames: readonly string[];
  readonly networkPolicy: CandidateBootstrapNetworkPolicyV1;
  readonly allowedRegistryEndpointDigests: readonly string[];
  readonly permissionDigest: string;
  readonly bootstrapBudgetDigest: string;
}

export interface CreateNoBootstrapCandidatePlanInputV1 {
  readonly sourceSnapshotDigest: string;
  readonly gatePlanDigest: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,191}$/u;
const PRIVATE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const MAX_STEPS = 8;
const MAX_ECOSYSTEM_REFS = 8;
const MAX_LOCKFILES = 32;
const MAX_ENVIRONMENT_NAMES = 32;
const MAX_GENERATED_SCOPES = 32;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const PROTECTED_SCOPE_SEGMENTS = new Set([
  '.git',
  '.wukong',
]);

const STEP_KEYS = [
  'schemaVersion',
  'stepId',
  'recipeRef',
  'recipeVersion',
  'executableIdentity',
  'runtimeVersionDigest',
  'exactArgvPrivateRef',
  'argvDigest',
  'effectiveEnvironmentPrivateRef',
  'effectiveEnvironmentDigest',
  'candidateRelativeCwd',
  'generatedPathScopes',
  'timeoutMs',
  'lifecycleScripts',
  'stepDigest',
] as const;

const PLAN_KEYS = [
  'schemaVersion',
  'bootstrapPlanId',
  'sourceSnapshotDigest',
  'gatePlanDigest',
  'ecosystemRefs',
  'lockfileDigests',
  'steps',
  'injectedEnvironmentNames',
  'networkPolicy',
  'allowedRegistryEndpointDigests',
  'permissionDigest',
  'bootstrapBudgetDigest',
  'bootstrapPlanDigest',
] as const;

export function createCandidateBootstrapStep(
  input: CreateCandidateBootstrapStepInputV1,
): CandidateBootstrapStepV1 {
  const core = {
    schemaVersion: 1 as const,
    stepId: input.stepId,
    recipeRef: input.recipeRef,
    recipeVersion: input.recipeVersion,
    executableIdentity: input.executableIdentity,
    runtimeVersionDigest: input.runtimeVersionDigest,
    exactArgvPrivateRef: input.exactArgvPrivateRef,
    argvDigest: input.argvDigest,
    effectiveEnvironmentPrivateRef: input.effectiveEnvironmentPrivateRef,
    effectiveEnvironmentDigest: input.effectiveEnvironmentDigest,
    candidateRelativeCwd: input.candidateRelativeCwd,
    generatedPathScopes: Object.freeze([...input.generatedPathScopes]),
    timeoutMs: input.timeoutMs,
    lifecycleScripts: 'deny' as const,
  };
  const step: CandidateBootstrapStepV1 = Object.freeze({
    ...core,
    stepDigest: canonicalDigest('wukong/candidate-bootstrap-step/v1', core),
  });
  if (!validateCandidateBootstrapStep(step)) {
    throw new TypeError('The candidate bootstrap step is invalid.');
  }
  return step;
}

export function createCandidateBootstrapPlan(
  input: CreateCandidateBootstrapPlanInputV1,
): CandidateBootstrapPlanV1 {
  const core = {
    schemaVersion: 1 as const,
    bootstrapPlanId: input.bootstrapPlanId,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    gatePlanDigest: input.gatePlanDigest,
    ecosystemRefs: Object.freeze([...input.ecosystemRefs]),
    lockfileDigests: Object.freeze([...input.lockfileDigests]),
    steps: Object.freeze([...input.steps]),
    injectedEnvironmentNames:
      Object.freeze([...input.injectedEnvironmentNames]),
    networkPolicy: input.networkPolicy,
    allowedRegistryEndpointDigests:
      Object.freeze([...input.allowedRegistryEndpointDigests]),
    permissionDigest: input.permissionDigest,
    bootstrapBudgetDigest: input.bootstrapBudgetDigest,
  };
  const plan: CandidateBootstrapPlanV1 = Object.freeze({
    ...core,
    bootstrapPlanDigest: canonicalDigest(
      'wukong/candidate-bootstrap-plan/v1',
      core,
    ),
  });
  if (!validateCandidateBootstrapPlan(plan)) {
    throw new TypeError('The candidate bootstrap plan is invalid.');
  }
  return plan;
}

/**
 * Creates the default-deny bootstrap identity used when a candidate needs no
 * dependency installation. It is deterministic so recovery can reconstruct
 * the exact plan without persisting another mutable input.
 */
export function createNoBootstrapCandidatePlan(
  input: CreateNoBootstrapCandidatePlanInputV1,
): CandidateBootstrapPlanV1 {
  if (!isDigest(input.sourceSnapshotDigest)
    || !isDigest(input.gatePlanDigest)) {
    throw new TypeError(
      'A valid source snapshot and Gate Plan digest are required.',
    );
  }
  const identity = {
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    gatePlanDigest: input.gatePlanDigest,
  };
  return createCandidateBootstrapPlan({
    bootstrapPlanId: uuidFromDigest(canonicalDigest(
      'wukong/no-bootstrap-plan-id/v1',
      identity,
    )),
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    gatePlanDigest: input.gatePlanDigest,
    ecosystemRefs: [],
    lockfileDigests: [],
    steps: [],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: canonicalDigest(
      'wukong/no-bootstrap-permission/v1',
      identity,
    ),
    bootstrapBudgetDigest: canonicalDigest(
      'wukong/no-bootstrap-budget/v1',
      identity,
    ),
  });
}

export function validateCandidateBootstrapStep(
  value: unknown,
): value is CandidateBootstrapStepV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, STEP_KEYS)
    || value['schemaVersion'] !== 1
    || !isOpaque(value['stepId'])
    || !isOpaque(value['recipeRef'])
    || !isOpaque(value['recipeVersion'])
    || !isDigest(value['executableIdentity'])
    || !isDigest(value['runtimeVersionDigest'])
    || !isPrivateRef(value['exactArgvPrivateRef'])
    || !isDigest(value['argvDigest'])
    || !isPrivateRef(value['effectiveEnvironmentPrivateRef'])
    || !isDigest(value['effectiveEnvironmentDigest'])
    || !isCandidateRelativeCwd(value['candidateRelativeCwd'])
    || !isGeneratedScopes(value['generatedPathScopes'])
    || typeof value['timeoutMs'] !== 'number'
    || !Number.isSafeInteger(value['timeoutMs'])
    || value['timeoutMs'] < MIN_TIMEOUT_MS
    || value['timeoutMs'] > MAX_TIMEOUT_MS
    || value['lifecycleScripts'] !== 'deny'
    || !isDigest(value['stepDigest'])) {
    return false;
  }
  const { stepDigest, ...core } =
    value as unknown as CandidateBootstrapStepV1;
  return canonicalDigest('wukong/candidate-bootstrap-step/v1', core)
    === stepDigest;
}

export function validateCandidateBootstrapPlan(
  value: unknown,
): value is CandidateBootstrapPlanV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, PLAN_KEYS)
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['bootstrapPlanId']))
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['gatePlanDigest'])
    || !isSortedUniqueOpaqueList(
      value['ecosystemRefs'],
      MAX_ECOSYSTEM_REFS,
    )
    || !isSortedUniqueDigestList(value['lockfileDigests'], MAX_LOCKFILES)
    || !isStepList(value['steps'])
    || !isSortedUniqueEnvironmentList(value['injectedEnvironmentNames'])
    || (value['networkPolicy'] !== 'deny'
      && value['networkPolicy'] !== 'explicit_once')
    || !isSortedUniqueDigestList(
      value['allowedRegistryEndpointDigests'],
      MAX_LOCKFILES,
    )
    || (value['networkPolicy'] === 'deny'
      ? value['allowedRegistryEndpointDigests'].length > 0
      : value['allowedRegistryEndpointDigests'].length === 0)
    || !isDigest(value['permissionDigest'])
    || !isDigest(value['bootstrapBudgetDigest'])
    || !isDigest(value['bootstrapPlanDigest'])) {
    return false;
  }
  const { bootstrapPlanDigest, ...core } =
    value as unknown as CandidateBootstrapPlanV1;
  return canonicalDigest('wukong/candidate-bootstrap-plan/v1', core)
    === bootstrapPlanDigest;
}

export function digestCandidateBootstrapArgv(
  argv: readonly string[],
): string {
  if (!Array.isArray(argv)
    || argv.length === 0
    || argv.length > 128
    || argv.some((argument) =>
      typeof argument !== 'string'
      || argument.includes('\0')
      || Buffer.byteLength(argument, 'utf8') > 16 * 1024)) {
    throw new TypeError('The candidate bootstrap argv is invalid.');
  }
  return canonicalDigest('wukong/candidate-bootstrap-argv/v1', argv);
}

export function digestCandidateBootstrapEnvironment(
  environment: Readonly<Record<string, string>>,
): string {
  if (!isRecord(environment)) {
    throw new TypeError('The candidate bootstrap environment is invalid.');
  }
  const names = Object.keys(environment).toSorted();
  if (names.length > MAX_ENVIRONMENT_NAMES
    || names.some((name) => !ENVIRONMENT_NAME.test(name))
    || names.some((name) => {
      const value = environment[name];
      return typeof value !== 'string'
        || value.includes('\0')
        || Buffer.byteLength(value, 'utf8') > 64 * 1024;
    })) {
    throw new TypeError('The candidate bootstrap environment is invalid.');
  }
  const canonicalEnvironment = Object.fromEntries(
    names.map((name) => [name, environment[name]]),
  );
  return canonicalDigest(
    'wukong/candidate-bootstrap-environment/v1',
    canonicalEnvironment,
  );
}

function isStepList(value: unknown): value is readonly CandidateBootstrapStepV1[] {
  if (!Array.isArray(value) || value.length > MAX_STEPS) return false;
  const stepIds = new Set<string>();
  for (const step of value) {
    if (!validateCandidateBootstrapStep(step) || stepIds.has(step.stepId)) {
      return false;
    }
    stepIds.add(step.stepId);
  }
  return true;
}

function isGeneratedScopes(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)
    || value.length > MAX_GENERATED_SCOPES
    || !isSortedUnique(value, isPortableRelativePath)) {
    return false;
  }
  const scopes = value as string[];
  for (const scope of scopes) {
    const segments = scope.split('/');
    if (segments.some((segment) => PROTECTED_SCOPE_SEGMENTS.has(segment))) {
      return false;
    }
  }
  for (const [index, scope] of scopes.entries()) {
    if (scopes.some((other, otherIndex) =>
      otherIndex !== index
      && (scope.startsWith(`${other}/`) || other.startsWith(`${scope}/`)))) {
      return false;
    }
  }
  return true;
}

function isSortedUniqueOpaqueList(
  value: unknown,
  limit: number,
): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= limit
    && isSortedUnique(value, isOpaque);
}

function isSortedUniqueDigestList(
  value: unknown,
  limit: number,
): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= limit
    && isSortedUnique(value, isDigest);
}

function isSortedUniqueEnvironmentList(
  value: unknown,
): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_ENVIRONMENT_NAMES
    && isSortedUnique(
      value,
      (item): item is string =>
        typeof item === 'string' && ENVIRONMENT_NAME.test(item),
    );
}

function isSortedUnique(
  value: readonly unknown[],
  validator: (item: unknown) => item is string,
): value is readonly string[] {
  let previous: string | null = null;
  for (const item of value) {
    if (!validator(item)
      || (previous !== null && previous >= item)) {
      return false;
    }
    previous = item;
  }
  return true;
}

function isCandidateRelativeCwd(value: unknown): value is string {
  return value === '.' || isPortableRelativePath(value);
}

function isPortableRelativePath(value: unknown): value is string {
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

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isPrivateRef(value: unknown): value is string {
  return typeof value === 'string' && PRIVATE_REF.test(value);
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

function uuidFromDigest(digest: string): string {
  const hex = digest.slice('sha256:'.length, 'sha256:'.length + 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
