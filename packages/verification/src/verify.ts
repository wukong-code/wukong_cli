import { resolve } from 'node:path';

import { inspectGit } from './git';
import { renderVerificationReport, writeReport } from './report';
import { runVerificationCommands } from './runner';
import { scanRisks } from './risks';
import { selectVerificationCommands } from './scripts';
import { statusFrom } from './status';
import type { VerificationOptions, VerificationResult } from './types';

export async function runVerification(options: VerificationOptions = {}): Promise<VerificationResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const selected = options.selectedCommands ?? await selectVerificationCommands({
    cwd,
    commands: options.commands,
    includeBuild: options.includeBuild,
  });
  const git = options.snapshot?.git ?? await inspectGit(cwd);
  const commandResults = await runVerificationCommands(selected, {
    cwd,
    timeoutMs: options.timeoutMs,
  });
  const selectedCommands = selected.map((command) => command.command);
  const risks = scanRisks({
    git,
    selectedCommands,
    includeCommandRisks: true,
  });
  const base = {
    status: statusFrom(risks, commandResults, options.strict === true),
    cwd,
    generatedAt: new Date().toISOString(),
    changedFiles: git.changedFiles,
    gitStatus: git.statusText,
    diffStat: git.diffStat,
    selectedCommands,
    commandResults,
    risks,
  } satisfies Omit<VerificationResult, 'report' | 'reportPath'>;

  if (options.writeReport === false) return base;

  const report = renderVerificationReport(base);
  const reportPath = await writeReport(options.reportPath ?? 'wukong-verification-report.md', report, cwd);
  return { ...base, reportPath, report };
}
