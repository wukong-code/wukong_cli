import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WukongVerifyInputSchema,
  WukongVerifyTool,
} from '../../src/tools/builtin/verification/wukong-verify';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wukong-verify-tool-'));
  tempDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function outputText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WukongVerifyTool', () => {
  it('exposes model-visible metadata and schema', () => {
    const tool = new WukongVerifyTool('/workspace');

    expect(tool.name).toBe('wukong_verify');
    expect(tool.description).toContain('deterministic checks');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        commands: { type: 'array' },
        strict: { type: 'boolean' },
      },
    });
    expect(WukongVerifyInputSchema.safeParse({ commands: ['npm test'] }).success).toBe(true);
    expect(WukongVerifyInputSchema.safeParse({ timeoutSeconds: -1 }).success).toBe(false);
  });

  it('runs verification and returns a structured summary', async () => {
    const cwd = makeRepo();
    const tool = new WukongVerifyTool(cwd);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_verify',
      args: {
        commands: ['node -e "process.exit(0)"'],
        writeReport: false,
      },
      signal,
    });

    expect(result.isError).not.toBe(true);
    const output = outputText(result.output);
    expect(output).toContain('Status: passed');
    expect(output).toContain('structured_summary:');

    const summary = JSON.parse(output.split('structured_summary:\n')[1] ?? '{}') as {
      status?: string;
      commandsRun?: number;
      failedCommands?: number;
    };
    expect(summary).toMatchObject({
      status: 'passed',
      commandsRun: 1,
      failedCommands: 0,
    });
  });

  it('keeps failed verification visible to the agent', async () => {
    const cwd = makeRepo();
    const tool = new WukongVerifyTool(cwd);

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_verify',
      args: {
        commands: ['node -e "process.exit(1)"'],
        writeReport: false,
      },
      signal,
    });

    expect(result.isError).not.toBe(true);
    const output = outputText(result.output);
    expect(output).toContain('Status: failed');
    expect(output).toContain('Do not claim the task is done until the verification is clean.');
    expect(result.message).toBe('Verification found problems. Fix them before finishing.');
  });
});
