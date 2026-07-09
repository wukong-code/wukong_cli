import {
  runJudge,
  runProof,
  runScan,
  runVerification,
  getGuardStats,
  getGuardStatus,
} from '@wukong/verification';
import type { JudgeResult, ProofResult, ScanResult, VerificationResult } from '@wukong/verification';

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
    // Match CLI stats: only hard failures count as failed; warning stays passed.
    host.state.chromeState.recordVerify(
      result.status === 'failed' ? 'failed' : 'passed',
      summarizeVerification(result),
    );
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
    host.state.chromeState.recordScan(result.status === 'failed' ? 'failed' : 'passed');
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

export async function handleProofSlashCommand(host: SlashCommandHost): Promise<void> {
  const spinner = host.showProgressSpinner('Running Wukong merge proof...');
  try {
    const result = await runProof({
      cwd: host.state.appState.workDir,
      writeReport: true,
    });
    spinner.stop({ ok: result.status !== 'blocked', label: `Merge proof: ${result.status}` });
    host.state.chromeState.recordProof(
      result.status === 'blocked' ? 'blocked' : 'pass',
      result.recommendation,
    );
    const panel = new UsagePanelComponent(
      () => buildProofReportLines(result),
      result.status === 'blocked' ? 'error' : 'success',
      ' Merge Proof ',
    );
    host.state.transcriptContainer.addChild(panel);
    host.state.ui.requestRender();
  } catch (error) {
    spinner.stop({ ok: false, label: 'Merge proof failed' });
    host.showError(`Merge proof failed: ${formatErrorMessage(error)}`);
  }
}

export async function handleJudgeSlashCommand(host: SlashCommandHost): Promise<void> {
  const spinner = host.showProgressSpinner('Running Wukong judge...');
  try {
    const result = await runJudge({
      cwd: host.state.appState.workDir,
    });
    spinner.stop({ ok: result.verdict !== 'block', label: `Judge: ${result.verdict}` });
    // Judge must not write proof stats — that would pollute today.proof / Proof track.
    const panel = new UsagePanelComponent(
      () => buildJudgeReportLines(result),
      result.verdict === 'block' ? 'error' : 'success',
      ' Judge ',
    );
    host.state.transcriptContainer.addChild(panel);
    host.state.ui.requestRender();
  } catch (error) {
    spinner.stop({ ok: false, label: 'Judge failed' });
    host.showError(`Judge failed: ${formatErrorMessage(error)}`);
  }
}

function buildJudgeReportLines(result: JudgeResult): string[] {
  return [
    `Verdict: ${result.verdict}`,
    `Mode: ${result.mode}`,
    `Proof status: ${result.proof.status}`,
    `Changed files: ${String(result.proof.verification.changedFiles.length)}`,
    '',
    'Reason:',
    `  ${result.reason}`,
  ];
}

function buildProofReportLines(result: ProofResult): string[] {
  const lines: string[] = [
    `Status: ${result.status}`,
    `Verification: ${result.verification.status}`,
    `Scan: ${result.scan.status}`,
    `Changed files: ${String(result.verification.changedFiles.length)}`,
    '',
    'Recommendation:',
    `  ${result.recommendation}`,
  ];

  if (result.verification.commandResults.length > 0) {
    lines.push('', 'Commands:');
    for (const commandResult of result.verification.commandResults) {
      lines.push(
        `  ${commandResult.status.padEnd(7)} ${commandResult.command} (exit ${String(commandResult.exitCode ?? 'N/A')})`,
      );
    }
  }

  const allRisks = [...result.verification.risks, ...result.scan.risks];
  if (allRisks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of allRisks) {
      const location = risk.file === undefined ? '' : ` (${risk.file}${risk.line === undefined ? '' : `:${String(risk.line)}`})`;
      lines.push(`  ${risk.severity.padEnd(7)} ${risk.message}${location}`);
    }
  }

  if (result.reportPath !== undefined) {
    lines.push('', `Report: ${result.reportPath}`);
  }

  return lines;
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

function summarizeVerification(result: VerificationResult): string | undefined {
  const failedCommands = result.commandResults.filter((c) => c.status !== 'passed');
  if (failedCommands.length > 0) {
    return `${String(failedCommands.length)} command${failedCommands.length === 1 ? '' : 's'} failed`;
  }
  if (result.risks.length > 0) {
    const high = result.risks.filter((r) => r.severity === 'high').length;
    return high > 0 ? `${String(high)} high risk${high === 1 ? '' : 's'}` : `${String(result.risks.length)} risk${result.risks.length === 1 ? '' : 's'}`;
  }
  return undefined;
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
