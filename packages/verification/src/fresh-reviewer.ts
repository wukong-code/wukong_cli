import { canonicalDigest } from './finish-line';
import type {
  BrokeredGateEvidenceEntryV1,
  ReviewSubjectEntryV1,
  ReviewSubjectManifestV1,
} from './review-subject';

export const FRESH_REVIEWER_POLICY_VERSION = 'fresh-criteria-reviewer/1';

export type EvidencePointerV1 =
  | {
      readonly kind: 'review-subject';
      readonly subjectRef: string;
      readonly subjectDigest: string;
    }
  | {
      readonly kind: 'gate-evidence';
      readonly producerId: string;
      readonly evidenceId: string;
      readonly evidenceDigest: string;
    };

export interface FreshReviewerCriterionV1 {
  readonly criterionId: string;
  readonly criterionProvenanceDigest: string;
}

export type FreshReviewerFindingV1 =
  | {
      readonly id: string;
      readonly origin: 'criterion';
      readonly criterionId: string;
      readonly criterionProvenanceDigest: string;
      readonly severity: 'blocking' | 'important' | 'note';
      readonly message: string;
      readonly nextAction: string;
      readonly evidence: readonly EvidencePointerV1[];
    }
  | {
      readonly id: string;
      readonly origin: 'independent';
      readonly severity: 'important' | 'note';
      readonly message: string;
      readonly nextAction: string;
      readonly evidence: readonly EvidencePointerV1[];
    }
  | {
      readonly id: string;
      readonly origin: 'frozen-review-policy';
      readonly policyLocator: '.wukong/review-policy.md';
      readonly policyDefinitionDigest: string;
      readonly severity: 'blocking' | 'important' | 'note';
      readonly message: string;
      readonly nextAction: string;
      readonly evidence: readonly EvidencePointerV1[];
    };

export interface FreshCriteriaVerdictV1 {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly reviewerInputDigest: string;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'INCONCLUSIVE';
  readonly criterionDispositions: readonly {
    readonly criterionId: string;
    readonly criterionProvenanceDigest: string;
    readonly status: 'satisfied' | 'unsatisfied' | 'unverified';
    readonly evidence: readonly EvidencePointerV1[];
  }[];
  readonly priorBlockerDispositions: readonly {
    readonly blockerKey: string;
    readonly status: 'resolved' | 'still-open' | 'replaced-by';
    readonly replacementBlockerKey?: string;
    readonly evidence: readonly EvidencePointerV1[];
  }[];
  readonly findings: readonly FreshReviewerFindingV1[];
}

export type FreshReviewPolicyV1 =
  | {
      readonly mode: 'blocking-frozen';
      readonly sourceLocator: '.wukong/review-policy.md';
      readonly definitionDigest: string;
    }
  | {
      readonly mode: 'advisory-live';
    };

export interface ValidateFreshCriteriaVerdictOptions {
  readonly attemptId: string;
  readonly expectedReviewerInputDigest: string;
  readonly criteria: readonly FreshReviewerCriterionV1[];
  readonly priorBlockerKeys: readonly string[];
  readonly reviewPolicy: FreshReviewPolicyV1;
  readonly manifest: ReviewSubjectManifestV1;
}

export interface FreshCriteriaVerdictValidationV1 {
  readonly valid: boolean;
  readonly status: 'PASS' | 'NEEDS_WORK' | 'INCONCLUSIVE';
  readonly reasonCode: 'passed' | 'criteria_needs_work' | 'reviewer_invalid_output';
  readonly errors: readonly string[];
  readonly verdictDigest: string;
}

export function createFreshReviewerInputDigest(input: {
  readonly attemptId: string;
  readonly contractId: string;
  readonly planDigest: string;
  readonly selectionDigest: string;
  readonly subjectManifestDigest: string;
  readonly orderedCheckResultDigests: readonly string[];
  readonly priorBlockerSetDigest: string;
  readonly reviewPolicyDigest: string;
  readonly consentDigest: string;
}): string {
  return canonicalDigest('wukong/fresh-reviewer-input/v1', input);
}

export function validateFreshCriteriaVerdict(
  verdict: FreshCriteriaVerdictV1,
  options: ValidateFreshCriteriaVerdictOptions,
): FreshCriteriaVerdictValidationV1 {
  const errors: string[] = [];
  if (
    verdict.schemaVersion !== 1
    || verdict.attemptId !== options.attemptId
    || verdict.reviewerInputDigest !== options.expectedReviewerInputDigest
  ) {
    errors.push('verdict binding does not match the current attempt');
  }
  const criteria = new Map(
    options.criteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  const dispositions = new Map<string, FreshCriteriaVerdictV1['criterionDispositions'][number]>();
  for (const disposition of verdict.criterionDispositions) {
    if (dispositions.has(disposition.criterionId)) {
      errors.push(`duplicate criterion disposition: ${disposition.criterionId}`);
      continue;
    }
    dispositions.set(disposition.criterionId, disposition);
    const expected = criteria.get(disposition.criterionId);
    if (
      expected === undefined
      || expected.criterionProvenanceDigest !== disposition.criterionProvenanceDigest
    ) {
      errors.push(`unknown or stale criterion disposition: ${disposition.criterionId}`);
    }
    validateEvidence(
      disposition.evidence,
      options.manifest,
      errors,
      `criterion ${disposition.criterionId}`,
    );
    if (disposition.status === 'satisfied' && disposition.evidence.length === 0) {
      errors.push(`satisfied criterion lacks evidence: ${disposition.criterionId}`);
    }
  }
  for (const criterionId of criteria.keys()) {
    if (!dispositions.has(criterionId)) {
      errors.push(`missing criterion disposition: ${criterionId}`);
    }
  }
  if (dispositions.size !== criteria.size) {
    errors.push('criterion dispositions do not exactly cover the frozen contract');
  }

  const blockerKeys = new Set(options.priorBlockerKeys);
  const blockerDispositions = new Map<
    string,
    FreshCriteriaVerdictV1['priorBlockerDispositions'][number]
  >();
  for (const disposition of verdict.priorBlockerDispositions) {
    if (blockerDispositions.has(disposition.blockerKey)) {
      errors.push(`duplicate prior blocker disposition: ${disposition.blockerKey}`);
      continue;
    }
    blockerDispositions.set(disposition.blockerKey, disposition);
    if (!blockerKeys.has(disposition.blockerKey)) {
      errors.push(`unknown prior blocker disposition: ${disposition.blockerKey}`);
    }
    validateEvidence(
      disposition.evidence,
      options.manifest,
      errors,
      `prior blocker ${disposition.blockerKey}`,
    );
    if (disposition.evidence.length === 0) {
      errors.push(`prior blocker disposition lacks evidence: ${disposition.blockerKey}`);
    }
    if (
      disposition.status === 'replaced-by'
      && (
        disposition.replacementBlockerKey === undefined
        || disposition.replacementBlockerKey === disposition.blockerKey
      )
    ) {
      errors.push(`invalid replacement blocker key: ${disposition.blockerKey}`);
    }
    if (
      disposition.status !== 'replaced-by'
      && disposition.replacementBlockerKey !== undefined
    ) {
      errors.push(`unexpected replacement blocker key: ${disposition.blockerKey}`);
    }
  }
  for (const blockerKey of blockerKeys) {
    if (!blockerDispositions.has(blockerKey)) {
      errors.push(`missing prior blocker disposition: ${blockerKey}`);
    }
  }
  if (blockerDispositions.size !== blockerKeys.size) {
    errors.push('prior blocker dispositions do not exactly cover the carried blocker set');
  }

  const findingIds = new Set<string>();
  const criterionBlockingFindings = new Map<string, number>();
  const validBlockingKeys = new Set<string>();
  for (const finding of verdict.findings) {
    if (findingIds.has(finding.id) || finding.id.trim() === '') {
      errors.push(`duplicate or empty finding id: ${finding.id}`);
    }
    findingIds.add(finding.id);
    validateEvidence(finding.evidence, options.manifest, errors, `finding ${finding.id}`);
    if (finding.nextAction.trim() === '' || finding.message.trim() === '') {
      errors.push(`finding message or next action is empty: ${finding.id}`);
    }
    if (finding.origin === 'criterion') {
      const expected = criteria.get(finding.criterionId);
      if (
        expected === undefined
        || expected.criterionProvenanceDigest !== finding.criterionProvenanceDigest
      ) {
        errors.push(`criterion finding has stale provenance: ${finding.id}`);
      }
      if (finding.severity === 'blocking') {
        criterionBlockingFindings.set(
          finding.criterionId,
          (criterionBlockingFindings.get(finding.criterionId) ?? 0) + 1,
        );
        validBlockingKeys.add(finding.id);
      }
    } else if (finding.origin === 'frozen-review-policy') {
      if (
        options.reviewPolicy.mode !== 'blocking-frozen'
        || finding.policyLocator !== options.reviewPolicy.sourceLocator
        || finding.policyDefinitionDigest !== options.reviewPolicy.definitionDigest
      ) {
        errors.push(`frozen policy finding has stale provenance: ${finding.id}`);
      }
      if (finding.severity === 'blocking') validBlockingKeys.add(finding.id);
    }
    if (finding.severity === 'blocking' && finding.evidence.length === 0) {
      errors.push(`blocking finding lacks evidence: ${finding.id}`);
    }
  }
  for (const disposition of dispositions.values()) {
    const blockingCount = criterionBlockingFindings.get(disposition.criterionId) ?? 0;
    if (disposition.status === 'unsatisfied' && blockingCount === 0) {
      errors.push(`unsatisfied criterion lacks a blocking finding: ${disposition.criterionId}`);
    }
    if (disposition.status === 'satisfied' && blockingCount > 0) {
      errors.push(`satisfied criterion has a blocking finding: ${disposition.criterionId}`);
    }
    if (disposition.status === 'unsatisfied' && disposition.evidence.length === 0) {
      errors.push(`unsatisfied criterion lacks evidence: ${disposition.criterionId}`);
    }
  }
  for (const disposition of blockerDispositions.values()) {
    if (
      disposition.status === 'replaced-by'
      && disposition.replacementBlockerKey !== undefined
      && !validBlockingKeys.has(disposition.replacementBlockerKey)
    ) {
      errors.push(
        `replacement blocker does not reference a current blocking finding: ${disposition.blockerKey}`,
      );
    }
  }

  const allCriteriaSatisfied = [...dispositions.values()]
    .every((disposition) => disposition.status === 'satisfied');
  const allPriorBlockersResolved = [...blockerDispositions.values()]
    .every((disposition) => disposition.status === 'resolved');
  const hasBlockingFinding = verdict.findings.some(
    (finding) => finding.severity === 'blocking',
  );
  const hasUnverified = [...dispositions.values()]
    .some((disposition) => disposition.status === 'unverified');
  if (verdict.status === 'PASS' && (
    !allCriteriaSatisfied
    || !allPriorBlockersResolved
    || hasBlockingFinding
  )) {
    errors.push('PASS verdict contradicts dispositions or blocking findings');
  }
  if (verdict.status === 'NEEDS_WORK' && (
    hasUnverified
    || (!hasBlockingFinding && allPriorBlockersResolved)
  )) {
    errors.push('NEEDS_WORK verdict lacks a current blocking reason');
  }
  if (verdict.status === 'INCONCLUSIVE' && !hasUnverified && errors.length === 0) {
    errors.push('INCONCLUSIVE verdict lacks an unverified criterion');
  }

  const verdictDigest = canonicalDigest('wukong/fresh-criteria-verdict/v1', verdict);
  if (errors.length > 0) {
    return {
      valid: false,
      status: 'INCONCLUSIVE',
      reasonCode: 'reviewer_invalid_output',
      errors,
      verdictDigest,
    };
  }
  return {
    valid: true,
    status: verdict.status,
    reasonCode: verdict.status === 'PASS' ? 'passed' : 'criteria_needs_work',
    errors,
    verdictDigest,
  };
}

function validateEvidence(
  evidence: readonly EvidencePointerV1[],
  manifest: ReviewSubjectManifestV1,
  errors: string[],
  label: string,
): void {
  const subjects = new Map<string, ReviewSubjectEntryV1>(
    manifest.entries.map((entry) => [entry.subjectRef, entry]),
  );
  const gateEvidence = new Map<string, BrokeredGateEvidenceEntryV1>(
    manifest.gateEvidence.map((entry) => [
      `${entry.producerId}\0${entry.evidenceId}`,
      entry,
    ]),
  );
  const seen = new Set<string>();
  for (const pointer of evidence) {
    const key = pointer.kind === 'review-subject'
      ? `subject:${pointer.subjectRef}`
      : `gate:${pointer.producerId}\0${pointer.evidenceId}`;
    if (seen.has(key)) {
      errors.push(`duplicate evidence pointer on ${label}`);
      continue;
    }
    seen.add(key);
    if (pointer.kind === 'review-subject') {
      const entry = subjects.get(pointer.subjectRef);
      if (entry === undefined || entry.sha256 !== pointer.subjectDigest) {
        errors.push(`unknown or stale review subject evidence on ${label}`);
      }
      continue;
    }
    const entry = gateEvidence.get(`${pointer.producerId}\0${pointer.evidenceId}`);
    if (entry === undefined || entry.brokeredEvidenceDigest !== pointer.evidenceDigest) {
      errors.push(`unknown or stale Gate evidence on ${label}`);
    }
  }
}
