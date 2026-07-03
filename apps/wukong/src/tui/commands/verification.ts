import {
  runScan,
  runVerification,
  getGuardStats,
  getGuardStatus,
} from '@wukong/verification';
import type { ScanResult, VerificationResult } from '@wukong/verification';

import { UsagePanelComponent } from '../components/messages/usage-panel';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { handleReportSlashCommand } from './report';

export { handleReportSlashCommand };

export async function handleVerifySlashCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const spinner = host.showProgressSpinner('Running Wukong verification...');
  try {
    const result = await runVerification({
      cwd: host.state.appState.workDir,
      writeReport: true,
    });
    spinner.stop({ ok: result.status !== 'failed', label: `Verification: ${result.status}` });
    const panel = new UsagePanelComponent(
      () => buildVerificationReportLines(result),
      result.status === 'failed' ? 'error' : result.status === 'warning' ? 'warning' : 'success',
      ' Verification ',
    );
    host.state.transcriptContainer.addChild(panel);
    host.state.ui.requestRender();
  } catch (error) {
    spinner.stop({ ok: false, label: 'Verification failed' });
    host.showError(`Verification failed: ${formatErrorMessage(error)}`);
  }
}

export async function handleScanSlashCommand(host: SlashCommandHost): Promise<void> {
  const spinner = host.showProgressSpinner('Running Wukong risk scan...');
  try {
    const result = await runScan({
      cwd: host.state.appState.workDir,
      writeReport: true,
    });
    spinner.stop({ ok: result.status !== 'failed', label: `Risk scan: ${result.status}` });
    const panel = new UsagePanelComponent(
      () => buildScanReportLines(result),
      result.status === 'failed' ? 'error' : result.status === 'warning' ? 'warning' : 'success',
      ' Risk Scan ',
    );
    host.state.transcriptContainer.addChild(panel);
    host.state.ui.requestRender();
  } catch (error) {
    spinner.stop({ ok: false, label: 'Risk scan failed' });
    host.showError(`Risk scan failed: ${formatErrorMessage(error)}`);
  }
}

export async function handleGuardSlashCommand(host: SlashCommandHost, args: string): Promise<void> {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === 'status' || trimmed === '') {
    try {
      const status = await getGuardStatus({ cwd: host.state.appState.workDir });
      const stats = await getGuardStats({ cwd: host.state.appState.workDir });
      host.showStatus(
        `Guard ${status.enabled ? 'enabled' : 'disabled'} · ${String(stats.total)} events · ${String(stats.blocked)} blocked · ${String(stats.allowed)} allowed`,
      );
    } catch (error) {
      host.showError(`Guard status failed: ${formatErrorMessage(error)}`);
    }
    return;
  }

  host.showError('Usage: /guard [status]');
}

function buildVerificationReportLines(result: VerificationResult): string[] {
  const lines: string[] = [
    `Status: ${result.status}`,
    `Changed files: ${String(result.changedFiles.length)}`,
  ];

  if (result.selectedCommands.length > 0) {
    lines.push('', 'Commands:');
    for (const commandResult of result.commandResults) {
      lines.push(
        `  ${commandResult.status.padEnd(7)} ${commandResult.command} (exit ${String(commandResult.exitCode ?? 'N/A')})`,
      );
    }
  }

  if (result.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of result.risks) {
      const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
      lines.push(`  ${risk.severity.padEnd(7)} ${risk.message}${location}`);
    }
  }

  if (result.reportPath !== undefined) {
    lines.push('', `Report: ${result.reportPath}`);
  }

  return lines;
}

function buildScanReportLines(result: ScanResult): string[] {
  const lines: string[] = [
    `Status: ${result.status}`,
    `Changed files: ${String(result.changedFiles.length)}`,
  ];

  if (result.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of result.risks) {
      const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
      lines.push(`  ${risk.severity.padEnd(7)} ${risk.message}${location}`);
    }
  } else {
    lines.push('', 'No risks found.');
  }

  if (result.reportPath !== undefined) {
    lines.push('', `Report: ${result.reportPath}`);
  }

  return lines;
}
