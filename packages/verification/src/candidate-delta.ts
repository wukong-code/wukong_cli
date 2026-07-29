import { canonicalDigest, canonicalJson } from './finish-line';

export interface CandidateProjectionEntryV1 {
  readonly schemaVersion: 1;
  readonly canonicalRelativePath: string;
  readonly mode: 0o100644 | 0o100755;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  readonly entryDigest: string;
}

export interface CandidateProjectionV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly sourceSnapshotDigest: string;
  readonly materializedSourceDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly generatedScopesDigest: string;
  readonly entries: readonly CandidateProjectionEntryV1[];
  readonly projectionDigest: string;
}

export type CandidateChangeOperationV1 =
  | 'create'
  | 'update'
  | 'delete'
  | 'rename'
  | 'mode';

export interface CandidateChangeV1 {
  readonly schemaVersion: 1;
  readonly changeIndex: number;
  readonly operation: CandidateChangeOperationV1;
  readonly sourcePath: string | null;
  readonly targetPath: string | null;
  readonly preimage: CandidateProjectionEntryV1 | null;
  readonly postimage: CandidateProjectionEntryV1 | null;
  readonly changeDigest: string;
}

export interface CandidateChangeManifestV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly baselineProjectionDigest: string;
  readonly candidateWorkspaceDigest: string;
  readonly changes: readonly CandidateChangeV1[];
  readonly changedPaths: readonly string[];
  readonly orderedChangeManifestDigest: string;
}

export interface CandidateDeltaV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly leaseId: string;
  readonly sourceSnapshotDigest: string;
  readonly materializedSourceDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly candidateWorkspaceDigest: string;
  readonly changedPaths: readonly string[];
  readonly orderedChangeManifestDigest: string;
  readonly agentDeltaDigest: string;
  readonly candidateDeltaDigest: string;
}

export interface CandidateDeltaBundleV1 {
  readonly manifest: CandidateChangeManifestV1;
  readonly delta: CandidateDeltaV1;
}

export interface CreateCandidateProjectionInputV1 {
  readonly candidateId: string;
  readonly leaseId: string;
  readonly sourceSnapshotDigest: string;
  readonly materializedSourceDigest: string;
  readonly bootstrapPlanDigest: string;
  readonly generatedScopesDigest: string;
  readonly entries: readonly Omit<
    CandidateProjectionEntryV1,
    'schemaVersion' | 'entryDigest'
  >[];
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PORTABLE_SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000]+$/u;
const MAX_ENTRIES = 200_000;
const MAX_PATH_BYTES = 4_096;
const MAX_SEGMENT_BYTES = 255;
const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;

export function createCandidateProjection(
  input: CreateCandidateProjectionInputV1,
): CandidateProjectionV1 {
  assertProjectionBinding(input);
  if (!Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) {
    throw new TypeError('The candidate projection entry list is invalid.');
  }
  const entries = input.entries.map((entry) => createProjectionEntry(entry))
    .toSorted((left, right) =>
      compareText(
        left.canonicalRelativePath,
        right.canonicalRelativePath,
      ));
  if (entries.some((entry, index) =>
    index > 0
    && entries[index - 1]?.canonicalRelativePath
      === entry.canonicalRelativePath)) {
    throw new TypeError('The candidate projection contains duplicate paths.');
  }
  if (hasPortablePathCollision(entries)) {
    throw new TypeError(
      'The candidate projection contains non-portable path aliases.',
    );
  }
  const core = {
    schemaVersion: 1 as const,
    candidateId: input.candidateId,
    leaseId: input.leaseId,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    materializedSourceDigest: input.materializedSourceDigest,
    bootstrapPlanDigest: input.bootstrapPlanDigest,
    generatedScopesDigest: input.generatedScopesDigest,
    entries: Object.freeze(entries),
  };
  return Object.freeze({
    ...core,
    projectionDigest: canonicalDigest(
      'wukong/candidate-projection/v1',
      core,
    ),
  });
}

export function createCandidateDelta(
  baseline: CandidateProjectionV1,
  candidate: CandidateProjectionV1,
): CandidateDeltaBundleV1 {
  if (!validateCandidateProjection(baseline)
    || !validateCandidateProjection(candidate)
    || !sameProjectionBinding(baseline, candidate)) {
    throw new TypeError('Candidate projections cannot form one delta.');
  }
  const changes = buildChanges(baseline.entries, candidate.entries);
  const changedPaths = [...new Set(changes.flatMap((change) => [
    ...(change.sourcePath === null ? [] : [change.sourcePath]),
    ...(change.targetPath === null ? [] : [change.targetPath]),
  ]))].toSorted();
  const manifestCore = {
    schemaVersion: 1 as const,
    candidateId: baseline.candidateId,
    leaseId: baseline.leaseId,
    baselineProjectionDigest: baseline.projectionDigest,
    candidateWorkspaceDigest: candidate.projectionDigest,
    changes,
    changedPaths,
  };
  const manifest = Object.freeze({
    ...manifestCore,
    orderedChangeManifestDigest: canonicalDigest(
      'wukong/candidate-change-manifest/v1',
      manifestCore,
    ),
  });
  const agentDeltaDigest = canonicalDigest(
    'wukong/candidate-agent-delta/v1',
    {
      materializedSourceDigest: baseline.materializedSourceDigest,
      baselineProjectionDigest: baseline.projectionDigest,
      candidateWorkspaceDigest: candidate.projectionDigest,
      orderedChangeManifestDigest: manifest.orderedChangeManifestDigest,
    },
  );
  const deltaCore = {
    schemaVersion: 1 as const,
    candidateId: baseline.candidateId,
    leaseId: baseline.leaseId,
    sourceSnapshotDigest: baseline.sourceSnapshotDigest,
    materializedSourceDigest: baseline.materializedSourceDigest,
    bootstrapPlanDigest: baseline.bootstrapPlanDigest,
    candidateWorkspaceDigest: candidate.projectionDigest,
    changedPaths,
    orderedChangeManifestDigest: manifest.orderedChangeManifestDigest,
    agentDeltaDigest,
  };
  const delta = Object.freeze({
    ...deltaCore,
    candidateDeltaDigest: canonicalDigest(
      'wukong/candidate-delta/v1',
      deltaCore,
    ),
  });
  return Object.freeze({ manifest, delta });
}

export function validateCandidateProjection(
  value: unknown,
): value is CandidateProjectionV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'bootstrapPlanDigest',
      'candidateId',
      'entries',
      'generatedScopesDigest',
      'leaseId',
      'materializedSourceDigest',
      'projectionDigest',
      'schemaVersion',
      'sourceSnapshotDigest',
    ])
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['candidateId']))
    || !UUID.test(String(value['leaseId']))
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['materializedSourceDigest'])
    || !isDigest(value['bootstrapPlanDigest'])
    || !isDigest(value['generatedScopesDigest'])
    || !isDigest(value['projectionDigest'])
    || !Array.isArray(value['entries'])
    || value['entries'].length > MAX_ENTRIES
    || value['entries'].some((entry) => !validateProjectionEntry(entry))) {
    return false;
  }
  const projection = value as unknown as CandidateProjectionV1;
  if (projection.entries.some((entry, index) =>
    index > 0
    && projection.entries[index - 1]!.canonicalRelativePath
      >= entry.canonicalRelativePath)) {
    return false;
  }
  if (hasPortablePathCollision(projection.entries)) return false;
  const { projectionDigest, ...core } = projection;
  return canonicalDigest('wukong/candidate-projection/v1', core)
    === projectionDigest;
}

export function validateCandidateChangeManifest(
  value: unknown,
): value is CandidateChangeManifestV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'baselineProjectionDigest',
      'candidateId',
      'candidateWorkspaceDigest',
      'changedPaths',
      'changes',
      'leaseId',
      'orderedChangeManifestDigest',
      'schemaVersion',
    ])
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['candidateId']))
    || !UUID.test(String(value['leaseId']))
    || !isDigest(value['baselineProjectionDigest'])
    || !isDigest(value['candidateWorkspaceDigest'])
    || !isDigest(value['orderedChangeManifestDigest'])
    || !Array.isArray(value['changes'])
    || value['changes'].length > MAX_ENTRIES * 2
    || value['changes'].some((change, index) =>
      !validateChange(change, index))
    || !isSortedUniquePathList(value['changedPaths'])) {
    return false;
  }
  const manifest = value as unknown as CandidateChangeManifestV1;
  const expectedPaths = [...new Set(manifest.changes.flatMap((change) => [
    ...(change.sourcePath === null ? [] : [change.sourcePath]),
    ...(change.targetPath === null ? [] : [change.targetPath]),
  ]))].toSorted();
  const { orderedChangeManifestDigest, ...core } = manifest;
  return canonicalJson(expectedPaths) === canonicalJson(manifest.changedPaths)
    && canonicalDigest('wukong/candidate-change-manifest/v1', core)
      === orderedChangeManifestDigest;
}

export function validateCandidateDelta(
  value: unknown,
): value is CandidateDeltaV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'agentDeltaDigest',
      'bootstrapPlanDigest',
      'candidateDeltaDigest',
      'candidateId',
      'candidateWorkspaceDigest',
      'changedPaths',
      'leaseId',
      'materializedSourceDigest',
      'orderedChangeManifestDigest',
      'schemaVersion',
      'sourceSnapshotDigest',
    ])
    || value['schemaVersion'] !== 1
    || !UUID.test(String(value['candidateId']))
    || !UUID.test(String(value['leaseId']))
    || !isDigest(value['sourceSnapshotDigest'])
    || !isDigest(value['materializedSourceDigest'])
    || !isDigest(value['bootstrapPlanDigest'])
    || !isDigest(value['candidateWorkspaceDigest'])
    || !isSortedUniquePathList(value['changedPaths'])
    || !isDigest(value['orderedChangeManifestDigest'])
    || !isDigest(value['agentDeltaDigest'])
    || !isDigest(value['candidateDeltaDigest'])) {
    return false;
  }
  const delta = value as unknown as CandidateDeltaV1;
  const { candidateDeltaDigest, ...core } = delta;
  return canonicalDigest('wukong/candidate-delta/v1', core)
    === candidateDeltaDigest;
}

function createProjectionEntry(
  input: Omit<CandidateProjectionEntryV1, 'schemaVersion' | 'entryDigest'>,
): CandidateProjectionEntryV1 {
  if (!isPortablePath(input.canonicalRelativePath)
    || (input.mode !== 0o100644 && input.mode !== 0o100755)
    || !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes < 0
    || input.sizeBytes > MAX_FILE_BYTES
    || !isDigest(input.contentDigest)) {
    throw new TypeError('A candidate projection entry is invalid.');
  }
  const core = {
    schemaVersion: 1 as const,
    canonicalRelativePath: input.canonicalRelativePath,
    mode: input.mode,
    sizeBytes: input.sizeBytes,
    contentDigest: input.contentDigest,
  };
  return Object.freeze({
    ...core,
    entryDigest: canonicalDigest(
      'wukong/candidate-projection-entry/v1',
      core,
    ),
  });
}

function validateProjectionEntry(
  value: unknown,
): value is CandidateProjectionEntryV1 {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'canonicalRelativePath',
      'contentDigest',
      'entryDigest',
      'mode',
      'schemaVersion',
      'sizeBytes',
    ])
    || value['schemaVersion'] !== 1
    || !isPortablePath(value['canonicalRelativePath'])
    || (value['mode'] !== 0o100644 && value['mode'] !== 0o100755)
    || !Number.isSafeInteger(value['sizeBytes'])
    || Number(value['sizeBytes']) < 0
    || Number(value['sizeBytes']) > MAX_FILE_BYTES
    || !isDigest(value['contentDigest'])
    || !isDigest(value['entryDigest'])) {
    return false;
  }
  const entry = value as unknown as CandidateProjectionEntryV1;
  const { entryDigest, ...core } = entry;
  return canonicalDigest('wukong/candidate-projection-entry/v1', core)
    === entryDigest;
}

function buildChanges(
  baseline: readonly CandidateProjectionEntryV1[],
  candidate: readonly CandidateProjectionEntryV1[],
): readonly CandidateChangeV1[] {
  const baselineByPath = new Map(
    baseline.map((entry) => [entry.canonicalRelativePath, entry]),
  );
  const candidateByPath = new Map(
    candidate.map((entry) => [entry.canonicalRelativePath, entry]),
  );
  const preliminary: Array<{
    readonly operation: CandidateChangeOperationV1;
    readonly sourcePath: string | null;
    readonly targetPath: string | null;
    readonly preimage: CandidateProjectionEntryV1 | null;
    readonly postimage: CandidateProjectionEntryV1 | null;
  }> = [];
  const deleted: CandidateProjectionEntryV1[] = [];
  const created: CandidateProjectionEntryV1[] = [];
  for (const entry of baseline) {
    const next = candidateByPath.get(entry.canonicalRelativePath);
    if (next === undefined) {
      deleted.push(entry);
    } else if (entry.contentDigest !== next.contentDigest
      || entry.sizeBytes !== next.sizeBytes) {
      preliminary.push({
        operation: 'update',
        sourcePath: entry.canonicalRelativePath,
        targetPath: next.canonicalRelativePath,
        preimage: entry,
        postimage: next,
      });
    } else if (entry.mode !== next.mode) {
      preliminary.push({
        operation: 'mode',
        sourcePath: entry.canonicalRelativePath,
        targetPath: next.canonicalRelativePath,
        preimage: entry,
        postimage: next,
      });
    }
  }
  for (const entry of candidate) {
    if (!baselineByPath.has(entry.canonicalRelativePath)) created.push(entry);
  }
  const remainingCreated = new Set(created.map(({ canonicalRelativePath }) =>
    canonicalRelativePath));
  for (const source of deleted) {
    const target = created.find((entry) =>
      remainingCreated.has(entry.canonicalRelativePath)
      && entry.contentDigest === source.contentDigest
      && entry.sizeBytes === source.sizeBytes
      && entry.mode === source.mode);
    if (target === undefined) continue;
    remainingCreated.delete(target.canonicalRelativePath);
    preliminary.push({
      operation: 'rename',
      sourcePath: source.canonicalRelativePath,
      targetPath: target.canonicalRelativePath,
      preimage: source,
      postimage: target,
    });
  }
  const renamedSources = new Set(preliminary.flatMap((change) =>
    change.operation === 'rename' && change.sourcePath !== null
      ? [change.sourcePath]
      : []));
  for (const entry of deleted) {
    if (renamedSources.has(entry.canonicalRelativePath)) continue;
    preliminary.push({
      operation: 'delete',
      sourcePath: entry.canonicalRelativePath,
      targetPath: null,
      preimage: entry,
      postimage: null,
    });
  }
  for (const entry of created) {
    if (!remainingCreated.has(entry.canonicalRelativePath)) continue;
    preliminary.push({
      operation: 'create',
      sourcePath: null,
      targetPath: entry.canonicalRelativePath,
      preimage: null,
      postimage: entry,
    });
  }
  preliminary.sort(compareChanges);
  return Object.freeze(preliminary.map((change, changeIndex) => {
    const core = {
      schemaVersion: 1 as const,
      changeIndex,
      ...change,
    };
    return Object.freeze({
      ...core,
      changeDigest: canonicalDigest('wukong/candidate-change/v1', core),
    });
  }));
}

function compareChanges(
  left: {
    readonly operation: CandidateChangeOperationV1;
    readonly sourcePath: string | null;
    readonly targetPath: string | null;
  },
  right: {
    readonly operation: CandidateChangeOperationV1;
    readonly sourcePath: string | null;
    readonly targetPath: string | null;
  },
): number {
  const leftKey = `${left.sourcePath ?? ''}\0${left.targetPath ?? ''}\0${left.operation}`;
  const rightKey = `${right.sourcePath ?? ''}\0${right.targetPath ?? ''}\0${right.operation}`;
  return compareText(leftKey, rightKey);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateChange(value: unknown, expectedIndex: number): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'changeDigest',
      'changeIndex',
      'operation',
      'postimage',
      'preimage',
      'schemaVersion',
      'sourcePath',
      'targetPath',
    ])
    || value['schemaVersion'] !== 1
    || value['changeIndex'] !== expectedIndex
    || !['create', 'update', 'delete', 'rename', 'mode']
      .includes(String(value['operation']))
    || (value['sourcePath'] !== null
      && !isPortablePath(value['sourcePath']))
    || (value['targetPath'] !== null
      && !isPortablePath(value['targetPath']))
    || (value['preimage'] !== null
      && !validateProjectionEntry(value['preimage']))
    || (value['postimage'] !== null
      && !validateProjectionEntry(value['postimage']))
    || !isDigest(value['changeDigest'])) {
    return false;
  }
  const change = value as unknown as CandidateChangeV1;
  if ((change.operation === 'create'
      && (change.sourcePath !== null
        || change.preimage !== null
        || change.targetPath === null
        || change.postimage === null))
    || (change.operation === 'delete'
      && (change.sourcePath === null
        || change.preimage === null
        || change.targetPath !== null
        || change.postimage !== null))
    || ((change.operation === 'update'
        || change.operation === 'mode'
        || change.operation === 'rename')
      && (change.sourcePath === null
        || change.preimage === null
        || change.targetPath === null
        || change.postimage === null))) {
    return false;
  }
  const { changeDigest, ...core } = change;
  return canonicalDigest('wukong/candidate-change/v1', core)
    === changeDigest;
}

function assertProjectionBinding(
  input: Omit<CreateCandidateProjectionInputV1, 'entries'>,
): void {
  if (!UUID.test(input.candidateId)
    || !UUID.test(input.leaseId)
    || !isDigest(input.sourceSnapshotDigest)
    || !isDigest(input.materializedSourceDigest)
    || !isDigest(input.bootstrapPlanDigest)
    || !isDigest(input.generatedScopesDigest)) {
    throw new TypeError('The candidate projection binding is invalid.');
  }
}

function sameProjectionBinding(
  left: CandidateProjectionV1,
  right: CandidateProjectionV1,
): boolean {
  return left.candidateId === right.candidateId
    && left.leaseId === right.leaseId
    && left.sourceSnapshotDigest === right.sourceSnapshotDigest
    && left.materializedSourceDigest === right.materializedSourceDigest
    && left.bootstrapPlanDigest === right.bootstrapPlanDigest
    && left.generatedScopesDigest === right.generatedScopesDigest;
}

function isSortedUniquePathList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_ENTRIES * 2
    && value.every((path, index) =>
      isPortablePath(path)
      && (index === 0 || String(value[index - 1]) < path));
}

function isPortablePath(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) =>
    PORTABLE_SEGMENT.test(segment)
    && Buffer.byteLength(segment, 'utf8') <= MAX_SEGMENT_BYTES
    && segment !== '.git'
    && segment !== '.wukong');
}

function hasPortablePathCollision(
  entries: readonly CandidateProjectionEntryV1[],
): boolean {
  const seen = new Set<string>();
  for (const { canonicalRelativePath } of entries) {
    const portableIdentity = canonicalRelativePath
      .normalize('NFC')
      .toLowerCase();
    if (seen.has(portableIdentity)) return true;
    seen.add(portableIdentity);
  }
  return false;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).toSorted().join(',') === [...keys].toSorted().join(',');
}
