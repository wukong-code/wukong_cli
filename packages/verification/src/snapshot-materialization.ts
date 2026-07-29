import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { canonicalDigest, canonicalJson } from './finish-line';
import {
  validateSnapshotBlobLease,
  type SnapshotBlobLeaseV1,
} from './snapshot-blob-lease';
import {
  validateSourceSnapshot,
  type SourceSnapshotV1,
} from './source-snapshot';

export const SNAPSHOT_MATERIALIZATION_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_MATERIALIZATION_POLICY_VERSION =
  'mirror-source-index-and-worktree/1' as const;

export interface SnapshotCandidateMaterializationLimitsV1 {
  readonly maxBaseEntries: number;
  readonly maxBaseBlobBytes: number;
  readonly maxBaseTotalBytes: number;
}

export const SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS = {
  maxBaseEntries: 100_000,
  maxBaseBlobBytes: 64 * 1024 * 1024,
  maxBaseTotalBytes: 512 * 1024 * 1024,
} as const satisfies SnapshotCandidateMaterializationLimitsV1;

export const SNAPSHOT_MATERIALIZATION_POLICY = Object.freeze({
  policyVersion: SNAPSHOT_MATERIALIZATION_POLICY_VERSION,
  containerFormatVersion: SNAPSHOT_MATERIALIZATION_FORMAT_VERSION,
  indexPolicy: 'mirror-source-index-postimage',
  worktreePolicy: 'mirror-source-worktree-postimage',
  checkoutPolicy: 'detached-no-checkout',
  excludedTrackedPolicy: 'deny',
  excludedUntrackedPolicy: 'deny',
  selectedUntrackedPolicy: 'materialize-approved',
  fileTypes: Object.freeze(['regular']),
  archiveExtraction: false,
  limits: SNAPSHOT_CANDIDATE_MATERIALIZATION_LIMITS,
} as const);

export const SNAPSHOT_MATERIALIZATION_POLICY_DIGEST = canonicalDigest(
  'wukong/snapshot-materialization-policy/v1',
  SNAPSHOT_MATERIALIZATION_POLICY,
);

export interface SnapshotMaterializationLimitsV1 {
  readonly maxEntries: number;
  readonly maxManifestBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxImageBytes: number;
  readonly maxPathBytes: number;
  readonly maxPathSegmentBytes: number;
}

export const SNAPSHOT_MATERIALIZATION_LIMITS = {
  maxEntries: 4_096,
  maxManifestBytes: 2 * 1024 * 1024,
  maxPayloadBytes: 64 * 1024 * 1024,
  maxImageBytes: 16 * 1024 * 1024,
  maxPathBytes: 4_096,
  maxPathSegmentBytes: 255,
} as const satisfies SnapshotMaterializationLimitsV1;

export interface SnapshotMaterializationImageV1 {
  readonly mode: 0o100644 | 0o100755;
  readonly sizeBytes: number;
  readonly offsetBytes: number;
  readonly contentDigest: string;
  readonly imageDigest: string;
}

export interface SnapshotMaterializationEntryV1 {
  readonly canonicalRelativePath: string;
  readonly selectedUntracked: boolean;
  readonly indexObjectId: string | null;
  readonly indexImage: SnapshotMaterializationImageV1 | null;
  readonly worktreeImage: SnapshotMaterializationImageV1 | null;
  readonly entryDigest: string;
}

export interface SnapshotMaterializationManifestV1 {
  readonly schemaVersion: 1;
  readonly formatVersion: 1;
  readonly sourceSnapshotDigest: string;
  readonly snapshotPolicyDigest: string;
  readonly materializationPolicyDigest: string;
  readonly entries: readonly SnapshotMaterializationEntryV1[];
  readonly entryCount: number;
  readonly payloadSizeBytes: number;
  readonly manifestDigest: string;
}

export interface SnapshotMaterializationImageInputV1 {
  readonly mode: 0o100644 | 0o100755;
  readonly content: Uint8Array;
}

export interface SnapshotMaterializationEntryInputV1 {
  readonly canonicalRelativePath: string;
  readonly selectedUntracked: boolean;
  readonly indexObjectId: string | null;
  readonly indexImage: SnapshotMaterializationImageInputV1 | null;
  readonly worktreeImage: SnapshotMaterializationImageInputV1 | null;
}

export interface BuildSnapshotMaterializationContainerInputV1 {
  readonly sourceSnapshotDigest: string;
  readonly snapshotPolicyDigest: string;
  readonly materializationPolicyDigest: string;
  readonly entries: readonly SnapshotMaterializationEntryInputV1[];
}

export interface BuiltSnapshotMaterializationContainerV1 {
  readonly manifest: SnapshotMaterializationManifestV1;
  readonly containerBytes: Uint8Array;
}

export interface ParsedSnapshotMaterializationContainerV1 {
  readonly manifest: SnapshotMaterializationManifestV1;
  readonly payloadBytes: Uint8Array;
}

export type SnapshotMaterializationErrorCodeV1 =
  | 'snapshot_materialization_input_invalid'
  | 'snapshot_materialization_limit'
  | 'snapshot_materialization_header_invalid'
  | 'snapshot_materialization_manifest_invalid'
  | 'snapshot_materialization_manifest_noncanonical'
  | 'snapshot_materialization_digest_mismatch'
  | 'snapshot_materialization_payload_invalid';

export class SnapshotMaterializationError extends Error {
  constructor(
    readonly reasonCode: SnapshotMaterializationErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotMaterializationError';
  }
}

interface MutableEntry {
  readonly canonicalRelativePath: string;
  readonly selectedUntracked: boolean;
  readonly indexObjectId: string | null;
  readonly indexContent: MaterializationContent | null;
  readonly worktreeContent: MaterializationContent | null;
}

interface MaterializationContent {
  readonly mode: 0o100644 | 0o100755;
  readonly bytes: Buffer;
}

const CONTAINER_MAGIC = Buffer.from('WKSMAT01', 'ascii');
const CONTAINER_HEADER_BYTES = 24;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_KEYS = ['contentDigest', 'imageDigest', 'mode', 'offsetBytes', 'sizeBytes'] as const;
const ENTRY_KEYS = [
  'canonicalRelativePath',
  'entryDigest',
  'indexObjectId',
  'indexImage',
  'selectedUntracked',
  'worktreeImage',
] as const;
const MANIFEST_KEYS = [
  'entries',
  'entryCount',
  'formatVersion',
  'manifestDigest',
  'materializationPolicyDigest',
  'payloadSizeBytes',
  'schemaVersion',
  'snapshotPolicyDigest',
  'sourceSnapshotDigest',
] as const;

const CONTENT_DIGEST_DOMAIN = 'wukong/snapshot-file-content/v1';
const IMAGE_DIGEST_DOMAIN = 'wukong/snapshot-materialization-image/v1';
const ENTRY_DIGEST_DOMAIN = 'wukong/snapshot-materialization-entry/v1';
const MANIFEST_DIGEST_DOMAIN = 'wukong/snapshot-materialization-manifest/v1';
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function buildSnapshotMaterializationContainer(
  input: BuildSnapshotMaterializationContainerInputV1,
): BuiltSnapshotMaterializationContainerV1 {
  if (!isRecord(input) || !hasExactKeys(input, [
    'entries',
    'materializationPolicyDigest',
    'snapshotPolicyDigest',
    'sourceSnapshotDigest',
  ]) || !Array.isArray(input.entries)) {
    invalidInput('The materialization input has an invalid shape.');
  }
  assertDigest(input.sourceSnapshotDigest, 'sourceSnapshotDigest', invalidInput);
  assertDigest(input.snapshotPolicyDigest, 'snapshotPolicyDigest', invalidInput);
  assertDigest(
    input.materializationPolicyDigest,
    'materializationPolicyDigest',
    invalidInput,
  );
  if (input.entries.length > SNAPSHOT_MATERIALIZATION_LIMITS.maxEntries) {
    limitExceeded('The materialization entry limit was exceeded.');
  }

  const mutableEntries: MutableEntry[] = [];
  let declaredPayloadBytes = 0;
  for (const entry of input.entries) {
    const normalized = normalizeInputEntry(
      entry,
      SNAPSHOT_MATERIALIZATION_LIMITS.maxPayloadBytes - declaredPayloadBytes,
    );
    declaredPayloadBytes += (normalized.indexContent?.bytes.length ?? 0)
      + (normalized.worktreeContent?.bytes.length ?? 0);
    mutableEntries.push(normalized);
  }
  mutableEntries.sort((left, right) => compareCanonicalPaths(
    left.canonicalRelativePath,
    right.canonicalRelativePath,
  ));
  assertNoPortablePathCollisions(
    mutableEntries.map((entry) => entry.canonicalRelativePath),
    invalidInput,
  );

  const payloadParts: Buffer[] = [];
  const entries: SnapshotMaterializationEntryV1[] = [];
  let payloadSizeBytes = 0;
  for (const entry of mutableEntries) {
    const indexImage = freezeImage(entry.indexContent, payloadSizeBytes, payloadParts);
    payloadSizeBytes += indexImage?.sizeBytes ?? 0;
    const worktreeImage = freezeImage(
      entry.worktreeContent,
      payloadSizeBytes,
      payloadParts,
    );
    payloadSizeBytes += worktreeImage?.sizeBytes ?? 0;
    if (payloadSizeBytes > SNAPSHOT_MATERIALIZATION_LIMITS.maxPayloadBytes) {
      limitExceeded('The materialization payload limit was exceeded.');
    }
    const entryCore = {
      canonicalRelativePath: entry.canonicalRelativePath,
      selectedUntracked: entry.selectedUntracked,
      indexObjectId: entry.indexObjectId,
      indexImage,
      worktreeImage,
    };
    entries.push({
      ...entryCore,
      entryDigest: canonicalDigest(ENTRY_DIGEST_DOMAIN, entryCore),
    });
  }

  const manifestCore = {
    schemaVersion: 1 as const,
    formatVersion: SNAPSHOT_MATERIALIZATION_FORMAT_VERSION,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    snapshotPolicyDigest: input.snapshotPolicyDigest,
    materializationPolicyDigest: input.materializationPolicyDigest,
    entries,
    entryCount: entries.length,
    payloadSizeBytes,
  };
  const manifest: SnapshotMaterializationManifestV1 = {
    ...manifestCore,
    manifestDigest: canonicalDigest(MANIFEST_DIGEST_DOMAIN, manifestCore),
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  if (manifestBytes.length > SNAPSHOT_MATERIALIZATION_LIMITS.maxManifestBytes) {
    limitExceeded('The materialization manifest limit was exceeded.');
  }

  const header = Buffer.alloc(CONTAINER_HEADER_BYTES);
  CONTAINER_MAGIC.copy(header, 0);
  header.writeUInt32BE(SNAPSHOT_MATERIALIZATION_FORMAT_VERSION, 8);
  header.writeUInt32BE(manifestBytes.length, 12);
  header.writeBigUInt64BE(BigInt(payloadSizeBytes), 16);
  const containerBytes = Buffer.concat([
    header,
    manifestBytes,
    ...payloadParts,
  ]);
  return {
    manifest,
    containerBytes: Uint8Array.from(containerBytes),
  };
}

export function parseSnapshotMaterializationContainer(
  containerBytes: Uint8Array,
): ParsedSnapshotMaterializationContainerV1 {
  if (!(containerBytes instanceof Uint8Array)) {
    headerInvalid('The materialization container must be bytes.');
  }
  if (containerBytes.byteLength > CONTAINER_HEADER_BYTES
    + SNAPSHOT_MATERIALIZATION_LIMITS.maxManifestBytes
    + SNAPSHOT_MATERIALIZATION_LIMITS.maxPayloadBytes) {
    limitExceeded('The materialization container length exceeds the fixed limit.');
  }
  const bytes = Buffer.from(containerBytes);
  if (bytes.length < CONTAINER_HEADER_BYTES) {
    headerInvalid('The materialization container header is truncated.');
  }
  if (!bytes.subarray(0, CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC)) {
    headerInvalid('The materialization container magic is invalid.');
  }
  if (bytes.readUInt32BE(8) !== SNAPSHOT_MATERIALIZATION_FORMAT_VERSION) {
    headerInvalid('The materialization container format version is unsupported.');
  }
  const manifestSizeBytes = bytes.readUInt32BE(12);
  if (manifestSizeBytes === 0
    || manifestSizeBytes > SNAPSHOT_MATERIALIZATION_LIMITS.maxManifestBytes) {
    limitExceeded('The materialization manifest length is invalid.');
  }
  const payloadSizeBigInt = bytes.readBigUInt64BE(16);
  if (payloadSizeBigInt > BigInt(SNAPSHOT_MATERIALIZATION_LIMITS.maxPayloadBytes)) {
    limitExceeded('The materialization payload length is invalid.');
  }
  const payloadSizeBytes = Number(payloadSizeBigInt);
  const expectedSize = CONTAINER_HEADER_BYTES + manifestSizeBytes + payloadSizeBytes;
  if (bytes.length !== expectedSize) {
    headerInvalid('The materialization container is truncated or has appended bytes.');
  }

  const manifestStart = CONTAINER_HEADER_BYTES;
  const payloadStart = manifestStart + manifestSizeBytes;
  const encodedManifest = bytes.subarray(manifestStart, payloadStart);
  let manifestJson: string;
  try {
    manifestJson = UTF8_DECODER.decode(encodedManifest);
  } catch {
    manifestInvalid('The materialization manifest is not valid UTF-8.');
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestJson);
  } catch {
    manifestInvalid('The materialization manifest is not valid JSON.');
  }
  if (canonicalJson(manifestValue) !== manifestJson) {
    noncanonicalManifest('The materialization manifest JSON is not canonical.');
  }

  const payloadBytes = Uint8Array.from(bytes.subarray(payloadStart));
  assertValidManifest(manifestValue, payloadBytes);
  return {
    manifest: manifestValue,
    payloadBytes,
  };
}

export function validateSnapshotMaterializationManifest(
  value: unknown,
  payloadBytes: Uint8Array,
): value is SnapshotMaterializationManifestV1 {
  try {
    assertValidManifest(value, payloadBytes);
    return true;
  } catch {
    return false;
  }
}

export function validateSnapshotMaterializationContainer(
  containerBytes: Uint8Array,
): boolean {
  try {
    parseSnapshotMaterializationContainer(containerBytes);
    return true;
  } catch {
    return false;
  }
}

export function digestSnapshotMaterializationContainer(
  containerBytes: Uint8Array,
): string {
  if (!(containerBytes instanceof Uint8Array)) {
    invalidInput('The materialization container must be bytes.');
  }
  return `sha256:${createHash('sha256')
    .update('wukong/snapshot-blob-container/v1')
    .update('\0')
    .update(containerBytes)
    .digest('hex')}`;
}

export function validateSnapshotBlobLeaseContainerBinding(
  lease: SnapshotBlobLeaseV1,
  containerBytes: Uint8Array,
): boolean {
  if (!validateSnapshotBlobLease(lease)) return false;
  try {
    const parsed = parseSnapshotMaterializationContainer(containerBytes);
    return lease.payloadFormatVersion === parsed.manifest.formatVersion
      && lease.payloadSizeBytes === containerBytes.byteLength
      && lease.entryCount === parsed.manifest.entryCount
      && lease.sourceSnapshotDigest === parsed.manifest.sourceSnapshotDigest
      && lease.snapshotPolicyDigest === parsed.manifest.snapshotPolicyDigest
      && lease.materializationPolicyDigest
        === parsed.manifest.materializationPolicyDigest
      && lease.manifestDigest === parsed.manifest.manifestDigest
      && lease.contentDigest === digestSnapshotMaterializationContainer(containerBytes);
  } catch {
    return false;
  }
}

export function validateSnapshotMaterializationSourceBinding(
  snapshot: SourceSnapshotV1,
  manifest: SnapshotMaterializationManifestV1,
  payloadBytes: Uint8Array,
): boolean {
  if (!validateSourceSnapshot(snapshot)
    || !validateSnapshotMaterializationManifest(manifest, payloadBytes)
    || manifest.sourceSnapshotDigest !== snapshot.snapshotDigest
    || manifest.snapshotPolicyDigest !== snapshot.snapshotPolicyDigest) {
    return false;
  }

  const trackedProjection = manifest.entries
    .filter((entry) => !entry.selectedUntracked)
    .map((entry) => ({
      path: entry.canonicalRelativePath,
      index: entry.indexImage === null
        ? []
        : [{
            mode: entry.indexImage.mode.toString(8),
            objectId: entry.indexObjectId,
            stage: 0,
          }],
      worktree: entry.worktreeImage === null
        ? {
            presence: 'absent' as const,
            fileType: null,
            mode: null,
            sizeBytes: null,
            contentDigest: null,
            exclusionReason: null,
          }
        : {
            presence: 'present' as const,
            fileType: 'regular' as const,
            mode: entry.worktreeImage.mode,
            sizeBytes: entry.worktreeImage.sizeBytes,
            contentDigest: entry.worktreeImage.contentDigest,
            exclusionReason: null,
          },
    }));
  const trackedDeltaDigest = trackedProjection.length === 0
    ? null
    : canonicalDigest('wukong/source-tracked-delta/v1', trackedProjection);
  if (trackedDeltaDigest !== snapshot.trackedDeltaDigest) return false;

  const includedUntracked = manifest.entries
    .filter((entry) => entry.selectedUntracked)
    .map((entry) => {
      const image = entry.worktreeImage;
      if (image === null) return null;
      const core = {
        canonicalRelativePath: entry.canonicalRelativePath,
        mode: image.mode,
        sizeBytes: image.sizeBytes,
        contentDigest: image.contentDigest,
      };
      return {
        ...core,
        fileRefDigest: canonicalDigest('wukong/snapshot-file-ref/v1', core),
      };
    });
  return !includedUntracked.includes(null)
    && canonicalJson(includedUntracked) === canonicalJson(snapshot.includedUntracked);
}

export function validateSnapshotBlobLeaseSourceBinding(
  lease: SnapshotBlobLeaseV1,
  containerBytes: Uint8Array,
  snapshot: SourceSnapshotV1,
): boolean {
  if (!validateSnapshotBlobLeaseContainerBinding(lease, containerBytes)) return false;
  try {
    const parsed = parseSnapshotMaterializationContainer(containerBytes);
    return validateSnapshotMaterializationSourceBinding(
      snapshot,
      parsed.manifest,
      parsed.payloadBytes,
    );
  } catch {
    return false;
  }
}

function normalizeInputEntry(
  entry: SnapshotMaterializationEntryInputV1,
  remainingPayloadBytes: number,
): MutableEntry {
  if (!isRecord(entry) || !hasExactKeys(entry, [
    'canonicalRelativePath',
    'indexImage',
    'indexObjectId',
    'selectedUntracked',
    'worktreeImage',
  ])) {
    invalidInput('A materialization entry has an invalid shape.');
  }
  const canonicalRelativePath = assertCanonicalRelativePath(
    entry.canonicalRelativePath,
    invalidInput,
  );
  if (typeof entry.selectedUntracked !== 'boolean') {
    invalidInput('A materialization entry selectedUntracked flag is invalid.');
  }
  const selectedUntracked = entry.selectedUntracked;
  const indexContent = normalizeInputImage(
    entry.indexImage,
    'indexImage',
    remainingPayloadBytes,
  );
  const worktreeContent = normalizeInputImage(
    entry.worktreeImage,
    'worktreeImage',
    remainingPayloadBytes - (indexContent?.bytes.length ?? 0),
  );
  const indexObjectId = entry.indexObjectId;
  if (indexContent === null
    ? indexObjectId !== null
    : !isGitObjectId(indexObjectId)
      || digestGitBlob(indexContent.bytes, indexObjectId.length) !== indexObjectId) {
    invalidInput(`Materialization entry ${canonicalRelativePath} has an invalid index object.`);
  }
  if (selectedUntracked && (indexContent !== null || worktreeContent === null)) {
    invalidInput(
      `Selected untracked entry ${canonicalRelativePath} must only have a worktree image.`,
    );
  }
  return {
    canonicalRelativePath,
    selectedUntracked,
    indexObjectId,
    indexContent,
    worktreeContent,
  };
}

function normalizeInputImage(
  image: SnapshotMaterializationImageInputV1 | null,
  label: string,
  remainingPayloadBytes: number,
): MaterializationContent | null {
  if (image === null) return null;
  if (!isRecord(image) || !hasExactKeys(image, ['content', 'mode'])) {
    invalidInput(`${label} has an invalid shape.`);
  }
  const mode = assertMode(image.mode, invalidInput);
  if (!(image.content instanceof Uint8Array)) {
    invalidInput(`${label}.content must be bytes.`);
  }
  if (image.content.byteLength > SNAPSHOT_MATERIALIZATION_LIMITS.maxImageBytes) {
    limitExceeded(`${label} exceeds the per-image size limit.`);
  }
  if (image.content.byteLength > remainingPayloadBytes) {
    limitExceeded('The materialization payload limit was exceeded.');
  }
  return {
    mode,
    bytes: Buffer.from(image.content),
  };
}

function freezeImage(
  content: MaterializationContent | null,
  offsetBytes: number,
  payloadParts: Buffer[],
): SnapshotMaterializationImageV1 | null {
  if (content === null) return null;
  const sizeBytes = content.bytes.length;
  const imageCore = {
    mode: content.mode,
    sizeBytes,
    offsetBytes,
    contentDigest: digestContent(content.bytes),
  };
  payloadParts.push(content.bytes);
  return {
    ...imageCore,
    imageDigest: canonicalDigest(IMAGE_DIGEST_DOMAIN, imageCore),
  };
}

function assertValidManifest(
  value: unknown,
  payloadBytes: Uint8Array,
): asserts value is SnapshotMaterializationManifestV1 {
  if (!(payloadBytes instanceof Uint8Array)) {
    payloadInvalid('The materialization payload must be bytes.');
  }
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) {
    manifestInvalid('The materialization manifest has an invalid shape.');
  }
  const schemaVersion = value['schemaVersion'];
  const formatVersion = value['formatVersion'];
  const sourceSnapshotDigest = value['sourceSnapshotDigest'];
  const snapshotPolicyDigest = value['snapshotPolicyDigest'];
  const materializationPolicyDigest = value['materializationPolicyDigest'];
  const manifestDigest = value['manifestDigest'];
  const rawEntries = value['entries'];
  const entryCount = value['entryCount'];
  const payloadSizeBytes = value['payloadSizeBytes'];
  if (schemaVersion !== 1
    || formatVersion !== SNAPSHOT_MATERIALIZATION_FORMAT_VERSION) {
    manifestInvalid('The materialization manifest version is unsupported.');
  }
  assertDigest(sourceSnapshotDigest, 'sourceSnapshotDigest', manifestInvalid);
  assertDigest(snapshotPolicyDigest, 'snapshotPolicyDigest', manifestInvalid);
  assertDigest(
    materializationPolicyDigest,
    'materializationPolicyDigest',
    manifestInvalid,
  );
  assertDigest(manifestDigest, 'manifestDigest', manifestInvalid);
  if (!Array.isArray(rawEntries)) {
    manifestInvalid('The materialization manifest entries are invalid.');
  }
  if (rawEntries.length > SNAPSHOT_MATERIALIZATION_LIMITS.maxEntries) {
    limitExceeded('The materialization entry limit was exceeded.');
  }
  if (!isNonNegativeSafeInteger(entryCount)
    || entryCount !== rawEntries.length) {
    manifestInvalid('The materialization entry count is invalid.');
  }
  if (!isNonNegativeSafeInteger(payloadSizeBytes)
    || payloadSizeBytes > SNAPSHOT_MATERIALIZATION_LIMITS.maxPayloadBytes
    || payloadSizeBytes !== payloadBytes.byteLength) {
    payloadInvalid('The materialization payload size is invalid.');
  }

  const paths: string[] = [];
  const entries: SnapshotMaterializationEntryV1[] = [];
  let nextOffsetBytes = 0;
  for (const [entryIndex, entryValue] of rawEntries.entries()) {
    if (!isRecord(entryValue) || !hasExactKeys(entryValue, ENTRY_KEYS)) {
      manifestInvalid(`Materialization entry ${entryIndex} has an invalid shape.`);
    }
    const rawCanonicalRelativePath = entryValue['canonicalRelativePath'];
    const selectedUntracked = entryValue['selectedUntracked'];
    const indexObjectId = entryValue['indexObjectId'];
    const rawIndexImage = entryValue['indexImage'];
    const rawWorktreeImage = entryValue['worktreeImage'];
    const entryDigest = entryValue['entryDigest'];
    const canonicalRelativePath = assertCanonicalRelativePath(
      rawCanonicalRelativePath,
      manifestInvalid,
    );
    const previousPath = paths.at(-1);
    if (previousPath !== undefined
      && compareCanonicalPaths(previousPath, canonicalRelativePath) >= 0) {
      noncanonicalManifest('Materialization entries are not canonically sorted.');
    }
    paths.push(canonicalRelativePath);
    if (typeof selectedUntracked !== 'boolean') {
      manifestInvalid(
        `Materialization entry ${canonicalRelativePath} has an invalid selectedUntracked flag.`,
      );
    }

    const indexImage = assertValidImage(
      rawIndexImage,
      payloadBytes,
      nextOffsetBytes,
      `${canonicalRelativePath}.indexImage`,
    );
    nextOffsetBytes += indexImage?.sizeBytes ?? 0;
    const worktreeImage = assertValidImage(
      rawWorktreeImage,
      payloadBytes,
      nextOffsetBytes,
      `${canonicalRelativePath}.worktreeImage`,
    );
    nextOffsetBytes += worktreeImage?.sizeBytes ?? 0;
    let verifiedIndexObjectId: string | null;
    if (indexImage === null) {
      if (indexObjectId !== null) {
        manifestInvalid(
          `Materialization entry ${canonicalRelativePath} has an invalid index object.`,
        );
      }
      verifiedIndexObjectId = null;
    } else {
      if (!isGitObjectId(indexObjectId)
        || digestGitBlob(
          payloadBytes.subarray(
            indexImage.offsetBytes,
            indexImage.offsetBytes + indexImage.sizeBytes,
          ),
          indexObjectId.length,
        ) !== indexObjectId) {
        manifestInvalid(
          `Materialization entry ${canonicalRelativePath} has an invalid index object.`,
        );
      }
      verifiedIndexObjectId = indexObjectId;
    }
    if (selectedUntracked
      && (indexObjectId !== null || indexImage !== null || worktreeImage === null)) {
      manifestInvalid(
        `Selected untracked entry ${canonicalRelativePath} has invalid images.`,
      );
    }
    assertDigest(entryDigest, 'entryDigest', manifestInvalid);
    const entryCore = {
      canonicalRelativePath,
      selectedUntracked,
      indexObjectId: verifiedIndexObjectId,
      indexImage,
      worktreeImage,
    };
    if (canonicalDigest(ENTRY_DIGEST_DOMAIN, entryCore) !== entryDigest) {
      digestMismatch(`Materialization entry ${canonicalRelativePath} was tampered.`);
    }
    entries.push({ ...entryCore, entryDigest });
  }
  assertNoPortablePathCollisions(paths, manifestInvalid);
  if (nextOffsetBytes !== payloadSizeBytes) {
    payloadInvalid('Materialization image ranges do not exactly cover the payload.');
  }

  const manifestCore = {
    schemaVersion: 1 as const,
    formatVersion: SNAPSHOT_MATERIALIZATION_FORMAT_VERSION,
    sourceSnapshotDigest,
    snapshotPolicyDigest,
    materializationPolicyDigest,
    entries,
    entryCount,
    payloadSizeBytes,
  };
  if (canonicalDigest(MANIFEST_DIGEST_DOMAIN, manifestCore) !== manifestDigest) {
    digestMismatch('The materialization manifest digest does not match.');
  }
}

function assertValidImage(
  value: unknown,
  payloadBytes: Uint8Array,
  expectedOffsetBytes: number,
  label: string,
): SnapshotMaterializationImageV1 | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, IMAGE_KEYS)) {
    manifestInvalid(`${label} has an invalid shape.`);
  }
  const rawMode = value['mode'];
  const sizeBytes = value['sizeBytes'];
  const offsetBytes = value['offsetBytes'];
  const contentDigest = value['contentDigest'];
  const imageDigest = value['imageDigest'];
  const mode = assertMode(rawMode, manifestInvalid);
  if (!isNonNegativeSafeInteger(sizeBytes)
    || sizeBytes > SNAPSHOT_MATERIALIZATION_LIMITS.maxImageBytes) {
    manifestInvalid(`${label}.sizeBytes is invalid.`);
  }
  if (!isNonNegativeSafeInteger(offsetBytes)
    || offsetBytes !== expectedOffsetBytes) {
    payloadInvalid(`${label}.offsetBytes is non-canonical or overlapping.`);
  }
  const endOffsetBytes = offsetBytes + sizeBytes;
  if (!Number.isSafeInteger(endOffsetBytes)
    || endOffsetBytes > payloadBytes.byteLength) {
    payloadInvalid(`${label} exceeds the payload bounds.`);
  }
  assertDigest(contentDigest, `${label}.contentDigest`, manifestInvalid);
  assertDigest(imageDigest, `${label}.imageDigest`, manifestInvalid);
  const imageCore = {
    mode,
    sizeBytes,
    offsetBytes,
    contentDigest,
  };
  if (canonicalDigest(IMAGE_DIGEST_DOMAIN, imageCore) !== imageDigest) {
    digestMismatch(`${label} metadata was tampered.`);
  }
  const content = payloadBytes.subarray(offsetBytes, endOffsetBytes);
  if (digestContent(content) !== contentDigest) {
    digestMismatch(`${label} content was tampered.`);
  }
  return { ...imageCore, imageDigest };
}

function assertCanonicalRelativePath(
  value: unknown,
  reject: (message: string) => never,
): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.normalize('NFC')
    || value.startsWith('/')
    || value.startsWith('//')
    || /^[A-Za-z]:\//u.test(value)
    || value.includes('\\')
    || /[\0-\u001F\u007F]/u.test(value)) {
    reject('A materialization path is not a canonical relative path.');
  }
  const segments = value.split('/');
  if (Buffer.byteLength(value, 'utf8') > SNAPSHOT_MATERIALIZATION_LIMITS.maxPathBytes
    || segments.some((segment) =>
      segment === ''
      || segment === '.'
      || segment === '..'
      || segment.toLowerCase() === '.git'
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || WINDOWS_RESERVED_CHARACTERS.test(segment)
      || WINDOWS_RESERVED_DEVICE.test(segment)
      || Buffer.byteLength(segment, 'utf8')
        > SNAPSHOT_MATERIALIZATION_LIMITS.maxPathSegmentBytes)) {
    reject('A materialization path contains an unsafe or non-portable segment.');
  }
  return value;
}

function assertNoPortablePathCollisions(
  paths: readonly string[],
  reject: (message: string) => never,
): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const portablePath = path.normalize('NFC').toLocaleLowerCase('en-US');
    const previous = seen.get(portablePath);
    if (previous !== undefined) {
      reject(`Materialization paths ${previous} and ${path} collide portably.`);
    }
    seen.set(portablePath, path);
  }
}

function assertMode(
  value: unknown,
  reject: (message: string) => never,
): 0o100644 | 0o100755 {
  if (value !== 0o100644 && value !== 0o100755) {
    reject('A materialization image mode is unsupported.');
  }
  return value;
}

function assertDigest(
  value: unknown,
  label: string,
  reject: (message: string) => never,
): asserts value is string {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    reject(`${label} is not a canonical SHA-256 digest.`);
  }
}

function digestContent(content: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update(CONTENT_DIGEST_DOMAIN)
    .update('\0')
    .update(content)
    .digest('hex')}`;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function digestGitBlob(content: Uint8Array, objectIdLength: number): string {
  const algorithm = objectIdLength === 40 ? 'sha1' : objectIdLength === 64 ? 'sha256' : null;
  if (algorithm === null) return '';
  return createHash(algorithm)
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).toSorted(compareCanonicalPaths);
  const sortedExpected = [...expected].toSorted(compareCanonicalPaths);
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function compareCanonicalPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidInput(message: string): never {
  throw new SnapshotMaterializationError(
    'snapshot_materialization_input_invalid',
    message,
  );
}

function limitExceeded(message: string): never {
  throw new SnapshotMaterializationError('snapshot_materialization_limit', message);
}

function headerInvalid(message: string): never {
  throw new SnapshotMaterializationError(
    'snapshot_materialization_header_invalid',
    message,
  );
}

function manifestInvalid(message: string): never {
  throw new SnapshotMaterializationError(
    'snapshot_materialization_manifest_invalid',
    message,
  );
}

function noncanonicalManifest(message: string): never {
  throw new SnapshotMaterializationError(
    'snapshot_materialization_manifest_noncanonical',
    message,
  );
}

function digestMismatch(message: string): never {
  throw new SnapshotMaterializationError(
    'snapshot_materialization_digest_mismatch',
    message,
  );
}

function payloadInvalid(message: string): never {
  throw new SnapshotMaterializationError(
    'snapshot_materialization_payload_invalid',
    message,
  );
}
