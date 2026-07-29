const REDACTED = '[REDACTED]';
const MAX_REDACTION_DEPTH = 12;

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'apisecret',
  'accesskeyid',
  'accesstoken',
  'accountkey',
  'authtoken',
  'awsaccesskeyid',
  'awssecretaccesskey',
  'awssessiontoken',
  'bearer',
  'clientsecret',
  'connectionstring',
  'cookie',
  'credential',
  'credentials',
  'databaseurl',
  'idtoken',
  'mongodburi',
  'mysqlpwd',
  'mysqlurl',
  'password',
  'passwd',
  'pgpassword',
  'postgresqlurl',
  'postgresurl',
  'privatekey',
  'pwd',
  'redisurl',
  'refreshtoken',
  'sastoken',
  'secret',
  'secretaccesskey',
  'setcookie',
  'token',
]);

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu;
const AUTHORIZATION_VALUE =
  /\b(authorization)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu;
const COOKIE_VALUE =
  /\b(cookie|set-cookie)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/giu;
const SECRET_ASSIGNMENT =
  /\b((?:[A-Za-z_][A-Za-z0-9_.-]*[_-])?(?:api[_-]?key|api[_-]?secret|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|account[_-]?key|connection[_-]?string|database[_-]?url|postgres(?:ql)?[_-]?url|mysql[_-]?(?:url|pwd)|mongodb[_-]?uri|redis[_-]?url|pgpassword|password|passwd|pwd|secret|credential|token))\s*([:=])\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;&#]+))/giu;
const QUOTED_SECRET_ASSIGNMENT =
  /(["'])((?:[A-Za-z_][A-Za-z0-9_.-]*[_-])?(?:api[_-]?key|api[_-]?secret|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|account[_-]?key|connection[_-]?string|database[_-]?url|postgres(?:ql)?[_-]?url|mysql[_-]?(?:url|pwd)|mongodb[_-]?uri|redis[_-]?url|pgpassword|password|passwd|pwd|secret|credential|token))\1(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}\]]+)/giu;
const TOKEN_SHAPE =
  /\b(?:(?:sk|rk|ghp|github_pat|glpat|npm|pypi|xox[baprs])[-_][A-Za-z0-9_-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})\b/giu;
const JWT_SHAPE =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/giu;
const CREDENTIAL_URL =
  /\b(?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s<>"'`]+/giu;
const SENSITIVE_QUERY_KEY =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|pwd|secret|signature|credential|cookie)/iu;
const SENSITIVE_KEY_SUFFIX =
  /(?:^|[_\-.])(?:api[_-]?key|api[_-]?secret|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|account[_-]?key|connection[_-]?string|database[_-]?url|postgres(?:ql)?[_-]?url|mysql[_-]?(?:url|pwd)|mongodb[_-]?uri|redis[_-]?url|pgpassword|password|passwd|pwd|secret|credential|token)$/iu;

/**
 * Redacts credential-shaped diagnostic text before it can cross a durable,
 * wire, log, or public-summary boundary. This is deliberately deterministic:
 * callers may safely digest the returned value.
 */
export function redactSensitiveText(value: string): string {
  const structured = redactJsonDocument(value);
  if (structured !== undefined) return structured;
  return value
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(CREDENTIAL_URL, redactUrl)
    .replace(AUTHORIZATION_VALUE, '$1: [REDACTED]')
    .replace(COOKIE_VALUE, '$1: [REDACTED]')
    .replace(
      QUOTED_SECRET_ASSIGNMENT,
      (_match, quote: string, key: string, separator: string) =>
        `${quote}${key}${quote}${separator}${quote}${REDACTED}${quote}`,
    )
    .replace(
      SECRET_ASSIGNMENT,
      (match, key: string, separator: string, doubleQuoted: string | undefined,
        singleQuoted: string | undefined, bare: string | undefined) => {
        const assignedValue = doubleQuoted ?? singleQuoted ?? bare ?? '';
        if (separator === ':' && isDiagnosticTokenStatus(assignedValue)) {
          return match;
        }
        return `${key}=[REDACTED]`;
      },
    )
    .replace(TOKEN_SHAPE, REDACTED)
    .replace(JWT_SHAPE, REDACTED);
}

export function containsSensitiveText(value: string): boolean {
  return redactSensitiveText(value) !== value;
}

/**
 * Applies the same string redactor recursively and masks values whose object
 * key is itself credential-bearing. Only JSON-like diagnostic payloads should
 * be passed here; class instances intentionally collapse to their enumerable
 * fields.
 */
export function redactSensitiveValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return walk(value, 0, seen);
}

function walk(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toJSON();
  if (depth >= MAX_REDACTION_DEPTH) return '[REDACTED:depth]';
  if (seen.has(value)) return '[REDACTED:cycle]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, depth + 1, seen));
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : walk(entry, depth + 1, seen);
  }
  return output;
}

function isDiagnosticTokenStatus(value: string): boolean {
  return /^(?:fetch|refresh|request|exchange|validation)\b/iu.test(value);
}

function redactJsonDocument(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !(trimmed.startsWith('{') && trimmed.endsWith('}'))
    && !(trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const serialized = JSON.stringify(parsed);
  const redacted = JSON.stringify(redactSensitiveValue(parsed));
  if (redacted === serialized) return value;
  const start = value.indexOf(trimmed);
  return `${value.slice(0, start)}${redacted}${value.slice(start + trimmed.length)}`;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_\-.]/gu, '');
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(normalizeKey(key))) return true;
  const segmented = key.replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2');
  return SENSITIVE_KEY_SUFFIX.test(segmented);
}

function redactUrl(rawMatch: string): string {
  const { candidate, suffix } = splitTrailingPunctuation(rawMatch);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return rawMatch;
  }
  let changed = false;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    parsed.username = REDACTED;
    parsed.password = '';
    changed = true;
  }
  for (const [key, current] of parsed.searchParams.entries()) {
    const next = SENSITIVE_QUERY_KEY.test(key)
      ? REDACTED
      : redactSensitiveText(current);
    if (next !== current) {
      parsed.searchParams.set(key, next);
      changed = true;
    }
  }
  if (parsed.hash.length > 1) {
    const fragment = parsed.hash.slice(1);
    const redacted = redactSensitiveText(fragment);
    if (redacted !== fragment) {
      parsed.hash = REDACTED;
      changed = true;
    }
  }
  if (!changed) return rawMatch;
  return `${parsed.toString()}${suffix}`;
}

function splitTrailingPunctuation(value: string): {
  readonly candidate: string;
  readonly suffix: string;
} {
  const match = /[),.;!?]+$/u.exec(value);
  if (match === null) return { candidate: value, suffix: '' };
  return {
    candidate: value.slice(0, -match[0].length),
    suffix: match[0],
  };
}
