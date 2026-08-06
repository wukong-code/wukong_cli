import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildFinishLine,
  canonicalDigest,
  canonicalJson,
  createTrustChallenge,
  validateFrozenGatePlan,
  verifyTrustChallenge,
} from '../src/finish-line';
import { makeTempDir, writeJson } from './helpers';

describe('Finish Line and frozen Gate Plan', () => {
  it('freezes discovered command provenance and validates the unchanged definition', async () => {
    const cwd = await makeTempDir('wukong-finish-line-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'vitest run' } });

    const built = await buildFinishLine({
      cwd,
      objective: 'Ship the change',
      completionCriterion: 'All project tests pass',
      includeDiscoveredChecks: true,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.gatePlan.requiredChecks).toMatchObject([{
      source: 'package-script',
      sourceLocator: 'package.json#scripts.test',
      resolution: 'resolved',
    }]);
    await expect(validateFrozenGatePlan(cwd, built.proposal)).resolves.toMatchObject({ ok: true });
  });

  it('fails closed when a frozen project check is weakened', async () => {
    const cwd = await makeTempDir('wukong-finish-line-drift-');
    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'vitest run' } });
    const built = await buildFinishLine({
      cwd,
      objective: 'Ship the change',
      completionCriterion: 'All project tests pass',
      includeDiscoveredChecks: true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'echo skipped' } });
    await expect(validateFrozenGatePlan(cwd, built.proposal)).resolves.toMatchObject({
      ok: false,
      reasonCode: 'gate_plan_changed',
    });
  });

  it('binds warning acknowledgement to the exact warning set', async () => {
    const cwd = await makeTempDir('wukong-finish-line-warning-');
    const initial = await buildFinishLine({
      cwd,
      objective: 'Do work',
      includeDiscoveredChecks: true,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const acknowledged = await buildFinishLine({
      cwd,
      objective: 'Do work',
      includeDiscoveredChecks: true,
      acknowledgeWarningSetDigest: initial.proposal.finishLineReview.warningSetDigest,
    });
    expect(acknowledged.ok).toBe(true);
    if (!acknowledged.ok) return;
    expect(acknowledged.proposal.finishLineReview.acknowledgedWarningIds)
      .toEqual(acknowledged.proposal.finishLineReview.warnings.map((warning) => warning.id));

    const changed = await buildFinishLine({
      cwd,
      objective: 'Do different work',
      includeDiscoveredChecks: true,
      acknowledgeWarningSetDigest: initial.proposal.finishLineReview.warningSetDigest,
    });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.proposal.finishLineReview.acknowledgedWarningIds).toEqual([]);
  });

  it('requires a separate exact no-check decision when discovery finds no applicable checks', async () => {
    const cwd = await makeTempDir('wukong-finish-line-no-check-');
    const initial = await buildFinishLine({
      cwd,
      objective: 'Update the documentation',
      includeDiscoveredChecks: true,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    expect(initial.proposal.noExecutableChecksDecision).toMatchObject({
      schemaVersion: 1,
      policyVersion: 'no-executable-checks/1',
      status: 'confirmation-required',
    });
    const decisionDigest = initial.proposal.noExecutableChecksDecision?.decisionDigest;
    expect(decisionDigest).toMatch(/^sha256:/u);

    const warningOnly = await buildFinishLine({
      cwd,
      objective: 'Update the documentation',
      includeDiscoveredChecks: true,
      acknowledgeWarningSetDigest: initial.proposal.finishLineReview.warningSetDigest,
    });
    expect(warningOnly.ok).toBe(true);
    if (!warningOnly.ok) return;
    expect(warningOnly.proposal.finishLineReview.acknowledgedWarningIds).not.toHaveLength(0);
    expect(warningOnly.proposal.noExecutableChecksDecision?.status)
      .toBe('confirmation-required');

    const acknowledged = await buildFinishLine({
      cwd,
      objective: 'Update the documentation',
      includeDiscoveredChecks: true,
      acknowledgeWarningSetDigest: initial.proposal.finishLineReview.warningSetDigest,
      acknowledgeNoExecutableChecksDigest: decisionDigest,
    });
    expect(acknowledged.ok).toBe(true);
    if (!acknowledged.ok) return;
    expect(acknowledged.proposal.noExecutableChecksDecision).toMatchObject({
      decisionDigest,
      status: 'acknowledged',
      acknowledgedAt: expect.any(Number),
    });

    const stale = await buildFinishLine({
      cwd,
      objective: 'Change the runtime implementation',
      includeDiscoveredChecks: true,
      acknowledgeNoExecutableChecksDigest: decisionDigest,
    });
    expect(stale.ok).toBe(true);
    if (stale.ok) expect(stale.proposal.noExecutableChecksDecision?.status)
      .toBe('confirmation-required');
  });

  it('does not offer a no-check decision after applicable discovered checks were excluded', async () => {
    const cwd = await makeTempDir('wukong-finish-line-excluded-check-');
    const built = await buildFinishLine({
      cwd,
      objective: 'Change the implementation',
      includeDiscoveredChecks: false,
      discoveredCommands: [{
        command: 'pnpm test',
        source: 'project-inferred',
      }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.proposal.gatePlan.requiredChecks).toHaveLength(0);
    expect(built.proposal.gatePlan.excludedChecks).toHaveLength(1);
    expect(built.proposal.noExecutableChecksDecision).toBeUndefined();
  });

  it('rejects inline credentials and destructive checks before persistence', async () => {
    const cwd = await makeTempDir('wukong-finish-line-guard-');
    const secret = await buildFinishLine({
      cwd,
      objective: 'Test API',
      explicitChecks: ['API_KEY=sk-example123456789 pnpm test'],
      includeDiscoveredChecks: false,
    });
    const destructive = await buildFinishLine({
      cwd,
      objective: 'Clean files',
      explicitChecks: ['rm -rf /'],
      includeDiscoveredChecks: false,
    });

    expect(secret).toMatchObject({ ok: false, failure: { code: 'inline_secret_rejected' } });
    expect(destructive).toMatchObject({ ok: false, failure: { code: 'invalid_finish_line' } });
  });

  it('binds a short-lived trust challenge to workspace, plan, and warnings', async () => {
    const challenge = createTrustChallenge({
      workspaceIdentityDigest: 'workspace-a',
      approvalSetDigest: 'approval-a',
      warningSetDigest: 'warnings-a',
      now: 1_000,
      ttlMs: 5_000,
    });

    expect(verifyTrustChallenge({
      challenge,
      workspaceIdentityDigest: 'workspace-a',
      approvalSetDigest: 'approval-a',
      warningSetDigest: 'warnings-a',
      now: 5_000,
    })).toBe(true);
    expect(verifyTrustChallenge({
      challenge,
      workspaceIdentityDigest: 'workspace-b',
      approvalSetDigest: 'approval-a',
      warningSetDigest: 'warnings-a',
      now: 5_000,
    })).toBe(false);
    expect(verifyTrustChallenge({
      challenge,
      workspaceIdentityDigest: 'workspace-a',
      approvalSetDigest: 'approval-a',
      warningSetDigest: 'warnings-a',
      now: 7_000,
    })).toBe(false);
  });

  it('uses deterministic key ordering for canonical JSON and digests', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } }))
      .toBe('{"a":{"b":1,"d":2},"z":1}');
    expect(canonicalDigest('test/v1', { b: 2, a: 1 }))
      .toBe(canonicalDigest('test/v1', { a: 1, b: 2 }));
  });

  it('detects a frozen blocking review-policy change', async () => {
    const cwd = await makeTempDir('wukong-review-policy-');
    await writeFile(join(cwd, '.placeholder'), '');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(cwd, '.wukong')));
    await writeFile(join(cwd, '.wukong', 'review-policy.md'), 'Block security regressions.');
    const built = await buildFinishLine({
      cwd,
      objective: 'Ship safely',
      completionCriterion: 'Security review is clean',
      includeDiscoveredChecks: false,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await writeFile(join(cwd, '.wukong', 'review-policy.md'), 'Everything is advisory.');
    await expect(validateFrozenGatePlan(cwd, built.proposal)).resolves.toMatchObject({
      ok: false,
      reasonCode: 'review_policy_changed',
    });
  });

  it('freezes a missing explicit project script as unresolved and requires revision when it appears', async () => {
    const cwd = await makeTempDir('wukong-expected-check-');
    await writeJson(join(cwd, 'package.json'), { scripts: {} });
    const built = await buildFinishLine({
      cwd,
      objective: 'Add project tests',
      completionCriterion: 'The new test script passes',
      explicitChecks: ['pnpm test'],
      includeDiscoveredChecks: false,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.gatePlan.requiredChecks).toMatchObject([{
      resolution: 'expected-unresolved',
      expectedSourceLocator: 'package.json#scripts.test',
    }]);
    await expect(validateFrozenGatePlan(cwd, built.proposal)).resolves.toMatchObject({ ok: true });

    await writeJson(join(cwd, 'package.json'), { scripts: { test: 'exit 0' } });
    await expect(validateFrozenGatePlan(cwd, built.proposal)).resolves.toMatchObject({
      ok: false,
      reasonCode: 'contract_update_required',
    });
  });
});
