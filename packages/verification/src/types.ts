export type VerificationStatus = 'passed' | 'warning' | 'failed';
export type RiskSeverity = 'low' | 'medium' | 'high';

export interface ChangedFile {
  readonly path: string;
  readonly status: string;
}

export interface GitInspection {
  readonly cwd: string;
  readonly isRepo: boolean;
  readonly root?: string;
  readonly statusText: string;
  readonly diffText: string;
  readonly diffStat: string;
  readonly changedFiles: readonly ChangedFile[];
}

export interface WorkspaceSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly headSha?: string;
  readonly inputDigest: string;
  readonly configDigest: string;
  readonly planDigest: string;
  readonly git: GitInspection;
}

export interface VerificationRisk {
  readonly id: string;
  readonly severity: RiskSeverity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly evidence?: string;
}

export interface VerificationCommand {
  readonly command: string;
  readonly source:
    | 'explicit'
    | 'package-script'
    | 'workspace-script'
    | 'project-config'
    | 'project-inferred';
  /** Workspace-relative source that gives this command its meaning. */
  readonly sourceLocator?: string;
  /** Exact source definition used to detect command weakening before execution. */
  readonly definition?: string;
}

export interface VerificationCommandResult {
  readonly command: string;
  readonly status: 'passed' | 'failed' | 'timed_out' | 'unavailable';
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationOptions {
  readonly cwd?: string;
  readonly commands?: readonly string[];
  readonly includeBuild?: boolean;
  readonly writeReport?: boolean;
  readonly reportPath?: string;
  readonly timeoutMs?: number;
  readonly strict?: boolean;
  readonly snapshot?: WorkspaceSnapshot;
  readonly selectedCommands?: readonly VerificationCommand[];
  readonly signal?: AbortSignal;
}

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly cwd: string;
  readonly generatedAt: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly gitStatus: string;
  readonly diffStat: string;
  readonly selectedCommands: readonly string[];
  readonly commandResults: readonly VerificationCommandResult[];
  readonly risks: readonly VerificationRisk[];
  readonly reportPath?: string;
  readonly report?: string;
}

export interface ScanOptions {
  readonly cwd?: string;
  readonly diffOnly?: boolean;
  readonly secrets?: boolean;
  readonly writeReport?: boolean;
  readonly reportPath?: string;
  readonly snapshot?: WorkspaceSnapshot;
}

export interface ScanResult {
  readonly status: VerificationStatus;
  readonly cwd: string;
  readonly generatedAt: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly gitStatus: string;
  readonly diffStat: string;
  readonly risks: readonly VerificationRisk[];
  readonly reportPath?: string;
  readonly report?: string;
}

export interface CommandRisk {
  readonly id: string;
  readonly severity: RiskSeverity;
  readonly message: string;
  readonly command: readonly string[];
}

export interface GuardStatus {
  readonly enabled: boolean;
  readonly configPath: string;
  readonly eventsPath: string;
}

export interface GuardStats {
  readonly total: number;
  readonly blocked: number;
  readonly allowed: number;
  readonly lastEventAt?: string;
}

export interface GuardEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly riskId?: string;
  readonly severity?: RiskSeverity;
  readonly action: 'blocked' | 'allowed';
  readonly message: string;
}

export type { ProofResult, ProofOptions } from './proof';
