import type { Agent } from '../..';
import { isWithinWorkspace } from '../../../tools/policies/path-access';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const HIGH_RISK_COMMANDS = [
  /(?:^|[;&|]\s*|\s)rm\s+(?=[^;\n]*(?:--recursive|--force|-[^\s]*[rf]))/i,
  /(?:^|\s)git\s+reset\s+--hard(?:\s|$)/i,
  /(?:^|\s)git\s+clean\s+-[^\s]*f/i,
  /(?:^|\s)git\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/i,
  /(?:curl|wget)\b[^|\n]*\|\s*(?:sh|bash|zsh)\b/i,
  /(?:^|\s)(?:scp|sftp)\s/i,
  /(?:^|\s)curl\b[^\n]*(?:\s-(?:d|F|T)\s|--(?:data(?:-raw)?|form|upload-file)\b)/i,
  /(?:^|\s)wget\b[^\n]*--post-(?:data|file)\b/i,
  /(?:^|\s)sudo(?:\s|$)/i,
  /(?:^|\s)(?:mkfs(?:\.[a-z0-9]+)?|fdisk)(?:\s|$)/i,
  /(?:^|\s)dd\b[^\n]*\bof=/i,
];

/**
 * Guardrails that distinguish 0.0.16 Auto from YOLO. Auto may execute normal
 * workspace work without asking, but it cannot silently cross a workspace or
 * unclassified external-capability boundary.
 */
export class AutoModeBoundaryDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'auto-mode-boundary-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.permission.mode !== 'auto') return;

    const toolName = context.toolCall.name;
    if (toolName.startsWith('mcp__')) {
      return deny('external_capability', 'Auto blocked an MCP action. Review it or restart explicitly with YOLO.');
    }
    const toolInfo = this.agent.tools?.data().find((tool) => tool.name === toolName);
    if (toolInfo?.source === 'user') {
      return deny('custom_capability', 'Auto blocked an unclassified custom tool. Review it or restart explicitly with YOLO.');
    }

    if (toolName === 'Bash') {
      const command = typeof context.args === 'object' && context.args !== null
        ? (context.args as Record<string, unknown>)['command']
        : undefined;
      if (typeof command === 'string' && HIGH_RISK_COMMANDS.some((pattern) => pattern.test(command))) {
        return deny('high_risk_command', 'Auto blocked a high-risk command. Review it or restart explicitly with YOLO.');
      }
    }

    const pathClass = this.agent.kaos.pathClass();
    const workspace = {
      workspaceDir: this.agent.config.cwd,
      additionalDirs: this.agent.getAdditionalDirs?.() ?? [],
    };
    const outsideWrite = context.execution.accesses?.find((access) =>
      access.kind === 'file'
      && (access.operation === 'write' || access.operation === 'readwrite')
      && !isWithinWorkspace(access.path, workspace, pathClass),
    );
    if (outsideWrite !== undefined) {
      return deny('outside_workspace_write', 'Auto blocked a write outside the workspace. Review it or restart explicitly with YOLO.');
    }
    return;
  }
}

function deny(category: string, message: string): PermissionPolicyResult {
  return {
    kind: 'deny',
    reason: { category, reason_code: 'permission_required' },
    message,
  };
}
