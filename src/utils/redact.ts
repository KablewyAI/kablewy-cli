const SECRET_KEY_PATTERN = /(authorization|cookie|api[-_]?key|secret|token|password|passwd|bearer|refresh)/i;

export function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value) return value;
  if (value.length <= 8) return '***';
  return `***${value.slice(-4)}`;
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? maskSecret(raw) : redactSecrets(raw);
  }
  return out as T;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

