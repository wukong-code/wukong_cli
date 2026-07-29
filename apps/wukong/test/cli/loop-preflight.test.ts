import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatLoopPreflightBlocked,
  formatLoopDryRun,
  formatLoopPreflightReady,
  runLoopPreflight,
} from '#/cli/lib/loop-preflight';

describe('Loop preflight', () => {
  const execFileAsync = promisify(execFile);
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

  async function gitWorkspace(): Promise<string> {
    const path = await workspace();
    await execFileAsync('git', ['init'], { cwd: path });
    await writeFile(join(path, 'package.json'), '{"scripts":{}}\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: path });
    await execFileAsync(
      'git',
      [
        '-c', 'user.name=Wukong Test',
        '-c', 'user.email=test@example.test',
        'commit', '-m', 'base',
      ],
      { cwd: path },
    );
    return path;
  }

  async function gitWorkspaceWithFiles(
    files: Readonly<Record<string, string>>,
  ): Promise<string> {
    const path = await workspace();
    await execFileAsync('git', ['init'], { cwd: path });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(path, name), content, 'utf8');
    }
    await execFileAsync('git', ['add', '.'], { cwd: path });
    await execFileAsync(
      'git',
      [
        '-c', 'user.name=Wukong Test',
        '-c', 'user.email=test@example.test',
        'commit', '-m', 'base',
      ],
      { cwd: path },
    );
    return path;
  }

  async function nativeBootstrapPath(): Promise<string> {
    const path = await workspace();
    const executable = join(path, 'npm');
    await symlink('/bin/echo', executable);
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

    expect(result.ready, JSON.stringify(result, null, 2)).toBe(true);
    if (result.ready) {
      expect(formatLoopPreflightReady(result, 2)).toContain('Verification 0 required project checks');
      expect(result.proposal.finishLineReview.warnings.map((warning) => warning.code))
        .toContain('no_resolved_checks');
    }
  });

  it('attaches a read-only isolated source snapshot to an enabled dry-run', async () => {
    const cwd = await gitWorkspace();
    await writeFile(join(cwd, 'src-new.ts'), 'export const value = 1;\n', 'utf8');

    const result = await runLoopPreflight({
      objective: 'create a module',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      selectedUntrackedPaths: ['src-new.ts'],
      getActiveGoal: async () => null,
      discoverChecks: async () => [],
    });

    expect(result.ready, JSON.stringify(result, null, 2)).toBe(true);
    if (!result.ready) return;
    expect(result.sourceSnapshotDryRun).toMatchObject({
      status: 'ready',
      reasonCode: null,
      proposedSnapshot: {
        includedUntracked: [{ canonicalRelativePath: 'src-new.ts' }],
      },
    });
    expect(formatLoopPreflightReady(result, 2))
      .toContain('snapshot dry-run ready · no worktree created');
    const serialized = JSON.parse(formatLoopDryRun(result));
    expect(serialized.sourceSnapshotDryRun).toMatchObject({
      status: 'ready',
      proposedSnapshot: { schemaVersion: 1 },
    });
    expect(JSON.stringify(serialized.sourceSnapshotDryRun)).not.toContain(cwd);
  });

  it('attaches a safe exact-lockfile bootstrap proposal without starting it', async () => {
    const cwd = await gitWorkspaceWithFiles({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test' },
        devDependencies: { example: '1.0.0' },
      }),
      'package-lock.json':
        '{"lockfileVersion":3,"packages":{"":{}}}\n',
    });
    const result = await runLoopPreflight({
      objective: 'verify the Node project',
      completionCriterion: 'The frozen test check passes',
      explicitChecks: ['npm test'],
      discoveredCheckDecision: 'only-explicit',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      mode: 'tui-proposal',
      bootstrapPathEnvironment: await nativeBootstrapPath(),
      getActiveGoal: async () => null,
    });

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.candidateBootstrapPreflight).toMatchObject({
      status: 'ready',
      reasonCode: 'candidate_bootstrap_confirmation_required',
      entries: [{
        ecosystem: 'node',
        recipe: { recipeRef: 'builtin:node:npm-ci' },
      }],
    });
    expect(formatLoopPreflightReady(result, 2))
      .toContain('Bootstrap    ready · 1 environment');
    expect(JSON.parse(formatLoopDryRun(result)))
      .toMatchObject({
        candidateBootstrapPreflight: {
          status: 'ready',
          requiresExplicitNetworkConsent: true,
        },
        candidateBootstrapPlan: {
          networkPolicy: 'explicit_once',
        },
      });
  });

  it('requires confirmation of the exact bootstrap plan before candidate creation', async () => {
    const cwd = await gitWorkspaceWithFiles({
      'package.json': JSON.stringify({
        scripts: { test: 'node --test' },
        devDependencies: { example: '1.0.0' },
      }),
      'package-lock.json':
        '{"lockfileVersion":3,"packages":{"":{}}}\n',
    });
    const bootstrapPathEnvironment = await nativeBootstrapPath();
    const proposal = await runLoopPreflight({
      objective: 'verify the Node project',
      completionCriterion: 'The frozen test check passes',
      explicitChecks: ['npm test'],
      discoveredCheckDecision: 'only-explicit',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      mode: 'tui-proposal',
      bootstrapPathEnvironment,
      getActiveGoal: async () => null,
    });
    expect(proposal.ready, JSON.stringify(proposal, null, 2)).toBe(true);
    if (!proposal.ready) return;
    const result = await runLoopPreflight({
      objective: 'verify the Node project',
      completionCriterion: 'The frozen test check passes',
      explicitChecks: ['npm test'],
      discoveredCheckDecision: 'only-explicit',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      mode: 'tui-confirmed',
      bootstrapPathEnvironment,
      getActiveGoal: async () => null,
    });

    expect(result).toMatchObject({
      ready: false,
      reasonCode: 'candidate_bootstrap_confirmation_required',
      candidateBootstrapPreflight: {
        status: 'ready',
      },
      candidateBootstrapPlan: {
        bootstrapPlanDigest:
          proposal.candidateBootstrapPlan?.bootstrapPlanDigest,
      },
    });
  });

  it('blocks unsupported lockfiles with a stable reason before candidate creation', async () => {
    const cwd = await gitWorkspaceWithFiles({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '1.0.0' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
    });
    const result = await runLoopPreflight({
      objective: 'verify the pnpm project',
      completionCriterion: 'The frozen test check passes',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      mode: 'tui-proposal',
      getActiveGoal: async () => null,
    });

    expect(result).toMatchObject({
      ready: false,
      reasonCode: 'candidate_bootstrap_lockfile_unsupported',
      candidateBootstrapPreflight: {
        status: 'unsupported',
        entries: [{ lockfilePath: 'pnpm-lock.yaml' }],
      },
    });
  });

  it('fails the isolated dry-run closed instead of silently using serial execution', async () => {
    const cwd = await workspace();

    const result = await runLoopPreflight({
      objective: 'create a module',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      getActiveGoal: async () => null,
      discoverChecks: async () => [],
    });

    expect(result).toMatchObject({
      ready: false,
      reasonCode: 'isolated_loop_not_git',
      sourceSnapshotDryRun: {
        status: 'blocked',
        proposedSnapshot: null,
      },
    });
    if (result.ready) return;
    expect(formatLoopPreflightBlocked(result)).toContain('Loop not started');
    expect(formatLoopPreflightBlocked(result)).toContain('Snapshot sha256:');
  });

  it('blocks a Windows Candidate backend before Goal or discovery work can start', async () => {
    const cwd = await gitWorkspace();
    const getActiveGoal = vi.fn(async () => null);
    const discoverChecks = vi.fn(async () => ['pnpm test']);

    const result = await runLoopPreflight({
      objective: 'create a module',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      getActiveGoal,
      discoverChecks,
      candidateWorkspaceBackendProbe: () => ({
        available: false,
        platform: 'win32',
        backend: null,
        reasonCode: 'candidate_atomic_backend_platform_unsupported',
      }),
    });

    expect(result).toMatchObject({
      ready: false,
      reasonCode: 'candidate_atomic_backend_unavailable',
      reason: expect.stringContaining(
        'candidate_atomic_backend_platform_unsupported',
      ),
    });
    expect(getActiveGoal).not.toHaveBeenCalled();
    expect(discoverChecks).not.toHaveBeenCalled();
  });

  it('blocks an explicitly selected source file that snapshot policy excludes', async () => {
    const cwd = await gitWorkspace();
    await writeFile(join(cwd, '.env'), 'API_KEY=sk-example123456789\n', 'utf8');

    const result = await runLoopPreflight({
      objective: 'create a module',
      model: 'glm-5.2',
      workspace: cwd,
      reviewProvider,
      inspectIsolatedSource: true,
      selectedUntrackedPaths: ['.env'],
      getActiveGoal: async () => null,
      discoverChecks: async () => [],
    });

    expect(result).toMatchObject({
      ready: false,
      reasonCode: 'snapshot_selection_excluded',
      sourceSnapshotDryRun: {
        status: 'blocked',
        reasonCode: 'snapshot_selection_excluded',
      },
    });
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
    });
  });
});
