export interface ParseDurationResult {
  readonly kind: 'ok';
  readonly ms: number;
}

export interface ParseDurationError {
  readonly kind: 'error';
  readonly message: string;
}

const UNITS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

const MIN_INTERVAL_MS = 60_000;

/**
 * Parse a simple duration string into milliseconds.
 *
 * Supported: `<n>s`, `<n>m`, `<n>h`, `<n>d` where n is a positive integer.
 * The cron scheduler resolves to the next minute, so the minimum returned
 * value is 60 seconds.
 */
export function parseLoopDuration(raw: string): ParseDurationResult | ParseDurationError {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: 'error', message: 'Duration cannot be empty.' };
  }
  const match = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (match === null) {
    return {
      kind: 'error',
      message: `Invalid duration "${trimmed}". Use <n>s, <n>m, <n>h, or <n>d (e.g. 5m, 1h).`,
    };
  }
  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const ms = value * UNITS[unit]!;
  if (!Number.isFinite(ms) || ms <= 0) {
    return { kind: 'error', message: 'Duration must be positive.' };
  }
  return { kind: 'ok', ms: Math.max(MIN_INTERVAL_MS, ms) };
}
