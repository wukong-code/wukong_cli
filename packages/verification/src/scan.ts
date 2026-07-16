import { resolve } from 'node:path';

import { inspectGit } from './git';
import { renderScanReport, writeReport } from './report';
import { scanRisks } from './risks';
import { statusFrom } from './status';
import type { ScanOptions, ScanResult } from './types';

export async function runScan(options: ScanOptions = {}): Promise<ScanResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const git = options.snapshot?.git ?? await inspectGit(cwd);
  const risks = scanRisks({ git, includeCommandRisks: false });
  const base = {
    status: statusFrom(risks, [], false),
    cwd,
    generatedAt: new Date().toISOString(),
    changedFiles: git.changedFiles,
    gitStatus: git.statusText,
    diffStat: git.diffStat,
    risks,
  } satisfies Omit<ScanResult, 'report' | 'reportPath'>;

  if (options.writeReport !== true) return base;

  const report = renderScanReport(base);
  const reportPath = await writeReport(options.reportPath ?? 'wukong-scan-report.md', report, cwd);
  return { ...base, reportPath, report };
}
