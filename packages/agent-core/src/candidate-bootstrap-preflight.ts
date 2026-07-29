import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  open,
  realpath,
} from 'node:fs/promises';
import {
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  candidateBootstrapRecipeFor,
  canonicalDigest,
  createCandidateBootstrapPreflight,
  createCandidateBootstrapPreflightEntry,
  inspectSourceSnapshot,
  sourceSnapshotMatches,
  validateSourceSnapshot,
  type CandidateBootstrapEcosystemV1,
  type CandidateBootstrapPreflightEntryV1,
  type CandidateBootstrapPreflightV1,
  type GatePlan,
  type SourceSnapshotV1,
} from '@wukong/verification';

const MAX_BOOTSTRAP_INPUT_BYTES = 16 * 1024 * 1024;
const NODE_LOCKFILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;
const PYTHON_MANIFESTS = [
  'pyproject.toml',
  'requirements.txt',
  'setup.cfg',
  'setup.py',
] as const;
const ALL_ECOSYSTEMS = ['go', 'node', 'python', 'rust'] as const;

export type CandidateBootstrapPreflightInspectorErrorCode =
  | 'candidate_bootstrap_preflight_invalid_input'
  | 'candidate_bootstrap_preflight_source_drift'
  | 'candidate_bootstrap_preflight_path_unsafe';

export class CandidateBootstrapPreflightInspectorError extends Error {
  constructor(
    readonly reasonCode: CandidateBootstrapPreflightInspectorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CandidateBootstrapPreflightInspectorError';
  }
}

export interface InspectCandidateBootstrapPreflightInputV1 {
  readonly sourceSnapshotCwd: string;
  readonly sourceSnapshot: SourceSnapshotV1;
  readonly gatePlan: GatePlan;
  readonly pathEnvironment?: string;
}

interface StableFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly digest: string;
}

/**
 * Produces the read-only, user-reviewable bootstrap proposal before any Blob
 * Lease, worktree, Goal record, or package-manager process is created.
 */
export async function inspectCandidateBootstrapPreflight(
  input: InspectCandidateBootstrapPreflightInputV1,
): Promise<CandidateBootstrapPreflightV1> {
  assertInput(input);
  const workspace = await realpath(resolve(input.sourceSnapshotCwd));
  await assertSnapshotCurrent(workspace, input.sourceSnapshot);
  const required = requiredEcosystems(input.gatePlan);
  const present = await presentEcosystems(workspace);
  if (required.size === 0 && present.length === 1
    && input.gatePlan.requiredChecks.some(
      (check) => check.resolution === 'resolved',
    )) {
    required.add(present[0]!);
  }

  const entries: CandidateBootstrapPreflightEntryV1[] = [];
  for (const ecosystem of ALL_ECOSYSTEMS) {
    if (!required.has(ecosystem)) continue;
    const entry = await inspectEcosystem({
      ecosystem,
      workspace,
      pathEnvironment: input.pathEnvironment ?? process.env['PATH'] ?? '',
    });
    if (entry !== null) entries.push(entry);
  }
  await assertSnapshotCurrent(workspace, input.sourceSnapshot);
  return createCandidateBootstrapPreflight({
    sourceSnapshotDigest: input.sourceSnapshot.snapshotDigest,
    gatePlanDigest: input.gatePlan.planDigest,
    entries,
  });
}

async function inspectEcosystem(input: {
  readonly ecosystem: CandidateBootstrapEcosystemV1;
  readonly workspace: string;
  readonly pathEnvironment: string;
}): Promise<CandidateBootstrapPreflightEntryV1 | null> {
  switch (input.ecosystem) {
    case 'node':
      return inspectNode(input.workspace, input.pathEnvironment);
    case 'python':
      return inspectPython(input.workspace, input.pathEnvironment);
    case 'rust':
      return inspectRust(input.workspace, input.pathEnvironment);
    case 'go':
      return inspectGo(input.workspace, input.pathEnvironment);
  }
}

async function inspectNode(
  workspace: string,
  pathEnvironment: string,
): Promise<CandidateBootstrapPreflightEntryV1 | null> {
  const manifest = await readStableFileOrNull(workspace, 'package.json');
  if (manifest === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.bytes.toString('utf8'));
  } catch {
    return unsupportedEntry(
      'node',
      'node:npm',
      manifest,
      null,
      'candidate_bootstrap_manifest_invalid',
    );
  }
  if (!isRecord(parsed)) {
    return unsupportedEntry(
      'node',
      'node:npm',
      manifest,
      null,
      'candidate_bootstrap_manifest_invalid',
    );
  }
  const dependencyCount = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ].reduce((count, key) => {
    const value = parsed[key];
    return count + (isRecord(value) ? Object.keys(value).length : 0);
  }, 0);
  const lockfiles = (await Promise.all(
    NODE_LOCKFILES.map((name) => readStableFileOrNull(workspace, name)),
  )).filter((file): file is StableFile => file !== null);
  if (dependencyCount === 0 && lockfiles.length === 0) {
    return notRequiredEntry('node', 'node:npm', manifest);
  }
  if (await readStableFileOrNull(workspace, '.npmrc') !== null) {
    return unsupportedEntry(
      'node',
      'node:npm',
      manifest,
      lockfiles.length === 1 ? lockfiles[0]! : null,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (lockfiles.length === 0) {
    return unsupportedEntry(
      'node',
      'node:npm',
      manifest,
      null,
      'candidate_bootstrap_lockfile_required',
    );
  }
  if (lockfiles.length > 1) {
    return unsupportedEntry(
      'node',
      'node:ambiguous',
      manifest,
      null,
      'candidate_bootstrap_lockfile_ambiguous',
    );
  }
  const lockfile = lockfiles[0]!;
  const recipe = candidateBootstrapRecipeFor('node', lockfile.path);
  if (recipe === null) {
    return unsupportedEntry(
      'node',
      `node:${packageManagerForLockfile(lockfile.path)}`,
      manifest,
      lockfile,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (!isSupportedPackageLock(lockfile.bytes)) {
    return unsupportedEntry(
      'node',
      'node:npm',
      manifest,
      lockfile,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (!await executableAvailable(recipe.executableName, pathEnvironment)) {
    return unsupportedEntry(
      'node',
      'node:npm',
      manifest,
      lockfile,
      'candidate_bootstrap_runtime_unavailable',
    );
  }
  return readyEntry('node', 'node:npm', manifest, lockfile);
}

async function inspectPython(
  workspace: string,
  pathEnvironment: string,
): Promise<CandidateBootstrapPreflightEntryV1 | null> {
  const manifests = (await Promise.all(
    PYTHON_MANIFESTS.map((name) => readStableFileOrNull(workspace, name)),
  )).filter((file): file is StableFile => file !== null);
  if (manifests.length === 0) return null;
  const manifest = manifests.find((file) => file.path === 'pyproject.toml')
    ?? manifests[0]!;
  const requirements = manifests.find(
    (file) => file.path === 'requirements.txt',
  ) ?? null;
  if (requirements === null) {
    return unsupportedEntry(
      'python',
      'python:pip',
      manifest,
      null,
      'candidate_bootstrap_lockfile_required',
    );
  }
  const requirementState = inspectHashedWheelRequirements(
    requirements.bytes.toString('utf8'),
  );
  if (requirementState === 'empty') {
    return notRequiredEntry('python', 'python:pip', manifest);
  }
  if (requirementState === 'unsupported') {
    return unsupportedEntry(
      'python',
      'python:pip',
      manifest,
      requirements,
      'candidate_bootstrap_native_build_unsupported',
    );
  }
  const recipe = candidateBootstrapRecipeFor(
    'python',
    requirements.path,
  );
  if (recipe === null) {
    return unsupportedEntry(
      'python',
      'python:pip',
      manifest,
      requirements,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (!await executableAvailable(recipe.executableName, pathEnvironment)) {
    return unsupportedEntry(
      'python',
      'python:pip',
      manifest,
      requirements,
      'candidate_bootstrap_runtime_unavailable',
    );
  }
  return readyEntry(
    'python',
    'python:pip',
    manifest,
    requirements,
  );
}

async function inspectRust(
  workspace: string,
  pathEnvironment: string,
): Promise<CandidateBootstrapPreflightEntryV1 | null> {
  const manifest = await readStableFileOrNull(workspace, 'Cargo.toml');
  if (manifest === null) return null;
  const manifestText = manifest.bytes.toString('utf8');
  const needsDependencies =
    /^\s*\[(?:dev-|build-)?dependencies(?:\.[^\]]+)?\]\s*$/mu
      .test(manifestText);
  const lockfile = await readStableFileOrNull(workspace, 'Cargo.lock');
  if (!needsDependencies && lockfile === null) {
    return notRequiredEntry('rust', 'rust:cargo', manifest);
  }
  if (lockfile === null) {
    return unsupportedEntry(
      'rust',
      'rust:cargo',
      manifest,
      null,
      'candidate_bootstrap_lockfile_required',
    );
  }
  const cargoConfigs = await Promise.all([
    readStableFileOrNull(workspace, '.cargo/config'),
    readStableFileOrNull(workspace, '.cargo/config.toml'),
  ]);
  if (cargoConfigs.some((config) => config !== null)) {
    return unsupportedEntry(
      'rust',
      'rust:cargo',
      manifest,
      lockfile,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (!isSupportedCargoLock(lockfile.bytes)) {
    return unsupportedEntry(
      'rust',
      'rust:cargo',
      manifest,
      lockfile,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  const recipe = candidateBootstrapRecipeFor('rust', lockfile.path);
  if (recipe === null) {
    return unsupportedEntry(
      'rust',
      'rust:cargo',
      manifest,
      lockfile,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (!await executableAvailable(recipe.executableName, pathEnvironment)) {
    return unsupportedEntry(
      'rust',
      'rust:cargo',
      manifest,
      lockfile,
      'candidate_bootstrap_runtime_unavailable',
    );
  }
  return readyEntry('rust', 'rust:cargo', manifest, lockfile);
}

async function inspectGo(
  workspace: string,
  pathEnvironment: string,
): Promise<CandidateBootstrapPreflightEntryV1 | null> {
  const manifest = await readStableFileOrNull(workspace, 'go.mod');
  if (manifest === null) return null;
  const manifestText = manifest.bytes.toString('utf8')
    .replaceAll(/\/\/.*$/gmu, '');
  if (/^\s*replace(?:\s|\()/mu.test(manifestText)) {
    return unsupportedEntry(
      'go',
      'go:modules',
      manifest,
      null,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  const needsDependencies = /^\s*require(?:\s|\()/mu.test(manifestText);
  const lockfile = await readStableFileOrNull(workspace, 'go.sum');
  if (!needsDependencies && lockfile === null) {
    return notRequiredEntry('go', 'go:modules', manifest);
  }
  if (lockfile === null) {
    return unsupportedEntry(
      'go',
      'go:modules',
      manifest,
      null,
      'candidate_bootstrap_lockfile_required',
    );
  }
  const recipe = candidateBootstrapRecipeFor('go', lockfile.path);
  if (recipe === null) {
    return unsupportedEntry(
      'go',
      'go:modules',
      manifest,
      lockfile,
      'candidate_bootstrap_lockfile_unsupported',
    );
  }
  if (!await executableAvailable(recipe.executableName, pathEnvironment)) {
    return unsupportedEntry(
      'go',
      'go:modules',
      manifest,
      lockfile,
      'candidate_bootstrap_runtime_unavailable',
    );
  }
  return readyEntry('go', 'go:modules', manifest, lockfile);
}

function readyEntry(
  ecosystem: CandidateBootstrapEcosystemV1,
  ecosystemRef: string,
  manifest: StableFile,
  lockfile: StableFile,
): CandidateBootstrapPreflightEntryV1 {
  const recipe = candidateBootstrapRecipeFor(ecosystem, lockfile.path);
  if (recipe === null) {
    throw new Error('A ready bootstrap entry has no built-in recipe.');
  }
  return createCandidateBootstrapPreflightEntry({
    ecosystem,
    ecosystemRef,
    candidateRelativeCwd: '.',
    manifestPath: manifest.path,
    manifestDigest: manifest.digest,
    lockfilePath: lockfile.path,
    lockfileDigest: lockfile.digest,
    status: 'ready',
    reasonCode: 'candidate_bootstrap_confirmation_required',
    recipe,
  });
}

function notRequiredEntry(
  ecosystem: CandidateBootstrapEcosystemV1,
  ecosystemRef: string,
  manifest: StableFile,
): CandidateBootstrapPreflightEntryV1 {
  return createCandidateBootstrapPreflightEntry({
    ecosystem,
    ecosystemRef,
    candidateRelativeCwd: '.',
    manifestPath: manifest.path,
    manifestDigest: manifest.digest,
    lockfilePath: null,
    lockfileDigest: null,
    status: 'not_required',
    reasonCode: 'candidate_bootstrap_not_required',
    recipe: null,
  });
}

function unsupportedEntry(
  ecosystem: CandidateBootstrapEcosystemV1,
  ecosystemRef: string,
  manifest: StableFile,
  lockfile: StableFile | null,
  reasonCode: Exclude<
    CandidateBootstrapPreflightEntryV1['reasonCode'],
    | 'candidate_bootstrap_confirmation_required'
    | 'candidate_bootstrap_not_required'
  >,
): CandidateBootstrapPreflightEntryV1 {
  return createCandidateBootstrapPreflightEntry({
    ecosystem,
    ecosystemRef,
    candidateRelativeCwd: '.',
    manifestPath: manifest.path,
    manifestDigest: manifest.digest,
    lockfilePath: lockfile?.path ?? null,
    lockfileDigest: lockfile?.digest ?? null,
    status: 'unsupported',
    reasonCode,
    recipe: null,
  });
}

function requiredEcosystems(
  gatePlan: GatePlan,
): Set<CandidateBootstrapEcosystemV1> {
  const required = new Set<CandidateBootstrapEcosystemV1>();
  for (const check of gatePlan.requiredChecks) {
    const locator = check.sourceLocator?.split('#', 1)[0] ?? '';
    const command = check.executionCommand.trim();
    if (locator.endsWith('package.json')
      || /^(?:bun|node|npm|npx|pnpm|yarn)(?:\s|$)/u.test(command)) {
      required.add('node');
    }
    if (/(?:^|\/)(?:pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini)$/u
      .test(locator)
      || /^(?:mypy|py(?:test|thon)|python3|ruff)(?:\s|$)/u.test(command)) {
      required.add('python');
    }
    if (locator.endsWith('Cargo.toml')
      || /^(?:cargo|rustc)(?:\s|$)/u.test(command)) {
      required.add('rust');
    }
    if (locator.endsWith('go.mod')
      || /^(?:go|golangci-lint)(?:\s|$)/u.test(command)) {
      required.add('go');
    }
  }
  return required;
}

async function presentEcosystems(
  workspace: string,
): Promise<CandidateBootstrapEcosystemV1[]> {
  const probes = await Promise.all([
    readStableFileOrNull(workspace, 'go.mod'),
    readStableFileOrNull(workspace, 'package.json'),
    Promise.any(PYTHON_MANIFESTS.map(
      (name) => readStableFileOrNull(workspace, name).then(
        (file) => file ?? Promise.reject(new Error('absent')),
      ),
    )).catch(() => null),
    readStableFileOrNull(workspace, 'Cargo.toml'),
  ]);
  return ALL_ECOSYSTEMS.filter((_, index) => probes[index] !== null);
}

function inspectHashedWheelRequirements(
  text: string,
): 'empty' | 'ready' | 'unsupported' {
  const lines = text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return 'empty';
  if (lines.some((line) =>
    line.startsWith('-')
    || line.includes(';')
    || line.includes('://')
    || !/^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?==[^\s\\]+(?:\s+--hash=sha256:[a-f0-9]{64})+$/u
      .test(line))) {
    return 'unsupported';
  }
  return 'ready';
}

function isSupportedPackageLock(bytes: Buffer): boolean {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return false;
  }
  if (!isRecord(value)
    || (value['lockfileVersion'] !== 2 && value['lockfileVersion'] !== 3)
    || !isRecord(value['packages'])) {
    return false;
  }
  for (const [path, metadata] of Object.entries(value['packages'])) {
    if (path === '') continue;
    if (!isRecord(metadata) || metadata['link'] === true) return false;
    const resolved = metadata['resolved'];
    if (resolved !== undefined
      && (typeof resolved !== 'string'
        || !resolved.startsWith('https://registry.npmjs.org/'))) {
      return false;
    }
    if (resolved !== undefined
      && (typeof metadata['integrity'] !== 'string'
        || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/u
          .test(metadata['integrity']))) {
      return false;
    }
  }
  return true;
}

function isSupportedCargoLock(bytes: Buffer): boolean {
  const text = bytes.toString('utf8');
  if (!/^version\s*=\s*[34]\s*$/mu.test(text)) return false;
  const sources = [...text.matchAll(
    /^\s*source\s*=\s*"([^"]+)"\s*$/gmu,
  )].map((match) => match[1]!);
  return sources.every((source) =>
    source === 'registry+https://github.com/rust-lang/crates.io-index'
    || source === 'registry+https://index.crates.io/');
}

async function executableAvailable(
  name: string,
  pathEnvironment: string,
): Promise<boolean> {
  for (const directory of pathEnvironment.split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const extensions = process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => extension.length > 0)
      : [];
    const candidates = [
      join(directory, name),
      ...extensions.map((extension) =>
        join(directory, `${name}${extension.toLowerCase()}`)),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate, fsConstants.X_OK);
        const info = await lstat(candidate);
        if (info.isFile() || info.isSymbolicLink()) return true;
      } catch {}
    }
  }
  return false;
}

async function readStableFileOrNull(
  workspace: string,
  path: string,
): Promise<StableFile | null> {
  const requested = resolve(workspace, path);
  if (!isInside(workspace, requested)) {
    pathUnsafe('A bootstrap input path escaped the source workspace.');
  }
  let before;
  try {
    before = await lstat(requested, { bigint: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw new CandidateBootstrapPreflightInspectorError(
      'candidate_bootstrap_preflight_path_unsafe',
      'A bootstrap input could not be inspected safely.',
      { cause: error },
    );
  }
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || before.size > BigInt(MAX_BOOTSTRAP_INPUT_BYTES)
    || await realpath(requested) !== requested) {
    pathUnsafe('A bootstrap input is not a bounded regular file.');
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(requested, fsConstants.O_RDONLY | noFollow);
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || bytes.byteLength !== Number(after.size)) {
      pathUnsafe('A bootstrap input changed while it was read.');
    }
    return Object.freeze({
      path,
      bytes,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  } finally {
    await handle.close();
  }
}

async function assertSnapshotCurrent(
  workspace: string,
  snapshot: SourceSnapshotV1,
): Promise<void> {
  const inspected = await inspectSourceSnapshot({
    cwd: workspace,
    selectedUntrackedPaths: snapshot.includedUntracked.map(
      (entry) => entry.canonicalRelativePath,
    ),
    limits: snapshot.snapshotLimits,
  });
  if (inspected.status !== 'ready'
    || inspected.proposedSnapshot === null
    || !sourceSnapshotMatches(snapshot, inspected.proposedSnapshot)) {
    throw new CandidateBootstrapPreflightInspectorError(
      'candidate_bootstrap_preflight_source_drift',
      'The source snapshot changed during bootstrap preflight.',
    );
  }
}

function assertInput(
  input: InspectCandidateBootstrapPreflightInputV1,
): void {
  if (!isRecord(input)
    || typeof input.sourceSnapshotCwd !== 'string'
    || input.sourceSnapshotCwd.length === 0
    || !validateSourceSnapshot(input.sourceSnapshot)
    || !isGatePlan(input.gatePlan)
    || (input.pathEnvironment !== undefined
      && typeof input.pathEnvironment !== 'string')) {
    throw new CandidateBootstrapPreflightInspectorError(
      'candidate_bootstrap_preflight_invalid_input',
      'The candidate bootstrap preflight input is invalid.',
    );
  }
}

function isGatePlan(value: unknown): value is GatePlan {
  if (!isRecord(value)
    || value['schemaVersion'] !== 1
    || value['stopCondition'] !== 'proof-pass'
    || !Array.isArray(value['requiredChecks'])
    || !Array.isArray(value['excludedChecks'])
    || typeof value['builtinRiskScanPolicyVersion'] !== 'string'
    || !isDigest(value['planDigest'])) {
    return false;
  }
  const { planDigest: _planDigest, ...core } = value;
  const encoded = JSON.stringify(core);
  return encoded.length <= 128 * 1024
    && canonicalDigest('wukong/gate-plan/v1', core)
      === value['planDigest'];
}

function packageManagerForLockfile(lockfile: string): string {
  if (lockfile.startsWith('pnpm-')) return 'pnpm';
  if (lockfile.startsWith('yarn.')) return 'yarn';
  if (lockfile.startsWith('bun.')) return 'bun';
  return 'unsupported';
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function pathUnsafe(message: string): never {
  throw new CandidateBootstrapPreflightInspectorError(
    'candidate_bootstrap_preflight_path_unsafe',
    message,
  );
}
