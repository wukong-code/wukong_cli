import { chmod, readFile } from 'node:fs/promises';

import { canonicalDigest, resolveWorkspaceIdentity } from '@wukong/verification';
import { z } from 'zod';

import type { LoopPreflightReady } from '#/cli/lib/loop-preflight';
import type { LoopCliOptions } from '#/cli/sub/loop';
import { writeJsonFile } from '#/utils/persistence';

export const LOOP_RUN_PLAN_SCHEMA_VERSION = 1;
const MAX_RUN_PLAN_TTL_MS = 600_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const SHA256_REGEX = /^sha256:[a-f0-9]{64}$/u;

const LoopRunPlanApprovalsSchema = z.object({
  approveGatePlanDigest: z.string().regex(SHA256_REGEX),
  acknowledgeWarningSetDigest: z.string().regex(SHA256_REGEX).optional(),
  acknowledgeNoExecutableChecksDigest: z.string().regex(SHA256_REGEX).optional(),
  trustWorkspaceChallenge: z.string().min(1).optional(),
  trustReviewSubjectChallenge: z.string().min(1),
  acknowledgeReviewSubjectConsentDigest: z.string().regex(SHA256_REGEX),
  verificationCatalogDigest: z.string().regex(SHA256_REGEX).optional(),
  verificationSkills: z.array(z.string().min(1)).readonly(),
});

const LoopRunPlanBodySchema = z.object({
  kind: z.literal('wukong.loop.run_plan'),
  schemaVersion: z.literal(LOOP_RUN_PLAN_SCHEMA_VERSION),
  contractSchemaVersion: z.union([z.literal(2), z.literal(3)]),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  workspaceIdentityDigest: z.string().regex(SHA256_REGEX),
  objective: z.string().min(1),
  doneWhen: z.string().optional(),
  constraints: z.array(z.string()).readonly(),
  explicitChecks: z.array(z.string()).readonly(),
  discoveredCheckDecision: z.enum(['accept', 'only-explicit']),
  maxIterations: z.number().int().positive(),
  writerProviderCallLimit: z.number().int().positive().optional(),
  reviewerProviderCallLimit: z.number().int().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
  minIntervalMs: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  reviewModel: z.string().min(1).optional(),
  approvals: LoopRunPlanApprovalsSchema,
  finishLineDigest: z.string().regex(SHA256_REGEX),
});

export const LoopRunPlanSchema = LoopRunPlanBodySchema.extend({
  planDigest: z.string().regex(SHA256_REGEX),
}).superRefine((plan, ctx) => {
  if (plan.contractSchemaVersion === 3) {
    if (
      plan.approvals.verificationCatalogDigest === undefined
      || plan.approvals.verificationSkills.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Contract schema v3 run-plans require verificationCatalogDigest and verificationSkills.',
      });
    }
  }
  if (plan.contractSchemaVersion === 2 && plan.approvals.verificationSkills.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Contract schema v2 run-plans cannot contain verificationSkills.',
    });
  }
});

export type LoopRunPlanV1 = z.infer<typeof LoopRunPlanSchema>;

export type LoopRunPlanVerificationResult =
  | {
      readonly ok: true;
      readonly plan: LoopRunPlanV1;
      readonly loopOptions: LoopCliOptions;
    }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'plan_unreadable'
        | 'plan_invalid_json'
        | 'plan_schema_invalid'
        | 'plan_tampered'
        | 'plan_approval_mismatch'
        | 'plan_expired'
        | 'plan_workspace_mismatch';
      readonly message: string;
    };

export function buildLoopRunPlan(
  result: LoopPreflightReady,
  options: LoopCliOptions,
  now: Date = new Date(),
): LoopRunPlanV1 {
  const proposal = result.proposal;
  const createdAtMs = now.getTime();
  const expiresAtMs = createdAtMs + MAX_RUN_PLAN_TTL_MS;

  const verificationSkills: string[] = [];
  if (result.verificationSelection !== undefined) {
    for (const selected of result.verificationSelection.selected) {
      const entry = result.verificationCatalog.entries.find(
        (candidate) => candidate.ref.provenanceDigest === selected.ref.provenanceDigest,
      );
      if (entry === undefined) {
        throw new Error(
          `Selected verification criteria is absent from the dry-run catalog: ${selected.ref.skillName}`,
        );
      }
      verificationSkills.push(`${entry.selectionId}@${selected.ref.provenanceDigest}`);
    }
  }

  const body: Omit<LoopRunPlanV1, 'planDigest'> = {
    kind: 'wukong.loop.run_plan',
    schemaVersion: LOOP_RUN_PLAN_SCHEMA_VERSION,
    contractSchemaVersion: result.contractSchemaVersion,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
    objective: proposal.objective,
    doneWhen: proposal.completionCriterion,
    constraints: proposal.constraints.map((constraint) => constraint.text),
    explicitChecks: [...(options.checks ?? [])],
    discoveredCheckDecision: options.onlyExplicitChecks === true ? 'only-explicit' : 'accept',
    maxIterations: options.maxIterations ?? 10,
    writerProviderCallLimit: options.writerProviderCallLimit,
    reviewerProviderCallLimit: options.reviewerProviderCallLimit,
    tokenBudget: options.tokenBudget,
    minIntervalMs: options.minIntervalMs,
    model: options.model ?? result.model,
    reviewModel: options.reviewModel ?? options.model ?? result.model,
    approvals: {
      approveGatePlanDigest: proposal.gateApproval.approvalSetDigest,
      acknowledgeWarningSetDigest:
        proposal.finishLineReview.warnings.length === 0
          ? undefined
          : proposal.finishLineReview.warningSetDigest,
      acknowledgeNoExecutableChecksDigest: proposal.noExecutableChecksDecision?.decisionDigest,
      trustWorkspaceChallenge: proposal.gateApproval.hasExecutableChecks
        ? result.trustChallenge
        : undefined,
      trustReviewSubjectChallenge: result.brokerTrustChallenge,
      acknowledgeReviewSubjectConsentDigest:
        result.reviewSubjectConsentProposal.consentProposalDigest,
      verificationCatalogDigest:
        result.verificationSelection === undefined
          ? undefined
          : result.verificationCatalog.catalogDigest,
      verificationSkills,
    },
    finishLineDigest: proposal.finishLineReview.finishLineDigest,
  };

  const planDigest = canonicalDigest('wukong/loop-run-plan/v1', body);
  return {
    ...body,
    planDigest,
  };
}

export async function writeLoopRunPlan(filePath: string, plan: LoopRunPlanV1): Promise<string> {
  await writeJsonFile(filePath, LoopRunPlanSchema, plan);
  await chmod(filePath, 0o600);
  return filePath;
}

export async function loadAndVerifyLoopRunPlan(input: {
  readonly filePath: string;
  readonly approvePlanDigest: string;
  readonly cwd: string;
  readonly now?: Date;
}): Promise<LoopRunPlanVerificationResult> {
  let rawText: string;
  try {
    rawText = await readFile(input.filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'plan_unreadable',
      message: `Unable to read run-plan file "${input.filePath}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      reasonCode: 'plan_invalid_json',
      message: 'Run-plan file is not valid JSON.',
    };
  }

  const parsedResult = LoopRunPlanSchema.safeParse(rawJson);
  if (!parsedResult.success) {
    return {
      ok: false,
      reasonCode: 'plan_schema_invalid',
      message: `Invalid run-plan file: ${parsedResult.error.issues[0]?.message ?? 'schema validation failed.'}`,
    };
  }

  const plan = parsedResult.data;
  const { planDigest, ...body } = plan;
  const expectedDigest = canonicalDigest('wukong/loop-run-plan/v1', body);
  if (expectedDigest !== planDigest) {
    return {
      ok: false,
      reasonCode: 'plan_tampered',
      message: 'Run-plan digest mismatch; the plan file was modified after --dry-run.',
    };
  }

  if (input.approvePlanDigest.trim() !== planDigest) {
    return {
      ok: false,
      reasonCode: 'plan_approval_mismatch',
      message: '--approve-plan digest does not match the run-plan file.',
    };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const createdMs = Date.parse(plan.createdAt);
  const expiresMs = Date.parse(plan.expiresAt);
  if (
    !Number.isFinite(createdMs)
    || !Number.isFinite(expiresMs)
    || expiresMs <= createdMs
    || expiresMs - createdMs > MAX_RUN_PLAN_TTL_MS
    || createdMs > nowMs + MAX_CLOCK_SKEW_MS
    || expiresMs < nowMs
  ) {
    return {
      ok: false,
      reasonCode: 'plan_expired',
      message: 'Run-plan has expired or has an invalid validity window. Re-run `wukong loop --dry-run --plan-out` to generate a fresh plan.',
    };
  }

  const identity = await resolveWorkspaceIdentity(input.cwd);
  if (identity.workspaceIdentityDigest !== plan.workspaceIdentityDigest) {
    return {
      ok: false,
      reasonCode: 'plan_workspace_mismatch',
      message: 'Run-plan belongs to a different workspace.',
    };
  }

  const loopOptions: LoopCliOptions = {
    objective: plan.objective,
    until: 'proof-pass',
    maxIterations: plan.maxIterations,
    writerProviderCallLimit: plan.writerProviderCallLimit,
    reviewerProviderCallLimit: plan.reviewerProviderCallLimit,
    tokenBudget: plan.tokenBudget,
    minIntervalMs: plan.minIntervalMs,
    dryRun: false,
    model: plan.model,
    reviewModel: plan.reviewModel,
    doneWhen: plan.doneWhen,
    constraints: plan.constraints,
    checks: plan.explicitChecks,
    acceptDiscoveredChecks: plan.discoveredCheckDecision === 'accept',
    onlyExplicitChecks: plan.discoveredCheckDecision === 'only-explicit',
    trustWorkspaceChallenge: plan.approvals.trustWorkspaceChallenge,
    approveGatePlanDigest: plan.approvals.approveGatePlanDigest,
    acknowledgeWarningSetDigest: plan.approvals.acknowledgeWarningSetDigest,
    acknowledgeNoExecutableChecksDigest: plan.approvals.acknowledgeNoExecutableChecksDigest,
    verificationCatalogDigest: plan.approvals.verificationCatalogDigest,
    verificationSkills: plan.approvals.verificationSkills,
    trustReviewSubjectChallenge: plan.approvals.trustReviewSubjectChallenge,
    acknowledgeReviewSubjectConsentDigest: plan.approvals.acknowledgeReviewSubjectConsentDigest,
  };

  return {
    ok: true,
    plan,
    loopOptions,
  };
}
