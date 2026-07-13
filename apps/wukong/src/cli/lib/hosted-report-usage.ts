import { getCliAccessToken } from '#/cli/lib/report-upload';

export interface HostedReportUsage {
  readonly tier: string;
  readonly used: number;
  readonly limit: number | 'unlimited';
  readonly dashboardUrl: string;
}

interface HostedUsageResponse {
  readonly hostedReports?: {
    readonly tier?: unknown;
    readonly used?: unknown;
    readonly limit?: unknown;
    readonly dashboardUrl?: unknown;
  };
}

const HOSTED_USAGE_TIMEOUT_MS = 2_000;

function getApiBaseUrl(): string {
  return process.env['WUKONG_API_URL'] ?? 'https://wukong.today';
}

function parseHostedReportUsage(value: HostedUsageResponse['hostedReports']): HostedReportUsage | null {
  if (value === undefined) return null;
  if (typeof value.tier !== 'string' || value.tier.length === 0) return null;
  if (typeof value.used !== 'number' || !Number.isInteger(value.used) || value.used < 0) return null;
  if (value.limit !== 'unlimited' && (typeof value.limit !== 'number' || !Number.isFinite(value.limit) || value.limit < 0)) {
    return null;
  }
  if (typeof value.dashboardUrl !== 'string') return null;
  try {
    const url = new URL(value.dashboardUrl);
    if (url.protocol !== 'https:' || (url.hostname !== 'wukong.today' && !url.hostname.endsWith('.wukong.today'))) {
      return null;
    }
    return {
      tier: value.tier,
      used: value.used,
      limit: value.limit,
      dashboardUrl: url.toString(),
    };
  } catch {
    return null;
  }
}

export async function loadHostedReportUsage(
  fetchImpl: typeof fetch = fetch,
): Promise<HostedReportUsage | null> {
  const token = await getCliAccessToken();
  if (token === null) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, HOSTED_USAGE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${getApiBaseUrl()}/api/v1/usages`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as HostedUsageResponse;
    return parseHostedReportUsage(body.hostedReports);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
