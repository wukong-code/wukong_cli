import { resolve } from 'node:path';

import { runProof } from './proof';
import type { ProofResult } from './proof';
import type { VerificationRisk } from './types';

export type JudgeVerdict = 'pass' | 'block';

export interface JudgeOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly strict?: boolean;
}

export interface JudgeResult {
  readonly verdict: JudgeVerdict;
  readonly reason: string;
  readonly proof: ProofResult;
  readonly mode: 'deterministic';
}

export async function runJudge(options: JudgeOptions = {}): Promise<JudgeResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const proof = await runProof({ cwd, commands: options.commands, writeReport: false });

  const { verdict, reason } = deterministicVerdict(proof, {
    strict: options.strict === true,
  });

  return {
    verdict,
    reason,
    proof,
    mode: 'deterministic',
  };
}

interface VerdictInput {
  readonly strict: boolean;
}

function deterministicVerdict(
  proof: ProofResult,
  input: VerdictInput,
): { readonly verdict: JudgeVerdict; readonly reason: string } {
  const allRisks = [...proof.verification.risks, ...proof.scan.risks];

  if (proof.verification.commandResults.length === 0) {
    return {
      verdict: 'block',
      reason: 'No verification commands were discovered or supplied.',
    };
  }

  if (proof.verification.status === 'failed') {
    const failedCommands = proof.verification.commandResults.some((command) => command.status !== 'passed');
    if (failedCommands) {
      return {
        verdict: 'block',
        reason: 'Verification commands failed.',
      };
    }
    return {
      verdict: 'block',
      reason: 'High-risk changes detected.',
    };
  }

  if (allRisks.some((risk) => risk.severity === 'high')) {
    return {
      verdict: 'block',
      reason: 'High-risk changes detected.',
    };
  }

  if (input.strict && allRisks.length > 0) {
    return {
      verdict: 'block',
      reason: `Strict mode: ${formatRiskCount(allRisks)} must be resolved.`,
    };
  }

  const mediumRisks = allRisks.filter((risk) => risk.severity === 'medium');
  if (mediumRisks.length > 0) {
    return {
      verdict: 'pass',
      reason: `${formatRiskCount(mediumRisks)}; review warnings before merging.`,
    };
  }

  if (allRisks.length > 0) {
    return {
      verdict: 'pass',
      reason: `${formatRiskCount(allRisks)}; review warnings before merging.`,
    };
  }

  return {
    verdict: 'pass',
    reason: 'No blockers detected.',
  };
}

function formatRiskCount(risks: readonly VerificationRisk[]): string {
  const grouped = new Map<VerificationRisk['severity'], number>();
  for (const risk of risks) {
    grouped.set(risk.severity, (grouped.get(risk.severity) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const severity of ['high', 'medium', 'low'] as const) {
    const count = grouped.get(severity);
    if (count !== undefined) {
      parts.push(`${String(count)} ${severity}`);
    }
  }
  return `${parts.join(', ')} risk${risks.length === 1 ? '' : 's'}`;
}
