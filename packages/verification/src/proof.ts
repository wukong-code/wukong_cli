import { resolve } from 'node:path';

import { renderMergeProofReport, writeReport } from './report';
import { runScan } from './scan';
import { selectVerificationCommands } from './scripts';
import { createWorkspaceSnapshot, workspaceSnapshotMatches } from './snapshot';
import type {
  ScanResult,
  VerificationCommand,
  VerificationResult,
  VerificationRisk,
  WorkspaceSnapshot,
} from './types';
import { runVerification } from './verify';

export type ProofStatus = 'passed' | 'blocked';

export interface ProofOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  /** Exact frozen selection. An empty array intentionally means no commands. */
  readonly selectedCommands?: readonly VerificationCommand[];
  readonly retryOnWorkspaceChange?: boolean;
  readonly strict?: boolean;
  readonly writeReport?: boolean;
  readonly reportPath?: string;
  readonly signal?: AbortSignal;
}

export interface ProofResult {
  readonly status: ProofStatus;
  readonly cwd: string;
  readonly generatedAt: string;
  readonly verification: VerificationResult;
  readonly scan: ScanResult;
  readonly summary: string;
  readonly recommendation: string;
  readonly reasonCode: string;
  readonly snapshotId: string;
  readonly workspaceFingerprint: {
    readonly headSha?: string;
    readonly inputDigest: string;
    readonly configDigest: string;
  };
  readonly blockers: readonly ProofBlocker[];
  readonly reportPath?: string;
  readonly report?: string;
}

export interface ProofBlocker {
  readonly id: string;
  readonly kind: 'check' | 'risk' | 'workspace' | 'review';
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
  readonly command?: string;
  readonly evidence?: string;
  readonly nextAction: string;
}

export class WorkspaceChangedError extends Error {
  readonly code = 'workspace_changed';

  constructor() {
    super('Workspace changed while the delivery gate was running twice; no conclusion was produced.');
    this.name = 'WorkspaceChangedError';
  }
}

export async function runProof(options: ProofOptions = {}): Promise<ProofResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  let attempt = await runProofAttempt(cwd, options);
  if (!workspaceSnapshotMatches(attempt.snapshot, attempt.after)) {
    if (options.retryOnWorkspaceChange === false) throw new WorkspaceChangedError();
    attempt = await runProofAttempt(cwd, options);
    if (!workspaceSnapshotMatches(attempt.snapshot, attempt.after)) {
      throw new WorkspaceChangedError();
    }
  }

  const { snapshot, rawVerification, scan } = attempt;
  const verification: VerificationResult = isDocsOnlyMissingChecks(rawVerification)
    ? {
        ...rawVerification,
        status: 'warning',
        risks: rawVerification.risks.filter((risk) => risk.id !== 'commands.none_detected'),
      }
    : rawVerification;

  const status = proofStatusFrom(verification, scan, options.strict === true);
  const blockers = buildBlockers(verification, scan, status, options.strict === true);
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
    reasonCode: reasonCodeFrom(status, blockers),
    snapshotId: snapshot.id,
    workspaceFingerprint: {
      headSha: snapshot.headSha,
      inputDigest: snapshot.inputDigest,
      configDigest: snapshot.configDigest,
    },
    blockers,
  };

  if (options.writeReport === false) return base;

  const report = renderMergeProofReport({ ...base, git: snapshot.git });
  const reportPath = await writeReport(options.reportPath ?? 'wukong-proof-report.md', report, cwd);
  return { ...base, reportPath, report };
}

async function runProofAttempt(cwd: string, options: ProofOptions): Promise<{
  readonly snapshot: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly rawVerification: VerificationResult;
  readonly scan: ScanResult;
}> {
  const selectedCommands = options.selectedCommands === undefined
    ? await selectVerificationCommands({
        cwd,
        commands: options.commands,
      })
    : [...options.selectedCommands];
  const snapshot = await createWorkspaceSnapshot({ cwd, commands: selectedCommands });
  const rawVerification = await runVerification({
    cwd,
    selectedCommands,
    snapshot,
    writeReport: false,
    signal: options.signal,
  });
  const scan = await runScan({ cwd, snapshot, writeReport: false });
  const after = await createWorkspaceSnapshot({ cwd, commands: selectedCommands });
  return { snapshot, after, rawVerification, scan };
}

function proofStatusFrom(
  verification: VerificationResult,
  scan: ScanResult,
  strict: boolean,
): ProofStatus {
  if (scan.status === 'failed') return 'blocked';
  if (verification.status === 'failed' && !isDocsOnlyMissingChecks(verification)) return 'blocked';
  if (hasUnverifiedSourceChanges(verification)) return 'blocked';
  if (strict && (verification.risks.length > 0 || scan.risks.length > 0)) return 'blocked';
  return 'passed';
}

function isDocsOnlyMissingChecks(verification: VerificationResult): boolean {
  return verification.selectedCommands.length === 0
    && verification.commandResults.length === 0
    && !verification.changedFiles.some((file) => SOURCE_CHANGE_PATTERN.test(file.path))
    && verification.risks.length > 0
    && verification.risks.every((risk) => risk.id === 'commands.none_detected');
}

const SOURCE_CHANGE_PATTERN = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|vue|svelte)$/i;

function hasUnverifiedSourceChanges(verification: VerificationResult): boolean {
  return verification.selectedCommands.length === 0
    && verification.changedFiles.some((file) => SOURCE_CHANGE_PATTERN.test(file.path));
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

  if (hasUnverifiedSourceChanges(verification)) {
    reasons.push('source code changed but no project checks were discovered; add or configure a verification command');
  }

  const risks = combineRisks(verification, scan);
  const highRisks = risks.filter((risk) => risk.severity === 'high');
  if (highRisks.length > 0) {
    const first = highRisks[0]!;
    const location = first.file === undefined
      ? ''
      : ` (${first.file}${first.line === undefined ? '' : `:${String(first.line)}`})`;
    const remaining = highRisks.length > 1 ? `; ${String(highRisks.length - 1)} more` : '';
    reasons.push(`high-risk finding: ${first.message}${location}${remaining}; review before merging`);
  }

  const mediumRisks = risks.filter((risk) => risk.severity === 'medium');
  if (mediumRisks.length > 0 && reasons.length === 0) {
    reasons.push('medium-risk changes detected; review warnings before merging');
  }

  if (reasons.length === 0) {
    reasons.push('merge blocked by verification policy');
  }

  return `${capitalizeFirst(reasons.join('; '))}.`;
}

function buildBlockers(
  verification: VerificationResult,
  scan: ScanResult,
  status: ProofStatus,
  strict: boolean,
): ProofBlocker[] {
  if (status === 'passed') return [];
  const blockers: ProofBlocker[] = [];
  for (const result of verification.commandResults) {
    if (result.status === 'passed') continue;
    const timedOut = result.status === 'timed_out';
    const unavailable = result.status === 'unavailable';
    blockers.push({
      id: timedOut ? 'check_timed_out' : unavailable ? 'check_unavailable' : 'check_failed',
      kind: 'check',
      summary: `${result.command} ${timedOut ? 'timed out' : unavailable ? 'is unavailable' : 'failed'}.`,
      command: result.command,
      evidence: truncateEvidence(result.stderr || result.stdout),
      nextAction: unavailable
        ? `Install the required tool for ${result.command}, or configure .wukong/checks.json with an available command.`
        : `Run ${result.command} and fix the reported failure.`,
    });
  }
  if (hasUnverifiedSourceChanges(verification)) {
    const file = verification.changedFiles.find((changed) => SOURCE_CHANGE_PATTERN.test(changed.path))?.path;
    blockers.push({
      id: 'checks_missing',
      kind: 'workspace',
      summary: 'Source code changed but no project checks were discovered.',
      file,
      nextAction: 'Add a project test/typecheck script or configure .wukong/checks.json.',
    });
  }
  const risks = combineRisks(verification, scan)
    .filter((risk) => risk.severity === 'high' || strict)
    .slice(0, 20 - blockers.length);
  for (const risk of risks) {
    blockers.push({
      id: risk.id,
      kind: 'risk',
      summary: risk.message,
      file: risk.file,
      line: risk.line,
      evidence: risk.evidence === undefined ? undefined : truncateEvidence(risk.evidence),
      nextAction: risk.file === undefined
        ? 'Review and resolve this risk before delivery.'
        : `Review and resolve the risk in ${risk.file}.`,
    });
  }
  if (blockers.length === 0) {
    blockers.push({
      id: 'verification_policy',
      kind: 'workspace',
      summary: 'The delivery gate was blocked by verification policy.',
      nextAction: 'Inspect the verification warnings and configure an explicit project gate.',
    });
  }
  return blockers.slice(0, 20);
}

function combineRisks(
  verification: VerificationResult,
  scan: ScanResult,
): VerificationRisk[] {
  const seen = new Set<string>();
  return [...verification.risks, ...scan.risks].filter((risk) => {
    const key = `${risk.id}:${risk.file ?? ''}:${risk.line ?? ''}:${risk.evidence ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reasonCodeFrom(status: ProofStatus, blockers: readonly ProofBlocker[]): string {
  if (status === 'passed') return 'passed';
  return blockers[0]?.id ?? 'verification_policy';
}

function truncateEvidence(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= 500) return trimmed;
  return `${trimmed.slice(0, 245)}\n...[evidence truncated]...\n${trimmed.slice(-225)}`;
}

function capitalizeFirst(value: string): string {
  if (value.length === 0) return value;
  const first = value.charAt(0);
  return `${first.toUpperCase()}${value.slice(1)}`;
}
