import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ToolCall } from '@wukong/kosong';
import {
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  clearBrokerReviewTrustBindingsForTests,
  createBrokerReviewTrustProposal,
  createReviewSubjectConsentProposal,
  grantBrokerReviewTrust,
  inspectSourceSnapshot,
} from '@wukong/verification';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  LoopRunReviewSettingsInput,
} from '../src/agent/goal';
import {
  buildCandidateBootstrapPlan,
  inspectCandidateBootstrapPreflight,
} from '../src';
import {
  FLAG_DEFINITIONS,
  FlagResolver,
} from '../src/flags';
import {
  testAgent,
} from './agent/harness/agent';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const PROVIDER_ENDPOINT = 'https://review.example.test/v1';

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  vi.unstubAllEnvs();
  clearBrokerReviewTrustBindingsForTests();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('isolated Loop runtime product chain', () => {
  it('keeps source unchanged until exact consent, then applies and verifies target PASS', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wukong-isolated-e2e-'));
    roots.push(parent);
    const repository = join(parent, 'repository');
    const sessionHome = join(parent, 'session');
    const wukongHome = join(parent, 'wukong-home');
    const bootstrapBin = join(parent, 'bootstrap-bin');
    await mkdir(bootstrapBin);
    await symlink('/bin/echo', join(bootstrapBin, 'npm'));
    vi.stubEnv(
      'PATH',
      `${bootstrapBin}:${process.env['PATH'] ?? ''}`,
    );
    await git(parent, ['init', 'repository']);
    await writeFile(join(repository, 'tracked.txt'), 'before\n');
    await writeFile(
      join(repository, 'package.json'),
      '{"scripts":{"test":"node --test"},"devDependencies":{"example":"1.0.0"}}\n',
    );
    await writeFile(
      join(repository, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"":{}}}\n',
    );
    await git(repository, ['add', '.']);
    await git(repository, [
      '-c', 'user.name=Wukong Test',
      '-c', 'user.email=test@example.test',
      'commit', '-m', 'base',
    ]);

    const objective = 'Change tracked.txt to exactly after';
    const finishLine = await buildFinishLine({
      cwd: repository,
      objective,
      completionCriterion:
        'tracked.txt contains exactly after and the frozen Gate passes',
      explicitChecks: ['npm test'],
      includeDiscoveredChecks: false,
    });
    if (!finishLine.ok) throw new Error(finishLine.failure.message);
    const source = await inspectSourceSnapshot({ cwd: repository });
    if (source.status !== 'ready' || source.proposedSnapshot === null) {
      throw new Error('Source snapshot fixture is not ready.');
    }
    const sourceSnapshot = source.proposedSnapshot;
    const bootstrapPreflight =
      await inspectCandidateBootstrapPreflight({
        sourceSnapshotCwd: repository,
        sourceSnapshot,
        gatePlan: finishLine.proposal.gatePlan,
      });
    if (bootstrapPreflight.status !== 'ready') {
      throw new Error(
        `Bootstrap preflight fixture is not ready: ${bootstrapPreflight.reasonCode}`,
      );
    }
    const preparedBootstrap = await buildCandidateBootstrapPlan({
      preflight: bootstrapPreflight,
      expectedPreflightDigest:
        bootstrapPreflight.preflightDigest,
      sourceWorkspaceRoot: repository,
    });
    const spawn = vi.fn(async (input: { readonly prompt: string }) => {
      const result = freshPassFromPrompt(input.prompt);
      return {
        agentId: 'fresh-reviewer',
        profileName: 'fresh-reviewer',
        resumed: false,
        completion: Promise.resolve({ result }),
      };
    });
    const ctx = testAgent({
      homedir: sessionHome,
      wukongHomeDir: wukongHome,
      experimentalFlags: new FlagResolver(
        {
          WUKONG_CODE_EXPERIMENTAL_ISOLATED_LOOP_WORKTREES: '1',
        },
        FLAG_DEFINITIONS,
      ),
      subagentHost: { spawn } as never,
    });
    ctx.configure({
      provider: {
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'writer-model',
        baseUrl: PROVIDER_ENDPOINT,
      },
    });
    ctx.agent.permission.setMode('yolo');
    ctx.agent.config.update({ cwd: repository });
    const reviewSettings = makeReviewSettings(
      finishLine.proposal.workspaceIdentity.workspaceIdentityDigest,
    );
    await ctx.agent.goal.createGoal({
      objective,
      completionCriterion:
        finishLine.proposal.completionCriterion,
      stopCondition: 'proof-pass',
      reviewModel: 'writer-model',
      loopContract: {
        schemaVersion: 2,
        objective,
        completionCriterion:
          finishLine.proposal.completionCriterion,
        constraints: finishLine.proposal.constraints,
        finishLineReview: {
          ...finishLine.proposal.finishLineReview,
          acknowledgedWarningIds:
            finishLine.proposal.finishLineReview.warnings.map(
              (warning) => warning.id,
            ),
        },
        workspaceIdentity: finishLine.proposal.workspaceIdentity,
        workspaceTrust: finishLine.proposal.workspaceTrust,
        gateApproval: finishLine.proposal.gateApproval,
        gatePlan: finishLine.proposal.gatePlan,
        reviewPolicy: finishLine.proposal.reviewPolicy,
        reviewSettings,
        source: 'user',
      },
    });

    const writeCall: ToolCall = {
      type: 'function',
      id: 'call_write_candidate',
      name: 'Write',
      arguments: JSON.stringify({
        path: 'tracked.txt',
        content: 'after\n',
      }),
    };
    ctx.mockNextResponse(
      { type: 'text', text: 'I will update the candidate.' },
      writeCall,
    );
    ctx.mockNextResponse({
      type: 'text',
      text: 'The candidate change is ready for independent verification.',
    });

    const payload = {
      schemaVersion: 1 as const,
      sourceRepositoryRoot: repository,
      sourceSnapshotCwd: repository,
      sourceSnapshot,
      approvedBootstrapPlanDigest:
        preparedBootstrap.plan.bootstrapPlanDigest,
    };
    await expect(
      ctx.agent.runIsolatedLoopCandidateIteration({
        ...payload,
        approvedBootstrapPlanDigest: undefined,
      }),
    ).rejects.toThrow(/not confirmed or is stale/u);
    expect(
      ctx.agent.goal.getIsolatedLoopCandidateBinding(),
    ).toBeNull();
    expect(await readFile(
      join(repository, 'tracked.txt'),
      'utf8',
    )).toBe('before\n');
    const candidate =
      await ctx.agent.runIsolatedLoopCandidateIteration(payload);

    if (candidate.outcome !== 'PASS') {
      throw new Error(
        `Unexpected candidate result: ${JSON.stringify(candidate)}`,
      );
    }
    expect(candidate).toMatchObject({
      outcome: 'PASS',
      leaseState: 'awaiting_promotion',
      writerRan: true,
      iteration: 1,
    });
    expect(await readFile(
      join(repository, 'tracked.txt'),
      'utf8',
    )).toBe('before\n');
    expect(await gitOutput(repository, ['status', '--short'])).toBe('');
    expect(ctx.agent.goal.getGoal().goal).toMatchObject({
      status: 'active',
      isolatedLoopCandidate: {
        candidateId: candidate.candidateId,
      },
    });

    const proposal =
      await ctx.agent.prepareIsolatedLoopPromotion(payload);
    expect(proposal).toMatchObject({
      candidateId: candidate.candidateId,
      changedFileCount: 1,
      changes: [{
        operation: 'update',
        sourcePath: 'tracked.txt',
        targetPath: 'tracked.txt',
      }],
    });
    await expect(ctx.agent.promoteIsolatedLoopCandidate({
      ...payload,
      proposalDigest: `${proposal.proposalDigest.slice(0, -1)}${
        proposal.proposalDigest.endsWith('0') ? '1' : '0'
      }`,
    })).rejects.toThrow(/stale/u);
    expect(await readFile(
      join(repository, 'tracked.txt'),
      'utf8',
    )).toBe('before\n');

    const promoted =
      await ctx.agent.promoteIsolatedLoopCandidate({
        ...payload,
        proposalDigest: proposal.proposalDigest,
      });

    expect(promoted).toMatchObject({
      candidateId: candidate.candidateId,
      proposalDigest: proposal.proposalDigest,
      outcome: 'PASS',
      reasonCode: 'target_final_gate_passed',
    });
    expect(promoted.completionSealDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await readFile(
      join(repository, 'tracked.txt'),
      'utf8',
    )).toBe('after\n');
    expect(await gitOutput(repository, ['status', '--short']))
      .toBe('M tracked.txt');
    expect(ctx.agent.goal.getGoal().goal).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

function makeReviewSettings(
  workspaceIdentityDigest: string,
): LoopRunReviewSettingsInput {
  const trustProposal = createBrokerReviewTrustProposal({
    workspaceIdentityDigest,
    intent: 'once',
  });
  const consentProposal = createReviewSubjectConsentProposal({
    workspaceIdentityDigest,
    allowedOrigins: ['changed-tracked', 'gate-evidence'],
    providerId: 'test-provider',
    endpoint: PROVIDER_ENDPOINT,
  });
  return {
    brokerReviewTrust: grantBrokerReviewTrust(
      trustProposal,
      trustProposal.trustProposalDigest,
      'isolated-loop-e2e-trust',
    ),
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      consentProposal,
      consentProposal.consentProposalDigest,
      1_000,
    ),
  };
}

function freshPassFromPrompt(prompt: string): string {
  const attemptId = lineValue(prompt, 'Attempt: ');
  const reviewerInputDigest =
    lineValue(prompt, 'Reviewer input digest: ');
  const criteria = JSON.parse(
    lineValue(prompt, 'Frozen criteria: '),
  ) as Array<{
    readonly criterionId: string;
    readonly criterionProvenanceDigest: string;
  }>;
  const priorBlockerKeys = JSON.parse(
    lineValue(prompt, 'Prior blocker keys: '),
  ) as string[];
  const manifest = JSON.parse(
    lineValue(prompt, 'Review Subject manifest: '),
  ) as {
    readonly entries: readonly {
      readonly subjectRef: string;
      readonly sha256: string;
    }[];
  };
  const firstSubject = manifest.entries[0];
  if (firstSubject === undefined) {
    throw new Error('Reviewer fixture requires one changed review subject.');
  }
  const evidence = [{
    kind: 'review-subject',
    subjectRef: firstSubject.subjectRef,
    subjectDigest: firstSubject.sha256,
  }];
  const verdict = {
    schemaVersion: 1,
    attemptId,
    reviewerInputDigest,
    status: 'PASS',
    criterionDispositions: criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      criterionProvenanceDigest:
        criterion.criterionProvenanceDigest,
      status: 'satisfied',
      evidence,
    })),
    priorBlockerDispositions: priorBlockerKeys.map(
      (blockerKey) => ({
        blockerKey,
        status: 'resolved',
        evidence,
      }),
    ),
    findings: [],
  };
  return `FRESH_VERDICT_JSON: ${JSON.stringify(verdict)}`;
}

function lineValue(prompt: string, prefix: string): string {
  const line = prompt.split('\n').find(
    (candidate) => candidate.startsWith(prefix),
  );
  if (line === undefined) {
    throw new Error(`Prompt line missing: ${prefix}`);
  }
  return line.slice(prefix.length);
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout.trim();
}
