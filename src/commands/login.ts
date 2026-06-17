import { Command } from 'commander';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { CommandContext } from '../types/index.js';
import { isScopedApiKey, scopedApiKeyErrorMessage } from '../core/credentials.js';

/**
 * `kablewy login` — get a scoped API key without ever pasting one.
 *
 * Primary path: REUSE the Kablewy desktop shell's sign-in when present. The
 * shell writes a session to `~/.kablewy/session.yaml`; we read it (refreshing
 * if stale) and mint the CLI's `api_` key from that session.
 *
 * Normal fallback: OAuth 2.0 Authorization Code + PKCE through the user's
 * browser session. The browser handles Kablewy web login, SSO, and MFA; the CLI
 * only receives a one-time authorization code through a loopback callback.
 *
 * Legacy fallback (`--loopback` or `--email`): email magic-link loopback.
 */

const LOOPBACK_TIMEOUT_MS = 120_000;
const OAUTH_TIMEOUT_MS = 120_000;
const SESSION_FILE = join(homedir(), '.kablewy', 'session.yaml');
const REFRESH_MARGIN_MS = 60_000;
const OAUTH_CLIENT_ID = 'kablewy-cli';
const OAUTH_SCOPE = 'cli';
const OAUTH_CALLBACK_PATH = '/oauth/callback';

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
  browser?: boolean;
}

interface ConfigLike {
  get(key: string): unknown;
  set(key: string, value: string): void;
  readonly configPath: string;
}

export function createLoginCommand(context: CommandContext): Command {
  const command = new Command('login');

  command
    .description('Sign in with browser authorization and store a scoped API key')
    .option('--email <email>', 'Email for the legacy magic-link fallback (implies --loopback)')
    .option('--api-url <url>', 'Kablewy API base URL (overrides config)')
    .option('--ttl <duration>', 'Key lifetime, e.g. 15m, 12h, 30d', '30d')
    .option('--name <label>', 'Label for the minted key')
    .option('--loopback', 'Use the legacy email magic-link loopback flow')
    .option('--shell', 'Require reusing the desktop-shell session (do not fall back to the browser flow)')
    .option('--no-browser', 'Print the browser authorization URL instead of opening it automatically')
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

  const base = trimTrailingSlashes(String(options.apiUrl || config.get('apiUrl') || ''));
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

  if (options.loopback || options.email) {
    await loopbackLogin({ base, ttlSeconds, options, context, config });
    return;
  }

  await oauthLogin({ base, ttlSeconds, options, context, config });
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
  source: 'desktop-shell' | 'browser-oauth' | 'magic-link';
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
  if (!isScopedApiKey(apiKey)) {
    throw new Error(`The server returned an invalid CLI key. ${scopedApiKeyErrorMessage('Returned key')}`);
  }

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

// ---- browser OAuth fallback --------------------------------------------------

async function oauthLogin(args: LoopbackArgs): Promise<void> {
  const { base, ttlSeconds, options, context, config } = args;
  const { output } = context;

  const state = randomBytes(32).toString('hex');
  const verifier = makeCodeVerifier();
  const challenge = codeChallengeForVerifier(verifier);
  const loopback = await startOAuthLoopback(state, OAUTH_TIMEOUT_MS);

  try {
    const redirectUri = `http://127.0.0.1:${loopback.port}${OAUTH_CALLBACK_PATH}`;
    const authorizeUrl = buildOAuthAuthorizeUrl(base, { redirectUri, state, codeChallenge: challenge });

    output.info('Opening Kablewy in your browser to authorize the CLI...');
    const opened = options.browser === false ? false : await openBrowser(authorizeUrl);
    if (!opened) {
      output.info(`Open this URL to continue:\n${authorizeUrl}`);
    }
    output.info('If you are not signed in, complete Kablewy web login first. The browser will return to this terminal automatically.');
    output.info('Waiting for browser authorization (2 min)...');

    const callback = await loopback.wait();
    if (callback.error) {
      throw new Error(callback.error === 'access_denied' ? 'Browser authorization was cancelled.' : `Browser authorization failed: ${callback.error}`);
    }
    if (!callback.code) {
      throw new Error('Browser authorization did not return an authorization code.');
    }

    const token = await postForm(`${base}/v1/oauth/token`, new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      code_verifier: verifier,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri
    }));
    if (!token.ok) throw new Error(describeHttp('complete browser authorization', token));

    const body = token.body as {
      sessionToken?: string;
      access_token?: string;
      userId?: string;
      orgId?: string;
      email?: string;
    } | undefined;
    const sessionToken = body?.sessionToken || body?.access_token || '';
    const userId = body?.userId || '';
    const orgId = body?.orgId || '';
    if (!sessionToken || !userId || !orgId) {
      throw new Error('Browser authorization did not return a complete Kablewy session.');
    }

    await mintAndStore({
      base,
      orgId,
      userId,
      sessionToken,
      email: body?.email,
      source: 'browser-oauth',
      ttlSeconds,
      options,
      context,
      config
    });
  } finally {
    loopback.close();
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

    // 2. Wait for the user to click the emailed link; the browser forwards the ml_ token here.
    output.success(`📧 Check your email (${email}) and click the Kablewy sign-in link.`);
    output.info('Waiting for confirmation (2 min)...');
    const callback = await loopback.wait();
    const orgId = resolveMagicLinkOrgId(callback.orgId, mlBody?.orgId);

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
  return 'This account requires MFA. Run `kablewy login` without --loopback so Kablewy can complete MFA in the browser, or reuse an existing Kablewy desktop session.';
}

export function resolveMagicLinkOrgId(callbackOrgId?: string, requestOrgId?: string): string {
  const orgId = callbackOrgId || requestOrgId || '';
  if (!orgId) {
    throw new Error(
      'The sign-in callback did not include an organization ID. Open the latest emailed Kablewy sign-in link on this same machine, or rerun `kablewy login`.'
    );
  }
  return orgId;
}

/** Turn a server error envelope ({error:{message}} | {message} | {detail}) into a readable line. */
export function describeHttp(action: string, res: { status: number; body: unknown }): string {
  const b = res.body as Record<string, unknown> | string | undefined;
  let detail = '';
  if (b && typeof b === 'object') {
    const err = b.error as { message?: string } | string | undefined;
    if (typeof err === 'string') {
      detail = b.error_description ? `${err}: ${String(b.error_description)}` : err;
    } else {
      detail = err?.message || (b.message as string) || (b.detail as string) || JSON.stringify(b);
    }
  } else if (typeof b === 'string') {
    detail = b;
  }
  return `Failed to ${action} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`;
}

export function makeCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function codeChallengeForVerifier(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function buildOAuthAuthorizeUrl(
  base: string,
  args: { redirectUri: string; state: string; codeChallenge: string }
): string {
  const url = new URL('/v1/oauth/authorize', `${trimTrailingSlashes(base)}/`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', args.state);
  url.searchParams.set('scope', OAUTH_SCOPE);
  return url.toString();
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

async function postForm(url: string, body: URLSearchParams): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
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

async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args =
    process.platform === 'darwin'
      ? [url]
      : process.platform === 'win32'
        ? ['/c', 'start', '', url.replace(/&/g, '^&')]
        : [url];

  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      let settled = false;
      child.once('error', () => {
        settled = true;
        resolve(false);
      });
      child.once('spawn', () => {
        if (!settled) {
          child.unref();
          resolve(true);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

interface OAuthCallback {
  code?: string;
  error?: string;
}

interface OAuthLoopback {
  port: number;
  wait: () => Promise<OAuthCallback>;
  close: () => void;
}

function startOAuthLoopback(state: string, timeoutMs: number): Promise<OAuthLoopback> {
  return new Promise<OAuthLoopback>((resolveListener, rejectListener) => {
    let settle!: (cb: OAuthCallback) => void;
    let fail!: (err: Error) => void;
    const done = new Promise<OAuthCallback>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const timer = setTimeout(
      () => fail(new Error('Login timed out waiting for browser authorization (2 min). Rerun `kablewy login` to try again.')),
      timeoutMs
    );

    const server = http.createServer((req, res) => {
      let handled: OAuthCallback | null = null;
      try {
        const url = new URL(req.url || '', 'http://127.0.0.1');
        if (url.pathname !== OAUTH_CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        const cbState = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        const error = url.searchParams.get('error') || '';
        if (cbState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end('<p>Invalid sign-in callback. You can close this window.</p>');
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<html><body><p>Kablewy CLI sign-in complete. You may close this window.</p><script>setTimeout(function(){window.close()},1500)</script></body></html>');
        handled = error ? { error } : { code };
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
      () => fail(new Error('Login timed out waiting for the email link (2 min). If no email arrived, confirm this email has access to Kablewy, then rerun `kablewy login`.')),
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
