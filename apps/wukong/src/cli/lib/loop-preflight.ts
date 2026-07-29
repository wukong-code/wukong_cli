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
  inspectSourceSnapshot,
  REVIEW_SUBJECT_POLICY_VERSION,
  SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION,
  registerBuiltinVerificationCriteriaRoot,
  verifyTrustChallenge,
  verifyBrokerReviewTrustChallenge,
  type BrokerReviewTrustBindingV1,
  type BrokerReviewTrustProposalV1,
  type FinishLineProposal,
  type ReviewSubjectConsentBindingV1,
  type ReviewSubjectConsentProposalV1,
  type SourceSnapshotDryRunV1,
  type CandidateBootstrapPreflightV1,
  type CandidateBootstrapPlanV1,
  type BootstrapBudgetV1,
  type VerificationCommand,
  type VerificationCriteriaCatalogV1,
  type VerificationCriteriaRecipeV1,
  type VerificationCriteriaSelectionV1,
  type VerificationCriteriaSourceRootV1,
} from '@wukong/verification';
import {
  buildCandidateBootstrapPlan,
  inspectCandidateWorkspaceBackendCapability,
  inspectCandidateBootstrapPreflight,
  type CandidateWorkspaceBackendCapabilityV1,
  type GoalSnapshot,
  type WukongConfig,
} from '@wukong/wukong-sdk';

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

export interface LoopPreflightReady {
  readonly ready: true;
  readonly model: string;
  readonly workspace: string;
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
  readonly sourceSnapshotDryRun?: SourceSnapshotDryRunV1;
  readonly candidateBootstrapPreflight?: CandidateBootstrapPreflightV1;
  readonly candidateBootstrapPlan?: CandidateBootstrapPlanV1;
  readonly candidateBootstrapBudget?: BootstrapBudgetV1;
  readonly sourceRepositoryRoot?: string;
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
    | 'review_subject_consent_required'
    | 'isolated_loop_not_git'
    | 'isolated_loop_git_unsupported'
    | 'source_snapshot_untrusted'
    | 'snapshot_dependency_excluded'
    | 'snapshot_selection_excluded'
    | 'candidate_atomic_backend_unavailable'
    | 'candidate_bootstrap_preflight_failed'
    | 'candidate_bootstrap_lockfile_required'
    | 'candidate_bootstrap_lockfile_ambiguous'
    | 'candidate_bootstrap_lockfile_unsupported'
    | 'candidate_bootstrap_manifest_invalid'
    | 'candidate_bootstrap_runtime_unavailable'
    | 'candidate_bootstrap_native_build_unsupported'
    | 'candidate_bootstrap_confirmation_required'
    | 'candidate_bootstrap_confirmation_mismatch';
  readonly proposal?: FinishLineProposal;
  readonly trustChallenge?: string;
  readonly brokerTrustProposal?: BrokerReviewTrustProposalV1;
  readonly brokerTrustChallenge?: string;
  readonly reviewSubjectConsentProposal?: ReviewSubjectConsentProposalV1;
  readonly verificationCatalog?: VerificationCriteriaCatalogV1;
  readonly sourceSnapshotDryRun?: SourceSnapshotDryRunV1;
  readonly candidateBootstrapPreflight?: CandidateBootstrapPreflightV1;
  readonly candidateBootstrapPlan?: CandidateBootstrapPlanV1;
  readonly candidateBootstrapBudget?: BootstrapBudgetV1;
}

export type LoopPreflightResult = LoopPreflightReady | LoopPreflightBlocked;

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
  readonly approveBootstrapPlanDigest?: string;
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
  readonly inspectIsolatedSource?: boolean;
  readonly selectedUntrackedPaths?: readonly string[];
  /**
   * Test/runtime injection for resolving an exact bootstrap executable.
   * Product callers intentionally use the current process PATH.
   */
  readonly bootstrapPathEnvironment?: string;
  /**
   * Controlled capability injection for platform/native backend tests.
   * Product callers use the packaged local capability probe.
   */
  readonly candidateWorkspaceBackendProbe?:
    () => CandidateWorkspaceBackendCapabilityV1;
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

  if (options.inspectIsolatedSource === true) {
    const backendCapability = (
      options.candidateWorkspaceBackendProbe
      ?? inspectCandidateWorkspaceBackendCapability
    )();
    if (!backendCapability.available) {
      return blocked(
        'candidate_atomic_backend_unavailable',
        `The isolated Candidate file backend is unavailable: ${
          backendCapability.reasonCode
        }.`,
        'Use macOS or Linux with the packaged native backend, then rerun the isolated Loop preflight.',
      );
    }
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
  const sourceSnapshotDryRun = options.inspectIsolatedSource === true
    ? await inspectSourceSnapshot({
        cwd: proposal.workspaceIdentity.canonicalRealpath,
        selectedUntrackedPaths: options.selectedUntrackedPaths,
        requiredGatePaths: gateSourcePaths(proposal),
      })
    : undefined;
  const trustChallenge = createTrustChallenge({
    workspaceIdentityDigest: proposal.workspaceIdentity.workspaceIdentityDigest,
    approvalSetDigest: proposal.gateApproval.approvalSetDigest,
    warningSetDigest: proposal.finishLineReview.warningSetDigest,
  });
  if (sourceSnapshotDryRun?.status === 'blocked') {
    const reasonCode = sourceSnapshotDryRun.reasonCode;
    if (reasonCode === null) throw new Error('Blocked source snapshot has no reason code.');
    return {
      ready: false,
      reasonCode,
      reason: reasonCode === 'isolated_loop_not_git'
        ? 'Isolated Loop execution requires a supported Git workspace.'
        : reasonCode === 'isolated_loop_git_unsupported'
          ? `Isolated Loop execution requires Git ${SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION} or newer.`
        : reasonCode === 'snapshot_dependency_excluded'
          ? 'A frozen Gate input is excluded by the source snapshot policy.'
          : reasonCode === 'snapshot_selection_excluded'
            ? 'An explicitly selected untracked file is excluded by the source snapshot policy.'
          : 'The source workspace could not be frozen into one trustworthy snapshot.',
      next: reasonCode === 'isolated_loop_not_git'
        ? 'Run the Loop in a Git workspace or disable the isolated worktree experiment.'
        : reasonCode === 'isolated_loop_git_unsupported'
          ? `Upgrade Git to ${SOURCE_SNAPSHOT_MINIMUM_GIT_VERSION} or newer, then rerun the Source Snapshot dry-run.`
        : reasonCode === 'snapshot_dependency_excluded'
          ? 'Remove the excluded Gate dependency or provide it through an approved run-scoped input.'
          : reasonCode === 'snapshot_selection_excluded'
            ? 'Remove the excluded selection or choose an eligible regular file.'
          : 'Resolve the Git state or path identity issue, then run the dry-run again.',
      proposal,
      trustChallenge,
      sourceSnapshotDryRun,
    };
  }
  let candidateBootstrapPreflight:
    CandidateBootstrapPreflightV1 | undefined;
  let candidateBootstrapPlan: CandidateBootstrapPlanV1 | undefined;
  let candidateBootstrapBudget: BootstrapBudgetV1 | undefined;
  if (sourceSnapshotDryRun?.status === 'ready'
    && sourceSnapshotDryRun.proposedSnapshot !== null) {
    try {
      candidateBootstrapPreflight =
        await inspectCandidateBootstrapPreflight({
          sourceSnapshotCwd:
            proposal.workspaceIdentity.canonicalRealpath,
          sourceSnapshot: sourceSnapshotDryRun.proposedSnapshot,
          gatePlan: proposal.gatePlan,
        });
    } catch {
      return {
        ready: false,
        reasonCode: 'candidate_bootstrap_preflight_failed',
        reason:
          'The candidate dependency environment could not be frozen safely.',
        next:
          'Resolve source drift or unsafe manifest paths, then run the dry-run again.',
        proposal,
        trustChallenge,
        sourceSnapshotDryRun,
      };
    }
    if (candidateBootstrapPreflight.status === 'unsupported') {
      const reasonCode = candidateBootstrapPreflight.reasonCode;
      if (reasonCode === 'candidate_bootstrap_not_required'
        || reasonCode === 'candidate_bootstrap_confirmation_required') {
        throw new Error(
          'An unsupported bootstrap preflight has a non-blocking reason.',
        );
      }
      return {
        ready: false,
        reasonCode,
        reason:
          'The frozen checks require a dependency environment that the safe bootstrap policy cannot prepare.',
        next:
          'Use a supported exact lockfile/runtime, remove the unsupported dependency step, or disable isolated execution.',
        proposal,
        trustChallenge,
        sourceSnapshotDryRun,
        candidateBootstrapPreflight,
      };
    }
    if (candidateBootstrapPreflight.status === 'ready') {
      try {
        const prepared = await buildCandidateBootstrapPlan({
          preflight: candidateBootstrapPreflight,
          expectedPreflightDigest:
            candidateBootstrapPreflight.preflightDigest,
          sourceWorkspaceRoot:
            proposal.workspaceIdentity.canonicalRealpath,
          pathEnvironment: options.bootstrapPathEnvironment,
        });
        candidateBootstrapPlan = prepared.plan;
        candidateBootstrapBudget = prepared.budget;
      } catch {
        return {
          ready: false,
          reasonCode: 'candidate_bootstrap_runtime_unavailable',
          reason:
            'The package-manager runtime could not be frozen as an exact executable.',
          next:
            'Install a supported native runtime or use a lockfile recipe with a supported executable identity.',
          proposal,
          trustChallenge,
          sourceSnapshotDryRun,
          candidateBootstrapPreflight,
        };
      }
      if (mode !== 'tui-proposal'
        && options.approveBootstrapPlanDigest
          !== candidateBootstrapPlan.bootstrapPlanDigest) {
        const missing = options.approveBootstrapPlanDigest === undefined;
        return {
          ready: false,
          reasonCode: missing
            ? 'candidate_bootstrap_confirmation_required'
            : 'candidate_bootstrap_confirmation_mismatch',
          reason: missing
            ? 'The exact dependency bootstrap plan requires explicit confirmation.'
            : 'The confirmed dependency bootstrap plan is stale.',
          next:
            `Review and confirm bootstrap plan ${candidateBootstrapPlan.bootstrapPlanDigest}.`,
          proposal,
          trustChallenge,
          sourceSnapshotDryRun,
          candidateBootstrapPreflight,
          candidateBootstrapPlan,
          candidateBootstrapBudget,
        };
      }
    }
  }
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
  if (sourceSnapshotDryRun?.status === 'ready'
    && git.root === undefined) {
    throw new Error(
      'A ready isolated source snapshot has no repository root.',
    );
  }
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
      'The actual reviewer provider endpoint could not be resolved.',
      'Configure the selected model provider with an exact base_url, then retry.',
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
    sourceSnapshotDryRun,
    candidateBootstrapPreflight,
    candidateBootstrapPlan,
    candidateBootstrapBudget,
    sourceRepositoryRoot: sourceSnapshotDryRun === undefined
      ? undefined
      : git.root,
  };
}

export function formatLoopPreflightBlocked(result: LoopPreflightBlocked): string {
  const lines = [
    'Loop not started',
    `Code     ${result.reasonCode}`,
    `Reason   ${result.reason}`,
    `Next     ${result.next}`,
  ];
  if (result.sourceSnapshotDryRun !== undefined) {
    lines.push(`Snapshot ${result.sourceSnapshotDryRun.dryRunDigest}`);
  }
  if (result.candidateBootstrapPreflight !== undefined) {
    lines.push(
      `Bootstrap     ${result.candidateBootstrapPreflight.status}`
      + ` · ${result.candidateBootstrapPreflight.preflightDigest}`,
    );
  }
  if (result.candidateBootstrapPlan !== undefined) {
    lines.push(
      `Bootstrap plan ${result.candidateBootstrapPlan.bootstrapPlanDigest}`,
    );
  }
  return lines.join('\n');
}

export function formatLoopPreflightReady(
  result: LoopPreflightReady,
  maxIterations: number,
): string {
  const contract = result.proposal;
  const lines = [
    'Finish line',
    '',
    `Goal         ${contract.objective}`,
    `Done when    ${contract.completionCriterion ?? 'Not specified separately'}`,
    `Must not     ${String(contract.constraints.length)} constraint${contract.constraints.length === 1 ? '' : 's'}`,
    `Verification ${String(contract.gatePlan.requiredChecks.length)} required project check${contract.gatePlan.requiredChecks.length === 1 ? '' : 's'}`,
    `Skill criteria ${String(result.verificationSelection?.selected.length ?? 0)} selected · ${String(result.verificationCatalog.suggestions.length)} suggested`,
    `Reviewer     brokered fresh context → ${result.reviewSubjectConsentProposal.provider.endpointOrigin.scheme}://${result.reviewSubjectConsentProposal.provider.endpointOrigin.host}:${String(result.reviewSubjectConsentProposal.provider.endpointOrigin.port)}`,
    'Input        bounded changed/scope files and redacted Gate evidence; secrets excluded',
    `Run          up to ${String(maxIterations)} iterations`,
  ];
  if (result.sourceSnapshotDryRun !== undefined) {
    const snapshot = result.sourceSnapshotDryRun.proposedSnapshot;
    lines.push(
      `Isolation    snapshot dry-run ${result.sourceSnapshotDryRun.status} · no worktree created`,
      `Source       ${snapshot === null
        ? result.sourceSnapshotDryRun.reasonCode
        : `${snapshot.trackedDeltaDigest === null ? 'clean tracked state' : 'tracked changes'} · ${String(snapshot.includedUntracked.length)} selected untracked`}`,
    );
  }
  if (result.candidateBootstrapPreflight !== undefined) {
    lines.push(
      `Bootstrap    ${result.candidateBootstrapPreflight.status}`
      + ` · ${String(result.candidateBootstrapPreflight.entries.length)} environment`
      + (result.candidateBootstrapPreflight.entries.length === 1 ? '' : 's'),
      `Bootstrap ID ${result.candidateBootstrapPreflight.preflightDigest}`,
    );
  }
  if (result.candidateBootstrapPlan !== undefined
    && result.candidateBootstrapBudget !== undefined) {
    lines.push(
      `Bootstrap plan ${result.candidateBootstrapPlan.bootstrapPlanDigest}`,
      `Bootstrap budget ${String(result.candidateBootstrapBudget.wallClockLimitMs)}ms · ${String(result.candidateBootstrapBudget.generatedByteLimit)} generated bytes · ${String(result.candidateBootstrapBudget.processOutputByteLimit)} output bytes`,
    );
  }
  return lines.join('\n');
}

export function formatLoopDryRun(
  result: LoopPreflightReady,
  runSettings?: {
    readonly maxIterations?: number;
    readonly writerModel?: string;
    readonly reviewerModel?: string;
    readonly minIntervalMs?: number;
  },
): string {
  const proposal = result.proposal;
  return `${JSON.stringify({
    kind: 'loop.finish_line.dry_run',
    schemaVersion: 1,
    proposedContract: proposal,
    runSettings,
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
    reviewSubjectPolicyVersion: REVIEW_SUBJECT_POLICY_VERSION,
    brokerTrustProposal: result.brokerTrustProposal,
    brokerTrustChallenge: result.brokerTrustChallenge,
    reviewSubjectConsentProposal: result.reviewSubjectConsentProposal,
    sourceSnapshotDryRun: result.sourceSnapshotDryRun ?? null,
    candidateBootstrapPreflight:
      result.candidateBootstrapPreflight ?? null,
    candidateBootstrapPlan: result.candidateBootstrapPlan ?? null,
    candidateBootstrapBudget: result.candidateBootstrapBudget ?? null,
    estimatedCost: {
      freshReviewerPassesPerGateAttempt: 1,
      additionalSkillCommands: 0,
    },
    trustChallenge: result.trustChallenge,
    approvalSetDigest: proposal.gateApproval.approvalSetDigest,
    warningSetDigest: proposal.finishLineReview.warningSetDigest,
  }, null, 2)}\n`;
}

function gateSourcePaths(proposal: FinishLineProposal): string[] {
  const paths = new Set<string>();
  for (const check of proposal.gatePlan.requiredChecks) {
    const locator = check.sourceLocator
      ?? (check.resolution === 'expected-unresolved' ? check.expectedSourceLocator : undefined);
    const path = locator?.split('#', 1)[0];
    if (path !== undefined && path.length > 0) paths.add(path);
  }
  if (proposal.reviewPolicy.mode === 'blocking-frozen') {
    paths.add(proposal.reviewPolicy.sourceLocator);
  }
  return [...paths].toSorted();
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
