import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { runFile } from './process';
import { selectVerificationCommands } from './scripts';
import type { VerificationCommand } from './types';

export const FINISH_LINE_WARNING_POLICY_VERSION = 'finish-line-warnings/1';
export const GATE_GUARD_POLICY_VERSION = 'gate-guard/1';
export const BUILTIN_RISK_SCAN_POLICY_VERSION = 'builtin-risk-scan/1';
export const NO_EXECUTABLE_CHECKS_POLICY_VERSION = 'no-executable-checks/1';

export type GateCheckSource = VerificationCommand['source'];

export interface LoopConstraint {
  readonly id: string;
  readonly text: string;
}

export interface FinishLineWarning {
  readonly id: string;
  readonly code:
    | 'missing_done_when'
    | 'broad_criterion'
    | 'conflicting_finish_line'
    | 'no_resolved_checks';
  readonly field: 'objective' | 'completion_criterion' | 'constraint' | 'gate_plan';
  readonly message: string;
}

export interface FinishLineReview {
  readonly schemaVersion: 1;
  readonly warningPolicyVersion: string;
  readonly finishLineDigest: string;
  readonly warnings: readonly FinishLineWarning[];
  readonly warningSetDigest: string;
  readonly acknowledgedWarningIds: readonly string[];
  readonly acknowledgedAt?: number;
}

export interface RequiredGateCheckBase {
  readonly id: string;
  readonly source: GateCheckSource;
  readonly sourceLocator?: string;
  readonly selectedBy: 'user' | 'project-default';
}

export interface ResolvedRequiredGateCheck extends RequiredGateCheckBase {
  readonly resolution: 'resolved';
  readonly executionCommand: string;
  readonly displayCommand: string;
  readonly commandDigest: string;
  readonly definitionDigest: string;
}

export interface ExpectedUnresolvedGateCheck extends RequiredGateCheckBase {
  readonly resolution: 'expected-unresolved';
  readonly executionCommand: string;
  readonly displayCommand: string;
  readonly commandDigest: string;
  readonly expectedSourceLocator?: string;
}

export type RequiredGateCheck =
  | ResolvedRequiredGateCheck
  | ExpectedUnresolvedGateCheck;

export interface ExcludedGateCheck {
  readonly displayCommand: string;
  readonly commandDigest: string;
  readonly source: GateCheckSource;
  readonly sourceLocator?: string;
  readonly excludedBy: 'user';
  readonly reason: 'only-explicit' | 'tui-confirmed';
}

export interface GatePlan {
  readonly schemaVersion: 1;
  readonly stopCondition: 'proof-pass';
  readonly requiredChecks: readonly RequiredGateCheck[];
  readonly excludedChecks: readonly ExcludedGateCheck[];
  readonly builtinRiskScanPolicyVersion: string;
  readonly planDigest: string;
}

export interface NoExecutableChecksDecisionV1 {
  readonly schemaVersion: 1;
  readonly policyVersion: string;
  readonly decisionDigest: string;
  readonly status: 'confirmation-required' | 'acknowledged';
  readonly acknowledgedAt?: number;
}

export interface GateApprovalOrderedCheck {
  readonly checkId: string;
  readonly resolution: RequiredGateCheck['resolution'];
  readonly commandDigest: string;
  readonly definitionDigest?: string;
  readonly sourceLocator?: string;
  readonly riskDigest: string;
  readonly permissionRequestDigest: string;
}

interface GateApprovalBindingBase {
  readonly schemaVersion: 1;
  readonly gatePlanDigest: string;
  readonly warningSetDigest: string;
  readonly guardPolicyVersion: string;
  readonly orderedChecks: readonly GateApprovalOrderedCheck[];
  readonly noExecutableChecksDecisionDigest?: string;
  readonly approvalSetDigest: string;
}

export interface ExecutableGateApprovalBinding extends GateApprovalBindingBase {
  readonly hasExecutableChecks: true;
  readonly workspaceIdentityDigest: string;
}

export interface NonExecutableGateApprovalBinding extends GateApprovalBindingBase {
  readonly hasExecutableChecks: false;
  readonly workspaceIdentityDigest?: never;
}

export type GateApprovalBinding =
  | ExecutableGateApprovalBinding
  | NonExecutableGateApprovalBinding;

export interface WorkspaceIdentity {
  readonly canonicalRealpath: string;
  readonly filesystemIdentity: string;
  readonly gitCommonDirIdentity?: string;
  readonly workspaceIdentityDigest: string;
}

export interface WorkspaceTrustBinding {
  readonly workspaceIdentityDigest: string;
  readonly scope: 'loop-project-checks';
  readonly trustGrantId?: string;
}

export type ReviewPolicyBinding =
  | {
      readonly mode: 'blocking-frozen';
      readonly sourceLocator: '.wukong/review-policy.md';
      readonly definitionDigest: string;
    }
  | {
      readonly mode: 'advisory-live';
    };

export interface FinishLineProposal {
  readonly schemaVersion: 1;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly LoopConstraint[];
  readonly finishLineReview: FinishLineReview;
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly workspaceTrust?: WorkspaceTrustBinding;
  readonly gateApproval: GateApprovalBinding;
  readonly gatePlan: GatePlan;
  readonly noExecutableChecksDecision?: NoExecutableChecksDecisionV1;
  readonly reviewPolicy: ReviewPolicyBinding;
}

export interface BuildFinishLineOptions {
  readonly cwd: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints?: readonly string[];
  readonly explicitChecks?: readonly string[];
  readonly includeDiscoveredChecks: boolean;
  readonly excludedDiscoveredReason?: ExcludedGateCheck['reason'];
  readonly acknowledgeWarningSetDigest?: string;
  readonly acknowledgeNoExecutableChecksDigest?: string;
  readonly discoveredCommands?: readonly VerificationCommand[];
}

export interface FinishLineFailure {
  readonly code:
    | 'invalid_finish_line'
    | 'inline_secret_rejected'
    | 'finish_line_warning_ack_required'
    | 'workspace_trust_mismatch'
    | 'gate_plan_changed'
    | 'frozen_check_missing'
    | 'contract_update_required'
    | 'review_policy_changed';
  readonly message: string;
}

export type BuildFinishLineResult =
  | { readonly ok: true; readonly proposal: FinishLineProposal }
  | { readonly ok: false; readonly failure: FinishLineFailure };

export interface GatePlanValidation {
  readonly ok: boolean;
  readonly reasonCode?:
    | 'workspace_trust_mismatch'
    | 'gate_plan_changed'
    | 'frozen_check_missing'
    | 'contract_update_required'
    | 'review_policy_changed';
  readonly message?: string;
  readonly workspaceIdentity?: WorkspaceIdentity;
}

const MAX_OBJECTIVE_LENGTH = 8_000;
const MAX_DONE_WHEN_LENGTH = 4_000;
const MAX_CONSTRAINT_LENGTH = 1_000;
const MAX_CONSTRAINTS = 16;
const MAX_CHECK_LENGTH = 2_000;
const MAX_CHECKS = 24;
const MAX_CONTRACT_BYTES = 64 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const INLINE_SECRET_PATTERNS = [
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/iu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{12,}\b/u,
  /\bAuthorization\s*:\s*Bearer\s+\S+/iu,
] as const;

export async function buildFinishLine(
  options: BuildFinishLineOptions,
): Promise<BuildFinishLineResult> {
  const validated = validateFinishLineInput(options);
  if (validated !== undefined) return { ok: false, failure: validated };

  let workspaceIdentity: WorkspaceIdentity;
  try {
    workspaceIdentity = await resolveWorkspaceIdentity(options.cwd);
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: 'workspace_trust_mismatch',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const explicit = options.explicitChecks ?? [];
  const discovered = options.discoveredCommands
    ?? await selectVerificationCommands({ cwd: workspaceIdentity.canonicalRealpath });
  const selected = mergeSelectedChecks(explicit, options.includeDiscoveredChecks ? discovered : []);
  const excluded = options.includeDiscoveredChecks
    ? []
    : discovered.map((command) => excludedCheck(
        command,
        options.excludedDiscoveredReason ?? 'only-explicit',
      ));

  const requiredChecks: RequiredGateCheck[] = [];
  for (const entry of selected) {
    if (containsInlineSecret(entry.command)) {
      return {
        ok: false,
        failure: {
          code: 'inline_secret_rejected',
          message: `A selected check contains an inline credential and cannot be persisted: ${redactCommand(entry.command)}`,
        },
      };
    }
    const guard = classifyGateCommand(entry.command);
    if (guard.classification === 'blocked') {
      return {
        ok: false,
        failure: {
          code: 'invalid_finish_line',
          message: `A selected check is blocked by the Gate guard (${guard.matchedRuleIds.join(', ')}): ${redactCommand(entry.command)}`,
        },
      };
    }
    requiredChecks.push(await freezeCheck(workspaceIdentity.canonicalRealpath, entry));
  }

  const gatePlanWithoutDigest = {
    schemaVersion: 1 as const,
    stopCondition: 'proof-pass' as const,
    requiredChecks,
    excludedChecks: excluded,
    builtinRiskScanPolicyVersion: BUILTIN_RISK_SCAN_POLICY_VERSION,
  };
  const gatePlan: GatePlan = {
    ...gatePlanWithoutDigest,
    planDigest: canonicalDigest('wukong/gate-plan/v1', gatePlanWithoutDigest),
  };
  const objective = options.objective.trim();
  const completionCriterion = normalizeOptional(options.completionCriterion);
  const constraints = (options.constraints ?? []).map((text, index) => ({
    id: `constraint-${String(index + 1)}`,
    text: text.trim(),
  }));
  const noExecutableChecksDecision = buildNoExecutableChecksDecision({
    objective,
    completionCriterion,
    constraints,
    gatePlan,
    acknowledgeDigest: options.acknowledgeNoExecutableChecksDigest,
  });
  const finishLineCore = {
    objective,
    completionCriterion: completionCriterion ?? null,
    constraints,
    gatePlanDigest: gatePlan.planDigest,
    noExecutableChecksDecisionDigest: noExecutableChecksDecision?.decisionDigest,
  };
  const finishLineDigest = canonicalDigest('wukong/finish-line/v1', finishLineCore);
  const warnings = finishLineWarnings({
    objective,
    completionCriterion,
    constraints,
    gatePlan,
  });
  const warningCore = {
    warningPolicyVersion: FINISH_LINE_WARNING_POLICY_VERSION,
    finishLineDigest,
    warnings,
  };
  const warningSetDigest = canonicalDigest('wukong/finish-line-warnings/v1', warningCore);
  const acknowledged = options.acknowledgeWarningSetDigest === warningSetDigest;
  const finishLineReview: FinishLineReview = {
    schemaVersion: 1,
    warningPolicyVersion: FINISH_LINE_WARNING_POLICY_VERSION,
    finishLineDigest,
    warnings,
    warningSetDigest,
    acknowledgedWarningIds: acknowledged ? warnings.map((warning) => warning.id) : [],
    acknowledgedAt: acknowledged && warnings.length > 0 ? Date.now() : undefined,
  };
  const reviewPolicy = await freezeReviewPolicy(workspaceIdentity.canonicalRealpath);
  const orderedChecks = gatePlan.requiredChecks.map(approvalCheck);
  const hasExecutableChecks = gatePlan.requiredChecks.some((check) => check.resolution === 'resolved');
  const approvalCore = {
    schemaVersion: 1 as const,
    gatePlanDigest: gatePlan.planDigest,
    warningSetDigest,
    guardPolicyVersion: GATE_GUARD_POLICY_VERSION,
    orderedChecks,
    noExecutableChecksDecisionDigest: noExecutableChecksDecision?.decisionDigest,
    ...(hasExecutableChecks
      ? { hasExecutableChecks: true as const, workspaceIdentityDigest: workspaceIdentity.workspaceIdentityDigest }
      : { hasExecutableChecks: false as const }),
  };
  const gateApproval: GateApprovalBinding = {
    ...approvalCore,
    approvalSetDigest: canonicalDigest('wukong/gate-approval/v1', approvalCore),
  };
  const proposal: FinishLineProposal = {
    schemaVersion: 1,
    objective,
    completionCriterion,
    constraints,
    finishLineReview,
    workspaceIdentity,
    workspaceTrust: hasExecutableChecks
      ? {
          workspaceIdentityDigest: workspaceIdentity.workspaceIdentityDigest,
          scope: 'loop-project-checks',
        }
      : undefined,
    gateApproval,
    gatePlan,
    noExecutableChecksDecision,
    reviewPolicy,
  };
  if (Buffer.byteLength(canonicalJson(proposal), 'utf8') > MAX_CONTRACT_BYTES) {
    return {
      ok: false,
      failure: {
        code: 'invalid_finish_line',
        message: `Finish Line exceeds ${String(MAX_CONTRACT_BYTES)} bytes.`,
      },
    };
  }
  return { ok: true, proposal };
}

function buildNoExecutableChecksDecision(input: {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly LoopConstraint[];
  readonly gatePlan: GatePlan;
  readonly acknowledgeDigest?: string;
}): NoExecutableChecksDecisionV1 | undefined {
  if (
    input.gatePlan.requiredChecks.length > 0
    || input.gatePlan.excludedChecks.length > 0
  ) {
    return undefined;
  }
  const decisionCore = {
    schemaVersion: 1 as const,
    policyVersion: NO_EXECUTABLE_CHECKS_POLICY_VERSION,
    objective: input.objective,
    completionCriterion: input.completionCriterion ?? null,
    constraints: input.constraints,
    gatePlanDigest: input.gatePlan.planDigest,
  };
  const decisionDigest = canonicalDigest(
    'wukong/no-executable-checks-decision/v1',
    decisionCore,
  );
  const acknowledged = input.acknowledgeDigest === decisionDigest;
  return {
    schemaVersion: 1,
    policyVersion: NO_EXECUTABLE_CHECKS_POLICY_VERSION,
    decisionDigest,
    status: acknowledged ? 'acknowledged' : 'confirmation-required',
    acknowledgedAt: acknowledged ? Date.now() : undefined,
  };
}

export async function validateFrozenGatePlan(
  cwd: string,
  proposal: Pick<
    FinishLineProposal,
    'workspaceIdentity' | 'workspaceTrust' | 'gatePlan' | 'gateApproval' | 'reviewPolicy'
  >,
): Promise<GatePlanValidation> {
  let workspaceIdentity: WorkspaceIdentity;
  try {
    workspaceIdentity = await resolveWorkspaceIdentity(cwd);
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'workspace_trust_mismatch',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    workspaceIdentity.workspaceIdentityDigest
      !== proposal.workspaceIdentity.workspaceIdentityDigest
    || proposal.workspaceTrust?.workspaceIdentityDigest
      !== proposal.gateApproval.workspaceIdentityDigest
  ) {
    return {
      ok: false,
      reasonCode: 'workspace_trust_mismatch',
      message: 'The canonical workspace identity no longer matches the approved Finish Line.',
      workspaceIdentity,
    };
  }
  if (proposal.gatePlan.builtinRiskScanPolicyVersion !== BUILTIN_RISK_SCAN_POLICY_VERSION) {
    return {
      ok: false,
      reasonCode: 'gate_plan_changed',
      message: 'The builtin risk-scan policy changed after the Finish Line was frozen.',
      workspaceIdentity,
    };
  }
  for (const check of proposal.gatePlan.requiredChecks) {
    const current = await resolveFrozenDefinition(workspaceIdentity.canonicalRealpath, check);
    if (check.resolution === 'expected-unresolved') {
      if (current !== undefined) {
        return {
          ok: false,
          reasonCode: 'contract_update_required',
          message: `A previously unresolved check now has a definition: ${check.displayCommand}`,
          workspaceIdentity,
        };
      }
      continue;
    }
    if (current === undefined) {
      return {
        ok: false,
        reasonCode: 'frozen_check_missing',
        message: `A frozen check source is missing: ${check.sourceLocator ?? check.displayCommand}`,
        workspaceIdentity,
      };
    }
    if (digestText('wukong/check-definition/v1', current) !== check.definitionDigest) {
      return {
        ok: false,
        reasonCode: 'gate_plan_changed',
        message: `A frozen check definition changed: ${check.sourceLocator ?? check.displayCommand}`,
        workspaceIdentity,
      };
    }
  }
  const currentPolicy = await freezeReviewPolicy(workspaceIdentity.canonicalRealpath);
  if (
    proposal.reviewPolicy.mode === 'blocking-frozen'
    && (
      currentPolicy.mode !== 'blocking-frozen'
      || currentPolicy.definitionDigest !== proposal.reviewPolicy.definitionDigest
    )
  ) {
    return {
      ok: false,
      reasonCode: 'review_policy_changed',
      message: 'The frozen blocking review policy changed.',
      workspaceIdentity,
    };
  }
  const planWithoutDigest = {
    schemaVersion: proposal.gatePlan.schemaVersion,
    stopCondition: proposal.gatePlan.stopCondition,
    requiredChecks: proposal.gatePlan.requiredChecks,
    excludedChecks: proposal.gatePlan.excludedChecks,
    builtinRiskScanPolicyVersion: proposal.gatePlan.builtinRiskScanPolicyVersion,
  };
  if (
    canonicalDigest('wukong/gate-plan/v1', planWithoutDigest)
      !== proposal.gatePlan.planDigest
  ) {
    return {
      ok: false,
      reasonCode: 'gate_plan_changed',
      message: 'The frozen Gate Plan digest is invalid.',
      workspaceIdentity,
    };
  }
  return { ok: true, workspaceIdentity };
}

export async function resolveWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  const requested = resolve(cwd);
  const rootLink = await lstat(requested);
  if (!rootLink.isDirectory() && !rootLink.isSymbolicLink()) {
    throw new Error('The workspace root is not a directory.');
  }
  const canonicalRealpath = await realpath(requested);
  const rootStat = await stat(canonicalRealpath);
  if (!rootStat.isDirectory()) throw new Error('The canonical workspace root is not a directory.');
  const filesystemIdentity = `${String(rootStat.dev)}:${String(rootStat.ino)}`;
  const gitCommonDir = await runFile('git', ['rev-parse', '--git-common-dir'], {
    cwd: canonicalRealpath,
  });
  let gitCommonDirIdentity: string | undefined;
  if (gitCommonDir.exitCode === 0 && gitCommonDir.stdout.trim().length > 0) {
    const commonPath = resolve(canonicalRealpath, gitCommonDir.stdout.trim());
    const commonRealpath = await realpath(commonPath);
    const commonStat = await stat(commonRealpath);
    gitCommonDirIdentity = `${commonRealpath}\0${String(commonStat.dev)}:${String(commonStat.ino)}`;
  }
  const identityCore = {
    canonicalRealpath,
    filesystemIdentity,
    gitCommonDirIdentity: gitCommonDirIdentity ?? null,
  };
  return {
    canonicalRealpath,
    filesystemIdentity,
    gitCommonDirIdentity,
    workspaceIdentityDigest: canonicalDigest('wukong/workspace-identity/v1', identityCore),
  };
}

export function createTrustChallenge(input: {
  readonly workspaceIdentityDigest: string;
  readonly approvalSetDigest: string;
  readonly warningSetDigest: string;
  readonly now?: number;
  readonly ttlMs?: number;
}): string {
  const issuedAt = input.now ?? Date.now();
  const payload = {
    schemaVersion: 1,
    workspaceIdentityDigest: input.workspaceIdentityDigest,
    approvalSetDigest: input.approvalSetDigest,
    warningSetDigest: input.warningSetDigest,
    issuedAt,
    expiresAt: issuedAt + Math.min(input.ttlMs ?? 10 * 60_000, 10 * 60_000),
    nonce: randomUUID(),
  };
  const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  const signature = digestText('wukong/workspace-trust-challenge/v1', body);
  return `${body}.${signature}`;
}

export function verifyTrustChallenge(input: {
  readonly challenge: string;
  readonly workspaceIdentityDigest: string;
  readonly approvalSetDigest: string;
  readonly warningSetDigest: string;
  readonly now?: number;
}): boolean {
  const [body, signature, extra] = input.challenge.split('.');
  if (!body || !signature || extra !== undefined) return false;
  const expected = digestText('wukong/workspace-trust-challenge/v1', body);
  if (!safeEqual(signature, expected)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!isChallengePayload(payload)) return false;
  const now = input.now ?? Date.now();
  return payload.workspaceIdentityDigest === input.workspaceIdentityDigest
    && payload.approvalSetDigest === input.approvalSetDigest
    && payload.warningSetDigest === input.warningSetDigest
    && payload.issuedAt <= now
    && payload.expiresAt >= now
    && payload.expiresAt - payload.issuedAt <= 10 * 60_000;
}

export function canonicalDigest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(domain)
    .update('\0')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function redactCommand(command: string): string {
  let output = command;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

export function containsInlineSecret(command: string): boolean {
  return INLINE_SECRET_PATTERNS.some((pattern) => pattern.test(command));
}

function validateFinishLineInput(options: BuildFinishLineOptions): FinishLineFailure | undefined {
  const objective = options.objective.trim();
  if (objective.length === 0 || objective.length > MAX_OBJECTIVE_LENGTH || CONTROL_CHARACTER.test(objective)) {
    return {
      code: 'invalid_finish_line',
      message: `Goal must contain 1-${String(MAX_OBJECTIVE_LENGTH)} visible characters.`,
    };
  }
  const completionCriterion = normalizeOptional(options.completionCriterion);
  if (
    completionCriterion !== undefined
    && (
      completionCriterion.length > MAX_DONE_WHEN_LENGTH
      || CONTROL_CHARACTER.test(completionCriterion)
    )
  ) {
    return {
      code: 'invalid_finish_line',
      message: `Done when must not exceed ${String(MAX_DONE_WHEN_LENGTH)} visible characters.`,
    };
  }
  const constraints = options.constraints ?? [];
  if (
    constraints.length > MAX_CONSTRAINTS
    || constraints.some((entry) => (
      entry.trim().length === 0
      || entry.length > MAX_CONSTRAINT_LENGTH
      || CONTROL_CHARACTER.test(entry)
    ))
  ) {
    return {
      code: 'invalid_finish_line',
      message: `Must not accepts at most ${String(MAX_CONSTRAINTS)} non-empty rules of ${String(MAX_CONSTRAINT_LENGTH)} characters.`,
    };
  }
  const checks = options.explicitChecks ?? [];
  if (
    checks.length > MAX_CHECKS
    || checks.some((entry) => (
      entry.trim().length === 0
      || entry.length > MAX_CHECK_LENGTH
      || /[\r\n\0]/u.test(entry)
      || CONTROL_CHARACTER.test(entry)
    ))
  ) {
    return {
      code: 'invalid_finish_line',
      message: `Checks accept at most ${String(MAX_CHECKS)} single-line commands of ${String(MAX_CHECK_LENGTH)} characters.`,
    };
  }
  return undefined;
}

function mergeSelectedChecks(
  explicit: readonly string[],
  discovered: readonly VerificationCommand[],
): VerificationCommand[] {
  const selected: VerificationCommand[] = [];
  const seen = new Set<string>();
  for (const command of explicit) {
    const normalized = command.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    selected.push({ command: normalized, source: 'explicit' });
  }
  for (const command of discovered) {
    if (seen.has(command.command)) continue;
    seen.add(command.command);
    selected.push(command);
  }
  return selected;
}

async function freezeCheck(
  cwd: string,
  command: VerificationCommand,
): Promise<RequiredGateCheck> {
  if (command.source === 'explicit' && command.sourceLocator === undefined) {
    const expectedSourceLocator = await unresolvedExplicitScriptLocator(cwd, command.command);
    if (expectedSourceLocator !== undefined) {
      return {
        id: `check-${digestText('wukong/check-id/v1', `explicit\0${expectedSourceLocator}\0${command.command}`).slice(-20)}`,
        resolution: 'expected-unresolved',
        source: 'explicit',
        sourceLocator: expectedSourceLocator,
        expectedSourceLocator,
        selectedBy: 'user',
        executionCommand: command.command,
        displayCommand: redactCommand(command.command),
        commandDigest: digestText('wukong/check-command/v1', command.command),
      };
    }
  }
  assertLocatorInsideWorkspace(cwd, command.sourceLocator);
  const definition = command.definition
    ?? await resolveCommandDefinition(cwd, command)
    ?? command.command;
  return {
    id: `check-${digestText('wukong/check-id/v1', `${command.source}\0${command.sourceLocator ?? ''}\0${command.command}`).slice(-20)}`,
    resolution: 'resolved',
    source: command.source,
    sourceLocator: command.sourceLocator,
    selectedBy: command.source === 'explicit' ? 'user' : 'project-default',
    executionCommand: command.command,
    displayCommand: redactCommand(command.command),
    commandDigest: digestText('wukong/check-command/v1', command.command),
    definitionDigest: digestText('wukong/check-definition/v1', definition),
  };
}

async function unresolvedExplicitScriptLocator(
  cwd: string,
  command: string,
): Promise<string | undefined> {
  const match = command.trim().match(
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/u,
  );
  const scriptName = match?.[1];
  if (scriptName === undefined || scriptName === 'exec' || scriptName === 'dlx') return undefined;
  try {
    const parsed = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      readonly scripts?: Record<string, unknown>;
    };
    if (typeof parsed.scripts?.[scriptName] === 'string') return undefined;
  } catch {
    // Missing or unreadable package metadata means the expected script has no
    // executable definition yet.
  }
  return `package.json#scripts.${scriptName}`;
}

function excludedCheck(
  command: VerificationCommand,
  reason: ExcludedGateCheck['reason'],
): ExcludedGateCheck {
  return {
    displayCommand: redactCommand(command.command),
    commandDigest: digestText('wukong/check-command/v1', command.command),
    source: command.source,
    sourceLocator: command.sourceLocator,
    excludedBy: 'user',
    reason,
  };
}

async function resolveFrozenDefinition(
  cwd: string,
  check: RequiredGateCheck,
): Promise<string | undefined> {
  if (check.source === 'explicit' && check.sourceLocator === undefined) {
    return check.resolution === 'resolved' ? check.executionCommand : undefined;
  }
  return resolveCommandDefinition(cwd, {
    command: check.executionCommand,
    source: check.source,
    sourceLocator: check.sourceLocator
      ?? (check.resolution === 'expected-unresolved' ? check.expectedSourceLocator : undefined),
  });
}

async function resolveCommandDefinition(
  cwd: string,
  command: VerificationCommand,
): Promise<string | undefined> {
  const locator = command.sourceLocator;
  if (locator === undefined) return command.definition;
  assertLocatorInsideWorkspace(cwd, locator);
  const [path, pointer] = splitLocator(locator);
  let text: string;
  try {
    text = await readFile(join(cwd, path), 'utf8');
  } catch {
    return undefined;
  }
  if (pointer === undefined) return text;
  if (path.endsWith('package.json')) {
    const parsed = JSON.parse(text) as { readonly scripts?: Record<string, unknown> };
    const scriptName = pointer.replace(/^scripts\./u, '');
    const value = parsed.scripts?.[scriptName];
    return typeof value === 'string' ? value : undefined;
  }
  if (path === '.wukong/checks.json' && pointer.startsWith('/commands/')) {
    const index = Number(pointer.slice('/commands/'.length));
    const parsed = JSON.parse(text) as { readonly commands?: readonly unknown[] };
    const value = parsed.commands?.[index];
    return typeof value === 'string' ? value.trim() : undefined;
  }
  return text;
}

function splitLocator(locator: string): readonly [string, string?] {
  const index = locator.indexOf('#');
  if (index < 0) return [locator];
  return [locator.slice(0, index), locator.slice(index + 1)];
}

function assertLocatorInsideWorkspace(cwd: string, locator: string | undefined): void {
  if (locator === undefined) return;
  const [path] = splitLocator(locator);
  if (path.length === 0 || isAbsolute(path)) throw new Error('Gate source locator must be workspace-relative.');
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Gate source locator escapes the canonical workspace.');
  }
}

function finishLineWarnings(input: {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly constraints: readonly LoopConstraint[];
  readonly gatePlan: GatePlan;
}): FinishLineWarning[] {
  const warnings: FinishLineWarning[] = [];
  if (input.completionCriterion === undefined) {
    warnings.push(warning(
      'missing_done_when',
      'completion_criterion',
      'No separate Done when criterion was provided.',
    ));
  } else if (input.completionCriterion.trim().split(/\s+/u).length < 3) {
    warnings.push(warning(
      'broad_criterion',
      'completion_criterion',
      'Done when may be too broad to review consistently.',
    ));
  }
  if (input.gatePlan.requiredChecks.every((check) => check.resolution !== 'resolved')) {
    warnings.push(warning(
      'no_resolved_checks',
      'gate_plan',
      'No executable project check is frozen; source changes cannot claim deterministic verification.',
    ));
  }
  const normalizedObjective = input.objective.toLowerCase();
  if (input.constraints.some((constraint) => normalizedObjective.includes(constraint.text.toLowerCase()))) {
    warnings.push(warning(
      'conflicting_finish_line',
      'constraint',
      'A Must not rule appears to conflict with the Goal text.',
    ));
  }
  return warnings;
}

function warning(
  code: FinishLineWarning['code'],
  field: FinishLineWarning['field'],
  message: string,
): FinishLineWarning {
  return {
    id: `${code}-${digestText('wukong/finish-line-warning-id/v1', `${field}\0${message}`).slice(-12)}`,
    code,
    field,
    message,
  };
}

async function freezeReviewPolicy(cwd: string): Promise<ReviewPolicyBinding> {
  const path = join(cwd, '.wukong', 'review-policy.md');
  try {
    const definition = await readFile(path, 'utf8');
    return {
      mode: 'blocking-frozen',
      sourceLocator: '.wukong/review-policy.md',
      definitionDigest: digestText('wukong/review-policy-definition/v1', definition),
    };
  } catch {
    return { mode: 'advisory-live' };
  }
}

function approvalCheck(check: RequiredGateCheck): GateApprovalOrderedCheck {
  const risk = classifyGateCommand(check.executionCommand);
  const permission = {
    filesystem: 'workspace',
    network: /\b(?:curl|wget|http|https|npm|pnpm|yarn|bun)\b/iu.test(check.executionCommand),
    environment: /\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*/u.test(check.executionCommand),
  };
  return {
    checkId: check.id,
    resolution: check.resolution,
    commandDigest: check.commandDigest,
    definitionDigest: check.resolution === 'resolved' ? check.definitionDigest : undefined,
    sourceLocator: check.sourceLocator,
    riskDigest: canonicalDigest('wukong/gate-risk/v1', {
      policyVersion: GATE_GUARD_POLICY_VERSION,
      classification: risk.classification,
      matchedRuleIds: risk.matchedRuleIds,
      residualRisk: 'Trusted project commands run with the current OS account permissions.',
    }),
    permissionRequestDigest: canonicalDigest('wukong/gate-permission-request/v1', permission),
  };
}

export function classifyGateCommand(command: string): {
  readonly classification: 'normal' | 'blocked';
  readonly matchedRuleIds: readonly string[];
} {
  const matches: string[] = [];
  if (/\brm\s+(?:-[^\s]*[rf][^\s]*\s+)+(?:\/|~|\$HOME|\.\.)/iu.test(command)) {
    matches.push('guard.rm_recursive_or_force');
  }
  if (/\bgit\s+reset\s+--hard\b/iu.test(command)) matches.push('guard.git_reset_hard');
  if (/\bgit\s+clean\s+-[^\s]*f/iu.test(command)) matches.push('guard.git_clean_force');
  if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash|zsh)\b/iu.test(command)) {
    matches.push('guard.remote_script_pipe');
  }
  if (/\b(?:curl|wget)\b.*(?:--data(?:-raw)?|-d|--form|-F)\b/iu.test(command)) {
    matches.push('guard.network_upload');
  }
  return {
    classification: matches.length === 0 ? 'normal' : 'blocked',
    matchedRuleIds: matches,
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (normalized === '') return undefined;
  return normalized;
}

function digestText(domain: string, value: string): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(value).digest('hex')}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isChallengePayload(value: unknown): value is {
  readonly schemaVersion: 1;
  readonly workspaceIdentityDigest: string;
  readonly approvalSetDigest: string;
  readonly warningSetDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  return input['schemaVersion'] === 1
    && typeof input['workspaceIdentityDigest'] === 'string'
    && typeof input['approvalSetDigest'] === 'string'
    && typeof input['warningSetDigest'] === 'string'
    && typeof input['issuedAt'] === 'number'
    && typeof input['expiresAt'] === 'number'
    && typeof input['nonce'] === 'string';
}
