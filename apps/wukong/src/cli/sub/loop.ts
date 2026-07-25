import type { Command } from 'commander';
import { createWukongHarness } from '@wukong/wukong-sdk';

import {
  formatLoopDryRun,
  formatLoopPreflightBlocked,
  formatLoopPreflightReady,
  resolveLoopReviewProvider,
  runLoopPreflight,
} from '#/cli/lib/loop-preflight';
import { createWukongCodeHostIdentity } from '#/cli/version';
import { parseLoopDuration } from '#/utils/duration';

const MAX_LOOP_OBJECTIVE_LENGTH = 8000;

export interface LoopCliOptions {
  readonly objective?: string;
  readonly until?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations?: number;
  readonly minIntervalMs?: number;
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly reviewModel?: string;
  readonly doneWhen?: string;
  readonly constraints?: readonly string[];
  readonly checks?: readonly string[];
  readonly acceptDiscoveredChecks?: boolean;
  readonly onlyExplicitChecks?: boolean;
  readonly trustWorkspaceChallenge?: string;
  readonly approveGatePlanDigest?: string;
  readonly acknowledgeWarningSetDigest?: string;
  readonly verificationCatalogDigest?: string;
  readonly verificationSkills?: readonly string[];
  readonly trustReviewSubjectChallenge?: string;
  readonly acknowledgeReviewSubjectConsentDigest?: string;
}

export type RunLoopHandler = (options: LoopCliOptions) => void;

export function registerLoopCommand(parent: Command, onRun?: RunLoopHandler): void {
  parent
    .command('loop')
    .description('Run an AI coding Loop until the independent delivery gate passes.')
    .argument('<objective>', 'The objective to iterate toward.')
    .option('--until <condition>', 'Advanced compatibility option. Loop always uses proof-pass.', 'proof-pass')
    .option('--max-iterations <n>', 'Maximum iterations before giving up.', '10')
    .option('--every <duration>', 'Optional minimum interval between iterations (e.g. 5m, 1h).')
    .option('--model <model>', 'Writer model alias for this Loop session.')
    .option('--review-model <model>', 'Independent reviewer model alias for this Loop.')
    .option('--done-when <criterion>', 'Optional user-confirmed completion criterion.')
    .option('--constraint <rule>', 'Must-not rule. Repeat for multiple rules.', collectOption, [])
    .option('--check <command>', 'Explicit required project check. Repeat for multiple checks.', collectOption, [])
    .option('--accept-discovered-checks', 'Include all currently recommended project checks.', false)
    .option('--only-explicit-checks', 'Exclude discovered checks and use only --check values.', false)
    .option('--trust-workspace <challenge>', 'Exact short-lived workspace trust challenge from --dry-run.')
    .option('--approve-gate-plan <digest>', 'Exact Gate approval-set digest from --dry-run.')
    .option('--ack-finish-line-warnings <digest>', 'Exact Finish Line warning-set digest from --dry-run.')
    .option('--verification-catalog-digest <digest>', 'Exact Verification Criteria catalog digest from --dry-run.')
    .option('--verification-skill <identity@digest>', 'Select an exact Verification Skill identity and provenance digest. Repeat to set flat order.', collectOption, [])
    .option('--trust-review-subject <challenge>', 'Exact short-lived local broker trust challenge from --dry-run.')
    .option('--ack-review-subject <digest>', 'Exact run-scoped BYOK review-subject consent digest from --dry-run.')
    .option('--dry-run', 'Validate arguments and print the planned loop without running it.', false)
    .action(async (objective: string, raw: RawLoopOptions, command: Command) => {
      const everyResult = parseEvery(raw.every);
      if (everyResult.kind === 'error') {
        process.stderr.write(`error: ${everyResult.message}\n`);
        process.exit(1);
        return;
      }

      const until = normalizeLoopStopCondition(raw.until);
      if (raw.until !== undefined && raw.until !== 'proof-pass') {
        process.stderr.write(`warning: --until ${raw.until} is deprecated; using proof-pass.\n`);
      }
      const inherited = command.optsWithGlobals<Record<string, unknown>>();
      const options: LoopCliOptions = {
        objective,
        until,
        maxIterations: parseMaxIterations(raw.maxIterations),
        minIntervalMs: everyResult.ms,
        dryRun: raw.dryRun === true,
        model: raw.model ?? (inherited['model'] as string | undefined),
        reviewModel: raw.reviewModel,
        doneWhen: raw.doneWhen,
        constraints: raw.constraint,
        checks: raw.check,
        acceptDiscoveredChecks: raw.acceptDiscoveredChecks === true,
        onlyExplicitChecks: raw.onlyExplicitChecks === true,
        trustWorkspaceChallenge: raw.trustWorkspace,
        approveGatePlanDigest: raw.approveGatePlan,
        acknowledgeWarningSetDigest: raw.ackFinishLineWarnings,
        verificationCatalogDigest: raw.verificationCatalogDigest,
        verificationSkills: raw.verificationSkill,
        trustReviewSubjectChallenge: raw.trustReviewSubject,
        acknowledgeReviewSubjectConsentDigest: raw.ackReviewSubject,
      };

      const validated = validateLoopOptions(options);
      if (validated.kind === 'error') {
        process.stderr.write(`error: ${validated.message}\n`);
        process.exit(1);
        return;
      }

      if (options.dryRun === true) {
        const harness = createWukongHarness({
          identity: createWukongCodeHostIdentity(),
        });
        let result;
        try {
          await harness.ensureConfigFile();
          const config = await harness.getConfig();
          const model = options.model ?? config.defaultModel;
          result = await runLoopPreflight({
            objective,
            completionCriterion: options.doneWhen,
            constraints: options.constraints,
            explicitChecks: options.checks,
            discoveredCheckDecision: options.onlyExplicitChecks === true ? 'only-explicit' : 'accept',
            model,
            workspace: process.cwd(),
            mode: 'tui-proposal',
            requireModel: false,
            reviewProvider: resolveLoopReviewProvider(config, model),
            verificationCatalogDigest: options.verificationCatalogDigest,
            verificationSkills: parseVerificationSkills(options.verificationSkills),
            getActiveGoal: async () => null,
          });
        } finally {
          await harness.close();
        }
        if (!result.ready) {
          process.stderr.write(`${formatLoopPreflightBlocked(result)}\n`);
          process.exit(2);
          return;
        }
        const outputFormat = inherited['outputFormat'];
        process.stdout.write(
          outputFormat === 'stream-json'
            ? formatLoopDryRun(result, {
                maxIterations: options.maxIterations,
                writerModel: options.model,
                reviewerModel: options.reviewModel,
                minIntervalMs: options.minIntervalMs,
              })
            : `${formatLoopPlan(options)}\n`
              + `${formatLoopPreflightReady(result, options.maxIterations ?? 10)}\n\n`
              + `Gate approval  ${result.proposal.gateApproval.approvalSetDigest}\n`
              + `Warnings       ${result.proposal.finishLineReview.warningSetDigest}\n`
              + `Project trust  ${result.trustChallenge}\n`
              + `Broker trust   ${result.brokerTrustProposal.trustProposalDigest}\n`
              + `Review consent ${result.reviewSubjectConsentProposal.consentProposalDigest}\n`
              + `Catalog        ${result.verificationCatalog.catalogDigest}\n`,
        );
        process.exit(0);
        return;
      }

      if (onRun === undefined) {
        process.stderr.write('error: Loop runner is unavailable in this build.\n');
        process.exit(2);
        return;
      }
      onRun(options);
    });
}

interface RawLoopOptions {
  readonly until?: 'proof-pass' | 'verify-pass' | 'scan-clean' | 'judge-pass';
  readonly maxIterations: string;
  readonly every?: string;
  readonly dryRun?: boolean;
  readonly model?: string;
  readonly reviewModel?: string;
  readonly doneWhen?: string;
  readonly constraint: string[];
  readonly check: string[];
  readonly acceptDiscoveredChecks?: boolean;
  readonly onlyExplicitChecks?: boolean;
  readonly trustWorkspace?: string;
  readonly approveGatePlan?: string;
  readonly ackFinishLineWarnings?: string;
  readonly verificationCatalogDigest?: string;
  readonly verificationSkill: string[];
  readonly trustReviewSubject?: string;
  readonly ackReviewSubject?: string;
}

type ValidationResult = { readonly kind: 'ok' } | { readonly kind: 'error'; readonly message: string };
type EveryResult = { readonly kind: 'ok'; readonly ms?: number } | { readonly kind: 'error'; readonly message: string };

export function parseEvery(raw: string | undefined): EveryResult {
  if (raw === undefined) return { kind: 'ok', ms: undefined };
  const result = parseLoopDuration(raw);
  if (result.kind === 'error') return result;
  return { kind: 'ok', ms: result.ms };
}

export function validateLoopOptions(options: LoopCliOptions): ValidationResult {
  if (options.objective === undefined || options.objective.trim().length === 0) {
    return { kind: 'error', message: 'Loop objective is required.' };
  }
  if (options.objective.length > MAX_LOOP_OBJECTIVE_LENGTH) {
    return { kind: 'error', message: `Loop objective is too long (max ${String(MAX_LOOP_OBJECTIVE_LENGTH)} characters).` };
  }
  if (
    options.until !== 'proof-pass'
  ) {
    return { kind: 'error', message: '--until must be proof-pass.' };
  }
  if (
    options.maxIterations === undefined ||
    !Number.isFinite(options.maxIterations) ||
    !Number.isInteger(options.maxIterations) ||
    options.maxIterations <= 0
  ) {
    return { kind: 'error', message: '--max-iterations must be a positive integer.' };
  }
  if (options.acceptDiscoveredChecks === true && options.onlyExplicitChecks === true) {
    return {
      kind: 'error',
      message: '--accept-discovered-checks and --only-explicit-checks are mutually exclusive.',
    };
  }
  try {
    parseVerificationSkills(options.verificationSkills);
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { kind: 'ok' };
}

export function parseMaxIterations(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function formatLoopPlan(options: LoopCliOptions): string {
  const lines = [
    'Planned loop:',
    `  Objective: ${options.objective ?? ''}`,
    `  Stop when: ${options.until ?? ''}`,
    `  Max iterations: ${String(options.maxIterations ?? '')}`,
  ];
  if (options.minIntervalMs !== undefined) {
    lines.push(`  Minimum interval: ${formatDuration(options.minIntervalMs)}`);
  }
  if (options.model !== undefined) lines.push(`  Writer model: ${options.model}`);
  if (options.reviewModel !== undefined) lines.push(`  Reviewer model: ${options.reviewModel}`);
  if (options.doneWhen !== undefined) lines.push(`  Done when: ${options.doneWhen}`);
  for (const constraint of options.constraints ?? []) lines.push(`  Must not: ${constraint}`);
  for (const check of options.checks ?? []) lines.push(`  Check: ${check}`);
  return `${lines.join('\n')}\n`;
}

function normalizeLoopStopCondition(
  value: RawLoopOptions['until'],
): 'proof-pass' | undefined {
  if (value === undefined) return 'proof-pass';
  if (value === 'proof-pass' || value === 'verify-pass' || value === 'scan-clean' || value === 'judge-pass') {
    return 'proof-pass';
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1_000}s`;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseVerificationSkills(
  values: readonly string[] | undefined,
): readonly { readonly selectionId: string; readonly provenanceDigest: string }[] {
  return (values ?? []).map((value) => {
    const marker = value.lastIndexOf('@sha256:');
    if (marker <= 0) {
      throw new Error('--verification-skill must be <exact-selection-id>@sha256:<digest>.');
    }
    const selectionId = value.slice(0, marker);
    const provenanceDigest = value.slice(marker + 1);
    if (!/^sha256:[a-f0-9]{64}$/u.test(provenanceDigest)) {
      throw new Error('--verification-skill requires a full lowercase SHA-256 provenance digest.');
    }
    return { selectionId, provenanceDigest };
  });
}
