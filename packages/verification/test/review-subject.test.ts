import {
  mkdir,
  link,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  readReviewSubjectFileSecurely,
  reviewSubjectFileBackendCapability,
} from '../src/review-subject-file-reader';
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
    await writeFile(
      join(cwd, 'src', 'quoted.json'),
      '{"AWS_SECRET_ACCESS_KEY":"quoted-json-secret-sentinel"}\n',
    );
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
        { logicalPath: 'src/quoted.json', origin: 'changed-tracked' },
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
      { reason: 'secret-content', count: 2 },
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

  it('never follows an ancestor symlink outside the workspace', async () => {
    const cwd = await makeTempDir('wukong-review-ancestor-link-');
    const outside = await makeTempDir('wukong-review-outside-');
    await writeFile(join(outside, 'leak.txt'), 'OUTSIDE_REVIEW_SENTINEL\n');
    await symlink(outside, join(cwd, 'linked'), 'dir');

    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent: makeConsent(['changed-tracked']),
      candidates: [{
        logicalPath: 'linked/leak.txt',
        origin: 'changed-tracked',
      }],
    });

    expect(broker.manifest.entries).toEqual([]);
    expect(broker.manifest.exclusions).toContainEqual({
      reason: 'outside-workspace',
      count: 1,
    });
    expect(broker.searchReviewSubjects('OUTSIDE_REVIEW_SENTINEL')).toEqual([]);
  });

  it('reads the held descriptor during a real ancestor replacement race', async () => {
    const cwd = await makeTempDir('wukong-review-descriptor-race-');
    const outside = await makeTempDir('wukong-review-race-outside-');
    const source = join(cwd, 'src');
    const detached = join(cwd, 'src-detached');
    await mkdir(source);
    await writeFile(join(source, 'subject.txt'), 'SAFE_DESCRIPTOR_BYTES\n');
    await writeFile(
      join(outside, 'subject.txt'),
      'OUTSIDE_REPLACEMENT_BYTES\n',
    );
    let observed = '';

    const bytes = await readReviewSubjectFileSecurely(
      cwd,
      'src/subject.txt',
      1024,
      {
        beforeDescriptorRead: async () => {
          await rename(source, detached);
          await symlink(outside, source, 'dir');
        },
        observeDescriptorBytes: async (value) => {
          observed = value.toString('utf8');
          await rm(source);
          await rename(detached, source);
        },
      },
    );

    expect(observed).toBe('SAFE_DESCRIPTOR_BYTES\n');
    expect(bytes.toString('utf8')).toBe('SAFE_DESCRIPTOR_BYTES\n');
    expect(observed).not.toContain('OUTSIDE_REPLACEMENT_BYTES');
  });

  it('rejects an outside hardlink before reading any descriptor bytes', async () => {
    const cwd = await makeTempDir('wukong-review-hardlink-');
    const outside = await makeTempDir('wukong-review-hardlink-outside-');
    const outsidePath = join(outside, 'outside.txt');
    await writeFile(outsidePath, 'OUTSIDE_HARDLINK_SENTINEL\n');
    await link(outsidePath, join(cwd, 'subject.txt'));
    let beforeRead = false;
    let observed = false;

    await expect(readReviewSubjectFileSecurely(
      cwd,
      'subject.txt',
      1024,
      {
        beforeDescriptorRead: () => {
          beforeRead = true;
        },
        observeDescriptorBytes: () => {
          observed = true;
        },
      },
    )).rejects.toMatchObject({ reason: 'unsafe-path' });
    expect(beforeRead).toBe(false);
    expect(observed).toBe(false);

    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent: makeConsent(['changed-tracked']),
      candidates: [{
        logicalPath: 'subject.txt',
        origin: 'changed-tracked',
      }],
    });
    expect(broker.manifest.entries).toEqual([]);
    expect(broker.searchReviewSubjects('OUTSIDE_HARDLINK_SENTINEL')).toEqual([]);
  });

  it('rejects non-canonical path segments inside the descriptor reader', async () => {
    const cwd = await makeTempDir('wukong-review-reader-path-');
    await writeFile(join(cwd, 'safe.txt'), 'safe\n');
    for (const logicalPath of [
      '../safe.txt',
      './safe.txt',
      'dir//safe.txt',
      'dir\\safe.txt',
      '/safe.txt',
      'safe.txt\u0000suffix',
    ]) {
      await expect(readReviewSubjectFileSecurely(
        cwd,
        logicalPath,
        1024,
      ), logicalPath).rejects.toMatchObject({ reason: 'unsafe-path' });
    }
  });

  it('fails closed before projecting evidence when the file backend is unavailable', async () => {
    expect(reviewSubjectFileBackendCapability('win32')).toEqual({
      supported: false,
      reasonCode: 'review_subject_backend_unavailable',
    });
    const cwd = await makeTempDir('wukong-review-backend-unavailable-');
    await writeFile(join(cwd, 'safe.txt'), 'safe\n');
    let evidenceReads = 0;
    const platform = vi.spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      await expect(ReviewSubjectBroker.build({
        workspaceRoot: cwd,
        attemptId: 'attempt-1',
        runId: 'run-1',
        contractId: 'contract-1',
        planDigest: 'sha256:plan',
        workspaceFingerprint: 'sha256:workspace-state',
        consent: makeConsent(['changed-tracked', 'gate-evidence']),
        candidates: [],
        gateEvidence: [{
          producerId: 'check:test',
          evidenceId: 'stdout',
          get content() {
            evidenceReads += 1;
            return 'must not be projected';
          },
          mediaType: 'text/plain',
        }],
      })).rejects.toMatchObject({
        reasonCode: 'review_subject_backend_unavailable',
      });
      expect(evidenceReads).toBe(0);
    } finally {
      platform.mockRestore();
    }
  });

  it('redacts cloud, database, and JWT credentials before reviewer access', async () => {
    const cwd = await makeTempDir('wukong-review-evidence-redaction-');
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
    const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const databasePassword = 'database-password-sentinel';
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    const broker = await ReviewSubjectBroker.build({
      workspaceRoot: cwd,
      attemptId: 'attempt-1',
      runId: 'run-1',
      contractId: 'contract-1',
      planDigest: 'sha256:plan',
      workspaceFingerprint: 'sha256:workspace-state',
      consent: makeConsent(['gate-evidence']),
      candidates: [],
      gateEvidence: [{
        producerId: 'candidate-check-0000',
        evidenceId: 'stdout',
        content: [
          `AWS_ACCESS_KEY_ID=${accessKeyId}`,
          `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
          `DATABASE_URL=postgresql://alice:${databasePassword}@db.example.test/app`,
          `token=${jwt}`,
          `payload={"AWS_SECRET_ACCESS_KEY":"${secretAccessKey}"}`,
          `"password": "${databasePassword}"`,
          'access token: fetch failed',
          'refresh_token: refresh failed',
        ].join('\n'),
        mediaType: 'text/plain',
      }, {
        producerId: 'candidate-check-0000',
        evidenceId: 'stderr',
        content: `connection failed for redis://default:${databasePassword}@cache.example.test/0`,
        mediaType: 'text/plain',
      }],
    });

    const reviewerEvidence = [
      broker.readGateEvidence('candidate-check-0000', 'stdout'),
      broker.readGateEvidence('candidate-check-0000', 'stderr'),
    ].join('\n');
    for (const credential of [
      accessKeyId,
      secretAccessKey,
      databasePassword,
      jwt,
      'alice',
    ]) {
      expect(reviewerEvidence).not.toContain(credential);
    }
    expect(reviewerEvidence).toContain('access token: fetch failed');
    expect(reviewerEvidence).toContain('refresh_token: refresh failed');
    expect(reviewerEvidence).toContain('[REDACTED]');
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
