import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { canonicalDigest, canonicalJson } from './finish-line';

export const VERIFICATION_CATALOG_POLICY_VERSION = 'verification-catalog/1';
export const VERIFICATION_SUGGESTION_POLICY_VERSION = 'verification-path-glob/1';
export const VERIFICATION_CRITERIA_ACCESS_POLICY_VERSION = 'verification-criteria-access/1';

const MAX_SKILL_MD_BYTES = 64 * 1024;
const MAX_SIDECAR_BYTES = 32 * 1024;
const MAX_CRITERIA = 16;
const REVIEW_SCOPE_MATCH_LIMIT = 500;
const PACKAGE_CRITERIA_SCAN_LIMIT = 500;
const PACKAGE_CRITERIA_SCAN_DEPTH = 8;
const MAX_TEXT_LENGTH = 1_000;
const MAX_EVIDENCE_LENGTH = 1_000;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const RECIPE_KEYS = new Set([
  'schemaVersion',
  'kind',
  'id',
  'description',
  'scope',
  'criteria',
]);
const SCOPE_KEYS = new Set(['kind', 'packagePath', 'paths']);
const CRITERION_KEYS = new Set(['id', 'text', 'evidence']);
const FORBIDDEN_RECIPE_KEYS = new Set([
  'steps',
  'commands',
  'scripts',
  'tools',
  'permissions',
  'hooks',
  'model',
  'agent',
  'mcp',
]);
const PACKAGE_MARKERS = [
  'Cargo.toml',
  'go.mod',
  'package.json',
  'pyproject.toml',
] as const;
const PACKAGE_SCAN_SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.wukong',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);
const runtimeBuiltinRoots = new Map<string, VerificationCriteriaSourceRootV1>();

export interface VerificationCriterionDeclarationV1 {
  readonly id: string;
  readonly text: string;
  readonly evidence: string;
}

export type VerificationCriteriaScopeV1 =
  | {
      readonly kind: 'personal';
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'project';
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'package';
      readonly packagePath: string;
      readonly paths: readonly string[];
    };

export interface VerificationCriteriaRecipeV1 {
  readonly schemaVersion: 1;
  readonly kind: 'wukong.verification-criteria';
  readonly id: string;
  readonly description: string;
  readonly scope: VerificationCriteriaScopeV1;
  readonly criteria: readonly VerificationCriterionDeclarationV1[];
}

interface VerificationCriteriaRefBaseV1 {
  readonly format: 'agent-skills';
  readonly skillName: string;
  readonly criteriaId: string;
  readonly logicalLocator: string;
  readonly skillMdDigest: string;
  readonly criteriaDigest: string;
  readonly provenanceDigest: string;
}

export type VerificationCriteriaRefV1 =
  | (VerificationCriteriaRefBaseV1 & {
      readonly source: { readonly kind: 'personal' };
      readonly sourceTrust: {
        readonly kind: 'personal-local';
        readonly rootIdentityDigest: string;
        readonly ownerIdentityDigest: string;
        readonly accessPolicyVersion: string;
        readonly accessControlDigest: string;
      };
    })
  | (VerificationCriteriaRefBaseV1 & {
      readonly source: { readonly kind: 'project' };
      readonly sourceTrust: {
        readonly kind: 'workspace';
        readonly workspaceIdentityDigest: string;
        readonly scope: 'verification-criteria-source';
      };
    })
  | (VerificationCriteriaRefBaseV1 & {
      readonly source: {
        readonly kind: 'package';
        readonly packagePath: string;
      };
      readonly sourceTrust: {
        readonly kind: 'workspace';
        readonly workspaceIdentityDigest: string;
        readonly scope: 'verification-criteria-source';
      };
    })
  | (VerificationCriteriaRefBaseV1 & {
      readonly source: {
        readonly kind: 'extra';
        readonly sourceId: string;
      };
      readonly sourceTrust: {
        readonly kind: 'extra-local-grant';
        readonly sourceId: string;
        readonly trustGrantId: string;
        readonly rootIdentityDigest: string;
      };
    })
  | (VerificationCriteriaRefBaseV1 & {
      readonly source: {
        readonly kind: 'builtin';
        readonly version: string;
      };
      readonly sourceTrust: {
        readonly kind: 'builtin-release';
        readonly version: string;
        readonly assetDigest: string;
      };
    });

export interface SelectedVerificationCriteriaRefV1 {
  readonly selectionOrder: number;
  readonly ref: VerificationCriteriaRefV1;
}

export interface VerificationCriteriaSelectionV1 {
  readonly schemaVersion: 1;
  readonly preflightCatalogDigest: string;
  readonly selected: readonly SelectedVerificationCriteriaRefV1[];
  readonly selectionDigest: string;
}

export interface VerificationCriteriaCatalogEntryV1 {
  readonly selectionId: string;
  readonly ref: VerificationCriteriaRefV1;
  readonly recipe: VerificationCriteriaRecipeV1;
  readonly status: 'valid' | 'collision';
}

export interface VerificationCriteriaCatalogFailureV1 {
  readonly logicalLocator: string;
  readonly reasonCode:
    | 'verification_criteria_invalid'
    | 'verification_criteria_untrusted'
    | 'verification_criteria_collision';
  readonly message: string;
}

export interface VerificationCriteriaSuggestionV1 {
  readonly selectionId: string;
  readonly provenanceDigest: string;
  readonly matchedRuleId: string;
  readonly matchedRuleVersion: string;
  readonly matchingPathCount: number;
  readonly matchingPaths: readonly string[];
  readonly source: VerificationCriteriaRefV1['source'];
  readonly scope: VerificationCriteriaScopeV1;
}

export interface VerificationCriteriaCatalogV1 {
  readonly schemaVersion: 1;
  readonly policyVersion: string;
  readonly entries: readonly VerificationCriteriaCatalogEntryV1[];
  readonly failures: readonly VerificationCriteriaCatalogFailureV1[];
  readonly suggestions: readonly VerificationCriteriaSuggestionV1[];
  readonly catalogDigest: string;
}

export type VerificationCriteriaSourceRootV1 =
  | {
      readonly kind: 'personal';
      readonly root: string;
    }
  | {
      readonly kind: 'project';
      readonly root: string;
      readonly workspaceIdentityDigest: string;
    }
  | {
      readonly kind: 'package';
      readonly root: string;
      readonly packagePath: string;
      readonly workspaceIdentityDigest: string;
    }
  | {
      readonly kind: 'extra';
      readonly root: string;
      readonly sourceId: string;
      readonly trustGrantId: string;
      readonly rootIdentityDigest: string;
    }
  | {
      readonly kind: 'builtin';
      readonly root: string;
      readonly version: string;
      readonly assetDigest: string;
    };

export interface DiscoverVerificationCriteriaOptions {
  readonly workspaceRoot: string;
  readonly roots: readonly VerificationCriteriaSourceRootV1[];
  readonly changedPaths?: readonly string[];
  readonly caseInsensitive?: boolean;
}

export function registerBuiltinVerificationCriteriaRoot(
  root: Extract<VerificationCriteriaSourceRootV1, { readonly kind: 'builtin' }>,
): void {
  runtimeBuiltinRoots.set(`${root.version}:${root.assetDigest}`, root);
}

export function clearBuiltinVerificationCriteriaRootsForTests(): void {
  runtimeBuiltinRoots.clear();
}

export async function digestVerificationCriteriaAssetRoot(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const files: Array<{ readonly path: string; readonly sha256: string }> = [];
  for (const skillDir of await listSkillDirectories(canonicalRoot)) {
    const skillName = basename(skillDir);
    for (const logicalPath of ['SKILL.md', 'verification/criteria.v1.json'] as const) {
      const path = join(skillDir, logicalPath);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new VerificationCriteriaError(
          'verification_criteria_untrusted',
          'Builtin criteria assets must contain only regular manifest files.',
        );
      }
      files.push({
        path: `${skillName}/${logicalPath}`,
        sha256: digestRaw('wukong/builtin-criteria-file/v1', await readFile(path)),
      });
    }
  }
  return canonicalDigest(
    'wukong/builtin-criteria-assets/v1',
    files.toSorted((left, right) => left.path.localeCompare(right.path)),
  );
}

export async function discoverPackageVerificationCriteriaRoots(options: {
  readonly workspaceRoot: string;
  readonly workspaceIdentityDigest: string;
}): Promise<readonly VerificationCriteriaSourceRootV1[]> {
  const workspaceRoot = await realpath(options.workspaceRoot);
  const roots: VerificationCriteriaSourceRootV1[] = [];
  let visitedDirectories = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (
      depth > PACKAGE_CRITERIA_SCAN_DEPTH
      || visitedDirectories >= PACKAGE_CRITERIA_SCAN_LIMIT
    ) return;
    visitedDirectories += 1;
    if (directory !== workspaceRoot && await isPackageDirectory(directory)) {
      const skillsRoot = join(directory, '.wukong', 'skills');
      try {
        const info = await lstat(skillsRoot);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          roots.push({
            kind: 'package',
            root: skillsRoot,
            packagePath: normalizeLogicalPath(relative(workspaceRoot, directory)),
            workspaceIdentityDigest: options.workspaceIdentityDigest,
          });
        }
      } catch {
        // Package-local criteria are optional.
      }
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (
        visitedDirectories >= PACKAGE_CRITERIA_SCAN_LIMIT
        || !entry.isDirectory()
        || entry.isSymbolicLink()
        || PACKAGE_SCAN_SKIPPED_DIRECTORIES.has(entry.name)
      ) continue;
      await walk(join(directory, entry.name), depth + 1);
    }
  };
  await walk(workspaceRoot, 0);
  return roots.toSorted((left, right) =>
    left.kind === 'package' && right.kind === 'package'
      ? left.packagePath.localeCompare(right.packagePath)
      : 0);
}

export class VerificationCriteriaError extends Error {
  constructor(
    readonly reasonCode:
      | 'verification_criteria_invalid'
      | 'verification_criteria_untrusted'
      | 'verification_criteria_collision'
      | 'verification_catalog_changed'
      | 'verification_criteria_missing'
      | 'verification_criteria_changed'
      | 'verification_selection_limit',
    message: string,
  ) {
    super(message);
    this.name = 'VerificationCriteriaError';
  }
}

export interface ResolveSelectedVerificationCriteriaOptions {
  readonly workspaceRoot: string;
  readonly selection: VerificationCriteriaSelectionV1;
  readonly sourceRoots?: readonly VerificationCriteriaSourceRootV1[];
  readonly personalRoot?: string;
}

/**
 * Re-read only the frozen selection. Unselected catalog drift is intentionally
 * ignored after contract creation.
 */
export async function resolveSelectedVerificationCriteria(
  options: ResolveSelectedVerificationCriteriaOptions,
): Promise<readonly VerificationCriteriaCatalogEntryV1[]> {
  validateVerificationCriteriaSelection(options.selection);
  const roots = options.sourceRoots
    ? selectedSourceRoots(
        options.workspaceRoot,
        options.selection,
        options.personalRoot,
        [...options.sourceRoots, ...runtimeBuiltinRoots.values()],
      )
    : selectedSourceRoots(
        options.workspaceRoot,
        options.selection,
        options.personalRoot,
        [...runtimeBuiltinRoots.values()],
      );
  const catalog = await discoverVerificationCriteriaCatalog({
    workspaceRoot: options.workspaceRoot,
    roots,
  });
  const byIdentity = new Map(
    catalog.entries.map((entry) => [selectionIdentity(entry.ref), entry]),
  );
  return options.selection.selected.map(({ ref }) => {
    const identity = selectionIdentity(ref);
    const entry = byIdentity.get(identity);
    if (entry === undefined) {
      const failure = catalog.failures.find(
        (candidate) => candidate.logicalLocator === ref.logicalLocator,
      );
      throw new VerificationCriteriaError(
        failure?.reasonCode === 'verification_criteria_untrusted'
          ? 'verification_criteria_untrusted'
          : 'verification_criteria_missing',
        failure?.message ?? `Selected verification criteria is missing: ${identity}`,
      );
    }
    if (entry.ref.provenanceDigest !== ref.provenanceDigest) {
      throw new VerificationCriteriaError(
        'verification_criteria_changed',
        `Selected verification criteria changed: ${identity}`,
      );
    }
    return entry;
  });
}

/**
 * Resolve regular workspace files covered by the exact selected recipe scopes.
 * The broker applies the final hard exclusions, secret scan, and consent limits.
 */
export async function resolveVerificationScopePaths(options: {
  readonly workspaceRoot: string;
  readonly recipes: readonly VerificationCriteriaRecipeV1[];
}): Promise<readonly string[]> {
  if (options.recipes.length === 0) return [];
  const workspaceRoot = await realpath(options.workspaceRoot);
  const matched = new Set<string>();
  const skippedDirectories = new Set([
    '.git', '.next', '.nuxt', '.wukong', 'build', 'coverage', 'dist',
    'node_modules', 'out', 'target', 'vendor',
  ]);
  const walk = async (directory: string): Promise<void> => {
    if (matched.size > REVIEW_SCOPE_MATCH_LIMIT) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (matched.size > REVIEW_SCOPE_MATCH_LIMIT) return;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const logicalPath = normalizeLogicalPath(relative(workspaceRoot, absolutePath));
      if (options.recipes.some((recipe) => scopeMatchesPath(recipe.scope, logicalPath))) {
        matched.add(logicalPath);
      }
    }
  };
  await walk(workspaceRoot);
  return [...matched].toSorted();
}

export async function discoverVerificationCriteriaCatalog(
  options: DiscoverVerificationCriteriaOptions,
): Promise<VerificationCriteriaCatalogV1> {
  const workspaceRealpath = await realpath(options.workspaceRoot);
  const entries: VerificationCriteriaCatalogEntryV1[] = [];
  const failures: VerificationCriteriaCatalogFailureV1[] = [];
  const seenLocators = new Map<string, string>();

  for (const sourceRoot of options.roots) {
    const rootResult = await validateSourceRoot(sourceRoot, workspaceRealpath);
    if (!rootResult.ok) {
      failures.push({
        logicalLocator: sourceLogicalRoot(sourceRoot),
        reasonCode: 'verification_criteria_untrusted',
        message: rootResult.message,
      });
      continue;
    }
    const skillDirs = await listSkillDirectories(rootResult.rootRealpath);
    for (const skillDir of skillDirs) {
      const logicalLocator = logicalSkillLocator(sourceRoot, basename(skillDir));
      const collisionKey = options.caseInsensitive === true
        ? logicalLocator.toLocaleLowerCase('en-US')
        : logicalLocator;
      const prior = seenLocators.get(collisionKey);
      if (prior !== undefined && prior !== logicalLocator) {
        failures.push({
          logicalLocator,
          reasonCode: 'verification_criteria_collision',
          message: `Case-fold collision with ${prior}`,
        });
        continue;
      }
      seenLocators.set(collisionKey, logicalLocator);
      try {
        const entry = await readCatalogEntry({
          sourceRoot,
          rootRealpath: rootResult.rootRealpath,
          skillDir,
          logicalLocator,
        });
        if (entry !== undefined) entries.push(entry);
      } catch (error) {
        const classified = error instanceof VerificationCriteriaError
          ? error
          : new VerificationCriteriaError(
              'verification_criteria_invalid',
              error instanceof Error ? error.message : String(error),
            );
        failures.push({
          logicalLocator,
          reasonCode: classified.reasonCode === 'verification_criteria_untrusted'
            ? classified.reasonCode
            : 'verification_criteria_invalid',
          message: classified.message,
        });
      }
    }
  }

  const collisionNames = new Set<string>();
  const byName = new Map<string, VerificationCriteriaCatalogEntryV1[]>();
  for (const entry of entries) {
    const list = byName.get(entry.ref.skillName) ?? [];
    list.push(entry);
    byName.set(entry.ref.skillName, list);
  }
  for (const [name, list] of byName) {
    if (list.length > 1) collisionNames.add(name);
  }
  const finalizedEntries = entries
    .map((entry) => collisionNames.has(entry.ref.skillName)
      ? { ...entry, status: 'collision' as const }
      : entry)
    .toSorted(compareCatalogEntry);
  for (const name of [...collisionNames].toSorted()) {
    failures.push({
      logicalLocator: name,
      reasonCode: 'verification_criteria_collision',
      message: `Multiple criteria sources define skill "${name}"; select an exact identity.`,
    });
  }
  const finalizedFailures = failures.toSorted((left, right) =>
    left.logicalLocator.localeCompare(right.logicalLocator)
      || left.reasonCode.localeCompare(right.reasonCode));
  const changedPaths = normalizeChangedPaths(options.changedPaths ?? []);
  const suggestions = finalizedEntries
    .filter((entry) => entry.status === 'valid')
    .flatMap((entry) => suggestionFor(entry, changedPaths))
    .toSorted((left, right) => left.selectionId.localeCompare(right.selectionId));
  const digestInput = {
    policyVersion: VERIFICATION_CATALOG_POLICY_VERSION,
    entries: finalizedEntries.map((entry) => ({
      ref: entry.ref,
      status: entry.status,
    })),
    failures: finalizedFailures,
  };
  return {
    schemaVersion: 1,
    policyVersion: VERIFICATION_CATALOG_POLICY_VERSION,
    entries: finalizedEntries,
    failures: finalizedFailures,
    suggestions,
    catalogDigest: canonicalDigest('wukong/verification-catalog/v1', digestInput),
  };
}

export function createVerificationCriteriaSelection(
  catalog: VerificationCriteriaCatalogV1,
  requested: readonly {
    readonly selectionId: string;
    readonly provenanceDigest: string;
  }[],
  expectedCatalogDigest: string,
): VerificationCriteriaSelectionV1 {
  if (expectedCatalogDigest !== catalog.catalogDigest) {
    throw new VerificationCriteriaError(
      'verification_catalog_changed',
      'Verification criteria catalog changed after preflight.',
    );
  }
  if (requested.length === 0 || requested.length > MAX_CRITERIA) {
    throw new VerificationCriteriaError(
      'verification_selection_limit',
      `Select between 1 and ${String(MAX_CRITERIA)} verification recipes.`,
    );
  }
  const byId = new Map(catalog.entries.map((entry) => [entry.selectionId, entry]));
  const seen = new Set<string>();
  const selected = requested.map((request, selectionOrder) => {
    if (seen.has(request.selectionId)) {
      throw new VerificationCriteriaError(
        'verification_selection_limit',
        `Duplicate verification criteria selection: ${request.selectionId}`,
      );
    }
    seen.add(request.selectionId);
    const entry = byId.get(request.selectionId);
    if (entry === undefined) {
      throw new VerificationCriteriaError(
        'verification_criteria_collision',
        `Verification criteria selection is missing or invalid: ${request.selectionId}`,
      );
    }
    if (entry.ref.provenanceDigest !== request.provenanceDigest) {
      throw new VerificationCriteriaError(
        'verification_catalog_changed',
        `Verification criteria provenance changed: ${request.selectionId}`,
      );
    }
    return { selectionOrder, ref: entry.ref };
  });
  const selectionCore = selected.map(({ selectionOrder, ref }) => ({ selectionOrder, ref }));
  return {
    schemaVersion: 1,
    preflightCatalogDigest: expectedCatalogDigest,
    selected,
    selectionDigest: canonicalDigest('wukong/verification-selection/v1', selectionCore),
  };
}

export function validateVerificationCriteriaSelection(
  selection: VerificationCriteriaSelectionV1,
): void {
  if (
    selection.schemaVersion !== 1
    || selection.selected.length === 0
    || selection.selected.length > MAX_CRITERIA
  ) {
    throw new VerificationCriteriaError(
      'verification_selection_limit',
      'Invalid verification criteria selection.',
    );
  }
  const seen = new Set<string>();
  for (const [index, selected] of selection.selected.entries()) {
    if (selected.selectionOrder !== index) {
      throw new VerificationCriteriaError(
        'verification_selection_limit',
        'Verification criteria selection order must be contiguous and match array order.',
      );
    }
    validateRefPairing(selected.ref);
    const identity = selectionIdentity(selected.ref);
    if (seen.has(identity)) {
      throw new VerificationCriteriaError(
        'verification_selection_limit',
        `Duplicate verification criteria identity: ${identity}`,
      );
    }
    seen.add(identity);
    const { provenanceDigest, ...provenanceCore } = selected.ref;
    if (
      canonicalDigest('wukong/verification-criteria-ref/v1', provenanceCore)
      !== provenanceDigest
    ) {
      throw new VerificationCriteriaError(
        'verification_catalog_changed',
        `Verification criteria provenance digest mismatch: ${identity}`,
      );
    }
  }
  const expected = canonicalDigest(
    'wukong/verification-selection/v1',
    selection.selected.map(({ selectionOrder, ref }) => ({ selectionOrder, ref })),
  );
  if (expected !== selection.selectionDigest) {
    throw new VerificationCriteriaError(
      'verification_catalog_changed',
      'Verification criteria selection digest mismatch.',
    );
  }
}

export function parseVerificationCriteriaRecipe(
  value: unknown,
): VerificationCriteriaRecipeV1 {
  if (!isRecord(value)) invalid('Sidecar must be a JSON object.');
  assertExactKeys(value, RECIPE_KEYS, 'recipe');
  for (const key of FORBIDDEN_RECIPE_KEYS) {
    if (key in value) invalid(`Forbidden recipe field: ${key}`);
  }
  if (value['schemaVersion'] !== 1 || value['kind'] !== 'wukong.verification-criteria') {
    invalid('Sidecar must use schemaVersion 1 and kind wukong.verification-criteria.');
  }
  const id = strictId(value['id'], 'recipe id');
  const description = boundedText(value['description'], 'description', MAX_TEXT_LENGTH);
  const scope = parseScope(value['scope']);
  const rawCriteria = value['criteria'];
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0 || rawCriteria.length > MAX_CRITERIA) {
    invalid(`criteria must contain 1-${String(MAX_CRITERIA)} entries.`);
  }
  const seen = new Set<string>();
  const criteria = rawCriteria.map((entry, index) => {
    if (!isRecord(entry)) invalid(`criteria[${String(index)}] must be an object.`);
    assertExactKeys(entry, CRITERION_KEYS, `criteria[${String(index)}]`);
    const criterionId = strictId(entry['id'], `criteria[${String(index)}].id`);
    if (seen.has(criterionId)) invalid(`Duplicate criterion id: ${criterionId}`);
    seen.add(criterionId);
    return {
      id: criterionId,
      text: boundedText(entry['text'], 'criterion text', MAX_TEXT_LENGTH),
      evidence: boundedText(entry['evidence'], 'criterion evidence', MAX_EVIDENCE_LENGTH),
    };
  });
  return {
    schemaVersion: 1,
    kind: 'wukong.verification-criteria',
    id,
    description,
    scope,
    criteria,
  };
}

function parseScope(value: unknown): VerificationCriteriaScopeV1 {
  if (!isRecord(value)) invalid('scope must be an object.');
  assertExactKeys(value, SCOPE_KEYS, 'scope', value['kind'] === 'package'
    ? undefined
    : new Set(['packagePath']));
  const kind = value['kind'];
  if (kind !== 'personal' && kind !== 'project' && kind !== 'package') {
    invalid('scope.kind must be personal, project, or package.');
  }
  const paths = value['paths'];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64) {
    invalid('scope.paths must contain 1-64 logical path globs.');
  }
  const normalizedPaths = paths.map((entry) => safeLogicalPath(entry, 'scope path', true));
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    invalid('scope.paths must not contain duplicates.');
  }
  if (kind === 'package') {
    return {
      kind,
      packagePath: safeLogicalPath(value['packagePath'], 'packagePath', false),
      paths: normalizedPaths,
    };
  }
  return { kind, paths: normalizedPaths };
}

async function readCatalogEntry(input: {
  readonly sourceRoot: VerificationCriteriaSourceRootV1;
  readonly rootRealpath: string;
  readonly skillDir: string;
  readonly logicalLocator: string;
}): Promise<VerificationCriteriaCatalogEntryV1 | undefined> {
  const skillMdPath = join(input.skillDir, 'SKILL.md');
  const skillMdStat = await lstat(skillMdPath);
  if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      'SKILL.md must be a regular file and cannot be a symlink.',
    );
  }
  if (skillMdStat.size > MAX_SKILL_MD_BYTES) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      `SKILL.md exceeds ${String(MAX_SKILL_MD_BYTES)} bytes.`,
    );
  }
  const skillMd = await readFile(skillMdPath, 'utf8');
  const frontmatter = extractFrontmatter(skillMd);
  const skillName = yamlScalar(frontmatter, 'name') ?? basename(input.skillDir);
  const criteriaPath = criteriaSidecarPath(frontmatter);
  if (criteriaPath === undefined) return undefined;
  const sidecarLogical = safeLogicalPath(criteriaPath, 'criteria sidecar path', false);
  if (sidecarLogical !== 'verification/criteria.v1.json') {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      'Verification criteria sidecar must be verification/criteria.v1.json.',
    );
  }
  const sidecarPath = resolve(input.skillDir, sidecarLogical);
  const sidecarRealpath = await realpath(sidecarPath);
  if (!isContained(input.skillDir, sidecarRealpath)) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      'Verification criteria sidecar escapes its Skill directory.',
    );
  }
  const sidecarStat = await lstat(sidecarPath);
  if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      'Verification criteria sidecar must be a regular file and cannot be a symlink.',
    );
  }
  if (sidecarStat.size > MAX_SIDECAR_BYTES) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      `Verification criteria sidecar exceeds ${String(MAX_SIDECAR_BYTES)} bytes.`,
    );
  }
  if (input.sourceRoot.kind === 'personal') {
    await validatePersonalAccess([input.rootRealpath, input.skillDir, skillMdPath, sidecarPath]);
  }
  const sidecarText = await readFile(sidecarPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(sidecarText);
  } catch (error) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      `Invalid verification criteria JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const recipe = parseVerificationCriteriaRecipe(parsed);
  if (recipe.id !== skillName) {
    throw new VerificationCriteriaError(
      'verification_criteria_invalid',
      `Recipe id "${recipe.id}" must match Skill name "${skillName}".`,
    );
  }
  validateRecipeScopeForSource(recipe.scope, input.sourceRoot);
  const skillMdDigest = digestRaw(
    'wukong/skill-md/v1',
    skillMd.replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
  );
  const criteriaDigest = canonicalDigest('wukong/verification-criteria/v1', recipe);
  const refCore = {
    format: 'agent-skills' as const,
    skillName,
    criteriaId: recipe.id,
    logicalLocator: input.logicalLocator,
    skillMdDigest,
    criteriaDigest,
    ...sourceAndTrust(input.sourceRoot),
  };
  const ref: VerificationCriteriaRefV1 = {
    ...refCore,
    provenanceDigest: canonicalDigest('wukong/verification-criteria-ref/v1', refCore),
  } as VerificationCriteriaRefV1;
  validateRefPairing(ref);
  return {
    selectionId: selectionIdentity(ref),
    ref,
    recipe,
    status: 'valid',
  };
}

async function validateSourceRoot(
  sourceRoot: VerificationCriteriaSourceRootV1,
  workspaceRealpath: string,
): Promise<{ readonly ok: true; readonly rootRealpath: string } | {
  readonly ok: false;
  readonly message: string;
}> {
  try {
    const rootStat = await lstat(sourceRoot.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, message: 'Criteria source root must be a regular directory.' };
    }
    const rootRealpath = await realpath(sourceRoot.root);
    if (
      (sourceRoot.kind === 'project' || sourceRoot.kind === 'package')
      && !isContained(workspaceRealpath, rootRealpath)
    ) {
      return { ok: false, message: 'Workspace criteria source escapes the confirmed workspace.' };
    }
    if (sourceRoot.kind === 'personal') await validatePersonalAccess([rootRealpath]);
    if (sourceRoot.kind === 'extra') {
      const info = await lstat(rootRealpath);
      const rootIdentityDigest = canonicalDigest('wukong/extra-criteria-root/v1', {
        canonicalRealpath: rootRealpath,
        device: info.dev,
        inode: info.ino,
      });
      if (rootIdentityDigest !== sourceRoot.rootIdentityDigest) {
        return { ok: false, message: 'Extra criteria source root identity changed after trust.' };
      }
    }
    if (
      sourceRoot.kind === 'builtin'
      && await digestVerificationCriteriaAssetRoot(rootRealpath) !== sourceRoot.assetDigest
    ) {
      return { ok: false, message: 'Builtin criteria release asset digest mismatch.' };
    }
    return { ok: true, rootRealpath };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function listSkillDirectories(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: string[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillMd = join(root, entry.name, 'SKILL.md');
    try {
      if ((await stat(skillMd)).isFile()) skills.push(join(root, entry.name));
    } catch {
      continue;
    }
  }
  return skills;
}

function sourceAndTrust(
  sourceRoot: VerificationCriteriaSourceRootV1,
): Pick<VerificationCriteriaRefV1, 'source' | 'sourceTrust'> {
  switch (sourceRoot.kind) {
    case 'project':
      return {
        source: { kind: 'project' },
        sourceTrust: {
          kind: 'workspace',
          workspaceIdentityDigest: sourceRoot.workspaceIdentityDigest,
          scope: 'verification-criteria-source',
        },
      };
    case 'package':
      return {
        source: { kind: 'package', packagePath: normalizeLogicalPath(sourceRoot.packagePath) },
        sourceTrust: {
          kind: 'workspace',
          workspaceIdentityDigest: sourceRoot.workspaceIdentityDigest,
          scope: 'verification-criteria-source',
        },
      };
    case 'extra':
      return {
        source: { kind: 'extra', sourceId: sourceRoot.sourceId },
        sourceTrust: {
          kind: 'extra-local-grant',
          sourceId: sourceRoot.sourceId,
          trustGrantId: sourceRoot.trustGrantId,
          rootIdentityDigest: sourceRoot.rootIdentityDigest,
        },
      };
    case 'builtin':
      return {
        source: { kind: 'builtin', version: sourceRoot.version },
        sourceTrust: {
          kind: 'builtin-release',
          version: sourceRoot.version,
          assetDigest: sourceRoot.assetDigest,
        },
      };
    case 'personal': {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      return {
        source: { kind: 'personal' },
        sourceTrust: {
          kind: 'personal-local',
          rootIdentityDigest: canonicalDigest('wukong/personal-criteria-root/v1', {
            locator: '~/.wukong/skills',
          }),
          ownerIdentityDigest: canonicalDigest('wukong/local-owner/v1', { uid }),
          accessPolicyVersion: VERIFICATION_CRITERIA_ACCESS_POLICY_VERSION,
          accessControlDigest: canonicalDigest('wukong/personal-criteria-access/v1', {
            owner: uid,
            policyVersion: VERIFICATION_CRITERIA_ACCESS_POLICY_VERSION,
          }),
        },
      };
    }
  }
}

function validateRefPairing(ref: VerificationCriteriaRefV1): void {
  const { source, sourceTrust } = ref;
  const paired = (
    (source.kind === 'personal' && sourceTrust.kind === 'personal-local')
    || (
      (source.kind === 'project' || source.kind === 'package')
      && sourceTrust.kind === 'workspace'
      && sourceTrust.scope === 'verification-criteria-source'
    )
    || (
      source.kind === 'extra'
      && sourceTrust.kind === 'extra-local-grant'
      && source.sourceId === sourceTrust.sourceId
    )
    || (
      source.kind === 'builtin'
      && sourceTrust.kind === 'builtin-release'
      && source.version === sourceTrust.version
    )
  );
  if (!paired) {
    throw new VerificationCriteriaError(
      'verification_criteria_untrusted',
      'Verification criteria source and trust binding do not match.',
    );
  }
}

function validateRecipeScopeForSource(
  scope: VerificationCriteriaScopeV1,
  source: VerificationCriteriaSourceRootV1,
): void {
  if (scope.kind === 'personal' && source.kind !== 'personal') {
    invalid('personal scope is only valid for personal criteria sources.');
  }
  if (scope.kind === 'package') {
    if (source.kind !== 'package') invalid('package scope requires a package criteria source.');
    if (
      source.kind === 'package'
      && normalizeLogicalPath(source.packagePath) !== scope.packagePath
    ) {
      invalid('package scope packagePath must match the package source.');
    }
  }
}

async function validatePersonalAccess(paths: readonly string[]): Promise<void> {
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const path of paths) {
    const info = await lstat(path);
    if (expectedUid !== undefined && info.uid !== expectedUid) {
      throw new VerificationCriteriaError(
        'verification_criteria_untrusted',
        `Personal criteria path is not owned by the current user: ${basename(path)}`,
      );
    }
    if ((info.mode & 0o022) !== 0) {
      throw new VerificationCriteriaError(
        'verification_criteria_untrusted',
        `Personal criteria path is group/world writable: ${basename(path)}`,
      );
    }
  }
}

async function isPackageDirectory(directory: string): Promise<boolean> {
  for (const marker of PACKAGE_MARKERS) {
    try {
      if ((await lstat(join(directory, marker))).isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function sourceLogicalRoot(source: VerificationCriteriaSourceRootV1): string {
  switch (source.kind) {
    case 'personal': return '~/.wukong/skills';
    case 'project': return '.wukong/skills';
    case 'package': return `${normalizeLogicalPath(source.packagePath)}/.wukong/skills`;
    case 'extra': return `extra:${source.sourceId}`;
    case 'builtin': return `builtin:${source.version}`;
  }
}

function logicalSkillLocator(
  source: VerificationCriteriaSourceRootV1,
  skillName: string,
): string {
  return `${sourceLogicalRoot(source)}/${skillName}`;
}

function selectionIdentity(ref: VerificationCriteriaRefV1): string {
  return `${sourceIdentity(ref.source)}:${ref.logicalLocator}:${ref.skillName}`;
}

function sourceIdentity(source: VerificationCriteriaRefV1['source']): string {
  switch (source.kind) {
    case 'personal':
    case 'project':
      return source.kind;
    case 'package':
      return `package:${source.packagePath}`;
    case 'extra':
      return `extra:${source.sourceId}`;
    case 'builtin':
      return `builtin:${source.version}`;
  }
}

function suggestionFor(
  entry: VerificationCriteriaCatalogEntryV1,
  changedPaths: readonly string[],
): readonly VerificationCriteriaSuggestionV1[] {
  if (changedPaths.length === 0) return [];
  const scope = entry.recipe.scope;
  const scopedPaths = scope.kind === 'package'
    ? changedPaths
        .filter((path) => path === scope.packagePath
          || path.startsWith(`${scope.packagePath}/`))
        .map((path) => path.slice(scope.packagePath.length).replace(/^\/+/u, ''))
    : changedPaths;
  const matching = scopedPaths
    .filter((path) => scope.paths.some((glob) => matchLogicalGlob(path, glob)))
    .toSorted();
  if (matching.length === 0) return [];
  return [{
    selectionId: entry.selectionId,
    provenanceDigest: entry.ref.provenanceDigest,
    matchedRuleId: 'scope-path',
    matchedRuleVersion: VERIFICATION_SUGGESTION_POLICY_VERSION,
    matchingPathCount: matching.length,
    matchingPaths: matching.slice(0, 20),
    source: entry.ref.source,
    scope,
  }];
}

function matchLogicalGlob(path: string, glob: string): boolean {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      const followedBySlash = glob[index + 2] === '/';
      pattern += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${pattern}$`, 'u').test(path);
}

function scopeMatchesPath(
  scope: VerificationCriteriaScopeV1,
  logicalPath: string,
): boolean {
  if (scope.kind !== 'package') {
    return scope.paths.some((glob) => matchLogicalGlob(logicalPath, glob));
  }
  if (
    logicalPath !== scope.packagePath
    && !logicalPath.startsWith(`${scope.packagePath}/`)
  ) {
    return false;
  }
  const packagePath = logicalPath
    .slice(scope.packagePath.length)
    .replace(/^\/+/u, '');
  return scope.paths.some((glob) => matchLogicalGlob(packagePath, glob));
}

function selectedSourceRoots(
  workspaceRoot: string,
  selection: VerificationCriteriaSelectionV1,
  personalRoot: string | undefined,
  trustedRoots: readonly VerificationCriteriaSourceRootV1[],
): readonly VerificationCriteriaSourceRootV1[] {
  const roots = new Map<string, VerificationCriteriaSourceRootV1>();
  for (const { ref } of selection.selected) {
    let root: VerificationCriteriaSourceRootV1;
    const source = ref.source;
    const sourceTrust = ref.sourceTrust;
    switch (source.kind) {
      case 'project':
        root = {
          kind: 'project',
          root: join(workspaceRoot, '.wukong', 'skills'),
          workspaceIdentityDigest: ref.sourceTrust.kind === 'workspace'
            ? ref.sourceTrust.workspaceIdentityDigest
            : '',
        };
        break;
      case 'package':
        root = {
          kind: 'package',
          root: join(workspaceRoot, source.packagePath, '.wukong', 'skills'),
          packagePath: source.packagePath,
          workspaceIdentityDigest: ref.sourceTrust.kind === 'workspace'
            ? ref.sourceTrust.workspaceIdentityDigest
            : '',
        };
        break;
      case 'personal':
        root = {
          kind: 'personal',
          root: personalRoot ?? join(homedir(), '.wukong', 'skills'),
        };
        break;
      case 'extra': {
        const exact = trustedRoots.find((candidate) => (
          candidate.kind === 'extra'
          && candidate.sourceId === source.sourceId
          && sourceTrust.kind === 'extra-local-grant'
          && candidate.trustGrantId === sourceTrust.trustGrantId
          && candidate.rootIdentityDigest === sourceTrust.rootIdentityDigest
        ));
        if (exact?.kind !== 'extra') {
          throw new VerificationCriteriaError(
            'verification_criteria_untrusted',
            'Selected extra criteria source grant is missing, changed, or revoked.',
          );
        }
        root = exact;
        break;
      }
      case 'builtin': {
        const exact = trustedRoots.find((candidate) => (
          candidate.kind === 'builtin'
          && candidate.version === source.version
          && sourceTrust.kind === 'builtin-release'
          && candidate.assetDigest === sourceTrust.assetDigest
        ));
        if (exact?.kind !== 'builtin') {
          throw new VerificationCriteriaError(
            'verification_criteria_untrusted',
            'Selected builtin criteria asset is missing or does not match this release.',
          );
        }
        root = exact;
        break;
      }
    }
    roots.set(sourceLogicalRoot(root), root);
  }
  return [...roots.values()];
}

function normalizeChangedPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => normalizeLogicalPath(path))
    .filter((path) => path !== ''))].toSorted();
}

function extractFrontmatter(markdown: string): string {
  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (!normalized.startsWith('---\n')) invalid('SKILL.md must contain YAML frontmatter.');
  const close = normalized.indexOf('\n---\n', 4);
  if (close === -1) invalid('SKILL.md frontmatter is not closed.');
  return normalized.slice(4, close);
}

function criteriaSidecarPath(frontmatter: string): string | undefined {
  const lines = frontmatter.split('\n');
  const metadataLine = lines.findIndex((line) => line.trim() === 'metadata:');
  if (metadataLine === -1) return undefined;
  for (let index = metadataLine + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\S/u.test(line)) break;
    const match = /^\s{2,}wukong\.verification\.criteria:\s*(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) return stripYamlScalar(match[1]);
  }
  return undefined;
}

function yamlScalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'mu').exec(frontmatter);
  return match?.[1] === undefined ? undefined : stripYamlScalar(match[1]);
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function safeLogicalPath(value: unknown, label: string, allowGlob: boolean): string {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  const normalized = normalizeLogicalPath(value);
  if (
    normalized === ''
    || isAbsolute(value)
    || value.includes('\\')
    || value.split('/').includes('..')
    || CONTROL_CHARACTER.test(value)
    || (!allowGlob && /[*?[\]{}]/u.test(value))
  ) {
    invalid(`${label} must be a safe POSIX logical path.`);
  }
  return normalized;
}

function normalizeLogicalPath(value: string): string {
  return posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//u, '');
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maxLength
    || CONTROL_CHARACTER.test(value)
  ) {
    invalid(`${label} must contain 1-${String(maxLength)} visible characters.`);
  }
  return value.trim();
}

function strictId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    invalid(`${label} must use lowercase letters, digits, dots, underscores, or hyphens.`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  ignored: ReadonlySet<string> = new Set(),
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key) && !ignored.has(key));
  if (unknown.length > 0) invalid(`${label} contains unknown fields: ${unknown.toSorted().join(', ')}`);
  for (const key of allowed) {
    if (ignored.has(key)) continue;
    if (!(key in value)) invalid(`${label} is missing field: ${key}`);
  }
}

function compareCatalogEntry(
  left: VerificationCriteriaCatalogEntryV1,
  right: VerificationCriteriaCatalogEntryV1,
): number {
  return sourceIdentity(left.ref.source).localeCompare(sourceIdentity(right.ref.source))
    || left.ref.logicalLocator.localeCompare(right.ref.logicalLocator)
    || left.ref.skillName.localeCompare(right.ref.skillName);
}

function digestRaw(domain: string, value: string | Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')}`;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new VerificationCriteriaError('verification_criteria_invalid', message);
}

export function criteriaCatalogDebugJson(catalog: VerificationCriteriaCatalogV1): string {
  return canonicalJson(catalog);
}
