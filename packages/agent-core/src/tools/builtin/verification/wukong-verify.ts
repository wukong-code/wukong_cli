/**
 * WukongVerifyTool — deterministic verification for AI agents.
 *
 * Lets an external agent (Claude Code, Cursor, Codex, etc.) call Wukong
 * verification after it has modified code, before claiming the task is done.
 * The tool returns a structured result so the agent can decide whether to
 * continue, fix, or ask the user.
 *
 * Implementation reuses `@wukong/verification` so CLI, TUI slash commands,
 * and agent tool all share the same deterministic core.
 */

import {
  runVerification,
  type VerificationResult,
  type VerificationCommandResult,
  type VerificationRisk,
} from '@wukong/verification';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import WUKONG_VERIFY_DESCRIPTION from './wukong-verify.md?raw';

export const WukongVerifyInputSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe('Working directory to verify. Defaults to the session working directory.'),
  commands: z
    .array(z.string())
    .optional()
    .describe('Explicit verification commands to run. When omitted, Wukong auto-detects lint/typecheck/test scripts.'),
  includeBuild: z
    .boolean()
    .optional()
    .describe('Include the package build script when auto-detecting commands.'),
  writeReport: z
    .boolean()
    .optional()
    .describe('Write a Markdown evidence report to the workspace. Defaults to true.'),
  reportPath: z
    .string()
    .optional()
    .describe('Custom path for the Markdown evidence report.'),
  timeoutSeconds: z
    .number()
    .positive()
    .optional()
    .describe('Per-command timeout in seconds.'),
  strict: z
    .boolean()
    .optional()
    .describe('Treat any risk as a failed verification.'),
});

export type WukongVerifyInput = z.infer<typeof WukongVerifyInputSchema>;

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;

export class WukongVerifyTool implements BuiltinTool<WukongVerifyInput> {
  readonly name = 'wukong_verify' as const;
  readonly description: string = WUKONG_VERIFY_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WukongVerifyInputSchema);

  constructor(private readonly sessionCwd: string) {}

  resolveExecution(args: WukongVerifyInput): ToolExecution {
    const cwd = args.cwd ?? this.sessionCwd;
    const preview = `verify ${cwd}`;
    return {
      description: `Wukong verification: ${preview}`,
      display: {
        kind: 'command',
        command: 'wukong verify',
        cwd,
        description: 'Deterministic verification of workspace changes',
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, cwd),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, cwd),
      execute: ({ signal }) => this.execution(args, signal),
    };
  }

  private async execution(
    args: WukongVerifyInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Verification aborted before it started.' };
    }

    const timeoutSeconds = clampTimeout(args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);

    try {
      const result = await runVerification({
        cwd: args.cwd ?? this.sessionCwd,
        commands: args.commands,
        includeBuild: args.includeBuild,
        writeReport: args.writeReport === false ? false : undefined,
        reportPath: args.reportPath,
        timeoutMs: timeoutSeconds * 1000,
        strict: args.strict,
      });

      return formatVerificationResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, output: `Verification failed: ${message}` };
    }
  }
}

function clampTimeout(seconds: number): number {
  return Math.min(Math.max(1, seconds), MAX_TIMEOUT_SECONDS);
}

function formatVerificationResult(result: VerificationResult): ExecutableToolResult {
  const builder = new ToolResultBuilder();
  const passedCommands = result.commandResults.filter((r: VerificationCommandResult) => r.status === 'passed');
  const failedCommands = result.commandResults.filter((r: VerificationCommandResult) => r.status === 'failed');
  const highRisks = result.risks.filter((r: VerificationRisk) => r.severity === 'high');
  const summary = {
    status: result.status,
    cwd: result.cwd,
    changedFiles: result.changedFiles.length,
    commandsRun: result.commandResults.length,
    failedCommands: failedCommands.length,
    risksFound: result.risks.length,
    highRisks: highRisks.length,
    reportPath: result.reportPath,
  };

  builder.write(`Status: ${result.status}\n`);
  builder.write(`Changed files: ${String(summary.changedFiles)}\n`);
  builder.write(`Commands run: ${String(summary.commandsRun)} (passed: ${String(passedCommands.length)}, failed: ${String(failedCommands.length)})\n`);
  builder.write(`Risks found: ${String(summary.risksFound)} (high: ${String(summary.highRisks)})\n`);

  if (result.commandResults.length > 0) {
    builder.write('\nCommands:\n');
    for (const commandResult of result.commandResults) {
      builder.write(`  ${commandResult.status.padEnd(7)} ${commandResult.command} (exit ${String(commandResult.exitCode ?? 'N/A')}, ${String(commandResult.durationMs)}ms)\n`);
    }
  }

  if (result.risks.length > 0) {
    builder.write('\nRisks:\n');
    for (const risk of result.risks) {
      const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
      builder.write(`  ${risk.severity.padEnd(7)} ${risk.message}${location}\n`);
    }
  }

  if (result.reportPath !== undefined) {
    builder.write(`\nReport: ${result.reportPath}\n`);
  }

  const agentMustNotClaimDone =
    result.status === 'failed' ||
    (result.status === 'warning' && result.risks.some((r: VerificationRisk) => r.severity === 'high'));

  if (agentMustNotClaimDone) {
    builder.write('\nDo not claim the task is done until the verification is clean.\n');
  }

  const message = agentMustNotClaimDone
    ? 'Verification found problems. Fix them before finishing.'
    : result.status === 'warning'
      ? 'Verification passed with warnings. Explain whether the warnings are acceptable.'
      : 'Verification passed.';

  const toolResult = builder.ok(message);
  return {
    ...toolResult,
    output: `${toolResult.output}\n\nstructured_summary:\n${JSON.stringify(summary, null, 2)}`,
  };
}
