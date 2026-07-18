import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runVerification } from '../src/verify';
import { gitAdd, makeTempRepo, writeJson, writeRepoFile } from './helpers';

describe('runVerification', () => {
  it('runs explicit commands and returns passed when no high risks are present', async () => {
    const cwd = await makeTempRepo('wukong-verify-pass-');
    const result = await runVerification({
      cwd,
      commands: ['node -e "process.exit(0)"'],
      writeReport: false,
    });

    expect(result.status).toBe('passed');
    expect(result.selectedCommands).toEqual(['node -e "process.exit(0)"']);
    expect(result.commandResults[0]?.status).toBe('passed');
  });

  it('detects package scripts when commands are not explicit', async () => {
    const cwd = await makeTempRepo('wukong-verify-scripts-');
    await writeJson(join(cwd, 'package.json'), {
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    });

    const result = await runVerification({ cwd, writeReport: false });

    expect(result.selectedCommands).toEqual(['npm run typecheck', 'npm run test']);
    expect(result.commandResults.map((command) => command.status)).toEqual(['passed', 'passed']);
  });

  it('fails when a verification command fails', async () => {
    const cwd = await makeTempRepo('wukong-verify-fail-');
    const result = await runVerification({
      cwd,
      commands: ['node -e "process.exit(7)"'],
      writeReport: false,
    });

    expect(result.status).toBe('failed');
    expect(result.commandResults[0]?.exitCode).toBe(7);
  });

  it('fails with a high risk when no verification commands are detected', async () => {
    const cwd = await makeTempRepo('wukong-verify-nocmd-');

    const result = await runVerification({ cwd, writeReport: false });

    expect(result.status).toBe('failed');
    expect(result.selectedCommands).toEqual([]);
    expect(result.risks).toContainEqual(
      expect.objectContaining({ id: 'commands.none_detected', severity: 'high' }),
    );
  });

  it('keeps diff risks visible without reporting passing project checks as failed', async () => {
    const cwd = await makeTempRepo('wukong-verify-risk-warning-');
    await writeRepoFile(cwd, 'src/feature.ts', '// TODO: replace before delivery\n');
    await gitAdd(cwd);

    const result = await runVerification({
      cwd,
      commands: ['node -e "process.exit(0)"'],
      writeReport: false,
    });

    expect(result.status).toBe('warning');
    expect(result.commandResults[0]?.status).toBe('passed');
    expect(result.risks).toContainEqual(expect.objectContaining({
      id: 'diff.placeholder_added',
      severity: 'high',
    }));
  });

  it('marks slow commands as timed_out and fails the run', async () => {
    const cwd = await makeTempRepo('wukong-verify-timeout-');

    const result = await runVerification({
      cwd,
      commands: ['node -e "setTimeout(() => {}, 10000)"'],
      timeoutMs: 300,
      writeReport: false,
    });

    expect(result.status).toBe('failed');
    expect(result.commandResults[0]?.status).toBe('timed_out');
  });

  it('distinguishes a missing project tool from a failed check', async () => {
    const cwd = await makeTempRepo('wukong-verify-unavailable-');

    const result = await runVerification({
      cwd,
      commands: ['wukong-tool-that-does-not-exist --check'],
      writeReport: false,
    });

    expect(result.status).toBe('failed');
    expect(result.commandResults[0]?.status).toBe('unavailable');
  });

  it('escalates warnings to failed in strict mode', async () => {
    const makeWarningRepo = async (): Promise<string> => {
      const cwd = await makeTempRepo(`wukong-verify-strict-${Math.random().toString(36).slice(2, 8)}-`);
      // Source change without test change is a medium risk => warning by default.
      await writeRepoFile(cwd, 'src/feature.ts', 'export const feature = () => 1;\n');
      await gitAdd(cwd);
      return cwd;
    };

    const relaxed = await runVerification({
      cwd: await makeWarningRepo(),
      commands: ['node -e "process.exit(0)"'],
      writeReport: false,
    });
    expect(relaxed.status).toBe('warning');

    const strict = await runVerification({
      cwd: await makeWarningRepo(),
      commands: ['node -e "process.exit(0)"'],
      strict: true,
      writeReport: false,
    });
    expect(strict.status).toBe('failed');
  });

  it('writes a markdown report by default', async () => {
    const cwd = await makeTempRepo('wukong-verify-report-');
    const result = await runVerification({
      cwd,
      commands: ['node -e "process.exit(0)"'],
    });

    expect(result.reportPath).toBe(join(cwd, 'wukong-verification-report.md'));
    expect(result.report).toContain('# Wukong Verification Report');
  });

  it('honors a custom nested report path', async () => {
    const cwd = await makeTempRepo('wukong-verify-report-path-');
    const result = await runVerification({
      cwd,
      commands: ['node -e "process.exit(0)"'],
      reportPath: 'reports/evidence.md',
    });

    expect(result.reportPath).toBe(join(cwd, 'reports', 'evidence.md'));
    expect(existsSync(join(cwd, 'reports', 'evidence.md'))).toBe(true);
  });
});
