import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { domainToASCII } from 'node:url';

import { canonicalDigest } from './finish-line';

export const REVIEW_SUBJECT_POLICY_VERSION = 'review-subject/1';
export const REVIEW_SUBJECT_HARD_EXCLUSION_POLICY_VERSION = 'review-subject-hard-exclusion/1';
export const REVIEW_SUBJECT_REDACTION_VERSION = 'review-subject-redaction/1';
export const REVIEW_SUBJECT_SECRET_SCAN_VERSION = 'review-subject-secret-scan/1';

export type ReviewSubjectOriginV1 =
  | 'changed-tracked'
  | 'explicit-untracked'
  | 'scope-match'
  | 'gate-evidence';

export interface ReviewSubjectLimitsV1 {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxGateEvidenceTotalBytes: number;
  readonly maxGateEvidenceBytes: number;
}

export const REVIEW_SUBJECT_HARD_LIMITS = {
  maxFiles: 500,
  maxTotalBytes: 4 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxGateEvidenceTotalBytes: 1024 * 1024,
  maxGateEvidenceBytes: 128 * 1024,
} as const satisfies ReviewSubjectLimitsV1;

const ORIGIN_ORDER: readonly ReviewSubjectOriginV1[] = [
  'changed-tracked',
  'explicit-untracked',
  'scope-match',
  'gate-evidence',
];
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const SECRET_PATH_SEGMENT = /(?:^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|tokens?|keys?|certs?|auth)(?:\/|$)/iu;
const SECRET_FILE = /(?:^|\/)[^/]*(?:secret|credential|token|api[_-]?key|private[_-]?key|\.pem|\.p12|\.pfx|\.key)(?:[^/]*)$/iu;
const PRIVATE_STATE = /(?:^|\/)(?:\.git|\.wukong\/(?:sessions?|logs?|trust|auth|providers?))(?:\/|$)/u;
const GENERATED = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|target|\.next|\.nuxt|out)(?:\/|$)/u;
const SECRET_CONTENT = [
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/iu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{12,}\b/u,
  /\bAuthorization\s*:\s*Bearer\s+\S+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
] as const;

export interface BrokerReviewTrustProposalV1 {
  readonly schemaVersion: 1;
  readonly workspaceIdentityDigest: string;
  readonly scope: 'brokered-review-subject';
  readonly reviewSubjectPolicyVersion: string;
  readonly intent: 'once' | 'remember-locally';
  readonly trustProposalDigest: string;
}

export interface BrokerReviewTrustBindingV1 {
  readonly workspaceIdentityDigest: string;
  readonly scope: 'brokered-review-subject';
  readonly trustProposalDigest: string;
  readonly trustGrantId: string;
}

export interface ProviderOriginV1 {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
}

export interface ReviewSubjectConsentProposalV1 {
  readonly schemaVersion: 1;
  readonly workspaceIdentityDigest: string;
  readonly reviewSubjectPolicyVersion: string;
  readonly hardExclusionPolicyVersion: string;
  readonly allowedOrigins: readonly ReviewSubjectOriginV1[];
  readonly limits: ReviewSubjectLimitsV1;
  readonly provider: {
    readonly providerId: string;
    readonly endpointOrigin: ProviderOriginV1;
    readonly endpointOriginDigest: string;
  };
  readonly consentProposalDigest: string;
}

export interface ReviewSubjectConsentBindingV1 {
  readonly schemaVersion: 1;
  readonly workspaceIdentityDigest: string;
  readonly reviewSubjectPolicyVersion: string;
  readonly hardExclusionPolicyVersion: string;
  readonly allowedOrigins: readonly ReviewSubjectOriginV1[];
  readonly limits: ReviewSubjectLimitsV1;
  readonly provider: {
    readonly providerId: string;
    readonly endpointOriginDigest: string;
  };
  readonly consentProposalDigest: string;
  readonly acknowledgedAt: number;
  readonly consentDigest: string;
}

export interface ReviewSubjectEntryV1 {
  readonly subjectRef: string;
  readonly logicalPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: 'text/plain' | 'application/json';
  readonly origin: Exclude<ReviewSubjectOriginV1, 'gate-evidence'>;
}

export interface ReviewSubjectExclusionV1 {
  readonly reason:
    | 'secret-path'
    | 'secret-content'
    | 'private-state'
    | 'binary'
    | 'generated'
    | 'oversize'
    | 'outside-workspace';
  readonly count: number;
}

export interface BrokeredGateEvidenceEntryV1 {
  readonly producerId: string;
  readonly evidenceId: string;
  readonly brokeredEvidenceDigest: string;
  readonly byteLength: number;
  readonly mediaType: 'text/plain' | 'application/json';
  readonly redactionVersion: string;
  readonly secretScanVersion: string;
}

export interface BrokeredGateEvidenceExclusionV1 {
  readonly exclusionId: string;
  readonly reason: 'secret-content' | 'private-state' | 'binary' | 'oversize';
}

export interface ReviewSubjectManifestV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly consentDigest: string;
  readonly workspaceFingerprint: string;
  readonly policyVersion: string;
  readonly entries: readonly ReviewSubjectEntryV1[];
  readonly exclusions: readonly ReviewSubjectExclusionV1[];
  readonly gateEvidence: readonly BrokeredGateEvidenceEntryV1[];
  readonly gateEvidenceExclusions: readonly BrokeredGateEvidenceExclusionV1[];
  readonly manifestDigest: string;
}

export interface ReviewSubjectCandidateV1 {
  readonly logicalPath: string;
  readonly origin: Exclude<ReviewSubjectOriginV1, 'gate-evidence'>;
}

export interface RawGateEvidenceV1 {
  readonly producerId: string;
  readonly evidenceId: string;
  readonly content: string | Uint8Array;
  readonly mediaType: 'text/plain' | 'application/json' | 'application/octet-stream';
  readonly privateState?: boolean;
}

export interface BuildReviewSubjectOptions {
  readonly workspaceRoot: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly workspaceFingerprint: string;
  readonly consent: ReviewSubjectConsentBindingV1;
  readonly candidates: readonly ReviewSubjectCandidateV1[];
  readonly gateEvidence?: readonly RawGateEvidenceV1[];
}

export class ReviewSubjectError extends Error {
  constructor(
    readonly reasonCode:
      | 'review_subject_limit'
      | 'review_subject_excluded'
      | 'review_subject_trust_required'
      | 'review_subject_consent_required'
      | 'review_evidence_excluded'
      | 'review_subject_changed'
      | 'reviewer_evidence_stale',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewSubjectError';
  }
}

export function createBrokerReviewTrustProposal(input: {
  readonly workspaceIdentityDigest: string;
  readonly intent: 'once' | 'remember-locally';
}): BrokerReviewTrustProposalV1 {
  const core = {
    schemaVersion: 1 as const,
    workspaceIdentityDigest: input.workspaceIdentityDigest,
    scope: 'brokered-review-subject' as const,
    reviewSubjectPolicyVersion: REVIEW_SUBJECT_POLICY_VERSION,
    intent: input.intent,
  };
  return {
    ...core,
    trustProposalDigest: canonicalDigest('wukong/broker-review-trust-proposal/v1', core),
  };
}

export function grantBrokerReviewTrust(
  proposal: BrokerReviewTrustProposalV1,
  expectedProposalDigest: string,
  trustGrantId: string = randomUUID(),
): BrokerReviewTrustBindingV1 {
  validateBrokerReviewTrustProposal(proposal);
  if (proposal.trustProposalDigest !== expectedProposalDigest) {
    throw new ReviewSubjectError(
      'review_subject_trust_required',
      'Broker review trust proposal is missing or stale.',
    );
  }
  return {
    workspaceIdentityDigest: proposal.workspaceIdentityDigest,
    scope: 'brokered-review-subject',
    trustProposalDigest: proposal.trustProposalDigest,
    trustGrantId,
  };
}

export function createReviewSubjectConsentProposal(input: {
  readonly workspaceIdentityDigest: string;
  readonly allowedOrigins: readonly ReviewSubjectOriginV1[];
  readonly limits?: Partial<ReviewSubjectLimitsV1>;
  readonly providerId: string;
  readonly endpoint: string;
}): ReviewSubjectConsentProposalV1 {
  const allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins);
  const limits = normalizeLimits(input.limits);
  const endpointOrigin = normalizeProviderOrigin(input.endpoint);
  const endpointOriginDigest = canonicalDigest('wukong/provider-origin/v1', endpointOrigin);
  const core = {
    schemaVersion: 1 as const,
    workspaceIdentityDigest: input.workspaceIdentityDigest,
    reviewSubjectPolicyVersion: REVIEW_SUBJECT_POLICY_VERSION,
    hardExclusionPolicyVersion: REVIEW_SUBJECT_HARD_EXCLUSION_POLICY_VERSION,
    allowedOrigins,
    limits,
    provider: {
      providerId: nonEmpty(input.providerId, 'providerId'),
      endpointOrigin,
      endpointOriginDigest,
    },
  };
  return {
    ...core,
    consentProposalDigest: canonicalDigest('wukong/review-subject-consent-proposal/v1', core),
  };
}

export function acknowledgeReviewSubjectConsent(
  proposal: ReviewSubjectConsentProposalV1,
  expectedProposalDigest: string,
  acknowledgedAt: number = Date.now(),
): ReviewSubjectConsentBindingV1 {
  validateReviewSubjectConsentProposal(proposal);
  if (proposal.consentProposalDigest !== expectedProposalDigest) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Review subject consent proposal is missing or stale.',
    );
  }
  if (!Number.isSafeInteger(acknowledgedAt) || acknowledgedAt <= 0) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Review subject acknowledgement timestamp is invalid.',
    );
  }
  const core = {
    schemaVersion: 1 as const,
    workspaceIdentityDigest: proposal.workspaceIdentityDigest,
    reviewSubjectPolicyVersion: proposal.reviewSubjectPolicyVersion,
    hardExclusionPolicyVersion: proposal.hardExclusionPolicyVersion,
    allowedOrigins: proposal.allowedOrigins,
    limits: proposal.limits,
    provider: {
      providerId: proposal.provider.providerId,
      endpointOriginDigest: proposal.provider.endpointOriginDigest,
    },
    consentProposalDigest: proposal.consentProposalDigest,
    acknowledgedAt,
  };
  return {
    ...core,
    consentDigest: canonicalDigest('wukong/review-subject-consent/v1', {
      consentProposalDigest: proposal.consentProposalDigest,
      acknowledgedAt,
    }),
  };
}

export function validateProviderAgainstConsent(input: {
  readonly consent: ReviewSubjectConsentBindingV1;
  readonly providerId: string;
  readonly endpoint: string;
  readonly redirectEndpoint?: string;
}): void {
  validateReviewSubjectConsentBinding(input.consent);
  const origin = normalizeProviderOrigin(input.endpoint);
  const digest = canonicalDigest('wukong/provider-origin/v1', origin);
  if (
    input.providerId !== input.consent.provider.providerId
    || digest !== input.consent.provider.endpointOriginDigest
  ) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Actual BYOK provider or endpoint origin does not match the frozen run consent.',
    );
  }
  if (input.redirectEndpoint !== undefined) {
    const redirectDigest = canonicalDigest(
      'wukong/provider-origin/v1',
      normalizeProviderOrigin(input.redirectEndpoint),
    );
    if (redirectDigest !== digest) {
      throw new ReviewSubjectError(
        'review_subject_consent_required',
        'Cross-origin provider redirects are not allowed.',
      );
    }
  }
}

export class ReviewSubjectBroker {
  readonly manifest: ReviewSubjectManifestV1;
  private destroyed = false;

  private constructor(
    private readonly options: BuildReviewSubjectOptions,
    private readonly brokerKey: Uint8Array,
    manifest: ReviewSubjectManifestV1,
    private readonly subjects: ReadonlyMap<string, string>,
    private readonly gateEvidence: ReadonlyMap<string, string>,
  ) {
    this.manifest = manifest;
  }

  static async build(options: BuildReviewSubjectOptions): Promise<ReviewSubjectBroker> {
    validateReviewSubjectConsentBinding(options.consent);
    const brokerKey = randomBytes(32);
    const built = await buildManifest(options, brokerKey);
    return new ReviewSubjectBroker(
      options,
      brokerKey,
      built.manifest,
      built.subjects,
      built.gateEvidence,
    );
  }

  readReviewSubject(subjectRef: string): string {
    this.assertLive();
    const content = this.subjects.get(subjectRef);
    if (content === undefined) {
      throw new ReviewSubjectError(
        'reviewer_evidence_stale',
        'Review subject ref is not part of the current attempt manifest.',
      );
    }
    return content;
  }

  searchReviewSubjects(query: string, subjectRefs?: readonly string[]): readonly {
    readonly subjectRef: string;
    readonly logicalPath: string;
  }[] {
    this.assertLive();
    if (query.length === 0 || query.length > 1_000 || CONTROL_CHARACTER.test(query)) {
      throw new ReviewSubjectError('reviewer_evidence_stale', 'Invalid broker search query.');
    }
    const allowed = subjectRefs === undefined
      ? new Set(this.manifest.entries.map((entry) => entry.subjectRef))
      : new Set(subjectRefs);
    for (const ref of allowed) {
      if (!this.subjects.has(ref)) {
        throw new ReviewSubjectError(
          'reviewer_evidence_stale',
          'Search includes a subject ref outside the current attempt manifest.',
        );
      }
    }
    const normalized = query.toLocaleLowerCase('en-US');
    return this.manifest.entries
      .filter((entry) => allowed.has(entry.subjectRef))
      .filter((entry) => (
        entry.logicalPath.toLocaleLowerCase('en-US').includes(normalized)
        || this.subjects.get(entry.subjectRef)?.toLocaleLowerCase('en-US').includes(normalized)
      ))
      .map((entry) => ({ subjectRef: entry.subjectRef, logicalPath: entry.logicalPath }));
  }

  readGateEvidence(producerId: string, evidenceId: string): string {
    this.assertLive();
    const key = gateEvidenceKey(producerId, evidenceId);
    const content = this.gateEvidence.get(key);
    if (content === undefined) {
      throw new ReviewSubjectError(
        'reviewer_evidence_stale',
        'Gate evidence is not part of the current attempt manifest.',
      );
    }
    return content;
  }

  async assertFresh(workspaceFingerprint: string): Promise<void> {
    this.assertLive();
    if (workspaceFingerprint !== this.options.workspaceFingerprint) {
      throw new ReviewSubjectError(
        'review_subject_changed',
        'Workspace fingerprint changed during fresh review.',
      );
    }
    const rebuilt = await buildManifest(this.options, this.brokerKey);
    if (rebuilt.manifest.manifestDigest !== this.manifest.manifestDigest) {
      throw new ReviewSubjectError(
        'review_subject_changed',
        'Review subject manifest changed during fresh review.',
      );
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.brokerKey.fill(0);
    this.destroyed = true;
  }

  private assertLive(): void {
    if (this.destroyed) {
      throw new ReviewSubjectError(
        'reviewer_evidence_stale',
        'Attempt-scoped review broker has already been destroyed.',
      );
    }
  }
}

export function validateReviewSubjectManifest(
  manifest: ReviewSubjectManifestV1,
  consent: ReviewSubjectConsentBindingV1,
): void {
  validateReviewSubjectConsentBinding(consent);
  const { manifestDigest, ...core } = manifest;
  if (
    manifest.schemaVersion !== 1
    || manifest.consentDigest !== consent.consentDigest
    || manifest.policyVersion !== consent.reviewSubjectPolicyVersion
    || canonicalDigest('wukong/review-subject-manifest/v1', core) !== manifestDigest
  ) {
    throw new ReviewSubjectError(
      'reviewer_evidence_stale',
      'Review subject manifest binding or digest is invalid.',
    );
  }
  const allowed = new Set(consent.allowedOrigins);
  if (
    manifest.entries.some((entry) => !allowed.has(entry.origin))
    || (manifest.gateEvidence.length > 0 && !allowed.has('gate-evidence'))
    || manifest.entries.length > consent.limits.maxFiles
    || manifest.entries.reduce((total, entry) => total + entry.byteLength, 0)
      > consent.limits.maxTotalBytes
    || manifest.entries.some((entry) => entry.byteLength > consent.limits.maxFileBytes)
    || manifest.gateEvidence.reduce((total, entry) => total + entry.byteLength, 0)
      > consent.limits.maxGateEvidenceTotalBytes
    || manifest.gateEvidence.some(
      (entry) => entry.byteLength > consent.limits.maxGateEvidenceBytes,
    )
  ) {
    throw new ReviewSubjectError(
      'reviewer_evidence_stale',
      'Review subject manifest exceeds the frozen consent boundary.',
    );
  }
}

async function buildManifest(
  options: BuildReviewSubjectOptions,
  brokerKey: Uint8Array,
): Promise<{
  readonly manifest: ReviewSubjectManifestV1;
  readonly subjects: ReadonlyMap<string, string>;
  readonly gateEvidence: ReadonlyMap<string, string>;
}> {
  const workspaceRealpath = await realpath(options.workspaceRoot);
  const allowed = new Set(options.consent.allowedOrigins);
  const subjects = new Map<string, string>();
  const subjectEntries: ReviewSubjectEntryV1[] = [];
  const exclusions = new Map<ReviewSubjectExclusionV1['reason'], number>();
  let totalBytes = 0;
  const candidates = [...options.candidates]
    .toSorted((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const seenPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!allowed.has(candidate.origin)) continue;
    const logicalPath = normalizeLogicalPath(candidate.logicalPath);
    if (seenPaths.has(logicalPath)) continue;
    seenPaths.add(logicalPath);
    const pathReason = excludedPathReason(logicalPath);
    if (pathReason !== undefined) {
      increment(exclusions, pathReason);
      continue;
    }
    const absolutePath = resolve(workspaceRealpath, logicalPath);
    if (!isContained(workspaceRealpath, absolutePath)) {
      increment(exclusions, 'outside-workspace');
      continue;
    }
    let info;
    let canonicalPath;
    try {
      info = await lstat(absolutePath);
      canonicalPath = await realpath(absolutePath);
    } catch {
      increment(exclusions, 'outside-workspace');
      continue;
    }
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || !isContained(workspaceRealpath, canonicalPath)
    ) {
      increment(exclusions, 'outside-workspace');
      continue;
    }
    if (info.size > options.consent.limits.maxFileBytes) {
      increment(exclusions, 'oversize');
      continue;
    }
    const bytes = await readFile(canonicalPath);
    if (isBinary(bytes)) {
      increment(exclusions, 'binary');
      continue;
    }
    const content = bytes.toString('utf8');
    if (containsSecret(content)) {
      increment(exclusions, 'secret-content');
      continue;
    }
    totalBytes += bytes.byteLength;
    if (
      subjectEntries.length + 1 > options.consent.limits.maxFiles
      || totalBytes > options.consent.limits.maxTotalBytes
    ) {
      throw new ReviewSubjectError(
        'review_subject_limit',
        'Review subject exceeds the frozen file or total-byte limit.',
      );
    }
    const sha256 = canonicalDigest('wukong/review-subject-content/v1', content);
    const subjectRef = opaqueRef(brokerKey, 'review-subject', `${logicalPath}\0${sha256}`);
    subjectEntries.push({
      subjectRef,
      logicalPath,
      sha256,
      byteLength: bytes.byteLength,
      mediaType: logicalPath.endsWith('.json') ? 'application/json' : 'text/plain',
      origin: candidate.origin,
    });
    subjects.set(subjectRef, content);
  }

  const gateEvidence = new Map<string, string>();
  const gateEntries: BrokeredGateEvidenceEntryV1[] = [];
  const gateExclusions: BrokeredGateEvidenceExclusionV1[] = [];
  let gateTotalBytes = 0;
  const seenEvidence = new Set<string>();
  if (allowed.has('gate-evidence')) {
    for (const raw of options.gateEvidence ?? []) {
      const identity = gateEvidenceKey(raw.producerId, raw.evidenceId);
      if (seenEvidence.has(identity)) {
        throw new ReviewSubjectError(
          'review_evidence_excluded',
          `Duplicate Gate evidence identity: ${identity}`,
        );
      }
      seenEvidence.add(identity);
      const rawBytes = typeof raw.content === 'string'
        ? Buffer.from(raw.content, 'utf8')
        : Buffer.from(raw.content);
      let reason: BrokeredGateEvidenceExclusionV1['reason'] | undefined;
      if (raw.privateState === true) reason = 'private-state';
      else if (raw.mediaType === 'application/octet-stream' || isBinary(rawBytes)) reason = 'binary';
      else if (rawBytes.byteLength > options.consent.limits.maxGateEvidenceBytes) reason = 'oversize';
      const redacted = reason === undefined
        ? redactEvidence(rawBytes.toString('utf8'))
        : undefined;
      if (redacted !== undefined && containsSecret(redacted)) reason = 'secret-content';
      if (reason !== undefined || redacted === undefined) {
        gateExclusions.push({
          exclusionId: opaqueRef(
            brokerKey,
            'gate-evidence-exclusion',
            `${raw.producerId}\0${raw.evidenceId}\0${reason ?? 'private-state'}`,
          ),
          reason: reason ?? 'private-state',
        });
        continue;
      }
      const bytes = Buffer.byteLength(redacted, 'utf8');
      gateTotalBytes += bytes;
      if (gateTotalBytes > options.consent.limits.maxGateEvidenceTotalBytes) {
        gateExclusions.push({
          exclusionId: opaqueRef(
            brokerKey,
            'gate-evidence-exclusion',
            `${raw.producerId}\0${raw.evidenceId}\0oversize`,
          ),
          reason: 'oversize',
        });
        continue;
      }
      const brokeredEvidenceDigest = canonicalDigest(
        'wukong/brokered-gate-evidence/v1',
        redacted,
      );
      gateEntries.push({
        producerId: raw.producerId,
        evidenceId: raw.evidenceId,
        brokeredEvidenceDigest,
        byteLength: bytes,
        mediaType: raw.mediaType === 'application/json' ? 'application/json' : 'text/plain',
        redactionVersion: REVIEW_SUBJECT_REDACTION_VERSION,
        secretScanVersion: REVIEW_SUBJECT_SECRET_SCAN_VERSION,
      });
      gateEvidence.set(identity, redacted);
    }
  }

  const core = {
    schemaVersion: 1 as const,
    attemptId: options.attemptId,
    runId: options.runId,
    contractId: options.contractId,
    planDigest: options.planDigest,
    consentDigest: options.consent.consentDigest,
    workspaceFingerprint: options.workspaceFingerprint,
    policyVersion: REVIEW_SUBJECT_POLICY_VERSION,
    entries: subjectEntries,
    exclusions: [...exclusions.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .toSorted((left, right) => left.reason.localeCompare(right.reason)),
    gateEvidence: gateEntries,
    gateEvidenceExclusions: gateExclusions,
  };
  const manifest: ReviewSubjectManifestV1 = {
    ...core,
    manifestDigest: canonicalDigest('wukong/review-subject-manifest/v1', core),
  };
  validateReviewSubjectManifest(manifest, options.consent);
  return { manifest, subjects, gateEvidence };
}

function validateBrokerReviewTrustProposal(proposal: BrokerReviewTrustProposalV1): void {
  const { trustProposalDigest, ...core } = proposal;
  if (
    proposal.schemaVersion !== 1
    || proposal.scope !== 'brokered-review-subject'
    || proposal.reviewSubjectPolicyVersion !== REVIEW_SUBJECT_POLICY_VERSION
    || canonicalDigest('wukong/broker-review-trust-proposal/v1', core)
      !== trustProposalDigest
  ) {
    throw new ReviewSubjectError(
      'review_subject_trust_required',
      'Broker review trust proposal is invalid.',
    );
  }
}

function validateReviewSubjectConsentProposal(
  proposal: ReviewSubjectConsentProposalV1,
): void {
  const { consentProposalDigest, ...core } = proposal;
  normalizeAllowedOrigins(proposal.allowedOrigins);
  normalizeLimits(proposal.limits);
  if (
    proposal.schemaVersion !== 1
    || proposal.reviewSubjectPolicyVersion !== REVIEW_SUBJECT_POLICY_VERSION
    || proposal.hardExclusionPolicyVersion
      !== REVIEW_SUBJECT_HARD_EXCLUSION_POLICY_VERSION
    || canonicalDigest('wukong/provider-origin/v1', proposal.provider.endpointOrigin)
      !== proposal.provider.endpointOriginDigest
    || canonicalDigest('wukong/review-subject-consent-proposal/v1', core)
      !== consentProposalDigest
  ) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Review subject consent proposal is invalid.',
    );
  }
}

function validateReviewSubjectConsentBinding(
  binding: ReviewSubjectConsentBindingV1,
): void {
  normalizeAllowedOrigins(binding.allowedOrigins);
  normalizeLimits(binding.limits);
  if (
    binding.schemaVersion !== 1
    || binding.reviewSubjectPolicyVersion !== REVIEW_SUBJECT_POLICY_VERSION
    || binding.hardExclusionPolicyVersion
      !== REVIEW_SUBJECT_HARD_EXCLUSION_POLICY_VERSION
    || canonicalDigest('wukong/review-subject-consent/v1', {
      consentProposalDigest: binding.consentProposalDigest,
      acknowledgedAt: binding.acknowledgedAt,
    }) !== binding.consentDigest
  ) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Review subject consent binding is invalid.',
    );
  }
}

function normalizeAllowedOrigins(
  origins: readonly ReviewSubjectOriginV1[],
): readonly ReviewSubjectOriginV1[] {
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Review subject origins must be unique and non-empty.',
    );
  }
  const normalized = [...origins].toSorted(
    (left, right) => ORIGIN_ORDER.indexOf(left) - ORIGIN_ORDER.indexOf(right),
  );
  if (normalized.some((origin, index) => origin !== origins[index])) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Review subject origins must use the canonical order.',
    );
  }
  return normalized;
}

function normalizeLimits(
  partial: Partial<ReviewSubjectLimitsV1> | undefined,
): ReviewSubjectLimitsV1 {
  const value = {
    ...REVIEW_SUBJECT_HARD_LIMITS,
    ...partial,
  };
  for (const key of Object.keys(REVIEW_SUBJECT_HARD_LIMITS) as (keyof ReviewSubjectLimitsV1)[]) {
    if (
      !Number.isSafeInteger(value[key])
      || value[key] <= 0
      || value[key] > REVIEW_SUBJECT_HARD_LIMITS[key]
    ) {
      throw new ReviewSubjectError(
        'review_subject_consent_required',
        `Review subject limit ${key} exceeds the hard policy boundary.`,
      );
    }
  }
  if (
    value.maxFileBytes > value.maxTotalBytes
    || value.maxGateEvidenceBytes > value.maxGateEvidenceTotalBytes
  ) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'Per-item review limits cannot exceed their total limits.',
    );
  }
  return value;
}

function normalizeProviderOrigin(endpoint: string): ProviderOriginV1 {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'BYOK provider endpoint must be an absolute HTTP(S) URL.',
    );
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'BYOK provider endpoint must use HTTP(S) and cannot contain credentials.',
    );
  }
  const host = domainToASCII(url.hostname.toLocaleLowerCase('en-US'));
  if (host === '') {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      'BYOK provider endpoint hostname is invalid.',
    );
  }
  const scheme = url.protocol.slice(0, -1) as 'http' | 'https';
  const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port);
  return { scheme, host, port };
}

function excludedPathReason(
  path: string,
): ReviewSubjectExclusionV1['reason'] | undefined {
  if (PRIVATE_STATE.test(path)) return 'private-state';
  if (GENERATED.test(path)) return 'generated';
  if (SECRET_PATH_SEGMENT.test(path) || SECRET_FILE.test(path)) return 'secret-path';
  return undefined;
}

function normalizeLogicalPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    normalized === ''
    || normalized.startsWith('/')
    || normalized.split('/').includes('..')
    || isAbsolute(path)
    || CONTROL_CHARACTER.test(path)
  ) {
    throw new ReviewSubjectError(
      'review_subject_excluded',
      'Review subject paths must be safe workspace-relative logical paths.',
    );
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isBinary(value: Uint8Array): boolean {
  if (value.includes(0)) return true;
  const sample = value.subarray(0, Math.min(value.byteLength, 8_192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.byteLength > 0 && suspicious / sample.byteLength > 0.03;
}

function containsSecret(value: string): boolean {
  return SECRET_CONTENT.some((pattern) => pattern.test(value));
}

function redactEvidence(value: string): string {
  return value
    .replaceAll(/(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/giu, '[REDACTED]')
    .replaceAll(/\bAuthorization\s*:\s*Bearer\s+\S+/giu, 'Authorization: [REDACTED]');
}

function opaqueRef(key: Uint8Array, domain: string, value: string): string {
  return `hmac256:${createHmac('sha256', key)
    .update(`wukong/${domain}/v1`)
    .update('\0')
    .update(value)
    .digest('hex')}`;
}

function gateEvidenceKey(producerId: string, evidenceId: string): string {
  return `${producerId}\0${evidenceId}`;
}

function increment(
  map: Map<ReviewSubjectExclusionV1['reason'], number>,
  reason: ReviewSubjectExclusionV1['reason'],
): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '' || CONTROL_CHARACTER.test(normalized)) {
    throw new ReviewSubjectError(
      'review_subject_consent_required',
      `${label} must be non-empty.`,
    );
  }
  return normalized;
}
