import { describe, expect, it } from 'vitest';

import {
  buildStandaloneGateReviewPrompt,
  evaluateStandaloneGateDecision,
  parseStandaloneReviewerVerdict,
  renderDeliveryProofCard,
  sanitizeProofText,
  type GateRunRecord,
} from '../src/gate-review';
import type { ProofResult } from '../src/proof';
import type { GitInspection } from '../src/types';

function makeProof(overrides: Partial<ProofResult> = {}): ProofResult {
  return {
    status: 'passed',
    cwd: '/Users/alice/work/repo',
    generatedAt: '2026-11-24T00:00:00.000Z',
    verification: {
      status: 'passed',
      cwd: '/Users/alice/work/repo',
      generatedAt: '2026-11-24T00:00:00.000Z',
      changedFiles: [],
      gitStatus: '',
      diffStat: '',
      selectedCommands: ['pnpm test'],
      commandResults: [
        {
          command: 'pnpm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 42,
          stdout: 'secret stdout should never appear',
          stderr: '',
        },
      ],
      risks: [],
    },
    scan: {
      status: 'passed',
      cwd: '/Users/alice/work/repo',
      generatedAt: '2026-11-24T00:00:00.000Z',
      changedFiles: [],
      gitStatus: '',
      diffStat: '',
      risks: [],
    },
    summary: 'verification passed',
    recommendation: 'Safe to merge.',
    reasonCode: 'passed',
    snapshotId: 'snap-1234',
    workspaceFingerprint: {
      headSha: 'abcdef1234567890',
      inputDigest: 'in-1',
      configDigest: 'cfg-1',
    },
    blockers: [],
    ...overrides,
  };
}

function makeGit(overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    cwd: '/Users/alice/work/repo',
    isRepo: true,
    root: '/Users/alice/work/repo',
    statusText: '',
    diffText: '',
    diffStat: '',
    changedFiles: [],
    ...overrides,
  };
}

describe('sanitizeProofText', () => {
  it('redacts secrets, URL credentials, query tokens, and absolute home paths', () => {
    const raw = [
      'key=sk-secret-test-value',
      'gh=ghp_1234567890abcdef',
      'ai=AIzaSyDummyKey1234567890',
      'url=https://user:pass@api.example.test/v1?token=query-secret&api_key=another-secret',
      'auth=Bearer my-bearer-secret-token',
      'mac=/Users/alice/project/.wukong/checks.json',
      'linux=/home/bob/project/src/index.ts',
      'win=C:\\Users\\carol\\project\\src\\index.ts',
      'custom=/var/folders/tmp/custom-home/runs/gate.json',
    ].join('\n');

    const cleaned = sanitizeProofText(raw, '/var/folders/tmp/custom-home');

    expect(cleaned).not.toContain('sk-secret-test-value');
    expect(cleaned).not.toContain('ghp_1234567890abcdef');
    expect(cleaned).not.toContain('AIzaSyDummyKey1234567890');
    expect(cleaned).not.toContain('user:pass');
    expect(cleaned).not.toContain('query-secret');
    expect(cleaned).not.toContain('another-secret');
    expect(cleaned).not.toContain('my-bearer-secret-token');
    expect(cleaned).not.toContain('/Users/alice');
    expect(cleaned).not.toContain('/home/bob');
    expect(cleaned).not.toContain('C:\\Users\\carol');
    expect(cleaned).not.toContain('/var/folders/tmp/custom-home');
    expect(cleaned).toContain('~/project/.wukong/checks.json');
    expect(cleaned).toContain('~/project/src/index.ts');
    expect(cleaned).toContain('~\\project\\src\\index.ts');
    expect(cleaned).toContain('~/runs/gate.json');
  });
});

describe('buildStandaloneGateReviewPrompt', () => {
  it('filters secret-like diff sections and bounds large diffs', () => {
    const diffText = [
      'diff --git a/.env.local b/.env.local',
      '+++ b/.env.local',
      '+API_KEY=should-not-leave-local-machine',
      'diff --git a/src/app.ts b/src/app.ts',
      '+++ b/src/app.ts',
      `+${'x'.repeat(300)}`,
    ].join('\n');

    const built = buildStandaloneGateReviewPrompt({
      objective: 'Verify login handler',
      reviewPolicyText: '- Never bypass auth',
      git: makeGit({
        changedFiles: [
          { path: '.env.local', status: 'M' },
          { path: 'src/app.ts', status: 'M' },
        ],
        diffText,
      }),
      proof: makeProof(),
      maxDiffChars: 120,
    });

    expect(built.skippedSecretFiles).toEqual(['.env.local']);
    expect(built.diffTruncated).toBe(true);
    expect(built.userPrompt).not.toContain('should-not-leave-local-machine');
    expect(built.userPrompt).toContain('[diff truncated at 120 chars]');
    expect(built.systemPrompt).toContain('UNTRUSTED DATA');
    expect(built.systemPrompt).toContain('GATE_VERDICT_JSON:');
  });
});

describe('parseStandaloneReviewerVerdict', () => {
  it('parses GATE_VERDICT_JSON lines and fenced json blocks', () => {
    const fromLine = parseStandaloneReviewerVerdict([
      'Review complete.',
      'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"NEEDS_WORK","summary":"Missing error check","findings":[{"id":"f1","severity":"blocking","message":"Null pointer","file":"src/a.ts","line":12,"nextAction":"Add null check"}],"uncoveredItems":["Integration suite skipped"]}',
    ].join('\n'));
    expect(fromLine).toEqual({
      valid: true,
      verdict: {
        schemaVersion: 1,
        status: 'NEEDS_WORK',
        summary: 'Missing error check',
        findings: [
          {
            id: 'f1',
            severity: 'blocking',
            message: 'Null pointer',
            file: 'src/a.ts',
            line: 12,
            nextAction: 'Add null check',
          },
        ],
        uncoveredItems: ['Integration suite skipped'],
      },
    });

    const fromFence = parseStandaloneReviewerVerdict([
      '```json',
      '{"schemaVersion":1,"status":"PASS","summary":"Clean change","findings":[],"uncoveredItems":[]}',
      '```',
    ].join('\n'));
    expect(fromFence.valid).toBe(true);
  });

  it('rejects PASS when blocking findings are present or required fields are malformed', () => {
    const contradiction = parseStandaloneReviewerVerdict(
      'GATE_VERDICT_JSON: {"schemaVersion":1,"status":"PASS","summary":"Wait","findings":[{"id":"f1","severity":"blocking","message":"Broken","nextAction":"Fix"}],"uncoveredItems":[]}',
    );
    expect(contradiction).toEqual({
      valid: false,
      reason: 'Reviewer returned PASS while reporting blocking findings.',
    });

    const missing = parseStandaloneReviewerVerdict('No JSON here at all.');
    expect(missing.valid).toBe(false);
  });
});

describe('evaluateStandaloneGateDecision', () => {
  it('never allows PASS when deterministic checks fail, are empty, or high-severity risks exist', () => {
    const failedChecks = evaluateStandaloneGateDecision({
      proof: makeProof({
        status: 'blocked',
        verification: {
          ...makeProof().verification,
          status: 'failed',
          commandResults: [
            {
              command: 'pnpm test',
              status: 'failed',
              exitCode: 1,
              durationMs: 10,
              stdout: '',
              stderr: 'fail',
            },
          ],
        },
      }),
      reviewPolicyLoaded: true,
    });
    expect(failedChecks.status).toBe('NEEDS_WORK');
    expect(failedChecks.reasonCode).toBe('checks_failed');
    expect(failedChecks.reviewer.status).toBe('not_run');

    const emptyChecks = evaluateStandaloneGateDecision({
      proof: makeProof({
        status: 'blocked',
        verification: {
          ...makeProof().verification,
          status: 'failed',
          selectedCommands: [],
          commandResults: [],
        },
      }),
      reviewPolicyLoaded: false,
    });
    expect(emptyChecks.status).toBe('NEEDS_WORK');
    expect(emptyChecks.reasonCode).toBe('no_executable_checks');

    const highRisk = evaluateStandaloneGateDecision({
      proof: makeProof({
        scan: {
          ...makeProof().scan,
          status: 'failed',
          risks: [{ id: 'file.secret_like_changed', severity: 'high', message: 'Secret changed' }],
        },
      }),
      reviewPolicyLoaded: true,
    });
    expect(highRisk.status).toBe('NEEDS_WORK');
    expect(highRisk.reasonCode).toBe('risks_blocked');
  });

  it('returns ERROR when reviewer fails, returns invalid output, or workspace changes', () => {
    for (const outcome of [
      { kind: 'error' as const, errorCode: 'timeout', errorMessage: 'Timed out', model: 'm1', providerId: 'openai' },
      { kind: 'invalid' as const, reason: 'Bad JSON', model: 'm1', providerId: 'openai' },
      { kind: 'workspace_changed' as const, model: 'm1', providerId: 'openai' },
    ]) {
      const decision = evaluateStandaloneGateDecision({
        proof: makeProof(),
        reviewPolicyLoaded: true,
        reviewerOutcome: outcome,
      });
      expect(decision.status).toBe('ERROR');
      expect(decision.reviewer.status).toBe('error');
    }
  });

  it('returns PASS when deterministic checks and independent review both pass', () => {
    const decision = evaluateStandaloneGateDecision({
      proof: makeProof(),
      reviewPolicyLoaded: true,
      reviewerOutcome: {
        kind: 'verdict',
        model: 'default',
        providerId: 'openai',
        verdict: {
          schemaVersion: 1,
          status: 'PASS',
          summary: 'Code changes and tests look solid.',
          findings: [],
          uncoveredItems: ['No live staging test executed'],
        },
      },
    });
    expect(decision.status).toBe('PASS');
    expect(decision.reasonCode).toBe('passed');
    expect(decision.reviewer.status).toBe('passed');
    expect(decision.uncoveredItems).toContain('No live staging test executed');
  });
});

describe('renderDeliveryProofCard', () => {
  it('renders a sanitized Markdown card and flags stale commits', () => {
    const record: GateRunRecord = {
      schemaVersion: 1,
      runId: 'gate-2026-11-24T00-00-00-000Z-12345678',
      source: 'gate',
      generatedAt: '2026-11-24T00:00:00.000Z',
      workspaceIdentityDigest: 'sha256:1234567890abcdef1234',
      workspaceName: 'repo',
      objective: 'Fix auth token refresh with sk-secret-test-value',
      git: {
        isRepo: true,
        headSha: 'abcdef1234567890',
        dirty: false,
        changedFileCount: 0,
      },
      snapshotId: 'snap-1',
      status: 'PASS',
      reasonCode: 'passed',
      summary: 'All checks passed under /Users/alice/work/repo.',
      checks: [
        { command: 'OPENAI_API_KEY=sk-secret-test-value pnpm test', status: 'passed', exitCode: 0, durationMs: 25 },
      ],
      risks: [],
      reviewer: {
        status: 'passed',
        model: 'default',
        providerId: 'openai',
        summary: 'Looks clean.',
      },
      findings: [],
      uncoveredItems: ['Manual UI pass not run'],
      nextSteps: ['Open PR'],
      reviewPolicyLoaded: true,
    };

    const md = renderDeliveryProofCard(record, {
      currentHeadSha: '9999999999999999',
      currentDirty: true,
      homeDir: '/Users/alice',
    });

    expect(md).toContain('## Wukong Delivery Proof Card');
    expect(md).toContain('**STALE**');
    expect(md).toContain('HEAD moved from abcdef12 to 99999999');
    expect(md).toContain('### Uncovered Items');
    expect(md).toContain('Manual UI pass not run');
    expect(md).not.toContain('sk-secret-test-value');
    expect(md).not.toContain('/Users/alice');
    expect(md).not.toContain('secret stdout should never appear');
  });
});
