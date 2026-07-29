import { execFile } from 'node:child_process';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import {
  canonicalDigest,
  createBootstrapBudget,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  digestCandidateBootstrapArgv,
  digestCandidateBootstrapEnvironment,
  validateBootstrapBudget,
  validateCandidateBootstrapPlan,
  validateCandidateBootstrapPreflight,
  type BootstrapBudgetV1,
  type CandidateBootstrapPlanV1,
  type CandidateBootstrapPreflightV1,
  type CandidateBootstrapRecipeDefinitionV1,
  type CandidateBootstrapStepV1,
} from '@wukong/verification';

import {
  bindTrustedExecutableRuntimeInputs,
  inspectTrustedExecutable,
  withTrustedExecutablePath,
  type TrustedExecutableHandleV1,
} from './trusted-executable';
import {
  inspectTrustedRuntimeBundle,
  withTrustedRuntimeBundle,
} from './trusted-runtime-bundle';
import {
  CANDIDATE_BOOTSTRAP_CWD_REF,
} from './candidate-bootstrap-environment';

const execFileAsync = promisify(execFile);

const authenticPreparedPlans =
  new WeakSet<PreparedCandidateBootstrapPlanV1>();

export type CandidateBootstrapPlanBuilderErrorCode =
  | 'candidate_bootstrap_plan_invalid_input'
  | 'candidate_bootstrap_preflight_mismatch'
  | 'candidate_bootstrap_confirmation_mismatch'
  | 'candidate_bootstrap_runtime_unavailable';

export class CandidateBootstrapPlanBuilderError extends Error {
  constructor(
    readonly reasonCode: CandidateBootstrapPlanBuilderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateBootstrapPlanBuilderError';
  }
}

export interface BuildCandidateBootstrapPlanInputV1 {
  readonly preflight: CandidateBootstrapPreflightV1;
  readonly expectedPreflightDigest: string;
  readonly sourceWorkspaceRoot: string;
  readonly forbiddenRoots?: readonly string[];
  readonly pathEnvironment?: string;
}

export interface PreparedCandidateBootstrapStepV1 {
  readonly step: CandidateBootstrapStepV1;
  readonly trustedExecutable: TrustedExecutableHandleV1;
  readonly argv: readonly string[];
  readonly effectiveEnvironment: Readonly<Record<string, string>>;
  readonly reservedWallClockMs: number;
  readonly reservedGeneratedBytes: number;
  readonly reservedOutputBytes: number;
}

export interface PreparedCandidateBootstrapPlanV1 {
  readonly preflight: CandidateBootstrapPreflightV1;
  readonly plan: CandidateBootstrapPlanV1;
  readonly budget: BootstrapBudgetV1;
  readonly preparedSteps: readonly PreparedCandidateBootstrapStepV1[];
}

export async function buildCandidateBootstrapPlan(
  input: BuildCandidateBootstrapPlanInputV1,
): Promise<PreparedCandidateBootstrapPlanV1> {
  assertInput(input);
  if (input.expectedPreflightDigest !== input.preflight.preflightDigest) {
    fail(
      'candidate_bootstrap_preflight_mismatch',
      'The expected bootstrap preflight digest is stale.',
    );
  }
  if (input.preflight.status !== 'ready') {
    fail(
      'candidate_bootstrap_plan_invalid_input',
      'Only a ready bootstrap preflight can create an execution plan.',
    );
  }
  const sourceRoot = await realpath(input.sourceWorkspaceRoot);
  const forbiddenRoots = [
    sourceRoot,
    ...(input.forbiddenRoots ?? []),
  ];
  const bootstrapPlanId = uuidFromDigest(canonicalDigest(
    'wukong/candidate-bootstrap-plan-id/v1',
    input.preflight.preflightDigest,
  ));
  const budgetId = uuidFromDigest(canonicalDigest(
    'wukong/candidate-bootstrap-budget-id/v1',
    input.preflight.preflightDigest,
  ));
  const preparedSteps: PreparedCandidateBootstrapStepV1[] = [];
  for (const [index, entry] of input.preflight.entries.entries()) {
    if (entry.status !== 'ready' || entry.recipe === null) continue;
    const runtime = await prepareBootstrapRuntime({
      recipe: entry.recipe,
      forbiddenRoots,
      pathEnvironment:
        input.pathEnvironment ?? process.env['PATH'] ?? '',
      runtimeSelectionCwd: join(
        sourceRoot,
        entry.candidateRelativeCwd,
      ),
    });
    const trustedExecutable = runtime.trustedExecutable;
    const stepId = `${entry.ecosystem}_bootstrap_${String(index + 1)}`;
    const argv = Object.freeze([
      ...runtime.argvPrefix,
      ...entry.recipe.installArgv,
    ]);
    const environment = environmentFor(
      entry.recipe,
      runtime.environmentOverrides,
    );
    const step = createCandidateBootstrapStep({
      stepId,
      recipeRef: entry.recipe.recipeRef,
      recipeVersion: entry.recipe.recipeVersion,
      executableIdentity:
        trustedExecutable.identity.executableIdentityDigest,
      runtimeVersionDigest:
        trustedExecutable.identity.runtimeVersionDigest,
      exactArgvPrivateRef: `private/bootstrap/argv/${stepId}`,
      argvDigest: digestCandidateBootstrapArgv(argv),
      effectiveEnvironmentPrivateRef:
        `private/bootstrap/environment/${stepId}`,
      effectiveEnvironmentDigest:
        digestCandidateBootstrapEnvironment(environment),
      candidateRelativeCwd: entry.candidateRelativeCwd,
      generatedPathScopes: entry.recipe.generatedPathScopes,
      timeoutMs: entry.recipe.timeoutMs,
    });
    preparedSteps.push(Object.freeze({
      step,
      trustedExecutable,
      argv,
      effectiveEnvironment: environment,
      reservedWallClockMs: entry.recipe.timeoutMs,
      reservedGeneratedBytes: entry.recipe.reservedGeneratedBytes,
      reservedOutputBytes: entry.recipe.reservedOutputBytes,
    }));
  }
  if (preparedSteps.length === 0) {
    fail(
      'candidate_bootstrap_plan_invalid_input',
      'The ready bootstrap preflight contains no executable step.',
    );
  }
  const budget = createBootstrapBudget({
    budgetId,
    bootstrapPlanId,
    wallClockLimitMs: sum(preparedSteps, 'reservedWallClockMs'),
    generatedByteLimit: sum(preparedSteps, 'reservedGeneratedBytes'),
    processOutputByteLimit: sum(preparedSteps, 'reservedOutputBytes'),
    stepLimit: preparedSteps.length,
  });
  const endpointDigests = input.preflight.entries.flatMap(
    (entry) => entry.recipe?.registryEndpoints.map(
      (endpoint) => canonicalDigest(
        'wukong/candidate-bootstrap-registry-endpoint/v1',
        endpoint,
      ),
    ) ?? [],
  ).toSorted();
  const permissionDigest = canonicalDigest(
    'wukong/candidate-bootstrap-permission/v1',
    {
      preflightDigest: input.preflight.preflightDigest,
      networkPolicy: 'explicit_once',
      endpointDigests,
      budgetDigest: budget.budgetDigest,
    },
  );
  const plan = createCandidateBootstrapPlan({
    bootstrapPlanId,
    sourceSnapshotDigest: input.preflight.sourceSnapshotDigest,
    gatePlanDigest: input.preflight.gatePlanDigest,
    ecosystemRefs: input.preflight.entries
      .filter((entry) => entry.status === 'ready')
      .map((entry) => entry.ecosystemRef)
      .toSorted(),
    lockfileDigests: input.preflight.entries.flatMap(
      (entry) => entry.status === 'ready' && entry.lockfileDigest !== null
        ? [entry.lockfileDigest]
        : [],
    ).toSorted(),
    steps: preparedSteps.map((prepared) => prepared.step),
    injectedEnvironmentNames: [],
    networkPolicy: 'explicit_once',
    allowedRegistryEndpointDigests: [...new Set(endpointDigests)],
    permissionDigest,
    bootstrapBudgetDigest: budget.budgetDigest,
  });
  const prepared = Object.freeze({
    preflight: input.preflight,
    plan,
    budget,
    preparedSteps: Object.freeze(preparedSteps),
  });
  authenticPreparedPlans.add(prepared);
  return prepared;
}

async function prepareBootstrapRuntime(input: {
  readonly recipe: CandidateBootstrapRecipeDefinitionV1;
  readonly forbiddenRoots: readonly string[];
  readonly pathEnvironment: string;
  readonly runtimeSelectionCwd: string;
}): Promise<{
  readonly trustedExecutable: TrustedExecutableHandleV1;
  readonly argvPrefix: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
}> {
  let executablePath: string | undefined;
  try {
    executablePath = await resolveExecutable(
      input.recipe.executableName,
      input.pathEnvironment,
    );
    if (input.recipe.recipeRef === 'builtin:rust:cargo-fetch') {
      return await prepareCargoRuntime({
        cargoExecutablePath: executablePath,
        forbiddenRoots: input.forbiddenRoots,
        pathEnvironment: input.pathEnvironment,
        runtimeSelectionCwd: input.runtimeSelectionCwd,
      });
    }
    return {
      trustedExecutable: await inspectTrustedExecutable({
        executablePath,
        versionProbeArgs: input.recipe.versionProbeArgv,
        forbiddenRoots: input.forbiddenRoots,
      }),
      argvPrefix: Object.freeze([]),
      environmentOverrides: Object.freeze({}),
    };
  } catch (nativeError) {
    if (input.recipe.recipeRef !== 'builtin:node:npm-ci') {
      throw runtimeUnavailable(nativeError);
    }
    try {
      return await prepareNpmCompositeRuntime({
        npmExecutablePath: executablePath
          ?? await resolveExecutable(
            input.recipe.executableName,
            input.pathEnvironment,
          ),
        forbiddenRoots: input.forbiddenRoots,
        pathEnvironment: input.pathEnvironment,
      });
    } catch (compositeError) {
      throw runtimeUnavailable(compositeError);
    }
  }
}

async function prepareCargoRuntime(input: {
  readonly cargoExecutablePath: string;
  readonly forbiddenRoots: readonly string[];
  readonly pathEnvironment: string;
  readonly runtimeSelectionCwd: string;
}): Promise<{
  readonly trustedExecutable: TrustedExecutableHandleV1;
  readonly argvPrefix: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
}> {
  let selectedCargoPath = input.cargoExecutablePath;
  let selectedRustcPath: string;
  if (isRustupExecutablePath(input.cargoExecutablePath)) {
    const rustup = await inspectTrustedExecutable({
      executablePath: input.cargoExecutablePath,
      versionProbeArgs: ['--version'],
      forbiddenRoots: input.forbiddenRoots,
    });
    [selectedCargoPath, selectedRustcPath] =
      await withTrustedExecutablePath(
        rustup,
        async (absoluteRustupPath) => Promise.all([
          resolveRustupToolPath(
            absoluteRustupPath,
            'cargo',
            input.runtimeSelectionCwd,
          ),
          resolveRustupToolPath(
            absoluteRustupPath,
            'rustc',
            input.runtimeSelectionCwd,
          ),
        ]),
      );
  } else {
    selectedRustcPath = await resolveRustcBesideCargoOrOnPath(
      selectedCargoPath,
      input.pathEnvironment,
    );
  }
  const cargo = await inspectTrustedExecutable({
    executablePath: selectedCargoPath,
    versionProbeArgs: ['--version'],
    forbiddenRoots: input.forbiddenRoots,
  });
  const rustc = await inspectTrustedExecutable({
    executablePath: selectedRustcPath,
    versionProbeArgs: ['--version'],
    forbiddenRoots: input.forbiddenRoots,
  });
  const exactRustcPath = await withTrustedExecutablePath(
    rustc,
    (absoluteRustcPath) => absoluteRustcPath,
  );
  const trustedExecutable =
    await bindTrustedExecutableRuntimeInputs({
      executable: cargo,
      runtimeVersionDigest: canonicalDigest(
        'wukong/trusted-rust-toolchain-version/v1',
        {
          cargoExecutableIdentityDigest:
            cargo.identity.executableIdentityDigest,
          cargoRuntimeVersionDigest:
            cargo.identity.runtimeVersionDigest,
          rustcExecutableIdentityDigest:
            rustc.identity.executableIdentityDigest,
          rustcRuntimeVersionDigest:
            rustc.identity.runtimeVersionDigest,
        },
      ),
      validateRuntimeInputs: async () => {
        await withTrustedExecutablePath(rustc, () => undefined);
      },
    });
  return {
    trustedExecutable,
    argvPrefix: Object.freeze([]),
    environmentOverrides: Object.freeze({
      RUSTC: exactRustcPath,
    }),
  };
}

function isRustupExecutablePath(executablePath: string): boolean {
  const name = basename(executablePath).toLowerCase();
  return name === 'rustup' || name === 'rustup.exe';
}

async function resolveRustupToolPath(
  absoluteRustupPath: string,
  toolName: 'cargo' | 'rustc',
  runtimeSelectionCwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    absoluteRustupPath,
    ['which', toolName],
    {
      cwd: runtimeSelectionCwd,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: sanitizedRustupSelectionEnvironment(),
    },
  );
  const lines = normalizeProbeOutput(stdout)
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || !isAbsolute(lines[0]!)) {
    fail(
      'candidate_bootstrap_runtime_unavailable',
      'Rustup did not select one absolute Cargo executable.',
    );
  }
  const name = basename(lines[0]!).toLowerCase();
  if (name !== toolName && name !== `${toolName}.exe`) {
    fail(
      'candidate_bootstrap_runtime_unavailable',
      'Rustup selected an unexpected toolchain executable.',
    );
  }
  return realpath(lines[0]!);
}

async function resolveRustcBesideCargoOrOnPath(
  cargoExecutablePath: string,
  pathEnvironment: string,
): Promise<string> {
  const siblingName = process.platform === 'win32'
    ? 'rustc.exe'
    : 'rustc';
  try {
    const candidate = join(dirname(cargoExecutablePath), siblingName);
    await access(candidate, fsConstants.X_OK);
    return await realpath(candidate);
  } catch {
    return resolveExecutable('rustc', pathEnvironment);
  }
}

async function prepareNpmCompositeRuntime(input: {
  readonly npmExecutablePath: string;
  readonly forbiddenRoots: readonly string[];
  readonly pathEnvironment: string;
}): Promise<{
  readonly trustedExecutable: TrustedExecutableHandleV1;
  readonly argvPrefix: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
}> {
  const entryScriptPath = await resolveNpmEntryScript(
    input.npmExecutablePath,
  );
  const packageRoot = dirname(dirname(entryScriptPath));
  const bundle = await inspectTrustedRuntimeBundle({
    rootPath: packageRoot,
    entryScriptPath,
    packageName: 'npm',
    forbiddenRoots: input.forbiddenRoots,
  });
  const nodePath = await resolveExecutable(
    'node',
    input.pathEnvironment,
  );
  const node = await inspectTrustedExecutable({
    executablePath: nodePath,
    versionProbeArgs: ['--version'],
    forbiddenRoots: input.forbiddenRoots,
  });
  const npmVersionDigest = await withTrustedExecutablePath(
    node,
    (absoluteNodePath) => withTrustedRuntimeBundle(
      bundle,
      async ({ entryScriptPath: exactEntryScriptPath }) => {
        const { stdout, stderr } = await execFileAsync(
          absoluteNodePath,
          [exactEntryScriptPath, '--version'],
          {
            encoding: 'utf8',
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: sanitizedRuntimeProbeEnvironment(),
          },
        );
        return canonicalDigest(
          'wukong/trusted-npm-composite-version/v1',
          {
            nodeRuntimeVersionDigest:
              node.identity.runtimeVersionDigest,
            npmBundleIdentityDigest:
              bundle.identity.bundleIdentityDigest,
            stdout: normalizeProbeOutput(stdout),
            stderr: normalizeProbeOutput(stderr),
          },
        );
      },
    ),
  );
  const validateRuntimeInputs = async (): Promise<void> => {
    await withTrustedRuntimeBundle(bundle, () => undefined);
  };
  const trustedExecutable =
    await bindTrustedExecutableRuntimeInputs({
      executable: node,
      runtimeVersionDigest: npmVersionDigest,
      validateRuntimeInputs,
    });
  const exactEntryScriptPath = await withTrustedRuntimeBundle(
    bundle,
    ({ entryScriptPath: path }) => path,
  );
  return Object.freeze({
    trustedExecutable,
    argvPrefix: Object.freeze([exactEntryScriptPath]),
    environmentOverrides: Object.freeze({}),
  });
}

async function resolveNpmEntryScript(
  npmExecutablePath: string,
): Promise<string> {
  if (basename(npmExecutablePath) === 'npm-cli.js') {
    return npmExecutablePath;
  }
  const candidates = [
    join(
      dirname(npmExecutablePath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    join(
      dirname(dirname(npmExecutablePath)),
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {}
  }
  throw new Error('The npm CLI package entry could not be resolved.');
}

function runtimeUnavailable(cause: unknown):
CandidateBootstrapPlanBuilderError {
  return new CandidateBootstrapPlanBuilderError(
    'candidate_bootstrap_runtime_unavailable',
    'The bootstrap runtime could not be frozen as an exact executable and runtime bundle.',
    { cause },
  );
}

export function confirmCandidateBootstrapPlan(
  prepared: PreparedCandidateBootstrapPlanV1,
  approvedBootstrapPlanDigest: string,
): PreparedCandidateBootstrapPlanV1 {
  if (!isRecord(prepared)
    || !authenticPreparedPlans.has(prepared)
    || !validateCandidateBootstrapPreflight(prepared.preflight)
    || prepared.preflight.status !== 'ready'
    || !validateCandidateBootstrapPlan(prepared.plan)
    || !validateBootstrapBudget(prepared.budget)
    || prepared.plan.bootstrapBudgetDigest !== prepared.budget.budgetDigest
    || prepared.plan.sourceSnapshotDigest
      !== prepared.preflight.sourceSnapshotDigest
    || prepared.plan.gatePlanDigest !== prepared.preflight.gatePlanDigest
    || prepared.preparedSteps.length !== prepared.plan.steps.length
    || approvedBootstrapPlanDigest !== prepared.plan.bootstrapPlanDigest) {
    fail(
      'candidate_bootstrap_confirmation_mismatch',
      'The approved bootstrap plan digest does not match the exact plan.',
    );
  }
  return prepared;
}

function environmentFor(
  recipe: CandidateBootstrapRecipeDefinitionV1,
  environmentOverrides: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const common: Record<string, string> = {
    CI: '1',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PATH: '',
  };
  switch (recipe.ecosystem) {
    case 'node':
      return Object.freeze({
        ...common,
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_CACHE: '.wukong-bootstrap/npm-cache',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_USERCONFIG:
          process.platform === 'win32' ? 'NUL' : '/dev/null',
        ...environmentOverrides,
      });
    case 'python':
      return Object.freeze({
        ...common,
        PIP_CONFIG_FILE:
          process.platform === 'win32' ? 'NUL' : '/dev/null',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_NO_CACHE_DIR: '1',
        PIP_NO_INPUT: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        ...environmentOverrides,
      });
    case 'rust':
      return Object.freeze({
        ...common,
        CARGO_HOME: '.wukong-bootstrap/cargo-home',
        CARGO_NET_GIT_FETCH_WITH_CLI: 'false',
        CARGO_REGISTRIES_CRATES_IO_INDEX:
          'sparse+https://index.crates.io/',
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
        ...environmentOverrides,
      });
    case 'go':
      return Object.freeze({
        ...common,
        GOENV: 'off',
        GOCACHE:
          `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-cache`,
        GOMODCACHE:
          `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-path/pkg/mod`,
        GONOSUMDB: '',
        GOPATH:
          `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-path`,
        GOPRIVATE: '',
        GOPROXY: 'https://proxy.golang.org',
        GOSUMDB: 'sum.golang.org',
        GOTOOLCHAIN: 'local',
        ...environmentOverrides,
      });
  }
}

async function resolveExecutable(
  name: string,
  pathEnvironment: string,
): Promise<string> {
  for (const directory of pathEnvironment.split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    for (const candidate of executableCandidates(directory, name)) {
      try {
        await access(candidate, fsConstants.X_OK);
        return await realpath(candidate);
      } catch {}
    }
  }
  fail(
    'candidate_bootstrap_runtime_unavailable',
    'The bootstrap runtime is unavailable on the approved PATH.',
  );
}

function executableCandidates(
  directory: string,
  name: string,
): readonly string[] {
  if (process.platform !== 'win32') {
    return [join(directory, name)];
  }
  const extensions = (process.env['PATHEXT']
    ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0)
    .map((extension) => extension.toLowerCase());
  return [
    join(directory, name),
    ...extensions.map((extension) =>
      join(directory, `${name}${extension}`)),
  ];
}

function sanitizedRuntimeProbeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env['SystemRoot'],
          WINDIR: process.env['WINDIR'],
        }
      : {}),
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PATH: '',
  };
}

function sanitizedRustupSelectionEnvironment(): NodeJS.ProcessEnv {
  const userHome = homedir();
  const rustupHome = process.env['RUSTUP_HOME'];
  return {
    ...sanitizedRuntimeProbeEnvironment(),
    HOME: userHome,
    USERPROFILE: userHome,
    ...(rustupHome !== undefined && isAbsolute(rustupHome)
      ? { RUSTUP_HOME: rustupHome }
      : {}),
  };
}

function normalizeProbeOutput(value: string): string {
  return value.replaceAll('\r\n', '\n').trim();
}

function sum(
  steps: readonly PreparedCandidateBootstrapStepV1[],
  field:
    | 'reservedWallClockMs'
    | 'reservedGeneratedBytes'
    | 'reservedOutputBytes',
): number {
  return steps.reduce((total, step) => total + step[field], 0);
}

function assertInput(input: BuildCandidateBootstrapPlanInputV1): void {
  if (!isRecord(input)
    || !validateCandidateBootstrapPreflight(input.preflight)
    || typeof input.expectedPreflightDigest !== 'string'
    || typeof input.sourceWorkspaceRoot !== 'string'
    || input.sourceWorkspaceRoot.length === 0
    || (input.forbiddenRoots !== undefined
      && (!Array.isArray(input.forbiddenRoots)
        || input.forbiddenRoots.some((root) => typeof root !== 'string')))
    || (input.pathEnvironment !== undefined
      && typeof input.pathEnvironment !== 'string')) {
    fail(
      'candidate_bootstrap_plan_invalid_input',
      'The candidate bootstrap plan input is invalid.',
    );
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  reasonCode: CandidateBootstrapPlanBuilderErrorCode,
  message: string,
): never {
  throw new CandidateBootstrapPlanBuilderError(reasonCode, message);
}
