import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runVerification } from '../src/verify';
import { makeTempRepo, writeJson } from './helpers';

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

  it('writes a markdown report by default', async () => {
    const cwd = await makeTempRepo('wukong-verify-report-');
    const result = await runVerification({
      cwd,
      commands: ['node -e "process.exit(0)"'],
    });

    expect(result.reportPath).toBe(join(cwd, 'wukong-verification-report.md'));
    expect(result.report).toContain('# Wukong Verification Report');
  });
});
