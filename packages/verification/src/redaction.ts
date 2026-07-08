import type { ProofResult } from './proof';
import type { ScanResult, VerificationResult, VerificationRisk, VerificationCommandResult } from './types';

export interface ReportUploadPayload {
  readonly type: 'verify' | 'scan' | 'proof';
  readonly status: 'passed' | 'warning' | 'failed' | 'blocked';
  readonly workspace_cwd: string;
  readonly repo_remote_hash?: string;
  readonly branch?: string;
  readonly commit_sha?: string;
  readonly changed_files_count: number;
  readonly commands_run: number;
  readonly failed_commands: number;
  readonly risks_found: number;
  readonly high_risks: number;
  readonly medium_risks: number;
  readonly low_risks: number;
  readonly report_markdown: string;
  readonly visibility?: 'public' | 'private';
}

export class ReportTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`Redacted report exceeds maximum upload size (${bytes} bytes)`);
    this.name = 'ReportTooLargeError';
  }
}

const MAX_UPLOAD_BYTES = 512 * 1024;

// Patterns that indicate a path or file should be redacted.
const SENSITIVE_PATH_SEGMENTS = [
  '.env',
  '.env.',
  'secret',
  'secrets',
  'private-key',
  'private_key',
  'id_rsa',
  'id_ed25519',
  'token',
  'tokens',
  'api-key',
  'api_key',
  'password',
  'passwd',
  'credential',
  'credentials',
];

// Regexes for secret-like values inside text.
const SECRET_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly replacement: string }> = [
  // Bearer/token strings
  { regex: /bearer\s+[a-zA-Z0-9_\-.]{20,}/gi, replacement: 'Bearer [REDACTED]' },
  // Generic tokens/keys with common prefixes
  { regex: /(sk|pk|api[_-]?key|apikey|token|secret)[=_:]\s*['"]?[a-zA-Z0-9_\-.]{16,}['"]?/gi, replacement: '$1=[REDACTED]' },
  // Private key blocks
  { regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  // AWS-style keys
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
  // GitHub-style PAT
  { regex: /ghp_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
  // Passwords in connection strings
  { regex: /(password|pwd)=([^;\s&]+)/gi, replacement: '$1=[REDACTED]' },
];

/**
 * Redact a markdown report by replacing secret-like strings and command output blocks.
 */
export function redactMarkdown(markdown: string): string {
  let redacted = markdown;

  for (const { regex, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(regex, replacement);
  }

  // Redact code blocks that look like shell command output (heuristic: after a command section)
  redacted = redacted.replaceAll(/(```text\n)([\s\S]*?)(\n```)/g, (_match, opener, content, closer) => {
    const trimmed = content.trim();
    // If it looks like git status/diff or command output, replace with placeholder.
    if (
      trimmed.startsWith('On branch') ||
      trimmed.startsWith('diff --git') ||
      trimmed.startsWith('@@') ||
      trimmed.startsWith('+') ||
      trimmed.startsWith('-') ||
      trimmed.startsWith('index ') ||
      trimmed.includes('stdout') ||
      trimmed.includes('stderr')
    ) {
      return `${opener}[REDACTED_OUTPUT]${closer}`;
    }
    return `${opener}${content}${closer}`;
  });

  return redacted;
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SENSITIVE_PATH_SEGMENTS.some((segment) => lower.includes(segment));
}

function redactPath(path: string): string {
  return isSensitivePath(path) ? '[REDACTED_PATH]' : path;
}

function redactRisk(risk: VerificationRisk): VerificationRisk {
  return {
    ...risk,
    file: risk.file === undefined ? undefined : redactPath(risk.file),
    evidence: risk.evidence === undefined ? undefined : redactMarkdown(risk.evidence),
  };
}

function redactCommandResult(result: VerificationCommandResult): VerificationCommandResult {
  return {
    ...result,
    stdout: '',
    stderr: '',
  };
}

function redactVerificationResult(result: VerificationResult): VerificationResult {
  return {
    ...result,
    gitStatus: '',
    diffStat: '',
    selectedCommands: result.selectedCommands.map(redactPath),
    commandResults: result.commandResults.map(redactCommandResult),
    risks: result.risks.map(redactRisk),
    changedFiles: result.changedFiles.map((file) => ({
      ...file,
      path: redactPath(file.path),
    })),
  };
}

function redactScanResult(result: ScanResult): ScanResult {
  return {
    ...result,
    gitStatus: '',
    diffStat: '',
    risks: result.risks.map(redactRisk),
    changedFiles: result.changedFiles.map((file) => ({
      ...file,
      path: redactPath(file.path),
    })),
  };
}

function redactProofResult(result: ProofResult): ProofResult {
  return {
    ...result,
    verification: redactVerificationResult(result.verification),
    scan: redactScanResult(result.scan),
  };
}

function countSeverities(risks: ReadonlyArray<VerificationRisk>): { high: number; medium: number; low: number } {
  return {
    high: risks.filter((r) => r.severity === 'high').length,
    medium: risks.filter((r) => r.severity === 'medium').length,
    low: risks.filter((r) => r.severity === 'low').length,
  };
}

function statusFromVerification(status: VerificationResult['status']): ReportUploadPayload['status'] {
  return status === 'failed' ? 'failed' : status;
}

function statusFromScan(status: ScanResult['status']): ReportUploadPayload['status'] {
  return status === 'failed' ? 'failed' : status;
}

function statusFromProof(status: ProofResult['status']): ReportUploadPayload['status'] {
  return status === 'blocked' ? 'blocked' : 'passed';
}

function hashRemoteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Simple hash to avoid uploading the actual remote URL.
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.codePointAt(i) ?? 0;
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(16);
}

function detectBranch(gitStatus: string): string | undefined {
  const match = gitStatus.match(/On branch ([^\s\n]+)/);
  return match?.[1];
}

function detectCommitSha(gitStatus: string): string | undefined {
  // Look for a commit SHA mention in git status output, otherwise undefined.
  const match = gitStatus.match(/commit ([a-f0-9]{7,40})/i);
  return match?.[1];
}

function detectRemoteUrl(gitStatus: string): string | undefined {
  const match = gitStatus.match(/origin\s+([^\s]+)/);
  return match?.[1];
}

function assertSize(reportMarkdown: string): void {
  const bytes = new TextEncoder().encode(reportMarkdown).length;
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new ReportTooLargeError(bytes);
  }
}

export function buildVerificationUploadPayload(
  result: VerificationResult,
  markdown: string,
): ReportUploadPayload {
  const redacted = redactVerificationResult(result);
  const counts = countSeverities(redacted.risks);
  const redactedMarkdown = redactMarkdown(markdown);
  assertSize(redactedMarkdown);

  return {
    type: 'verify',
    status: statusFromVerification(redacted.status),
    workspace_cwd: redacted.cwd.split('/').pop() ?? redacted.cwd,
    repo_remote_hash: hashRemoteUrl(detectRemoteUrl(result.gitStatus)),
    branch: detectBranch(result.gitStatus),
    commit_sha: detectCommitSha(result.gitStatus),
    changed_files_count: redacted.changedFiles.length,
    commands_run: redacted.commandResults.length,
    failed_commands: redacted.commandResults.filter((c) => c.status !== 'passed').length,
    risks_found: redacted.risks.length,
    high_risks: counts.high,
    medium_risks: counts.medium,
    low_risks: counts.low,
    report_markdown: redactedMarkdown,
  };
}

export function buildScanUploadPayload(result: ScanResult, markdown: string): ReportUploadPayload {
  const redacted = redactScanResult(result);
  const counts = countSeverities(redacted.risks);
  const redactedMarkdown = redactMarkdown(markdown);
  assertSize(redactedMarkdown);

  return {
    type: 'scan',
    status: statusFromScan(redacted.status),
    workspace_cwd: redacted.cwd.split('/').pop() ?? redacted.cwd,
    repo_remote_hash: hashRemoteUrl(detectRemoteUrl(result.gitStatus)),
    branch: detectBranch(result.gitStatus),
    commit_sha: detectCommitSha(result.gitStatus),
    changed_files_count: redacted.changedFiles.length,
    commands_run: 0,
    failed_commands: 0,
    risks_found: redacted.risks.length,
    high_risks: counts.high,
    medium_risks: counts.medium,
    low_risks: counts.low,
    report_markdown: redactedMarkdown,
  };
}

export function buildProofUploadPayload(result: ProofResult, markdown: string): ReportUploadPayload {
  const redacted = redactProofResult(result);
  const allRisks = [...redacted.verification.risks, ...redacted.scan.risks];
  const counts = countSeverities(allRisks);
  const redactedMarkdown = redactMarkdown(markdown);
  assertSize(redactedMarkdown);

  return {
    type: 'proof',
    status: statusFromProof(redacted.status),
    workspace_cwd: redacted.cwd.split('/').pop() ?? redacted.cwd,
    repo_remote_hash: hashRemoteUrl(detectRemoteUrl(result.verification.gitStatus)),
    branch: detectBranch(result.verification.gitStatus),
    commit_sha: detectCommitSha(result.verification.gitStatus),
    changed_files_count: redacted.verification.changedFiles.length,
    commands_run: redacted.verification.commandResults.length,
    failed_commands: redacted.verification.commandResults.filter((c) => c.status !== 'passed').length,
    risks_found: allRisks.length,
    high_risks: counts.high,
    medium_risks: counts.medium,
    low_risks: counts.low,
    report_markdown: redactedMarkdown,
  };
}
