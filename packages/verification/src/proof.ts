import { resolve } from 'node:path';

import { inspectGit } from './git';
import { renderMergeProofReport, writeReport } from './report';
import { runScan } from './scan';
import { statusFrom } from './status';
import type { ScanResult, VerificationResult } from './types';
import { runVerification } from './verify';

export type ProofStatus = 'passed' | 'blocked';

export interface ProofOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly strict?: boolean;
  readonly writeReport?: boolean;
  readonly reportPath?: string;
}

export interface ProofResult {
  readonly status: ProofStatus;
  readonly cwd: string;
  readonly generatedAt: string;
  readonly verification: VerificationResult;
  readonly scan: ScanResult;
  readonly summary: string;
  readonly recommendation: string;
  readonly reportPath?: string;
  readonly report?: string;
}

export async function runProof(options: ProofOptions = {}): Promise<ProofResult> {
  const cwd = resolve(options.cwd ?? process.cwd());

  const [verification, scan] = await Promise.all([
    runVerification({ cwd, commands: options.commands, writeReport: false }),
    runScan({ cwd, writeReport: false }),
  ]);

  const status = proofStatusFrom(verification, scan, options.strict === true);
  const recommendation = buildRecommendation(verification, scan, status);
  const summary = buildSummary(verification, scan, status);

  const base: Omit<ProofResult, 'report' | 'reportPath'> = {
    status,
    cwd,
    generatedAt: new Date().toISOString(),
    verification,
    scan,
    summary,
    recommendation,
  };

  if (options.writeReport === false) return base;

  const git = await inspectGit(cwd);
  const report = renderMergeProofReport({ ...base, git });
  const reportPath = await writeReport(options.reportPath ?? 'wukong-proof-report.md', report, cwd);
  return { ...base, reportPath, report };
}

function proofStatusFrom(
  verification: VerificationResult,
  scan: ScanResult,
  strict: boolean,
): ProofStatus {
  if (verification.status === 'failed' || scan.status === 'failed') return 'blocked';
  if (strict && (verification.risks.length > 0 || scan.risks.length > 0)) return 'blocked';
  return 'passed';
}

function buildSummary(verification: VerificationResult, scan: ScanResult, status: ProofStatus): string {
  const parts: string[] = [
    `verification ${verification.status}`,
    `scan ${scan.status}`,
    `${String(verification.changedFiles.length)} changed files`,
  ];
  return `Merge proof ${status}: ${parts.join(', ')}.`;
}

function buildRecommendation(
  verification: VerificationResult,
  scan: ScanResult,
  status: ProofStatus,
): string {
  if (status === 'passed') {
    return 'No blockers detected. Ready to merge.';
  }

  const reasons: string[] = [];

  if (verification.commandResults.some((command) => command.status !== 'passed')) {
    reasons.push('verification commands failed; fix failing checks before merging');
  }

  const highRisks = [...verification.risks, ...scan.risks].filter((risk) => risk.severity === 'high');
  if (highRisks.length > 0) {
    reasons.push('high-risk changes detected; review before merging');
  }

  const mediumRisks = [...verification.risks, ...scan.risks].filter(
    (risk) => risk.severity === 'medium',
  );
  if (mediumRisks.length > 0 && reasons.length === 0) {
    reasons.push('medium-risk changes detected; review warnings before merging');
  }

  if (reasons.length === 0) {
    reasons.push('merge blocked by verification policy');
  }

  return `${capitalizeFirst(reasons.join('; '))}.`;
}

function capitalizeFirst(value: string): string {
  if (value.length === 0) return value;
  const first = value.charAt(0);
  return `${first.toUpperCase()}${value.slice(1)}`;
}

