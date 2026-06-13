export const SCOPED_API_KEY_PREFIX = 'api_';

export function normalizeApiKey(value: unknown): string {
  return String(value || '').trim();
}

export function isScopedApiKey(value: unknown): boolean {
  return normalizeApiKey(value).startsWith(SCOPED_API_KEY_PREFIX);
}

export function scopedApiKeyErrorMessage(source = 'API key'): string {
  return `${source} must be a scoped Kablewy API key starting with "api_". Run \`kablewy login\` to mint one; browser or desktop session tokens are only used during login.`;
}
