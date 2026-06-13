import { Command } from 'commander';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { CommandContext } from '../types/index.js';

/**
 * `kablewy login` — get a scoped API key without ever pasting one.
 *
 * Primary path: REUSE the Kablewy desktop shell's sign-in. The shell is the
 * connect surface and the robust auth front door (it can also catch the
 * `kablewy://` deep link, which a CLI cannot). It writes a session to
 * `~/.kablewy/session.yaml`; we read it (refreshing if stale) and mint the
 * CLI's `api_` key from that session — no browser, no redirect-page fragility.
 *
 * Fallback path (`--loopback`, or when no shell session exists): port the
 * shell's own loopback magic-link ceremony (auth.rs) directly in the CLI.
 */

const LOOPBACK_TIMEOUT_MS = 120_000;
const SESSION_FILE = join(homedir(), '.kablewy', 'session.yaml');
const REFRESH_MARGIN_MS = 60_000;

// Least-privilege capability template for a CLI/CI key: the resource types the
// deterministic lane touches, with the verbs the routes check. No admin and no wildcard.
// `mcp` is required for the MCP JSON-RPC surface (tools/list, tools/call, chat).
// `mcp-servers` is required for the MCP server management REST surface. `integrations`
// is required for Quick Actions, webhook destinations, and workflow-job triggers.
// `auth` is required for self-service API key list/revoke.
export const CLI_KEY_CAPABILITIES = [
  {
    resources: ['documents', 'skills', 'tools', 'mcp', 'mcp-servers', 'integrations', 'auth'],
    actions: ['read', 'list', 'view', 'search', 'create', 'write', 'update', 'execute', 'delete']
  }
];

interface LoginOptions {
  email?: string;
  apiUrl?: string;
  ttl?: string;
  name?: string;
  json?: boolean;
  loopback?: boolean;
  shell?: boolean;
}

interface ConfigLike {
  get(key: string): unknown;
  set(key: string, value: string): void;
  readonly configPath: string;
}

export function createLoginCommand(context: CommandContext): Command {
  const command = new Command('login');

  command
    .description('Sign in (reuses the Kablewy desktop session) and store a scoped API key')
    .option('--email <email>', 'Email for the browser fallback flow (prompts if omitted)')
    .option('--api-url <url>', 'Kablewy API base URL (overrides config)')
    .option('--ttl <duration>', 'Key lifetime, e.g. 15m, 12h, 30d', '30d')
    .option('--name <label>', 'Label for the minted key')
    .option('--loopback', 'Force the browser magic-link flow (ignore any desktop-shell session)')
    .option('--shell', 'Require reusing the desktop-shell session (do not fall back to the browser flow)')
    .option('--json', 'Output the result as JSON')
    .action(async (options: LoginOptions) => {
      const { output } = context;
      try {
        await handleLogin(options, context);
      } catch (error: unknown) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  return command;
}

async function handleLogin(options: LoginOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = context.config as unknown as ConfigLike;

  const base = String(options.apiUrl || config.get('apiUrl') || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('No API URL configured. Pass --api-url or run `kablewy config --set apiUrl=<url>`.');
  }

  const ttlSeconds = parseTtl(options.ttl ?? '30d');
  if (!ttlSeconds) {
    throw new Error(`Invalid --ttl "${options.ttl}". Use forms like 15m, 12h, 30d.`);
  }

  // Primary path: reuse the desktop-shell session (unless the user forced --loopback).
  if (!options.loopback) {
    const session = loadShellSession();
    if (session) {
      const sessionToken = await resolveSessionToken(base, session, output);
      if (sessionToken) {
        output.info('Reusing your Kablewy desktop sign-in (no browser needed)...');
        await mintAndStore({
          base,
          orgId: session.orgId,
          userId: session.userId,
          sessionToken,
          email: session.email,
          source: 'desktop-shell',
          ttlSeconds,
          options,
          context,
          config
        });
        return;
      }
      if (options.shell) {
        throw new Error('Your Kablewy desktop session has expired. Sign in again via the Kablewy shell, then re-run.');
      }
      output.warning('Desktop-shell session expired; falling back to browser sign-in.');
    } else if (options.shell) {
      throw new Error(
        `No Kablewy desktop session found at ${SESSION_FILE}. Sign in via the Kablewy shell first, or omit --shell to use the browser flow.`
      );
    }
  }

  await loopbackLogin({ base, ttlSeconds, options, context, config });
}

// ---- shell-session reuse -----------------------------------------------------

interface ShellSession {
  orgId: string;
  userId: string;
  sessionToken: string;
  sessionExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  email?: string;
}

/**
 * Read and normalize the desktop shell's `~/.kablewy/session.yaml` (the
 * SessionFile written by kablewy-shell/src-tauri/src/auth.rs). Returns null if
 * absent, unparseable, or missing required fields. Exported for testing.
 */
export function loadShellSession(path: string = SESSION_FILE): ShellSession | null {
  if (!existsSync(path)) return null;
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const user = (d.user && typeof d.user === 'object' ? (d.user as Record<string, unknown>) : {}) as Record<string, unknown>;

  const orgId = asString(d.org_id);
  const userId = asString(d.user_id) || asString(user.id);
  const sessionToken = asString(d.session_token);
  const refreshToken = asString(d.refresh_token);
  if (!orgId || !userId || !sessionToken) return null;

  return {
    orgId,
    userId,
    sessionToken,
    sessionExpiresAt: asMillis(d.session_expires_at),
    refreshToken,
    refreshTokenExpiresAt: asMillis(d.refresh_token_expires_at),
    email: asString(user.email) || undefined
  };
}

/** Return a usable session token (current, or refreshed), or null if neither works. */
async function resolveSessionToken(
  base: string,
  session: ShellSession,
  output: CommandContext['output']
): Promise<string | null> {
  const now = Date.now();
  if (session.sessionExpiresAt > now + REFRESH_MARGIN_MS) {
    return session.sessionToken;
  }
  if (session.refreshTokenExpiresAt > now && session.refreshToken) {
    const refreshed = await refreshSessionToken(base, session.orgId, session.refreshToken);
    if (refreshed) return refreshed;
    output.warning('Could not refresh the desktop-shell session.');
  }
  return null;
}

async function refreshSessionToken(base: string, orgId: string, refreshToken: string): Promise<string | null> {
  try {
    const res = await postJson(`${base}/v1/auth/refresh`, { refreshToken, orgId });
    if (!res.ok) return null;
    const body = res.body as { sessionToken?: string } | undefined;
    return body?.sessionToken ?? null;
  } catch {
    return null;
  }
}

// ---- shared mint + persist ---------------------------------------------------

interface MintArgs {
  base: string;
  orgId: string;
  userId: string;
  sessionToken: string;
  email?: string;
  source: 'desktop-shell' | 'magic-link';
  ttlSeconds: number;
  options: LoginOptions;
  context: CommandContext;
  config: ConfigLike;
}

async function mintAndStore(args: MintArgs): Promise<void> {
  const { base, orgId, userId, sessionToken, email, source, ttlSeconds, options, context, config } = args;
  const { output } = context;

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const keyName = options.name || defaultKeyName(new Date());
  const mint = await postJson(
    `${base}/v1/org/${orgId}/api-keys`,
    buildKeyRequest(userId, keyName, expiresAt),
    { Authorization: `Bearer ${sessionToken}` }
  );
  if (!mint.ok) throw new Error(describeHttp('mint an API key', mint));
  const mintBody = mint.body as { id?: string; keyId?: string; key?: string; prefix?: string; keyPrefix?: string; expiresAt?: string } | undefined;
  const apiKey = mintBody?.key;
  if (!apiKey) throw new Error('The server did not return an API key.');

  // Persist and lock down (conf defaults to 0o666 — chmod the credential file).
  config.set('apiUrl', base);
  config.set('orgId', orgId);
  config.set('userId', userId);
  config.set('apiKey', apiKey);
  config.set('apiKeyId', mintBody?.id || mintBody?.keyId || '');
  config.set('apiKeyPrefix', mintBody?.prefix || mintBody?.keyPrefix || '');
  config.set('apiKeyExpiresAt', mintBody?.expiresAt || expiresAt);
  try {
    chmodSync(config.configPath, 0o600);
  } catch {
    // best-effort; platforms without POSIX perms (Windows) ignore this
  }

  if (options.json) {
    output.json({ success: true, data: { source, email, orgId, userId, expiresAt, keyPrefix: mintBody?.prefix || mintBody?.keyPrefix } });
  } else {
    output.success(`Signed in${email ? ` as ${email}` : ''}`);
    output.info(`Org: ${orgId}`);
    output.info(`Key stored at ${config.configPath} (chmod 600), expires ${expiresAt}`);
    output.info('Note: API keys are not instantly revocable server-side — the short expiry is the kill switch. Re-run `kablewy login` to rotate.');
  }
}

// ---- loopback magic-link fallback -------------------------------------------

interface LoopbackArgs {
  base: string;
  ttlSeconds: number;
  options: LoginOptions;
  context: CommandContext;
  config: ConfigLike;
}

async function loopbackLogin(args: LoopbackArgs): Promise<void> {
  const { base, ttlSeconds, options, context, config } = args;
  const { output, input } = context;

  const email = (options.email || (await input.prompt('Email:'))).trim();
  if (!email) {
    throw new Error('Email is required.');
  }

  const state = randomBytes(32).toString('hex');
  const loopback = await startLoopback(state, LOOPBACK_TIMEOUT_MS);

  try {
    const redirectUrl = `http://127.0.0.1:${loopback.port}/cb?state=${state}`;

    // 1. Request the magic link (desktop branch validates the loopback redirect, emails the link).
    output.info(`Requesting a sign-in link for ${email}...`);
    const ml = await postJson(`${base}/v1/org/magic-links`, { email, clientType: 'desktop', redirectUrl });
    if (!ml.ok) throw new Error(describeHttp('request a magic link', ml));
    const mlBody = ml.body as { orgId?: string } | undefined;
    if (!mlBody?.orgId) {
      throw new Error('No Kablewy account found for that email, or it is not eligible for desktop sign-in.');
    }

    // 2. Wait for the user to click the emailed link; the browser forwards the ml_ token here.
    output.success(`📧 Check your email (${email}) and click the Kablewy sign-in link.`);
    output.info('Waiting for confirmation (2 min)...');
    const callback = await loopback.wait();
    const orgId = callback.orgId || mlBody.orgId;

    // 3. Exchange the ml_ token for a session token.
    const verify = await postJson(`${base}/v1/org/${orgId}/magic-links/verify`, {
      token: callback.token,
      clientType: 'desktop'
    });
    if (!verify.ok) throw new Error(describeHttp('verify the magic link', verify));
    const vBody = verify.body as
      | { mfaRequired?: boolean; sessionToken?: string; userData?: { id?: string } }
      | undefined;
    if (vBody?.mfaRequired) {
      throw new Error(mfaFallbackMessage());
    }
    const sessionToken = vBody?.sessionToken;
    const userId = vBody?.userData?.id;
    if (!sessionToken || !userId) {
      throw new Error('Sign-in response did not include a session token.');
    }

    // 4. Mint a scoped, expiring key (session token authorizes the mint).
    await mintAndStore({
      base,
      orgId,
      userId,
      sessionToken,
      email,
      source: 'magic-link',
      ttlSeconds,
      options,
      context,
      config
    });
  } finally {
    loopback.close();
  }
}

// ---- pure, testable helpers --------------------------------------------------

/** Parse a TTL like "15m", "12h", "30d", or bare seconds. Returns 0 on invalid input. */
export function parseTtl(value: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(String(value).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2] || 's';
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return n * mult;
}

/** Build the POST /api-keys body for a least-privilege CLI key. */
export function buildKeyRequest(userId: string, name: string, expiresAt: string) {
  return {
    userId,
    name,
    capabilities: CLI_KEY_CAPABILITIES,
    expiresAt
  };
}

export function defaultKeyName(now: Date): string {
  return `kablewy-cli ${now.toISOString().slice(0, 10)}`;
}

export function mfaFallbackMessage(): string {
  return 'This account requires MFA. CLI login does not support MFA yet. Use the Kablewy desktop app, then rerun `kablewy login` to reuse that desktop session.';
}

/** Turn a server error envelope ({error:{message}} | {message} | {detail}) into a readable line. */
export function describeHttp(action: string, res: { status: number; body: unknown }): string {
  const b = res.body as Record<string, unknown> | string | undefined;
  let detail = '';
  if (b && typeof b === 'object') {
    const err = b.error as { message?: string } | undefined;
    detail = err?.message || (b.message as string) || (b.detail as string) || JSON.stringify(b);
  } else if (typeof b === 'string') {
    detail = b;
  }
  return `Failed to ${action} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Normalize a YAML datetime (Date from the timestamp schema, or an ISO string) to epoch ms; 0 if invalid. */
function asMillis(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(asString(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

// ---- network + loopback ------------------------------------------------------

interface JsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

async function postJson(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

interface LoopbackCallback {
  token: string;
  orgId: string;
}

interface Loopback {
  port: number;
  wait: () => Promise<LoopbackCallback>;
  close: () => void;
}

/**
 * Bind a single-use loopback listener on 127.0.0.1 (never 0.0.0.0) that serves GET /cb.
 * Resolves once the listener is accepting; `wait()` resolves when a valid (CSRF-matched)
 * callback arrives, or rejects after `timeoutMs`.
 */
function startLoopback(state: string, timeoutMs: number): Promise<Loopback> {
  return new Promise<Loopback>((resolveListener, rejectListener) => {
    let settle!: (cb: LoopbackCallback) => void;
    let fail!: (err: Error) => void;
    const done = new Promise<LoopbackCallback>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const timer = setTimeout(
      () => fail(new Error('Login timed out waiting for the email link (2 min). Re-run `kablewy login`.')),
      timeoutMs
    );

    const server = http.createServer((req, res) => {
      let handled: LoopbackCallback | null = null;
      try {
        const url = new URL(req.url || '', 'http://127.0.0.1');
        if (url.pathname !== '/cb') {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        const token = url.searchParams.get('token') || '';
        const cbState = url.searchParams.get('state') || '';
        const orgId = url.searchParams.get('orgId') || '';
        if (!token || cbState !== state) {
          // Bad/missing params or CSRF mismatch: 400 but keep listening.
          res.writeHead(400, { 'Content-Type': 'text/html' }).end('<p>Invalid sign-in callback. You can close this window.</p>');
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<html><body><p>Signed in. You may close this window.</p><script>setTimeout(function(){window.close()},1500)</script></body></html>');
        handled = { token, orgId };
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
      }
      if (handled) {
        clearTimeout(timer);
        settle(handled);
      }
    });

    server.on('error', rejectListener);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolveListener({
        port,
        wait: () => done,
        close: () => {
          clearTimeout(timer);
          try {
            server.close();
          } catch {
            // ignore
          }
        }
      });
    });
  });
}
