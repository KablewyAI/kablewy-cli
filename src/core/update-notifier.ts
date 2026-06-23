import chalk from 'chalk';
import { CLI_VERSION } from './version.js';

const NPM_LATEST_URL = 'https://registry.npmjs.org/@kablewy/cli/latest';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 750;

interface UpdateConfig {
  get(key: 'updateCheckLastAt'): string | undefined;
  set(key: 'updateCheckLastAt', value: string): void;
}

interface UpdateCommandLike {
  opts(): Record<string, unknown>;
  parent?: UpdateCommandLike | null;
}

export interface UpdateNoticeOptions {
  command?: UpdateCommandLike;
  now?: Date;
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  stdoutIsTTY?: boolean;
}

export async function maybeShowUpdateNotice(config: UpdateConfig, options: UpdateNoticeOptions = {}): Promise<void> {
  if (!shouldCheckForUpdates(config, options)) return;

  const now = options.now ?? new Date();
  try {
    config.set('updateCheckLastAt', now.toISOString());
  } catch {
    // A read-only or corrupt config file should never break the user's command.
  }

  try {
    const latest = await fetchLatestVersion(options.fetchImpl ?? fetch);
    const current = options.currentVersion ?? CLI_VERSION;
    if (!latest || compareSemver(latest, current) <= 0) return;

    console.error(chalk.yellow(`Update available: @kablewy/cli ${current} -> ${latest}`));
    console.error(chalk.gray('Run: npm install -g @kablewy/cli@latest'));
  } catch {
    // Update checks are advisory only.
  }
}

export function shouldCheckForUpdates(config: UpdateConfig, options: UpdateNoticeOptions = {}): boolean {
  if (process.env.KABLEWY_DISABLE_UPDATE_CHECK === '1') return false;
  if (process.env.KABLEWY_DISABLE_UPDATE_CHECK === 'true') return false;
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  const isTty = options.stdoutIsTTY ?? process.stdout.isTTY;
  if (isTty !== true) return false;
  if (commandRequestedJson(options.command)) return false;

  const last = config.get('updateCheckLastAt');
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const nowMs = (options.now ?? new Date()).getTime();
  return nowMs - lastMs >= UPDATE_CHECK_INTERVAL_MS;
}

export function commandRequestedJson(command: UpdateCommandLike | undefined): boolean {
  let cursor: UpdateCommandLike | undefined | null = command;
  while (cursor) {
    if (cursor.opts()?.json === true) return true;
    cursor = cursor.parent;
  }
  return false;
}

export async function fetchLatestVersion(fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(NPM_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { version?: unknown } | null;
    return typeof body?.version === 'string' ? body.version : null;
  } finally {
    clearTimeout(timeout);
  }
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i] - right[i];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  ];
}
