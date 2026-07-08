import { describe, expect, it } from 'vitest';

import { highestSeverity, statusFrom } from '../src/status';
import type { VerificationCommandResult, VerificationRisk } from '../src/types';

function command(status: VerificationCommandResult['status']): VerificationCommandResult {
  return { command: 'npm test', status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1, stdout: '', stderr: '' };
}

function risk(severity: VerificationRisk['severity']): VerificationRisk {
  return { id: `risk.${severity}`, severity, message: 'test risk' };
}

describe('statusFrom', () => {
  it('returns passed for clean runs', () => {
    expect(statusFrom([], [command('passed')])).toBe('passed');
    expect(statusFrom([], [])).toBe('passed');
  });

  it('fails when any command fails or times out', () => {
    expect(statusFrom([], [command('passed'), command('failed')])).toBe('failed');
    expect(statusFrom([], [command('timed_out')])).toBe('failed');
  });

  it('fails on high risks and warns on lower ones', () => {
    expect(statusFrom([risk('high')], [command('passed')])).toBe('failed');
    expect(statusFrom([risk('medium')], [command('passed')])).toBe('warning');
    expect(statusFrom([risk('low')], [command('passed')])).toBe('warning');
  });

  it('treats any risk as failure in strict mode', () => {
    expect(statusFrom([risk('low')], [command('passed')], true)).toBe('failed');
    expect(statusFrom([], [command('passed')], true)).toBe('passed');
  });
});

describe('highestSeverity', () => {
  it('picks the highest severity present', () => {
    expect(highestSeverity([risk('low'), risk('high'), risk('medium')])).toBe('high');
    expect(highestSeverity([risk('low'), risk('medium')])).toBe('medium');
    expect(highestSeverity([risk('low')])).toBe('low');
    expect(highestSeverity([])).toBeUndefined();
  });
});
