import path from 'node:path';
import { redactSecrets } from './redact.js';

export type ShellRisk = 'read' | 'mutating' | 'dangerous';

export interface ShellCommandClassification {
  command: string;
  risk: ShellRisk;
  reasons: string[];
  blockedByDefault: boolean;
  usesOutsideCwd: boolean;
}

export interface AgentSafetyConfig {
  cwd: string;
  allowDangerousShell: boolean;
  allowOutsideCwd: boolean;
  requireShellApproval: boolean;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  auditLogPath?: string;
}

export interface OutputChunk {
  text: string;
  usedBytes: number;
  truncated: boolean;
}

const READ_ONLY_PATTERNS = [
  /^(pwd|ls|cat|head|tail|wc|rg|grep|find|git\s+status|git\s+diff|git\s+log|git\s+show|npm\s+test|npm\s+run\s+test)\b/i,
];

const MUTATING_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(install|add|remove|update|upgrade|audit\s+fix)\b/i,
  /\b(git)\s+(add|commit|merge|rebase|pull|push|checkout|switch|restore|stash)\b/i,
  /\b(touch|mkdir|mv|cp|rm|tee|truncate)\b/i,
  /\b(sed\s+-i|perl\s+-pi)\b/i,
  /(^|\s)(>|>>)\s*\S+/,
];

const DANGEROUS_PATTERNS = [
  /\bsudo\b/i,
  /\brm\s+-[^\n;|&]*[rf][^\n;|&]*\s+/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\n;|&]*[fd][^\n;|&]*/i,
  /\bchmod\s+(-R|777)\b/i,
  /\bchown\s+-R\b/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
  /\bdd\s+if=/i,
  /\b(mkfs|diskutil|shutdown|reboot)\b/i,
  /:\(\)\s*\{\s*:\|:\s*;\s*\}/,
];

const OUTSIDE_CWD_PATTERNS = [
  /\bcd\s+(\.\.|\/|~)/,
  /(^|\s)\.\.\//,
  /(^|\s)\/(Users|home|private|tmp|var|etc|opt|usr)\//,
];

const TEXT_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/api_[A-Za-z0-9_-]{12,}/g, 'api_***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***'],
  [/\b(Authorization:\s*)[^\n\r]+/gi, '$1***'],
  [/\b(Cookie:\s*)[^\n\r]+/gi, '$1***'],
  [/\b(refresh[_-]?token\s*[:=]\s*)[^\s]+/gi, '$1***'],
  [/\b(session[_-]?token\s*[:=]\s*)[^\s]+/gi, '$1***'],
  [/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----'],
];

export const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_AGENT_MAX_OUTPUT_BYTES = 262_144;

export function defaultAgentAuditLogPath(cwd: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(cwd, '.kablewy', 'agent-sessions', `${stamp}.jsonl`);
}

export function classifyShellCommand(command: string): ShellCommandClassification {
  const trimmed = String(command || '').trim();
  const reasons: string[] = [];
  let risk: ShellRisk = 'read';

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      risk = 'dangerous';
      reasons.push('matches a dangerous shell pattern');
      break;
    }
  }

  if (risk !== 'dangerous') {
    for (const pattern of MUTATING_PATTERNS) {
      if (pattern.test(trimmed)) {
        risk = 'mutating';
        reasons.push('may change local files, dependencies, or git state');
        break;
      }
    }
  }

  if (risk === 'read' && !READ_ONLY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    reasons.push('not recognized as a simple read-only command');
  }

  const usesOutsideCwd = OUTSIDE_CWD_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (usesOutsideCwd) {
    reasons.push('references paths or directory changes outside the working directory');
    if (risk === 'read') risk = 'mutating';
  }

  if (reasons.length === 0) reasons.push('read-only command');

  return {
    command: trimmed,
    risk,
    reasons,
    blockedByDefault: risk === 'dangerous',
    usesOutsideCwd,
  };
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function redactText(value: string): string {
  let out = String(value || '');
  for (const [pattern, replacement] of TEXT_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function takeOutputChunk(chunk: string, usedBytes: number, maxBytes: number): OutputChunk {
  if (maxBytes <= 0) return { text: '', usedBytes, truncated: true };
  const remaining = maxBytes - usedBytes;
  if (remaining <= 0) return { text: '', usedBytes, truncated: true };

  const bytes = Buffer.byteLength(chunk, 'utf8');
  if (bytes <= remaining) {
    return { text: chunk, usedBytes: usedBytes + bytes, truncated: false };
  }

  let text = '';
  let nextBytes = usedBytes;
  for (const char of chunk) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (nextBytes + charBytes > maxBytes) break;
    text += char;
    nextBytes += charBytes;
  }
  return { text, usedBytes: nextBytes, truncated: true };
}

export function redactAuditPayload<T>(payload: T): T {
  const keyed = redactSecrets(payload);
  return redactStringsDeep(keyed);
}

function redactStringsDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactStringsDeep(item)) as T;
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactStringsDeep(raw);
  }
  return out as T;
}
