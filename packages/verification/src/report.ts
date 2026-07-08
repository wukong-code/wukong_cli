import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { GitInspection, ScanResult, VerificationResult } from './types';

export interface MergeProofReportData {
  readonly status: 'passed' | 'blocked';
  readonly cwd: string;
  readonly generatedAt: string;
  readonly verification: VerificationResult;
  readonly scan: ScanResult;
  readonly summary: string;
  readonly recommendation: string;
  readonly git: GitInspection;
}

export function renderVerificationReport(result: Omit<VerificationResult, 'report'>): string {
  return [
    '# Wukong Verification Report',
    '',
    `- Status: ${result.status}`,
    `- Generated at: ${result.generatedAt}`,
    `- Workspace: ${result.cwd}`,
    `- Changed files: ${String(result.changedFiles.length)}`,
    '',
    '## Commands',
    '',
    ...renderCommands(result),
    '',
    '## Risks',
    '',
    ...renderRisks(result.risks),
    '',
    '## Git Status',
    '',
    '```text',
    result.gitStatus || '(clean or unavailable)',
    '```',
    '',
    '## Diff Stat',
    '',
    '```text',
    result.diffStat || '(no diff stat)',
    '```',
    '',
  ].join('\n');
}

export function renderScanReport(result: Omit<ScanResult, 'report'>): string {
  return [
    '# Wukong Risk Scan Report',
    '',
    `- Status: ${result.status}`,
    `- Generated at: ${result.generatedAt}`,
    `- Workspace: ${result.cwd}`,
    `- Changed files: ${String(result.changedFiles.length)}`,
    '',
    '## Risks',
    '',
    ...renderRisks(result.risks),
    '',
    '## Git Status',
    '',
    '```text',
    result.gitStatus || '(clean or unavailable)',
    '```',
    '',
    '## Diff Stat',
    '',
    '```text',
    result.diffStat || '(no diff stat)',
    '```',
    '',
  ].join('\n');
}

export function renderMergeProofReport(data: MergeProofReportData): string {
  const verification = data.verification;
  const scan = data.scan;
  return [
    '# Wukong Merge Proof Report',
    '',
    `- Status: ${data.status}`,
    `- Generated at: ${data.generatedAt}`,
    `- Workspace: ${data.cwd}`,
    `- Changed files: ${String(data.git.changedFiles.length)}`,
    '',
    '## Summary',
    '',
    data.summary,
    '',
    '## Recommendation',
    '',
    data.recommendation,
    '',
    '## Verification',
    '',
    `- Status: ${verification.status}`,
    `- Commands: ${String(verification.commandResults.length)}`,
    ...formatCommandResults(verification.commandResults),
    '',
    '## Risk Scan',
    '',
    `- Status: ${scan.status}`,
    `- Risks: ${String(scan.risks.length)}`,
    ...renderRisks(scan.risks),
    '',
    '## Git Status',
    '',
    '```text',
    data.git.statusText || '(clean or unavailable)',
    '```',
    '',
    '## Diff Stat',
    '',
    '```text',
    data.git.diffStat || '(no diff stat)',
    '```',
    '',
  ].join('\n');
}

function formatCommandResults(results: VerificationResult['commandResults']): string[] {
  if (results.length === 0) return [];
  return [
    '',
    '### Command Results',
    '',
    ...results.map((command) => {
      const exit = command.exitCode === null ? 'null' : String(command.exitCode);
      return `- ${command.status}: \`${command.command}\` (exit ${exit}, ${String(command.durationMs)}ms)`;
    }),
  ];
}

export async function writeReport(path: string, content: string, cwd: string): Promise<string> {
  const resolved = resolve(cwd, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
  return resolved;
}

function renderCommands(result: Omit<VerificationResult, 'report'>): string[] {
  if (result.selectedCommands.length === 0) return ['No commands selected.'];
  return result.commandResults.map((command) => {
    const exit = command.exitCode === null ? 'null' : String(command.exitCode);
    return `- ${command.status}: \`${command.command}\` (exit ${exit}, ${String(command.durationMs)}ms)`;
  });
}

function renderRisks(risks: VerificationResult['risks']): string[] {
  if (risks.length === 0) return ['No risks found.'];
  return risks.map((risk) => {
    const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
    return `- ${risk.severity}: ${risk.message}${location}${risk.evidence === undefined ? '' : ` — ${risk.evidence}`}`;
  });
}
