import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  acknowledgeReviewSubjectConsent,
  buildFinishLine,
  classifyGateCommand,
  createBrokerReviewTrustProposal,
  createBrokerReviewTrustChallenge,
  createReviewSubjectConsentProposal,
  createVerificationCriteriaSelection,
  createTrustChallenge,
  digestVerificationCriteriaAssetRoot,
  discoverPackageVerificationCriteriaRoots,
  discoverVerificationCriteriaCatalog,
  grantBrokerReviewTrust,
  inspectGit,
  REVIEW_SUBJECT_POLICY_VERSION,
  registerBuiltinVerificationCriteriaRoot,
  verifyTrustChallenge,
  verifyBrokerReviewTrustChallenge,
  type BrokerReviewTrustBindingV1,
  type BrokerReviewTrustProposalV1,
  type FinishLineProposal,
  type ReviewSubjectConsentBindingV1,
  type ReviewSubjectConsentProposalV1,
  type VerificationCommand,
  type VerificationCriteriaCatalogV1,
  type VerificationCriteriaRecipeV1,
  type VerificationCriteriaSelectionV1,
  type VerificationCriteriaSourceRootV1,
} from '@wukong/verification';
import type { GoalSnapshot, WukongConfig } from '@wukong/wukong-sdk';

import { WUKONG_BUILD_INFO } from '../build-info';
import { getNativePackageRoot } from '../../native/native-assets';
import {
  brokerReviewTrustBinding,
  findBrokerReviewTrust,
  findWorkspaceTrust,
  listCriteriaSourceTrustGrants,
  type WorkspaceTrustGrant,
} from './workspace-trust';

export type DiscoveredCheckDecision = 'accept' | 'only-explicit' | 'tui-default';
export type LoopPreflightMode = 'tui-proposal' | 'tui-confirmed' | 'headless';

const PREFLIGHT_CHANGED_FILE_CAPTURE_LIMIT = 20;
const PREFLIGHT_SUMMARY_ITEM_LIMIT = 5;
const PREFLIGHT_SUMMARY_VALUE_LIMIT = 240;

export interface LoopPreflightReady {
  readonly ready: true;
  readonly model: string;
  readonly workspace: string;
  readonly workspaceGit?: {
    readonly isRepo: boolean;
    readonly changedFileCount: number;
    readonly changedFiles: readonly {
      readonly path: string;
      readonly status: string;
    }[];
  };
  readonly checks: readonly string[];
  readonly proposal: FinishLineProposal;
  readonly trustChallenge: string;
  readonly trustGrant?: WorkspaceTrustGrant;
  readonly contractSchemaVersion: 2 | 3;
  readonly verificationCatalog: VerificationCriteriaCatalogV1;
  readonly verificationSelection?: VerificationCriteriaSelectionV1;
  readonly selectedRecipes: readonly {
    readonly recipe: VerificationCriteriaRecipeV1;
    readonly provenanceDigest: string;
  }[];
  readonly brokerTrustProposal: BrokerReviewTrustProposalV1;
  readonly brokerTrustChallenge: string;
  readonly brokerReviewTrust?: BrokerReviewTrustBindingV1;
  readonly reviewSubjectConsentProposal: ReviewSubjectConsentProposalV1;
  readonly reviewSubjectConsent?: ReviewSubjectConsentBindingV1;
}

export interface LoopPreflightBlocked {
  readonly ready: false;
  readonly reason: string;
  readonly next: string;
  readonly reasonCode:
    | 'invalid_finish_line'
    | 'model_not_configured'
    | 'workspace_unreadable'
    | 'goal_already_active'
    | 'goal_state_unreadable'
    | 'project_check_discovery_failed'
    | 'discovered_check_confirmation_required'
    | 'workspace_trust_required'
    | 'workspace_trust_mismatch'
    | 'gate_approval_required'
    | 'gate_approval_mismatch'
    | 'check_permission_required'
    | 'finish_line_warning_ack_required'
    | 'inline_secret_rejected'
    | 'verification_catalog_changed'
    | 'verification_criteria_invalid'
    | 'review_subject_trust_required'
    | 'review_subject_consent_required';
  readonly proposal?: FinishLineProposal;
  readonly trustChallenge?: string;
  readonly brokerTrustProposal?: BrokerReviewTrustProposalV1;
  readonly brokerTrustChallenge?: string;
  readonly reviewSubjectConsentProposal?: ReviewSubjectConsentProposalV1;
  readonly verificationCatalog?: VerificationCriteriaCatalogV1;
}

export type LoopPreflightResult = LoopPreflightReady | LoopPreflightBlocked;

export interface LoopRuntimeFacts {
  readonly writerModel?: string;
  readonly reviewerModel?: string;
  readonly permission?: 'manual' | 'auto' | 'yolo';
}

export interface LoopPreflightOptions {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints?: readonly string[];
  readonly explicitChecks?: readonly string[];
  readonly discoveredCheckDecision?: DiscoveredCheckDecision;
  readonly model: string | undefined;
  readonly workspace: string;
  readonly mode?: LoopPreflightMode;
  readonly getActiveGoal: () => Promise<GoalSnapshot | null>;
  readonly approveGatePlanDigest?: string;
  readonly acknowledgeWarningSetDigest?: string;
  readonly trustWorkspaceChallenge?: string;
  readonly verificationCatalogDigest?: string;
  readonly verificationSkills?: readonly {
    readonly selectionId: string;
    readonly provenanceDigest: string;
  }[];
  readonly trustReviewSubjectChallenge?: string;
  readonly brokerReviewTrust?: BrokerReviewTrustBindingV1;
  readonly acknowledgeReviewSubjectConsentDigest?: string;
  readonly reviewProvider?: {
    readonly providerId: string;
    readonly endpoint: string;
  };
  readonly criteriaRoots?: readonly VerificationCriteriaSourceRootV1[];
  readonly homeDir?: string;
  readonly requireModel?: boolean;
  readonly discoverChecks?: (workspace: string) => Promise<readonly string[]>;
}

export interface LoopReviewSettingsProposal {
  readonly brokerTrustProposal: BrokerReviewTrustProposalV1;
  readonly reviewSubjectConsentProposal: ReviewSubjectConsentProposalV1;
}

export function createLoopReviewSettingsProposal(input: {
  readonly workspaceIdentityDigest: string;
  readonly reviewProvider: {
    readonly providerId: string;
    readonly endpoint: string;
  };
}): LoopReviewSettingsProposal {
  return {
    brokerTrustProposal: createBrokerReviewTrustProposal({
      workspaceIdentityDigest: input.workspaceIdentityDigest,
      intent: 'once',
    }),
    reviewSubjectConsentProposal: createReviewSubjectConsentProposal({
      workspaceIdentityDigest: input.workspaceIdentityDigest,
      allowedOrigins: [
        'changed-tracked',
        'explicit-untracked',
        'scope-match',
        'gate-evidence',
      ],
      providerId: input.reviewProvider.providerId,
      endpoint: input.reviewProvider.endpoint,
    }),
  };
}

export function confirmLoopReviewSettings(
  proposal: LoopReviewSettingsProposal,
): {
  readonly brokerReviewTrust: BrokerReviewTrustBindingV1;
  readonly reviewSubjectConsent: ReviewSubjectConsentBindingV1;
} {
  return {
    brokerReviewTrust: grantBrokerReviewTrust(
      proposal.brokerTrustProposal,
      proposal.brokerTrustProposal.trustProposalDigest,
    ),
    reviewSubjectConsent: acknowledgeReviewSubjectConsent(
      proposal.reviewSubjectConsentProposal,
      proposal.reviewSubjectConsentProposal.consentProposalDigest,
    ),
  };
}

export async function runLoopPreflight(
  options: LoopPreflightOptions,
): Promise<LoopPreflightResult> {
  if (options.objective.trim().length === 0) {
    return blocked(
      'invalid_finish_line',
      'Loop objective is empty.',
      'Run /loop <goal> with a concrete finish line.',
    );
  }

  const model = options.model?.trim();
  if (!model && options.requireModel !== false) {
    return blocked(
      'model_not_configured',
      'No model is configured.',
      'Run /provider or /model, then start the Loop again.',
    );
  }

  try {
    const workspaceStat = await stat(options.workspace);
    if (!workspaceStat.isDirectory()) {
      return blocked(
        'workspace_unreadable',
        'The workspace is not a directory.',
        'Change to a readable project directory, then start the Loop again.',
      );
    }
    await access(options.workspace, constants.R_OK);
  } catch {
    return blocked(
      'workspace_unreadable',
      'The workspace is not readable.',
      'Fix the workspace path or permissions, then start the Loop again.',
    );
  }

  try {
    const activeGoal = await options.getActiveGoal();
    if (activeGoal !== null) {
      return blocked(
        'goal_already_active',
        'Another Goal is already active.',
        'Resume or cancel the active Goal before starting a new Loop.',
      );
    }
  } catch {
    return blocked(
      'goal_state_unreadable',
      'The active Goal state could not be read.',
      'Run /goal status or wukong doctor, then retry.',
    );
  }

  const mode = options.mode ?? 'tui-proposal';
  const decision = options.discoveredCheckDecision;
  let discoveredCommands: readonly VerificationCommand[] | undefined;
  try {
    const injected = await options.discoverChecks?.(options.workspace);
    discoveredCommands = injected?.map((command) => ({
      command,
      source: 'project-inferred' as const,
    }));
  } catch (error) {
    return blocked(
      'project_check_discovery_failed',
      `Project checks could not be discovered: ${error instanceof Error ? error.message : String(error)}`,
      'Fix .wukong/checks.json or the project manifest, then retry.',
    );
  }
  if (mode === 'headless' && decision === undefined) {
    const discovery = await buildFinishLine({
      cwd: options.workspace,
      objective: options.objective,
      completionCriterion: options.completionCriterion,
      constraints: options.constraints,
      explicitChecks: options.explicitChecks,
      includeDiscoveredChecks: true,
      discoveredCommands,
    });
    if (!discovery.ok) return proposalFailure(discovery.failure);
    if (
      discovery.proposal.gatePlan.requiredChecks.some(
        (check) => check.source !== 'explicit',
      )
    ) {
      return blocked(
        'discovered_check_confirmation_required',
        'Project checks were discovered but no selection decision was provided.',
        'Re-run with --accept-discovered-checks or --only-explicit-checks after reviewing --dry-run.',
        discovery.proposal,
      );
    }
  }

  let built;
  try {
    built = await buildFinishLine({
      cwd: options.workspace,
      objective: options.objective,
      completionCriterion: options.completionCriterion,
      constraints: options.constraints,
      explicitChecks: options.explicitChecks,
      includeDiscoveredChecks: decision !== 'only-explicit',
      excludedDiscoveredReason: decision === 'only-explicit' ? 'only-explicit' : 'tui-confirmed',
      acknowledgeWarningSetDigest: options.acknowledgeWarningSetDigest,
      discoveredCommands,
    });
  } catch (error) {
    return blocked(
      'project_check_discovery_failed',
      `Project checks could not be discovered: ${error instanceof Error ? error.message : String(error)}`,
      'Fix .wukong/checks.json or the project manifest, then retry.',
    );
  }
  if (!built.ok) return proposalFailure(built.failure);
  const proposal = built.proposal;
  const trustChallenge = createTrustChallenge({
    workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
    approvalSetDigest: proposal.gateApproval.approvalSetDigest,
    warningSetDigest: proposal.finishLineReview.warningSetDigest,
  });
  let trustGrant = await findWorkspaceTrust(
    proposal.workspaceIdentity.workspaceIdentityDigest,
    { homeDir: options.homeDir },
  );

  const criteriaRoots = options.criteriaRoots
    ?? await defaultCriteriaRoots(
      proposal.workspaceIdentity.canonicalRealpath,
      proposal.workspaceIdentity.workspaceIdentityDigest,
      options.homeDir,
    );
  const git = await inspectGit(proposal.workspaceIdentity.canonicalRealpath);
  const verificationCatalog = await discoverVerificationCriteriaCatalog({
    workspaceRoot: proposal.workspaceIdentity.canonicalRealpath,
    roots: criteriaRoots,
    changedPaths: git.changedFiles.map((file) => file.path),
  });
  let verificationSelection: VerificationCriteriaSelectionV1 | undefined;
  let selectedRecipes: LoopPreflightReady['selectedRecipes'] = [];
  const requestedSkills = options.verificationSkills ?? [];
  if (requestedSkills.length > 0) {
    if (options.verificationCatalogDigest === undefined) {
      return blocked(
        'verification_catalog_changed',
        'Verification Skill selection requires the exact dry-run catalog digest.',
        `Re-run with --verification-catalog-digest ${verificationCatalog.catalogDigest}`,
        proposal,
        trustChallenge,
        undefined,
        undefined,
        verificationCatalog,
      );
    }
    try {
      verificationSelection = createVerificationCriteriaSelection(
        verificationCatalog,
        requestedSkills,
        options.verificationCatalogDigest,
      );
    } catch (error) {
      return blocked(
        error instanceof Error && error.message.includes('catalog')
          ? 'verification_catalog_changed'
          : 'verification_criteria_invalid',
        error instanceof Error ? error.message : String(error),
        'Run --dry-run again and select exact current Verification Skill identities.',
        proposal,
        trustChallenge,
        undefined,
        undefined,
        verificationCatalog,
      );
    }
    const byIdentity = new Map(
      verificationCatalog.entries.map((entry) => [entry.selectionId, entry]),
    );
    selectedRecipes = requestedSkills.map((request) => {
      const entry = byIdentity.get(request.selectionId);
      if (entry === undefined) {
        throw new Error(`Selected Verification Skill disappeared: ${request.selectionId}`);
      }
      return {
        recipe: entry.recipe,
        provenanceDigest: entry.ref.provenanceDigest,
      };
    });
  } else if (options.verificationCatalogDigest !== undefined) {
    return blocked(
      'verification_criteria_invalid',
      'Catalog digest is not applicable when no Verification Skill is selected.',
      'Remove --verification-catalog-digest or add an exact --verification-skill.',
      proposal,
      trustChallenge,
      undefined,
      undefined,
      verificationCatalog,
    );
  }

  const provider = options.reviewProvider;
  if (provider === undefined) {
    return blocked(
      'model_not_configured',
      `The reviewer model "${model ?? 'selected model'}" is not connected to a configured provider.`,
      'Open /provider to add or repair the provider, or use `wukong provider list` in scripts, then retry.',
      proposal,
      trustChallenge,
      undefined,
      undefined,
      verificationCatalog,
    );
  }
  const {
    brokerTrustProposal,
    reviewSubjectConsentProposal,
  } = createLoopReviewSettingsProposal({
    workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
    reviewProvider: provider,
  });
  const brokerTrustChallenge = createBrokerReviewTrustChallenge(brokerTrustProposal);
  const storedBrokerTrust = options.brokerReviewTrust === undefined
    ? await findBrokerReviewTrust(
        proposal.workspaceIdentity.workspaceIdentityDigest,
        { homeDir: options.homeDir },
      )
    : undefined;
  if (mode === 'headless' || mode === 'tui-confirmed') {
    if (
      proposal.finishLineReview.warnings.length > 0
      && options.acknowledgeWarningSetDigest
        !== proposal.finishLineReview.warningSetDigest
    ) {
      return blocked(
        'finish_line_warning_ack_required',
        'Finish Line warnings require exact acknowledgement.',
        `Re-run with --ack-finish-line-warnings ${proposal.finishLineReview.warningSetDigest}`,
        proposal,
        trustChallenge,
      );
    }
    if (
      options.approveGatePlanDigest !== proposal.gateApproval.approvalSetDigest
      && mode === 'headless'
    ) {
      return blocked(
        options.approveGatePlanDigest === undefined
          ? 'gate_approval_required'
          : 'gate_approval_mismatch',
        'The complete Gate Plan approval digest is missing or stale.',
        `Re-run with --approve-gate-plan ${proposal.gateApproval.approvalSetDigest}`,
        proposal,
        trustChallenge,
      );
    }
    const blockedCheck = proposal.gatePlan.requiredChecks.find(
      (check) => (
        check.resolution === 'resolved'
        && classifyGateCommand(check.executionCommand).classification === 'blocked'
      ),
    );
    if (blockedCheck !== undefined) {
      return blocked(
        'check_permission_required',
        `A selected project check was blocked before spawn: ${blockedCheck.displayCommand}`,
        'Remove the risky check or run it separately under an explicit permission flow.',
        proposal,
        trustChallenge,
      );
    }
    if (
      mode === 'headless'
      &&
      proposal.gateApproval.hasExecutableChecks
      && trustGrant === undefined
      && (
        options.trustWorkspaceChallenge === undefined
        || !verifyTrustChallenge({
          challenge: options.trustWorkspaceChallenge,
          workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
          approvalSetDigest: proposal.gateApproval.approvalSetDigest,
          warningSetDigest: proposal.finishLineReview.warningSetDigest,
        })
      )
    ) {
      return blocked(
        options.trustWorkspaceChallenge === undefined
          ? 'workspace_trust_required'
          : 'workspace_trust_mismatch',
        'Exact workspace trust is required before project checks can run.',
        `Re-run with --trust-workspace ${trustChallenge}`,
        proposal,
        trustChallenge,
      );
    }
    if (
      mode === 'headless'
      && proposal.gateApproval.hasExecutableChecks
      && trustGrant === undefined
      && options.trustWorkspaceChallenge !== undefined
    ) {
      trustGrant = {
        schemaVersion: 1,
        trustGrantId: randomUUID(),
        canonicalRealpath: proposal.workspaceIdentity.canonicalRealpath,
        workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
        scope: 'loop-project-checks',
        persistence: 'session',
        createdAt: Date.now(),
      };
    }
  }

  const suppliedBrokerTrust =
    options.brokerReviewTrust?.workspaceIdentityDigest
      === proposal.workspaceIdentity.workspaceIdentityDigest
      && options.brokerReviewTrust.scope === 'brokered-review-subject'
      ? options.brokerReviewTrust
      : undefined;
  const rememberedBrokerTrust = storedBrokerTrust === undefined
    || storedBrokerTrust.reviewSubjectPolicyVersion
      !== brokerTrustProposal.reviewSubjectPolicyVersion
    ? undefined
    : brokerReviewTrustBinding(storedBrokerTrust);
  let brokerReviewTrust = suppliedBrokerTrust ?? rememberedBrokerTrust;
  let reviewSubjectConsent: ReviewSubjectConsentBindingV1 | undefined;
  if (mode === 'headless' || mode === 'tui-confirmed') {
    if (
      brokerReviewTrust === undefined
      && (
        options.trustReviewSubjectChallenge === undefined
        || !verifyBrokerReviewTrustChallenge({
          challenge: options.trustReviewSubjectChallenge,
          proposal: brokerTrustProposal,
        })
      )
    ) {
      return blocked(
        'review_subject_trust_required',
        'Exact local broker trust is required before Wukong can read bounded review subjects.',
        `Re-run with --trust-review-subject ${brokerTrustChallenge}`,
        proposal,
        trustChallenge,
        brokerTrustProposal,
        reviewSubjectConsentProposal,
        verificationCatalog,
        brokerTrustChallenge,
      );
    }
    if (
      options.acknowledgeReviewSubjectConsentDigest
        !== reviewSubjectConsentProposal.consentProposalDigest
    ) {
      return blocked(
        'review_subject_consent_required',
        'Exact run-scoped consent is required before review subjects can be sent to the selected BYOK provider.',
        `Re-run with --ack-review-subject ${reviewSubjectConsentProposal.consentProposalDigest}`,
        proposal,
        trustChallenge,
        brokerTrustProposal,
        reviewSubjectConsentProposal,
        verificationCatalog,
        brokerTrustChallenge,
      );
    }
    brokerReviewTrust ??= grantBrokerReviewTrust(
      brokerTrustProposal,
      brokerTrustProposal.trustProposalDigest,
    );
    reviewSubjectConsent = acknowledgeReviewSubjectConsent(
      reviewSubjectConsentProposal,
      options.acknowledgeReviewSubjectConsentDigest,
    );
  }

  const trustedProposal: FinishLineProposal = trustGrant === undefined
    || proposal.workspaceTrust === undefined
    ? proposal
    : {
        ...proposal,
        workspaceTrust: {
          ...proposal.workspaceTrust,
          trustGrantId: trustGrant.trustGrantId,
        },
      };
  return {
    ready: true,
    model: model ?? 'not configured',
    workspace: proposal.workspaceIdentity.canonicalRealpath,
    workspaceGit: {
      isRepo: git.isRepo,
      changedFileCount: git.changedFiles.length,
      changedFiles: git.changedFiles
        .slice(0, PREFLIGHT_CHANGED_FILE_CAPTURE_LIMIT)
        .map((file) => ({ path: file.path, status: file.status })),
    },
    checks: proposal.gatePlan.requiredChecks.map((check) => check.displayCommand),
    proposal: trustedProposal,
    trustChallenge,
    trustGrant,
    contractSchemaVersion: verificationSelection === undefined ? 2 : 3,
    verificationCatalog,
    verificationSelection,
    selectedRecipes,
    brokerTrustProposal,
    brokerTrustChallenge,
    brokerReviewTrust,
    reviewSubjectConsentProposal,
    reviewSubjectConsent,
  };
}

export function formatLoopPreflightBlocked(result: LoopPreflightBlocked): string {
  return [
    'Loop not started',
    `Code     ${result.reasonCode}`,
    `Reason   ${result.reason}`,
    `Next     ${result.next}`,
  ].join('\n');
}

export function formatLoopPreflightReady(
  result: LoopPreflightReady,
  maxIterations: number,
  runtime: LoopRuntimeFacts = {},
  options: { readonly includeHeading?: boolean } = {},
): string {
  const contract = result.proposal;
  const provider = result.reviewSubjectConsentProposal.provider;
  const origin = provider.endpointOrigin;
  const checks = contract.gatePlan.requiredChecks;
  const permission = runtime.permission ?? 'manual';
  const constraints = contract.constraints.slice(0, PREFLIGHT_SUMMARY_ITEM_LIMIT);
  const visibleChecks = checks.slice(0, PREFLIGHT_SUMMARY_ITEM_LIMIT);
  const warnings = contract.finishLineReview.warnings.slice(0, PREFLIGHT_SUMMARY_ITEM_LIMIT);
  const limits = result.reviewSubjectConsentProposal.limits;
  return [
    ...(options.includeHeading === false ? [] : ['Loop preflight', '']),
    `Goal         ${boundedSummaryValue(contract.objective)}`,
    `Done when    ${boundedSummaryValue(contract.completionCriterion ?? 'Not specified separately — the Goal is the only success condition')}`,
    ...(contract.constraints.length === 0
      ? ['Must not     No explicit boundaries specified']
      : [
          `Must not     ${String(contract.constraints.length)} explicit boundar${contract.constraints.length === 1 ? 'y' : 'ies'}`,
          ...constraints.map((constraint, index) =>
            `Must not ${String(index + 1).padEnd(3)} ${boundedSummaryValue(constraint.text)}`,
          ),
          ...(contract.constraints.length > constraints.length
            ? [`Must not     +${String(contract.constraints.length - constraints.length)} more · use Edit finish line to review all`]
            : []),
        ]),
    `Verification ${String(checks.length)} required project check${checks.length === 1 ? '' : 's'}${checks.length === 0 ? ' · none approved; PASS requires recorded verification evidence' : ''}`,
    ...visibleChecks.map((check, index) =>
      `Check ${String(index + 1).padEnd(7)} ${boundedSummaryValue(check.displayCommand)}`,
    ),
    ...(checks.length > visibleChecks.length
      ? [`Checks       +${String(checks.length - visibleChecks.length)} more · use Review checks to inspect all`]
      : []),
    ...warnings.map((warning) => `Needs review ${boundedSummaryValue(warning.message)}`),
    ...(contract.finishLineReview.warnings.length > warnings.length
      ? [`Needs review +${String(contract.finishLineReview.warnings.length - warnings.length)} more warning${contract.finishLineReview.warnings.length - warnings.length === 1 ? '' : 's'} · use Edit finish line`]
      : []),
    `Skill criteria ${String(result.verificationSelection?.selected.length ?? 0)} selected · ${String(result.verificationCatalog.suggestions.length)} suggested`,
    `Writer       ${runtime.writerModel ?? result.model}`,
    `Reviewer     ${runtime.reviewerModel ?? result.model}`,
    `Provider     ${provider.providerId} → ${origin.scheme}://${origin.host}:${String(origin.port)}`,
    `Permission   ${permission} · current OS account · no OS sandbox`,
    ...formatWorkspaceGitState(result),
    `Iterations   up to ${String(maxIterations)} writer iterations`,
    'Provider calls no separate cap configured',
    'Token budget no separate cap configured',
    'Outbound     changed tracked files, selected untracked/scope-matched files, and redacted Gate evidence',
    'Excluded     credential/session/trust/log, generated-output, binary, and oversized paths; recognized secret patterns filtered',
    `Payload      up to ${String(limits.maxFiles)} files · ${formatByteLimit(limits.maxTotalBytes)} source · ${formatByteLimit(limits.maxGateEvidenceTotalBytes)} Gate evidence`,
    'Retention    the configured provider\'s data and retention policy applies',
    'Approvals    local review read → provider transmission → permission → project-check execution',
    'Result       PASS / NEEDS_WORK / ERROR; /loop stop records STOPPED_BY_USER',
    'After        workspace changes stay on disk; review git status and diff before keeping or reverting them',
  ].join('\n');
}

export function formatLoopDryRun(
  result: LoopPreflightReady,
  runSettings?: LoopRuntimeFacts & {
    readonly maxIterations?: number;
    readonly minIntervalMs?: number;
  },
): string {
  const proposal = result.proposal;
  const effectiveRuntime = {
    ...runSettings,
    writerModel: runSettings?.writerModel ?? result.model,
    reviewerModel: runSettings?.reviewerModel ?? result.model,
    permission: runSettings?.permission ?? 'auto' as const,
  };
  return `${JSON.stringify({
    kind: 'loop.finish_line.dry_run',
    schemaVersion: 1,
    proposedContract: proposal,
    runSettings: effectiveRuntime,
    selectedChecks: proposal.gatePlan.requiredChecks.map((check) => ({
      id: check.id,
      command: check.displayCommand,
      source: check.source,
      sourceLocator: check.sourceLocator,
      resolution: check.resolution,
    })),
    excludedChecks: proposal.gatePlan.excludedChecks,
    contractSchemaVersion: result.contractSchemaVersion,
    selectionState: result.verificationSelection === undefined ? 'none' : 'selected',
    catalogCompareAndSet: result.verificationSelection === undefined
      ? 'not-applicable'
      : {
          preflightCatalogDigest: result.verificationCatalog.catalogDigest,
          selectionDigest: result.verificationSelection.selectionDigest,
        },
    verificationCatalog: result.verificationCatalog,
    verificationSelection: result.verificationSelection ?? null,
    selectedRecipes: result.selectedRecipes,
    workspaceGit: result.workspaceGit ?? null,
    reviewSubjectPolicyVersion: REVIEW_SUBJECT_POLICY_VERSION,
    brokerTrustProposal: result.brokerTrustProposal,
    brokerTrustChallenge: result.brokerTrustChallenge,
    reviewSubjectConsentProposal: result.reviewSubjectConsentProposal,
    estimatedCost: {
      freshReviewerPassesPerGateAttempt: 1,
      additionalSkillCommands: 0,
    },
    trustChallenge: result.trustChallenge,
    approvalSetDigest: proposal.gateApproval.approvalSetDigest,
    warningSetDigest: proposal.finishLineReview.warningSetDigest,
    headlessStart: {
      checkDecisionRequired: proposal.gatePlan.requiredChecks.some(
        (check) => check.source !== 'explicit',
      ),
      approveGatePlanDigest: proposal.gateApproval.approvalSetDigest,
      acknowledgeWarningSetDigest: proposal.finishLineReview.warnings.length === 0
        ? null
        : proposal.finishLineReview.warningSetDigest,
      trustWorkspaceChallenge: proposal.gateApproval.hasExecutableChecks
        ? result.trustChallenge
        : null,
      trustReviewSubjectChallenge: result.brokerTrustChallenge,
      acknowledgeReviewSubjectConsentDigest:
        result.reviewSubjectConsentProposal.consentProposalDigest,
      verificationCatalogDigest: result.verificationSelection === undefined
        ? null
        : result.verificationCatalog.catalogDigest,
      brokerChallengeExpiresWithinMs: 600_000,
    },
  }, null, 2)}\n`;
}

function formatWorkspaceGitState(result: LoopPreflightReady): string[] {
  const git = result.workspaceGit;
  if (git === undefined) return [`Workspace    ${result.workspace} · Git state unavailable`];
  if (!git.isRepo) return [`Workspace    ${result.workspace} · not a Git repository`];
  if (git.changedFileCount === 0) return [`Workspace    ${result.workspace} · clean`];
  const changedFiles = git.changedFiles.slice(0, PREFLIGHT_SUMMARY_ITEM_LIMIT);
  return [
    `Workspace    ${result.workspace} · ${String(git.changedFileCount)} pre-existing changed file${git.changedFileCount === 1 ? '' : 's'}`,
    ...changedFiles.map((file, index) =>
      `Dirty ${String(index + 1).padEnd(7)} ${file.status} ${boundedSummaryValue(file.path)}`,
    ),
    ...(git.changedFileCount > changedFiles.length
      ? [`Dirty        +${String(git.changedFileCount - changedFiles.length)} more · use Review workspace changes`]
      : []),
  ];
}

function boundedSummaryValue(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, ' ').trim();
  if (normalized.length <= PREFLIGHT_SUMMARY_VALUE_LIMIT) return normalized;
  return `${normalized.slice(0, PREFLIGHT_SUMMARY_VALUE_LIMIT - 1)}…`;
}

function formatByteLimit(value: number): string {
  if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) {
    return `${String(value / (1024 * 1024))} MiB`;
  }
  if (value >= 1024 && value % 1024 === 0) return `${String(value / 1024)} KiB`;
  return `${String(value)} B`;
}

function blocked(
  reasonCode: LoopPreflightBlocked['reasonCode'],
  reason: string,
  next: string,
  proposal?: FinishLineProposal,
  trustChallenge?: string,
  brokerTrustProposal?: BrokerReviewTrustProposalV1,
  reviewSubjectConsentProposal?: ReviewSubjectConsentProposalV1,
  verificationCatalog?: VerificationCriteriaCatalogV1,
  brokerTrustChallenge?: string,
): LoopPreflightBlocked {
  return {
    ready: false,
    reasonCode,
    reason,
    next,
    proposal,
    trustChallenge,
    brokerTrustProposal,
    brokerTrustChallenge,
    reviewSubjectConsentProposal,
    verificationCatalog,
  };
}

function proposalFailure(failure: {
  readonly code: string;
  readonly message: string;
}): LoopPreflightBlocked {
  return blocked(
    failure.code === 'inline_secret_rejected'
      ? 'inline_secret_rejected'
      : 'invalid_finish_line',
    failure.message,
    'Edit the Finish Line and retry.',
  );
}

export function resolveLoopReviewProvider(
  config: Pick<WukongConfig, 'defaultModel' | 'models' | 'providers'>,
  requestedModel?: string,
): { readonly providerId: string; readonly endpoint: string } | undefined {
  const requested = requestedModel?.trim();
  const model = requested === undefined || requested.length === 0
    ? config.defaultModel
    : requested;
  if (model === undefined) return undefined;
  const alias = config.models?.[model];
  const providerId = alias?.provider ?? model.split('/')[0];
  if (providerId === undefined || providerId === '') return undefined;
  const provider = config.providers[providerId];
  if (provider === undefined) return undefined;
  const endpoint = provider.baseUrl ?? defaultProviderEndpoint(provider.type);
  return endpoint === undefined ? undefined : { providerId, endpoint };
}

async function defaultCriteriaRoots(
  workspace: string,
  workspaceIdentityDigest: string,
  homeDir?: string,
): Promise<readonly VerificationCriteriaSourceRootV1[]> {
  const candidates: VerificationCriteriaSourceRootV1[] = [
    {
      kind: 'project',
      root: join(workspace, '.wukong', 'skills'),
      workspaceIdentityDigest,
    },
    {
      kind: 'personal',
      root: join(homeDir ?? homedir(), '.wukong', 'skills'),
    },
  ];
  const roots: VerificationCriteriaSourceRootV1[] = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate.root)).isDirectory()) roots.push(candidate);
    } catch {
      continue;
    }
  }
  roots.push(...await discoverPackageVerificationCriteriaRoots({
    workspaceRoot: workspace,
    workspaceIdentityDigest,
  }));
  for (const grant of await listCriteriaSourceTrustGrants({ homeDir })) {
    roots.push({
      kind: 'extra',
      root: grant.canonicalRealpath,
      sourceId: grant.sourceId,
      trustGrantId: grant.trustGrantId,
      rootIdentityDigest: grant.rootIdentityDigest,
    });
  }
  const builtinRoot = await resolveBuiltinCriteriaRoot();
  if (builtinRoot !== undefined) {
    const root = {
      kind: 'builtin' as const,
      root: builtinRoot,
      version: WUKONG_BUILD_INFO.version ?? 'dev',
      assetDigest: await digestVerificationCriteriaAssetRoot(builtinRoot),
    };
    registerBuiltinVerificationCriteriaRoot(root);
    roots.push(root);
  }
  return roots;
}

async function resolveBuiltinCriteriaRoot(): Promise<string | undefined> {
  const nativeRoot = getNativePackageRoot('@wukong/reference-verification-skills');
  const moduleDirectory = import.meta.dirname;
  const candidates = [
    nativeRoot,
    join(moduleDirectory, '..', 'reference-verification-skills'),
    join(moduleDirectory, '..', '..', '..', 'reference-verification-skills'),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function defaultProviderEndpoint(
  type: WukongConfig['providers'][string]['type'],
): string | undefined {
  switch (type) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'openai':
    case 'openai_responses':
      return 'https://api.openai.com/v1';
    case 'google-genai':
      return 'https://generativelanguage.googleapis.com';
    case 'wukong':
      return 'https://api.wukong.ai/v1';
    case 'vertexai':
      return undefined;
  }
}
