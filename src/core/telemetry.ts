import type { Command } from 'commander';
import { CLI_VERSION } from './version.js';

const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isCliTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return DISABLE_VALUES.has(String(env.KABLEWY_DISABLE_TELEMETRY || '').trim().toLowerCase());
}

export function commandPathForTelemetry(command: Command | undefined): string | undefined {
  const names: string[] = [];
  let current: Command | undefined = command;
  while (current) {
    const name = current.name();
    if (name) names.unshift(name);
    current = current.parent as Command | undefined;
  }
  if (names[0] === 'kablewy') names.shift();
  return sanitizeTelemetryCommand(names.join('.'));
}

export function sanitizeTelemetryCommand(command: unknown): string | undefined {
  const raw = String(command || '').trim().toLowerCase();
  const value = /\s/.test(raw) ? commandTokensOnly(raw) : raw;
  if (!value) return undefined;
  const sanitized = value
    .replace(/[^a-z0-9_.:-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
  return sanitized || undefined;
}

function commandTokensOnly(value: string): string {
  const tokens: string[] = [];
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    if (tokens.length === 0 && token === 'kablewy') continue;
    if (!/^[a-z0-9][a-z0-9:-]*$/i.test(token)) break;
    tokens.push(token);
    if (tokens.length >= 4) break;
  }
  return tokens.join('.');
}

export function cliTelemetryHeaders(command?: unknown): Record<string, string> {
  if (isCliTelemetryDisabled()) return {};

  const sanitizedCommand = sanitizeTelemetryCommand(command);
  const userAgent = sanitizedCommand
    ? `@kablewy/cli/${CLI_VERSION} (command=${sanitizedCommand})`
    : `@kablewy/cli/${CLI_VERSION}`;

  return {
    'User-Agent': userAgent,
    'X-Kablewy-Client': 'cli',
    'X-Kablewy-CLI-Version': CLI_VERSION,
    ...(sanitizedCommand ? { 'X-Kablewy-CLI-Command': sanitizedCommand } : {})
  };
}
