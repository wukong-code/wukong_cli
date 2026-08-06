import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatLoopPreflightBlocked,
  formatLoopDryRun,
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
      completionCriterion: 'The exact project checks pass and the reviewer returns PASS',
      constraints: [
        'Do not weaken tests',
        'Do not change public APIs',
        'Do not overwrite user changes',
        'Do not send secrets',
        'Do not skip the fresh review',
        'Do not claim success without evidence',
      ],
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
      const output = formatLoopPreflightReady(result, 5, {
        writerModel: 'writer-alias',
        reviewerModel: 'reviewer-alias',
        permission: 'auto',
      });
      expect(output).toContain('Iterations   up to 5 writer iterations');
      expect(output).toContain('Writer       writer-alias');
      expect(output).toContain('Reviewer     reviewer-alias');
      expect(output).toContain('Provider     test → https://api.example.test:443');
      expect(output).toContain('Permission   auto · current OS account · no OS sandbox');
      expect(output).toContain('Done when    The exact project checks pass');
      expect(output).toContain('Must not 1   Do not weaken tests');
      expect(output).toContain('Must not 5   Do not skip the fresh review');
      expect(output).toContain('Must not     +1 more');
      expect(output).toContain('Check 1       pnpm test');
      expect(output).toContain('Check 2       pnpm typecheck');
      expect(output).toContain('Provider calls no separate cap configured');
      expect(output).toContain('Token budget no separate cap configured');
      expect(output).toContain('Outbound     changed tracked files');
      expect(output).toContain('Result       PASS / NEEDS_WORK / ERROR');
      const dirtyOutput = formatLoopPreflightReady({
        ...result,
        workspaceGit: {
          isRepo: true,
          changedFileCount: 7,
          changedFiles: [
            { status: 'M', path: 'src/one.ts' },
            { status: 'A', path: 'src/two.ts' },
            { status: '??', path: 'test/three.test.ts' },
            { status: 'D', path: 'docs/four.md' },
            { status: 'M', path: 'packages/five.ts' },
            { status: 'M', path: 'packages/six.ts' },
          ],
        },
      }, 5);
      expect(dirtyOutput).toContain('7 pre-existing changed files');
      expect(dirtyOutput).toContain('Dirty 1       M src/one.ts');
      expect(dirtyOutput).toContain('Dirty 5       M packages/five.ts');
      expect(dirtyOutput).toContain('Dirty        +2 more');
      expect(result.proposal.gatePlan.requiredChecks).toHaveLength(2);
      expect(result.trustChallenge).toContain('.');
      expect(result.verificationCatalog.entries.filter((entry) =>
        entry.ref.source.kind === 'builtin')).toHaveLength(4);
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
    if (
      ready.ready
      || ready.brokerTrustProposal === undefined
      || ready.brokerTrustChallenge === undefined
    ) return;

    const trusted = await runLoopPreflight({
      ...base,
      acknowledgeWarningSetDigest: warning.proposal.finishLineReview.warningSetDigest,
      approveGatePlanDigest: approvedWarning.proposal.gateApproval.approvalSetDigest,
      trustWorkspaceChallenge: approvedPlan.trustChallenge,
      trustReviewSubjectChallenge: ready.brokerTrustChallenge,
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
      trustReviewSubjectChallenge: ready.brokerTrustChallenge,
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

  it('uses one stream-json protocol for no-selection V2 and exact-selection V3 dry-runs', async () => {
    const cwd = await workspace();
    const skillDir = join(cwd, '.wukong', 'skills', 'review-api-contract');
    await mkdir(join(skillDir, 'verification'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      'name: review-api-contract',
      'description: Review API compatibility.',
      'metadata:',
      '  wukong.verification.criteria: verification/criteria.v1.json',
      '---',
      'Review API compatibility without executing commands.',
    ].join('\n'));
    await writeFile(
      join(skillDir, 'verification', 'criteria.v1.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'wukong.verification-criteria',
        id: 'review-api-contract',
        description: 'Review API compatibility.',
        scope: { kind: 'project', paths: ['src/api/**'] },
        criteria: [{
          id: 'typed-failures',
          text: 'API failures remain explicit and typed.',
          evidence: 'Cite the handler and deterministic test evidence.',
        }],
      }),
    );
    const base = {
      objective: 'keep API failures typed',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      mode: 'tui-proposal' as const,
      getActiveGoal: async () => null,
      discoverChecks: async () => [],
    };
    const none = await runLoopPreflight(base);
    expect(none.ready).toBe(true);
    if (!none.ready) return;
    const noneJson = JSON.parse(formatLoopDryRun(none));
    expect(noneJson).toMatchObject({
      kind: 'loop.finish_line.dry_run',
      contractSchemaVersion: 2,
      selectionState: 'none',
      catalogCompareAndSet: 'not-applicable',
      verificationSelection: null,
      reviewSubjectPolicyVersion: 'review-subject/1',
      estimatedCost: {
        freshReviewerPassesPerGateAttempt: 1,
        additionalSkillCommands: 0,
      },
      runSettings: {
        writerModel: 'glm-5.2',
        reviewerModel: 'glm-5.2',
        permission: 'auto',
      },
      headlessStart: {
        checkDecisionRequired: false,
        approveGatePlanDigest: none.proposal.gateApproval.approvalSetDigest,
        trustReviewSubjectChallenge: none.brokerTrustChallenge,
        acknowledgeReviewSubjectConsentDigest:
          none.reviewSubjectConsentProposal.consentProposalDigest,
        verificationCatalogDigest: null,
        brokerChallengeExpiresWithinMs: 600_000,
      },
    });

    const entry = none.verificationCatalog.entries[0];
    if (entry === undefined) throw new Error('verification catalog entry missing');
    const selected = await runLoopPreflight({
      ...base,
      verificationCatalogDigest: none.verificationCatalog.catalogDigest,
      verificationSkills: [{
        selectionId: entry.selectionId,
        provenanceDigest: entry.ref.provenanceDigest,
      }],
    });
    expect(selected.ready).toBe(true);
    if (!selected.ready) return;
    const selectedJson = JSON.parse(formatLoopDryRun(selected));
    expect(selectedJson).toMatchObject({
      contractSchemaVersion: 3,
      selectionState: 'selected',
      catalogCompareAndSet: {
        preflightCatalogDigest: none.verificationCatalog.catalogDigest,
      },
      verificationSelection: {
        selected: [{
          selectionOrder: 0,
          ref: { provenanceDigest: entry.ref.provenanceDigest },
        }],
      },
      reviewSubjectConsentProposal: {
        provider: { providerId: 'test' },
      },
      headlessStart: {
        trustReviewSubjectChallenge: selected.brokerTrustChallenge,
        verificationCatalogDigest: selected.verificationCatalog.catalogDigest,
      },
    });
  });
});
