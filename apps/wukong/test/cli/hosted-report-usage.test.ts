import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#/cli/lib/report-upload', () => ({
  getCliAccessToken: vi.fn(),
}));

import { loadHostedReportUsage } from '#/cli/lib/hosted-report-usage';
import { getCliAccessToken } from '#/cli/lib/report-upload';

const mockedGetCliAccessToken = vi.mocked(getCliAccessToken);

describe('loadHostedReportUsage', () => {
  beforeEach(() => {
    mockedGetCliAccessToken.mockReset();
    mockedGetCliAccessToken.mockResolvedValue('token');
  });

  it('returns null without a cached CLI login', async () => {
    mockedGetCliAccessToken.mockResolvedValue(null);
    const fetchImpl = vi.fn();

    await expect(loadHostedReportUsage(fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads a validated hosted-report summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      hostedReports: {
        tier: 'founder',
        used: 7,
        limit: 100,
        dashboardUrl: 'https://wukong.today/dashboard',
      },
    }), { status: 200 }));

    await expect(loadHostedReportUsage(fetchImpl)).resolves.toEqual({
      tier: 'founder',
      used: 7,
      limit: 100,
      dashboardUrl: 'https://wukong.today/dashboard',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://wukong.today/api/v1/usages',
      expect.objectContaining({ headers: { Authorization: 'Bearer token' } }),
    );
  });

  it('fails closed for untrusted dashboard URLs and fails open for network errors', async () => {
    const unsafeResponse = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      hostedReports: {
        tier: 'founder',
        used: 7,
        limit: 100,
        dashboardUrl: 'https://example.com/phishing',
      },
    }), { status: 200 }));

    await expect(loadHostedReportUsage(unsafeResponse)).resolves.toBeNull();
    await expect(loadHostedReportUsage(vi.fn().mockRejectedValue(new Error('offline')))).resolves.toBeNull();
  });
});
