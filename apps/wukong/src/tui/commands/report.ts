import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { UsagePanelComponent } from '../components/messages/usage-panel';
import type { SlashCommandHost } from './dispatch';

const REPORT_FILES = [
  'wukong-verification-report.md',
  'wukong-scan-report.md',
] as const;

interface ReportFile {
  readonly path: string;
  readonly mtime: number;
}

function findLatestReport(cwd: string): ReportFile | undefined {
  let latest: ReportFile | undefined;
  for (const name of REPORT_FILES) {
    const path = join(cwd, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      if (latest === undefined || stats.mtimeMs > latest.mtime) {
        latest = { path, mtime: stats.mtimeMs };
      }
    } catch {
      // ignore missing files
    }
  }
  return latest;
}

function parseStatusToken(content: string): 'success' | 'warning' | 'error' {
  const match = /Status:\s*(passed|warning|failed)/i.exec(content);
  if (match?.[1] === 'failed') return 'error';
  if (match?.[1] === 'warning') return 'warning';
  return 'success';
}

function formatReportLines(content: string): readonly string[] {
  return content.split(/\r?\n/);
}

export async function handleReportSlashCommand(host: SlashCommandHost): Promise<void> {
  const cwd = host.state.appState.workDir;
  const latest = findLatestReport(cwd);
  if (latest === undefined) {
    host.showError('No verification or scan report found in the workspace.');
    return;
  }

  let content: string;
  try {
    content = readFileSync(latest.path, 'utf8');
  } catch (error) {
    host.showError(`Could not read report: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const title = latest.path.includes('verification') ? ' Verification Report ' : ' Risk Scan Report ';
  const panel = new UsagePanelComponent(
    () => formatReportLines(content),
    parseStatusToken(content),
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}
