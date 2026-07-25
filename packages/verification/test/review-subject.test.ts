import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeReviewSubjectConsent,
  clearBrokerReviewTrustBindingsForTests,
  createBrokerReviewTrustChallenge,
  createBrokerReviewTrustProposal,
  createReviewSubjectConsentProposal,
  grantBrokerReviewTrust,
  isBrokerReviewTrustBindingActive,
  ReviewSubjectBroker,
  ReviewSubjectError,
  validateProviderAgainstConsent,
  verifyBrokerReviewTrustChallenge,
  revokeBrokerReviewTrustBinding,
} from '../src/review-subject';
import {
  createFreshReviewerInputDigest,
  type FreshCriteriaVerdictV1,
  validateFreshCriteriaVerdict,
} from '../src/fresh-reviewer';
import { makeTempDir } from './helpers';

describe('Review Subject consent and broker', () => {
  beforeEach(() => {
    clearBrokerReviewTrustBindingsForTests();
  });

  it('binds broker trust and outbound consent as separate exact decisions', () => {
    const trustProposal = createBrokerReviewTrustProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      intent: 'once',
    });
    const trust = grantBrokerReviewTrust(
      trustProposal,
      trustProposal.trustProposalDigest,
      'grant-1',
    );
    const consentProposal = createReviewSubjectConsentProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      allowedOrigins: ['changed-tracked', 'gate-evidence'],
      providerId: 'anthropic',
      endpoint: 'https://EXAMPLE.com/v1/messages',
    });
    const consent = acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
      1_000,
    );

    expect(trust).toMatchObject({
      scope: 'brokered-review-subject',
      trustGrantId: 'grant-1',
    });
    expect(consent.provider.providerId).toBe('anthropic');
    expect(consent.consentDigest).not.toBe(consent.consentProposalDigest);
    expect(() => {
      validateProviderAgainstConsent({
        consent,
        providerId: 'anthropic',
        endpoint: 'https://example.com:443/other',
      });
    }).not.toThrow();
    expect(() => {
      validateProviderAgainstConsent({
        consent,
        providerId: 'other',
        endpoint: 'https://example.com',
      });
    }).toThrowError(expect.objectContaining({
      reasonCode: 'review_subject_consent_required',
    }));
    expect(() => {
      validateProviderAgainstConsent({
        consent,
        providerId: 'anthropic',
        endpoint: 'https://example.com',
        redirectEndpoint: 'https://redirect.example.test',
      });
    }).toThrowError(expect.objectContaining({
      reasonCode: 'review_subject_consent_required',
    }));
  });

  it('uses a proposal-bound broker challenge that expires within ten minutes', () => {
    const proposal = createBrokerReviewTrustProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      intent: 'once',
    });
    const challenge = createBrokerReviewTrustChallenge(proposal, { now: 1_000 });

    expect(verifyBrokerReviewTrustChallenge({
      challenge,
      proposal,
      now: 1_000,
    })).toBe(true);
    expect(verifyBrokerReviewTrustChallenge({
      challenge,
      proposal,
      now: 601_001,
    })).toBe(false);
    expect(verifyBrokerReviewTrustChallenge({
      challenge,
      proposal: createBrokerReviewTrustProposal({
        workspaceIdentityDigest: 'sha256:other-workspace',
        intent: 'once',
      }),
      now: 1_000,
    })).toBe(false);
  });

  it('invalidates the exact in-memory broker binding immediately on revoke', () => {
    const proposal = createBrokerReviewTrustProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      intent: 'once',
    });
    const binding = grantBrokerReviewTrust(
      proposal,
      proposal.trustProposalDigest,
      'grant-revoke-test',
    );

    expect(isBrokerReviewTrustBindingActive(binding)).toBe(true);
    revokeBrokerReviewTrustBinding(binding.trustGrantId);
    expect(isBrokerReviewTrustBindingActive(binding)).toBe(false);
  });

  it('rejects non-canonical origins and limits above the hard ceiling', () => {
    expect(() => createReviewSubjectConsentProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      allowedOrigins: ['gate-evidence', 'changed-tracked'],
      providerId: 'example',
      endpoint: 'https://example.test',
    })).toThrow(ReviewSubjectError);
    expect(() => createReviewSubjectConsentProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      allowedOrigins: ['changed-tracked'],
      limits: { maxFiles: 501 },
      providerId: 'example',
      endpoint: 'https://example.test',
    })).toThrow(ReviewSubjectError);
  });

  it('excludes secret/private/generated/binary inputs and exposes only bounded refs', async () => {
    const cwd = await makeTempDir('wukong-review-broker-');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await mkdir(join(cwd, 'dist'), { recursive: true });
    await writeFile(join(cwd, 'src', 'safe.ts'), 'export const answer = 42;\n');
    await writeFile(join(cwd, 'src', 'config.ts'), 'const API_KEY = "YOUR_API_KEY";\n');
    await writeFile(join(cwd, '.env'), 'API_KEY=YOUR_API_KEY\n');
    await writeFile(join(cwd, 'dist', 'built.js'), 'generated');
    await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    const consent = makeConsent(['changed-tracked', 'gate-evidence']);
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent,
      candidates: [
        { logicalPath: '.env', origin: 'changed-tracked' },
        { logicalPath: 'dist/built.js', origin: 'changed-tracked' },
        { logicalPath: 'image.bin', origin: 'changed-tracked' },
        { logicalPath: 'src/safe.ts', origin: 'changed-tracked' },
        { logicalPath: 'src/config.ts', origin: 'changed-tracked' },
      ],
      gateEvidence: [
        {
          producerId: 'check:test',
          evidenceId: 'stdout',
          content: 'password=YOUR_API_KEY\nTests passed',
          mediaType: 'text/plain',
        },
        {
          producerId: 'scan',
          evidenceId: 'private',
          content: '-----BEGIN PRIVATE KEY-----',
          mediaType: 'text/plain',
        },
      ],
    });

    expect(broker.manifest.entries).toMatchObject([{
      logicalPath: 'src/safe.ts',
      origin: 'changed-tracked',
    }]);
    expect(broker.manifest.exclusions).toEqual(expect.arrayContaining([
      { reason: 'binary', count: 1 },
      { reason: 'generated', count: 1 },
      { reason: 'secret-content', count: 1 },
      { reason: 'secret-path', count: 1 },
    ]));
    expect(broker.manifest.gateEvidence).toMatchObject([{
      producerId: 'check:test',
      evidenceId: 'stdout',
    }]);
    expect(broker.manifest.gateEvidenceExclusions).toMatchObject([{
      reason: 'secret-content',
    }]);
    expect(JSON.stringify(broker.manifest.gateEvidenceExclusions))
      .not.toContain('private');
    const subject = broker.manifest.entries[0]!;
    expect(broker.readReviewSubject(subject.subjectRef)).toContain('answer = 42');
    expect(broker.readGateEvidence('check:test', 'stdout')).toContain('[REDACTED]');
    expect(() => broker.readReviewSubject('src/config.ts')).toThrowError(
      expect.objectContaining({ reasonCode: 'reviewer_evidence_stale' }),
    );
    expect(() => broker.readGateEvidence('scan', 'private')).toThrowError(
      expect.objectContaining({ reasonCode: 'reviewer_evidence_stale' }),
    );
    expect(broker.searchReviewSubjects('answer')).toEqual([{
      subjectRef: subject.subjectRef,
      logicalPath: 'src/safe.ts',
    }]);
    broker.destroy();
    expect(() => broker.readReviewSubject(subject.subjectRef)).toThrowError(
      expect.objectContaining({ reasonCode: 'reviewer_evidence_stale' }),
    );
  });

  it('fails freshness after the workspace subject changes', async () => {
    const cwd = await makeTempDir('wukong-review-freshness-');
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'index.ts'), 'export const value = 1;\n');
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent: makeConsent(['changed-tracked']),
      candidates: [{ logicalPath: 'src/index.ts', origin: 'changed-tracked' }],
    });
    await expect(broker.assertFresh('sha256:workspace-state')).resolves.toBeUndefined();
    await writeFile(join(cwd, 'src', 'index.ts'), 'export const value = 2;\n');
    await expect(broker.assertFresh('sha256:workspace-state')).rejects.toMatchObject({
      reasonCode: 'review_subject_changed',
    });
  });

  it('fails instead of truncating when total subject bytes exceed consent', async () => {
    const cwd = await makeTempDir('wukong-review-limit-');
    await writeFile(join(cwd, 'a.txt'), '12345678');
    await writeFile(join(cwd, 'b.txt'), '12345678');
    const proposal = createReviewSubjectConsentProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      allowedOrigins: ['changed-tracked'],
      limits: { maxTotalBytes: 10, maxFileBytes: 10 },
      providerId: 'example',
      endpoint: 'https://example.test',
    });
    const consent = acknowledgeReviewSubjectConsent(
      proposal,
      proposal.consentProposalDigest,
      1_000,
    );

    await expect(ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent,
      candidates: [
        { logicalPath: 'a.txt', origin: 'changed-tracked' },
        { logicalPath: 'b.txt', origin: 'changed-tracked' },
      ],
    })).rejects.toMatchObject({ reasonCode: 'review_subject_limit' });
  });
});

describe('Fresh Criteria verdict validation', () => {
  it('accepts a fully evidenced PASS and rejects incomplete or stale evidence', async () => {
    const cwd = await makeTempDir('wukong-fresh-verdict-');
    await writeFile(join(cwd, 'safe.ts'), 'export const ok = true;\n');
    const consent = makeConsent(['changed-tracked']);
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent,
      candidates: [{ logicalPath: 'safe.ts', origin: 'changed-tracked' }],
    });
    const entry = broker.manifest.entries[0]!;
    const reviewerInputDigest = createFreshReviewerInputDigest({
      attemptId: 'attempt-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      selectionDigest: 'sha256:selection',
      subjectManifestDigest: broker.manifest.manifestDigest,
      orderedCheckResultDigests: ['sha256:check'],
      priorBlockerSetDigest: 'sha256:blockers',
      reviewPolicyDigest: 'sha256:policy',
      consentDigest: consent.consentDigest,
    });
    const evidence = [{
      kind: 'review-subject' as const,
      subjectRef: entry.subjectRef,
      subjectDigest: entry.sha256,
    }];
    const verdict: FreshCriteriaVerdictV1 = {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      reviewerInputDigest,
      status: 'PASS',
      criterionDispositions: [{
        criterionId: 'objective',
        criterionProvenanceDigest: 'sha256:criterion',
        status: 'satisfied',
        evidence,
      }],
      priorBlockerDispositions: [{
        blockerKey: 'prior:1',
        status: 'resolved',
        evidence,
      }],
      findings: [],
    };
    const options = {
      attemptId: 'attempt-1',
      expectedReviewerInputDigest: reviewerInputDigest,
      criteria: [{
        criterionId: 'objective',
        criterionProvenanceDigest: 'sha256:criterion',
      }],
      priorBlockerKeys: ['prior:1'],
      reviewPolicy: { mode: 'advisory-live' as const },
      manifest: broker.manifest,
    };

    expect(validateFreshCriteriaVerdict(verdict, options)).toMatchObject({
      valid: true,
      status: 'PASS',
      reasonCode: 'passed',
    });
    expect(validateFreshCriteriaVerdict({
      ...verdict,
      criterionDispositions: [{
        ...verdict.criterionDispositions[0]!,
        evidence: [],
      }],
    }, options)).toMatchObject({
      valid: false,
      status: 'INCONCLUSIVE',
      reasonCode: 'reviewer_invalid_output',
    });
    expect(validateFreshCriteriaVerdict({
      ...verdict,
      criterionDispositions: [{
        ...verdict.criterionDispositions[0]!,
        evidence: [{
          ...evidence[0]!,
          subjectRef: 'hmac256:stale',
        }],
      }],
    }, options)).toMatchObject({
      valid: false,
      status: 'INCONCLUSIVE',
    });
  });

  it('keeps independent findings advisory and requires blocking provenance', async () => {
    const cwd = await makeTempDir('wukong-fresh-policy-');
    await writeFile(join(cwd, 'safe.ts'), 'export const ok = true;\n');
    const consent = makeConsent(['changed-tracked']);
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent,
      candidates: [{ logicalPath: 'safe.ts', origin: 'changed-tracked' }],
    });
    const entry = broker.manifest.entries[0]!;
    const evidence = [{
      kind: 'review-subject' as const,
      subjectRef: entry.subjectRef,
      subjectDigest: entry.sha256,
    }];
    const verdict: FreshCriteriaVerdictV1 = {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      reviewerInputDigest: 'sha256:input',
      status: 'NEEDS_WORK',
      criterionDispositions: [{
        criterionId: 'objective',
        criterionProvenanceDigest: 'sha256:criterion',
        status: 'unsatisfied',
        evidence,
      }],
      priorBlockerDispositions: [],
      findings: [{
        id: 'finding-1',
        origin: 'criterion',
        criterionId: 'objective',
        criterionProvenanceDigest: 'sha256:criterion',
        severity: 'blocking',
        message: 'Objective is not complete.',
        nextAction: 'Complete the implementation.',
        evidence,
      }, {
        id: 'advice-1',
        origin: 'independent',
        severity: 'important',
        message: 'Consider simplifying this module.',
        nextAction: 'Review after the blocking issue.',
        evidence,
      }],
    };

    expect(validateFreshCriteriaVerdict(verdict, {
      attemptId: 'attempt-1',
      expectedReviewerInputDigest: 'sha256:input',
      criteria: [{
        criterionId: 'objective',
        criterionProvenanceDigest: 'sha256:criterion',
      }],
      priorBlockerKeys: [],
      reviewPolicy: { mode: 'advisory-live' },
      manifest: broker.manifest,
    })).toMatchObject({
      valid: true,
      status: 'NEEDS_WORK',
    });
  });
});

function makeConsent(
  allowedOrigins: readonly ('changed-tracked' | 'gate-evidence')[],
) {
  const proposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest: 'sha256:workspace',
    allowedOrigins,
    providerId: 'example',
    endpoint: 'https://example.test/v1',
  });
  return acknowledgeReviewSubjectConsent(
    proposal,
    proposal.consentProposalDigest,
    1_000,
  );
}
