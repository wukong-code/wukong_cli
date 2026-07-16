import { describe, it, expect } from 'vitest';
import {
  buildVerificationUploadPayload,
  buildScanUploadPayload,
  buildProofUploadPayload,
  redactMarkdown,
  ReportTooLargeError,
} from '../src/redaction';
import type { VerificationResult, ScanResult, ProofResult } from '../src/types';

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    status: 'passed',
    cwd: '/home/user/my-project',
    generatedAt: new Date().toISOString(),
    changedFiles: [{ path: 'src/index.ts', status: 'M' }],
    gitStatus: 'On branch main\nYour branch is up to date with \'origin/main\'.',
    diffStat: ' src/index.ts | 1 +',
    selectedCommands: ['pnpm test'],
    commandResults: [
      {
        command: 'pnpm test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1200,
        stdout: 'test output with ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        stderr: '',
      },
    ],
    risks: [
      {
        id: 'placeholder',
        severity: 'medium',
        message: 'Placeholder detected',
        file: 'src/index.ts',
        line: 10,
        evidence: 'TODO: implement secret token sk-1234567890abcdef',
      },
    ],
    ...overrides,
  };
}

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    status: 'warning',
    cwd: '/home/user/my-project',
    generatedAt: new Date().toISOString(),
    changedFiles: [{ path: 'src/index.ts', status: 'M' }],
    gitStatus: 'On branch main',
    diffStat: ' src/index.ts | 1 +',
    risks: [
      {
        id: 'secret_file',
        severity: 'high',
        message: 'Secret file changed',
        file: '.env.local',
        evidence: 'api_key=super_secret_value_here',
      },
    ],
    ...overrides,
  };
}

describe('redactMarkdown', () => {
  it('replaces GitHub PATs', () => {
    const text = 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(redactMarkdown(text)).toBe('token [REDACTED_GH_TOKEN]');
  });

  it('replaces generic api keys', () => {
    const text = 'api_key=1234567890abcdef1234567890abcdef';
    expect(redactMarkdown(text)).toContain('[REDACTED]');
  });

  it('replaces private key blocks', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    expect(redactMarkdown(text)).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('replaces bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactMarkdown(text)).toContain('Bearer [REDACTED]');
  });
});

describe('buildVerificationUploadPayload', () => {
  it('redacts command stdout/stderr and secrets', () => {
    const result = makeVerificationResult();
    const payload = buildVerificationUploadPayload(result, '# Report\n\nSome stdout: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(payload.type).toBe('verify');
    expect(payload.status).toBe('passed');
    expect(payload.report_markdown).not.toContain('ghp_');
    expect(payload.high_risks).toBe(0);
    expect(payload.medium_risks).toBe(1);
    expect(payload.commands_run).toBe(1);
    expect(payload.failed_commands).toBe(0);
  });

  it('redacts sensitive file paths', () => {
    const result = makeVerificationResult({
      changedFiles: [{ path: '.env.local', status: 'M' }],
    });
    const payload = buildVerificationUploadPayload(result, '# Report');

    expect(payload.report_markdown).toBe('# Report');
  });

  it('throws when report markdown is too large', () => {
    const result = makeVerificationResult();
    const hugeMarkdown = 'x'.repeat(600 * 1024);
    expect(() => buildVerificationUploadPayload(result, hugeMarkdown)).toThrow(ReportTooLargeError);
  });
});

describe('buildScanUploadPayload', () => {
  it('redacts scan risks and secrets', () => {
    const result = makeScanResult();
    const payload = buildScanUploadPayload(result, '# Scan\n\nRisk evidence: api_key=secret1234567890abcdef');

    expect(payload.type).toBe('scan');
    expect(payload.status).toBe('warning');
    expect(payload.report_markdown).not.toContain('secret1234567890abcdef');
    expect(payload.high_risks).toBe(1);
    expect(payload.commands_run).toBe(0);
  });
});

describe('buildProofUploadPayload', () => {
  it('combines verification and scan redaction', () => {
    const proof: ProofResult = {
      status: 'blocked',
      cwd: '/home/user/my-project',
      generatedAt: new Date().toISOString(),
      verification: makeVerificationResult(),
      scan: makeScanResult(),
      summary: 'blocked',
      recommendation: 'fix it',
      reasonCode: 'check_failed',
      snapshotId: 'snapshot-id',
      workspaceFingerprint: {
        inputDigest: 'input-digest',
        configDigest: 'config-digest',
      },
      blockers: [],
    };

    const payload = buildProofUploadPayload(proof, '# Proof\n\nToken: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(payload.type).toBe('proof');
    expect(payload.status).toBe('blocked');
    expect(payload.report_markdown).not.toContain('ghp_');
    expect(payload.risks_found).toBe(2);
  });
});
