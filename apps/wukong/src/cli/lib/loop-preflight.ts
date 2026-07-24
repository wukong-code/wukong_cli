import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  buildFinishLine,
  classifyGateCommand,
  createTrustChallenge,
  verifyTrustChallenge,
  type FinishLineProposal,
  type VerificationCommand,
} from '@wukong/verification';
import type { GoalSnapshot } from '@wukong/wukong-sdk';

import {
  findWorkspaceTrust,
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
    | 'inline_secret_rejected';
  readonly proposal?: FinishLineProposal;
  readonly trustChallenge?: string;
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
  readonly acknowledgeWarningSetDigest?: string;
  readonly trustWorkspaceChallenge?: string;
  readonly homeDir?: string;
  readonly requireModel?: boolean;
  readonly discoverChecks?: (workspace: string) => Promise<readonly string[]>;
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
): string {
  const contract = result.proposal;
  return [
    'Finish line',
    '',
    `Goal         ${contract.objective}`,
    `Done when    ${contract.completionCriterion ?? 'Not specified separately'}`,
    `Must not     ${String(contract.constraints.length)} constraint${contract.constraints.length === 1 ? '' : 's'}`,
    `Verification ${String(contract.gatePlan.requiredChecks.length)} required project check${contract.gatePlan.requiredChecks.length === 1 ? '' : 's'}`,
    `Run          up to ${String(maxIterations)} iterations`,
  ].join('\n');
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
    trustChallenge: result.trustChallenge,
    approvalSetDigest: proposal.gateApproval.approvalSetDigest,
    warningSetDigest: proposal.finishLineReview.warningSetDigest,
  }, null, 2)}\n`;
}

function blocked(
  reasonCode: LoopPreflightBlocked['reasonCode'],
  reason: string,
  next: string,
  proposal?: FinishLineProposal,
  trustChallenge?: string,
): LoopPreflightBlocked {
  return { ready: false, reasonCode, reason, next, proposal, trustChallenge };
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
