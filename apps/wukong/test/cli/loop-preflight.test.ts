import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatLoopPreflightBlocked,
  formatLoopPreflightReady,
  runLoopPreflight,
} from '#/cli/lib/loop-preflight';

describe('Loop preflight', () => {
  const homes: string[] = [];
  const reviewProvider = { providerId: 'test', endpoint: 'https://api.example.test' };

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'wukong-loop-preflight-'));
    homes.push(path);
    return path;
  }

  it('discovers checks before declaring the Loop ready', async () => {
    const cwd = await workspace();
    const result = await runLoopPreflight({
      objective: 'fix tests',
      model: 'glm-5.2',
      workspace: await realpath(cwd),
      reviewProvider,
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test', 'pnpm typecheck'],
    });

    expect(result).toMatchObject({
      ready: true,
      model: 'glm-5.2',
      workspace: await realpath(cwd),
      checks: ['pnpm test', 'pnpm typecheck'],
    });
    if (result.ready) {
      expect(formatLoopPreflightReady(result, 5)).toContain('Run          up to 5 iterations');
      expect(result.proposal.gatePlan.requiredChecks).toHaveLength(2);
      expect(result.trustChallenge).toContain('.');
    }
  });

  it('allows a Loop with no checks but labels the missing evidence', async () => {
    const cwd = await workspace();
    const result = await runLoopPreflight({
      objective: 'create a module',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      getActiveGoal: async () => null,
      discoverChecks: async () => [],
    });

    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(formatLoopPreflightReady(result, 2)).toContain('Verification 0 required project checks');
      expect(result.proposal.finishLineReview.warnings.map((warning) => warning.code))
        .toContain('no_resolved_checks');
    }
  });

  it('blocks before quota when model, workspace, active Goal, or checks config is invalid', async () => {
    const cwd = await workspace();
    const base = {
      objective: 'fix tests',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test'],
    };

    const noModel = await runLoopPreflight({ ...base, model: '' });
    const badWorkspace = await runLoopPreflight({ ...base, workspace: join(cwd, 'missing') });
    const activeGoal = await runLoopPreflight({
      ...base,
      getActiveGoal: async () => ({ goalId: 'g1' }) as never,
    });
    const badChecks = await runLoopPreflight({
      ...base,
      discoverChecks: async () => { throw new Error('bad checks file'); },
    });

    expect(noModel).toMatchObject({ ready: false, reason: 'No model is configured.' });
    expect(badWorkspace).toMatchObject({ ready: false, reason: 'The workspace is not readable.' });
    expect(activeGoal).toMatchObject({ ready: false, reason: 'Another Goal is already active.' });
    expect(badChecks).toMatchObject({ ready: false, reason: expect.stringContaining('bad checks file') });
    if (!noModel.ready) expect(formatLoopPreflightBlocked(noModel)).toContain('Loop not started');
  });

  it('requires exact headless selection, warning, plan, and workspace approvals', async () => {
    const cwd = await workspace();
    const base = {
      objective: 'fix tests',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      mode: 'headless' as const,
      discoveredCheckDecision: 'accept' as const,
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test'],
      homeDir: join(cwd, 'home'),
    };

    const warning = await runLoopPreflight(base);
    expect(warning).toMatchObject({
      ready: false,
      reasonCode: 'finish_line_warning_ack_required',
    });
    if (warning.ready || warning.proposal === undefined) return;

    const approvedWarning = await runLoopPreflight({
      ...base,
      acknowledgeWarningSetDigest: warning.proposal.finishLineReview.warningSetDigest,
    });
    expect(approvedWarning).toMatchObject({
      ready: false,
      reasonCode: 'gate_approval_required',
    });
    if (approvedWarning.ready || approvedWarning.proposal === undefined) return;

    const approvedPlan = await runLoopPreflight({
      ...base,
      acknowledgeWarningSetDigest: warning.proposal.finishLineReview.warningSetDigest,
      approveGatePlanDigest: approvedWarning.proposal.gateApproval.approvalSetDigest,
    });
    expect(approvedPlan).toMatchObject({
      ready: false,
      reasonCode: 'workspace_trust_required',
    });
    if (approvedPlan.ready || approvedPlan.trustChallenge === undefined) return;

    const ready = await runLoopPreflight({
      ...base,
      acknowledgeWarningSetDigest: warning.proposal.finishLineReview.warningSetDigest,
      approveGatePlanDigest: approvedWarning.proposal.gateApproval.approvalSetDigest,
      trustWorkspaceChallenge: approvedPlan.trustChallenge,
    });
    expect(ready).toMatchObject({
      ready: false,
      reasonCode: 'review_subject_trust_required',
    });
    if (ready.ready || ready.brokerTrustProposal === undefined) return;

    const trusted = await runLoopPreflight({
      ...base,
      acknowledgeWarningSetDigest: warning.proposal.finishLineReview.warningSetDigest,
      approveGatePlanDigest: approvedWarning.proposal.gateApproval.approvalSetDigest,
      trustWorkspaceChallenge: approvedPlan.trustChallenge,
      trustReviewSubjectProposalDigest: ready.brokerTrustProposal.trustProposalDigest,
    });
    expect(trusted).toMatchObject({
      ready: false,
      reasonCode: 'review_subject_consent_required',
    });
    if (trusted.ready || trusted.reviewSubjectConsentProposal === undefined) return;

    const consented = await runLoopPreflight({
      ...base,
      acknowledgeWarningSetDigest: warning.proposal.finishLineReview.warningSetDigest,
      approveGatePlanDigest: approvedWarning.proposal.gateApproval.approvalSetDigest,
      trustWorkspaceChallenge: approvedPlan.trustChallenge,
      trustReviewSubjectProposalDigest: ready.brokerTrustProposal.trustProposalDigest,
      acknowledgeReviewSubjectConsentDigest:
        trusted.reviewSubjectConsentProposal.consentProposalDigest,
    });
    expect(consented).toMatchObject({ ready: true, checks: ['pnpm test'] });
  });

  it('rejects stale headless approval after the Finish Line changes', async () => {
    const cwd = await workspace();
    const initial = await runLoopPreflight({
      objective: 'first objective',
      completionCriterion: 'All tests pass cleanly',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      mode: 'headless',
      discoveredCheckDecision: 'accept',
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test'],
      homeDir: join(cwd, 'home'),
    });
    expect(initial.ready).toBe(false);
    if (initial.ready || initial.proposal === undefined) return;

    const changed = await runLoopPreflight({
      objective: 'different objective',
      completionCriterion: 'All tests pass cleanly',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      mode: 'headless',
      discoveredCheckDecision: 'accept',
      getActiveGoal: async () => null,
      discoverChecks: async () => ['pnpm test'],
      approveGatePlanDigest: initial.proposal.gateApproval.approvalSetDigest,
      homeDir: join(cwd, 'home'),
    });
    expect(changed).toMatchObject({ ready: false, reasonCode: 'gate_approval_mismatch' });
  });
});
