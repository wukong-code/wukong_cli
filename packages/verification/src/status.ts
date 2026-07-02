import type { RiskSeverity, VerificationCommandResult, VerificationRisk, VerificationStatus } from './types';

export function statusFrom(
  risks: readonly VerificationRisk[],
  commandResults: readonly VerificationCommandResult[],
  strict = false,
): VerificationStatus {
  if (commandResults.some((result) => result.status !== 'passed')) return 'failed';
  if (risks.some((risk) => risk.severity === 'high')) return 'failed';
  if (strict && risks.length > 0) return 'failed';
  if (risks.length > 0) return 'warning';
  return 'passed';
}

export function highestSeverity(risks: readonly VerificationRisk[]): RiskSeverity | undefined {
  if (risks.some((risk) => risk.severity === 'high')) return 'high';
  if (risks.some((risk) => risk.severity === 'medium')) return 'medium';
  if (risks.some((risk) => risk.severity === 'low')) return 'low';
  return undefined;
}
