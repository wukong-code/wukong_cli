import { describe, expect, it } from 'vitest';

import {
  containsSensitiveText,
  redactSensitiveText,
  redactSensitiveValue,
} from '../src';

const SECRET = 'sk_live_wukongPrivacySentinel123456789';

describe('durable diagnostic redaction', () => {
  it('redacts URL userinfo/query, Authorization, env assignments, and token shapes', () => {
    const raw = [
      `https://alice:${SECRET}@example.test/v1?token=${SECRET}&page=2`,
      `Authorization: Bearer ${SECRET}`,
      `OPENAI_API_KEY=${SECRET}`,
      `stderr=${SECRET}`,
    ].join('\n');
    const redacted = redactSensitiveText(raw);

    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain('alice');
    expect(redacted).toContain('page=2');
    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(containsSensitiveText(raw)).toBe(true);
    expect(containsSensitiveText(redacted)).toBe(false);
  });

  it('recursively masks credential keys and diagnostic strings', () => {
    const redacted = redactSensitiveValue({
      headers: { Authorization: `Bearer ${SECRET}` },
      environment: { API_KEY: SECRET, CI: '1' },
      exception: {
        message: `request failed at https://example.test/?secret=${SECRET}`,
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('"CI":"1"');
  });

  it('redacts common cloud, database URL, and bare JWT credential shapes', () => {
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
    const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const databasePassword = 'database-password-sentinel';
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    const raw = [
      `AWS_ACCESS_KEY_ID=${accessKeyId}`,
      `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
      `DATABASE_URL=postgresql://alice:${databasePassword}@db.example.test/app`,
      `redis://default:${databasePassword}@cache.example.test/0`,
      jwt,
    ].join('\n');
    const redacted = redactSensitiveText(raw);

    for (const credential of [
      accessKeyId,
      secretAccessKey,
      databasePassword,
      jwt,
      'alice',
    ]) {
      expect(redacted).not.toContain(credential);
    }
    expect(redacted).toContain('[REDACTED]');
    expect(containsSensitiveText(redacted)).toBe(false);
  });

  it('preserves ordinary token and OAuth failure diagnostics', () => {
    const diagnostic = [
      'access token: fetch failed',
      'refresh_token: refresh failed',
      'OAuth token exchange failed',
      'access token validation timed out',
    ].join('\n');

    expect(redactSensitiveText(diagnostic)).toBe(diagnostic);
    expect(containsSensitiveText(diagnostic)).toBe(false);
  });

  it('redacts quoted JSON and YAML credential keys without formatting-only false positives', () => {
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const password = 'quoted-password-sentinel';
    const json = JSON.stringify({
      AWS_SECRET_ACCESS_KEY: awsSecret,
      nested: { password, DB_PASSWORD: password },
      safe: 'preserved',
    }, null, 2);
    const redactedJson = redactSensitiveText(json);

    expect(redactedJson).not.toContain(awsSecret);
    expect(redactedJson).not.toContain(password);
    expect(redactedJson).toContain('"safe":"preserved"');
    expect(containsSensitiveText(redactedJson)).toBe(false);

    const embedded = [
      `provider stdout: {"AWS_SECRET_ACCESS_KEY":"${awsSecret}"}`,
      `  'password': '${password}'`,
      'access token: fetch failed',
      'OAuth token exchange failed',
    ].join('\n');
    const redactedEmbedded = redactSensitiveText(embedded);
    expect(redactedEmbedded).not.toContain(awsSecret);
    expect(redactedEmbedded).not.toContain(password);
    expect(redactedEmbedded).toContain('access token: fetch failed');
    expect(redactedEmbedded).toContain('OAuth token exchange failed');
    expect(containsSensitiveText(redactedEmbedded)).toBe(false);

    const safeJson = '{\n  "status": "fetch failed",\n  "attempt": 1\n}\n';
    expect(redactSensitiveText(safeJson)).toBe(safeJson);
    expect(containsSensitiveText(safeJson)).toBe(false);
  });
});
