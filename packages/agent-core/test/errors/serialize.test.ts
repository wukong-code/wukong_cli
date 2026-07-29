import { APIStatusError } from '@wukong/kosong';
import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '#/errors';
import {
  makeErrorPayload,
  toWukongErrorPayload,
} from '#/errors/serialize';

const NGINX_413_HTML =
  '413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
  '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('toWukongErrorPayload — APIStatusError message sanitization', () => {
  it('extracts the <title> from an nginx 413 HTML body and strips CR', () => {
    const payload = toWukongErrorPayload(new APIStatusError(413, NGINX_413_HTML));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.message).toBe('413 Request Entity Too Large');
    expect(payload.details).toMatchObject({ statusCode: 413 });
  });

  it('extracts the <title> from other nginx HTML error pages', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n' +
      '<body><center><h1>502 Bad Gateway</h1></center></body></html>';
    const payload = toWukongErrorPayload(new APIStatusError(502, html));
    expect(payload.message).toBe('502 Bad Gateway');
  });

  it('leaves a plain-text message unchanged', () => {
    const payload = toWukongErrorPayload(new APIStatusError(500, 'Internal Server Error'));
    expect(payload.message).toBe('Internal Server Error');
  });

  it('strips carriage returns from a non-HTML message', () => {
    const payload = toWukongErrorPayload(new APIStatusError(500, 'line1\r\nline2\r'));
    expect(payload.message).toBe('line1\nline2');
  });

  it('falls back to the original message when the <title> is empty', () => {
    const html = '<html><head><title>   </title></head><body>x</body></html>';
    const payload = toWukongErrorPayload(new APIStatusError(500, html));
    expect(payload.message).toContain('<html>');
  });

  it('does not affect 429 / 401 code mapping, only the message', () => {
    const html = '<html><head><title>429 Too Many Requests</title></head></html>';
    expect(toWukongErrorPayload(new APIStatusError(429, html)).code).toBe('provider.rate_limit');
    expect(toWukongErrorPayload(new APIStatusError(401, 'Unauthorized')).code).toBe(
      'provider.auth_error',
    );
  });

  it('redacts synthetic credentials before crash/error payloads cross the wire', () => {
    const secret = 'sk_live_wukongPrivacySentinel123456789';
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const message = [
      `provider failed at https://alice:${secret}@example.test/v1?token=${secret}`,
      `Authorization: Bearer ${secret}`,
      `OPENAI_API_KEY=${secret}`,
      `provider json: {"AWS_SECRET_ACCESS_KEY":"${awsSecret}"}`,
    ].join('\n');
    const fromException = toWukongErrorPayload(new Error(message));
    const synthetic = makeErrorPayload(
      ErrorCodes.INTERNAL,
      message,
      {
        details: {
          headers: { Authorization: `Bearer ${secret}` },
          environment: { API_KEY: secret, CI: '1' },
        },
      },
    );

    for (const payload of [fromException, synthetic]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(awsSecret);
      expect(serialized).not.toContain('alice');
      expect(serialized).toContain('[REDACTED]');
    }
    expect(synthetic.details).toMatchObject({
      headers: { Authorization: '[REDACTED]' },
      environment: { API_KEY: '[REDACTED]', CI: '1' },
    });
  });
});
