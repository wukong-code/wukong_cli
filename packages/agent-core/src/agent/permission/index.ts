import type { Agent } from '..';
import type { PrepareToolExecutionResult } from '../../loop';
import { createPermissionDecisionPolicies } from './policies';
import type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  PermissionReasonValue,
  PermissionRule,
} from './types';

export * from './types';

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: PermissionManager;
}

interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export class PermissionManager {
  readonly policies: PermissionPolicy[];
  readonly rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly localSessionApprovalRulePatterns = new Set<string>();

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.policies = createPermissionDecisionPolicies(this.agent);
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? this.parent?.mode ?? 'manual';
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  data(): PermissionData {
    return {
      mode: this.mode,
      rules: this.effectiveRules,
    };
  }

  setMode(mode: PermissionMode): void {
    this.agent.records.logRecord({
      type: 'permission.set_mode',
      mode,
    });
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.modeOverride = mode;
    if (this.agent.records.restoring === null || this.agent.records.restoring === undefined) {
      this.agent.telemetry.track('permission_mode_selected', { permission_mode: mode });
      if (mode === 'yolo') {
        this.agent.telemetry.track('yolo_session_started', { permission_mode: mode });
      }
    }
    this.agent.emitStatusUpdated();
  }

  /**
   * Apply a process-local permission override without writing it to the session
   * wire. Headless callers use this so SIGKILL or power loss cannot leave a
   * resumed session durably elevated to auto/yolo.
   */
  setModeTransient(mode: PermissionMode): void {
    this.modeOverride = mode;
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.agent.emitStatusUpdated();
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.agent.records.logRecord({
      type: 'permission.record_approval_result',
      ...record,
    });
    this.agent.replayBuilder.push({
      type: 'approval_result',
      record,
    });
    if (record.result.decision !== 'approved' || record.result.scope !== 'session') {
      return;
    }
    const pattern = record.sessionApprovalRule;
    if (pattern === undefined) return;
    this.localSessionApprovalRulePatterns.add(pattern);
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [
      ...this.localSessionApprovalRulePatterns,
      ...(this.parent?.sessionApprovalRulePatterns ?? []),
    ];
  }

  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    const toolName = context.toolCall.name;
    const toolInfo = this.agent.tools?.data().find((tool) => tool.name === toolName);
    const telemetryToolName = toolName.startsWith('mcp__')
      ? 'mcp'
      : toolInfo?.source === 'user'
        ? 'custom'
        : toolName;
    this.agent.telemetry.track('permission_policy_decision', {
      policy_name: evaluation.policyName,
      tool_name: telemetryToolName,
      permission_mode: this.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    if (
      this.mode === 'auto'
      && evaluation.result.kind === 'deny'
      && evaluation.result.reason?.['reason_code'] === 'permission_required'
    ) {
      return this.blockAutoPermission(
        evaluation.result.reason?.['category'],
        evaluation.result.message,
        context,
      );
    }
    return this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private async requestToolApproval(
    context: PermissionPolicyContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<PrepareToolExecutionResult | undefined> {
    if (this.mode === 'auto') {
      return this.blockAutoPermission('approval_required', undefined, context);
    }
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.name;
    const display =
      context.execution.display ?? {
        kind: 'generic',
        summary: context.execution.description ?? `Approve ${name}`,
        detail: context.args,
      };
    const action = context.execution.description ?? `Call ${name}`;
    const startedAt = Date.now();

    let response: ApprovalResponse;
    let requestedApproval = false;
    if (this.agent.rpc?.requestApproval) {
      requestedApproval = true;
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionRequest', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          toolInput: context.args,
          display,
        },
      });
      try {
        response = await this.agent.rpc.requestApproval(
          {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            display,
          },
          { signal },
        );
      } catch (error) {
        this.agent.telemetry.track('permission_approval_result', {
          policy_name: policyName ?? null,
          tool_name: name,
          permission_mode: this.mode,
          result: 'error',
          approval_surface: display.kind,
          duration_ms: Date.now() - startedAt,
          session_cache_written: false,
          has_feedback: false,
        });
        void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
          matcherValue: name,
          inputData: {
            turnId: Number(context.turnId),
            toolCallId: id,
            toolName: name,
            action,
            decision: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        const resolved = result.resolveError?.(error);
        return resolved === undefined
          ? Promise.reject(error)
          : this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
      }
    } else {
      response = {
        decision: 'approved',
      };
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;

    if (requestedApproval) {
      void this.agent.hooks?.fireAndForgetTrigger?.('PermissionResult', {
        matcherValue: name,
        inputData: {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          decision: response.decision,
          scope: response.scope,
          feedback: response.feedback,
          selectedLabel: response.selectedLabel,
        },
      });
    }

    this.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.agent.telemetry.track('permission_approval_result', {
      policy_name: policyName ?? null,
      tool_name: name,
      permission_mode: this.mode,
      result:
        response.decision === 'approved' && response.scope === 'session'
          ? 'approved_for_session'
          : response.decision,
      approval_surface: display.kind,
      duration_ms: Date.now() - startedAt,
      session_cache_written: sessionApprovalRule !== undefined,
      has_feedback: response.feedback !== undefined && response.feedback.length > 0,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    if (response.decision === 'approved') {
      return undefined;
    }

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  private async blockAutoPermission(
    category: PermissionReasonValue | undefined,
    message = 'Auto blocked an action that requires permission. Review it or restart explicitly with YOLO.',
    context?: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult> {
    this.agent.telemetry.track('auto_action_blocked', {
      reason_code: 'permission_required',
      category: typeof category === 'string' ? category : 'unknown',
    });

    const current = this.agent.goal.getGoal().goal;
    if (current?.status === 'active' && current.stopCondition !== undefined) {
      const categoryLabel = typeof category === 'string' ? category : 'unknown';
      const toolName = context?.toolCall.name ?? 'unknown tool';
      const summary = `Auto paused the Loop because ${toolName} requires explicit permission (${categoryLabel}).`;
      this.agent.goal.recordLoopResult({
        schemaVersion: 2,
        status: 'NEEDS_WORK',
        reasonCode: 'permission_required',
        summary,
        checks: [],
        blockers: [{
          id: `permission-required:${toolName}:${categoryLabel}`,
          kind: 'risk',
          summary: `The guarded ${toolName} action was not executed in Auto mode.`,
          evidence: `tool=${toolName}; category=${categoryLabel}; permission_mode=auto`,
          nextAction: 'Switch to Manual, run `/loop resume`, and approve the exact action; or explicitly choose YOLO only if you accept the risk; otherwise revise the goal.',
        }],
        evidence: { verification: 'not_run', reviewer: 'not_run' },
      });
      await this.agent.goal.markBlocked(
        { reason: `loop:NEEDS_WORK:permission_required:${summary}` },
        'system',
      );
      this.agent.context.appendSystemReminder(
        'The current Loop paused at a permission boundary. Review the requested action, then resume manually or restart explicitly with YOLO if you accept the risk.',
        { kind: 'system_trigger', name: 'loop_permission_required' },
      );
    }

    return {
      block: true,
      reason: message,
    };
  }

  private async evaluatePolicies(
    context: PermissionPolicyContext,
  ): Promise<PolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) {
        return { policyName: policy.name, result };
      }
    }
    return undefined;
  }

  private get effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules ?? [])];
  }

  private permissionPolicyResolutionToPrepare(
    result: PermissionPolicyResolution,
    context: PermissionPolicyContext,
    policyName?: string,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  protected formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.agent.type === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.agent.type === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}
