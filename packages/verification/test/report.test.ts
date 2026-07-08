import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderScanReport, renderVerificationReport, writeReport } from '../src/report';
import type { ScanResult, VerificationResult } from '../src/types';
import { makeTempDir } from './helpers';

const verificationBase: Omit<VerificationResult, 'report'> = {
  status: 'failed',
  cwd: '/workspace',
  generatedAt: '2026-07-08T00:00:00.000Z',
  changedFiles: [{ path: 'src/a.ts', status: 'M' }],
  gitStatus: ' M src/a.ts',
  diffStat: ' src/a.ts | 2 +-',
  selectedCommands: ['npm run test'],
  commandResults: [
    { command: 'npm run test', status: 'failed', exitCode: 1, durationMs: 250, stdout: '', stderr: 'boom' },
  ],
  risks: [
    { id: 'diff.placeholder_added', severity: 'high', message: 'Placeholder added.', file: 'src/a.ts', line: 3, evidence: '// TODO' },
    { id: 'coverage.source_without_tests', severity: 'medium', message: 'Source without tests.' },
  ],
};

describe('renderVerificationReport', () => {
  it('renders status, commands, and risks with locations', () => {
    const report = renderVerificationReport(verificationBase);

    expect(report).toContain('# Wukong Verification Report');
    expect(report).toContain('- Status: failed');
    expect(report).toContain('- Changed files: 1');
    expect(report).toContain('- failed: `npm run test` (exit 1, 250ms)');
    expect(report).toContain('- high: Placeholder added. (src/a.ts:3) — // TODO');
    expect(report).toContain('- medium: Source without tests.');
    expect(report).toContain(' M src/a.ts');
  });

  it('renders empty-state markers for clean runs', () => {
    const report = renderVerificationReport({
      ...verificationBase,
      status: 'passed',
      selectedCommands: [],
      commandResults: [],
      risks: [],
      gitStatus: '',
      diffStat: '',
    });

    expect(report).toContain('No commands selected.');
    expect(report).toContain('No risks found.');
    expect(report).toContain('(clean or unavailable)');
    expect(report).toContain('(no diff stat)');
  });
});

describe('renderScanReport', () => {
  it('renders scan status and risks', () => {
    const scan: Omit<ScanResult, 'report'> = {
      status: 'warning',
      cwd: '/workspace',
      generatedAt: '2026-07-08T00:00:00.000Z',
      changedFiles: [],
      gitStatus: '',
      diffStat: '',
      risks: [{ id: 'coverage.source_without_tests', severity: 'medium', message: 'Source without tests.' }],
    };

    const report = renderScanReport(scan);

    expect(report).toContain('# Wukong Risk Scan Report');
    expect(report).toContain('- Status: warning');
    expect(report).toContain('- medium: Source without tests.');
  });
});

describe('writeReport', () => {
  it('creates missing parent directories and resolves relative paths against cwd', async () => {
    const cwd = await makeTempDir('wukong-report-write-');

    const resolved = await writeReport('reports/nested/evidence.md', '# report body', cwd);

    expect(resolved).toBe(join(cwd, 'reports', 'nested', 'evidence.md'));
    expect(existsSync(resolved)).toBe(true);
    await expect(readFile(resolved, 'utf8')).resolves.toBe('# report body');
  });
});
