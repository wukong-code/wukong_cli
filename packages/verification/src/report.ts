import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ScanResult, VerificationResult } from './types';

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
