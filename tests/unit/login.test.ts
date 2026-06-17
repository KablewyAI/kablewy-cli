import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTtl,
  buildKeyRequest,
  defaultKeyName,
  describeHttp,
  loadShellSession,
  mfaFallbackMessage,
  resolveMagicLinkOrgId,
  CLI_KEY_CAPABILITIES
} from '../../src/commands/login.js';

describe('login helpers', () => {
  describe('parseTtl', () => {
    it('parses unit suffixes to seconds', () => {
      expect(parseTtl('15m')).toBe(900);
      expect(parseTtl('12h')).toBe(43200);
      expect(parseTtl('30d')).toBe(2592000);
      expect(parseTtl('45s')).toBe(45);
    });

    it('treats a bare number as seconds', () => {
      expect(parseTtl('90')).toBe(90);
    });

    it('tolerates surrounding whitespace', () => {
      expect(parseTtl(' 30d ')).toBe(2592000);
    });

    it('returns 0 for invalid or non-positive input', () => {
      expect(parseTtl('')).toBe(0);
      expect(parseTtl('abc')).toBe(0);
      expect(parseTtl('0')).toBe(0);
      expect(parseTtl('-5')).toBe(0);
      expect(parseTtl('10x')).toBe(0);
    });
  });

  describe('buildKeyRequest', () => {
    it('produces a least-privilege key body', () => {
      const body = buildKeyRequest('user-1', 'my key', '2026-07-06T00:00:00.000Z');
      expect(body.userId).toBe('user-1');
      expect(body.name).toBe('my key');
      expect(body.expiresAt).toBe('2026-07-06T00:00:00.000Z');
      expect(body.capabilities).toBe(CLI_KEY_CAPABILITIES);
    });

    it('grants the public CLI surface without admin, wildcard, or manage', () => {
      const flatResources = CLI_KEY_CAPABILITIES.flatMap(c => c.resources);
      const flatActions = CLI_KEY_CAPABILITIES.flatMap(c => c.actions);
      expect(flatResources).not.toContain('admin');
      expect(flatResources).not.toContain('*');
      expect(flatActions).not.toContain('*');
      expect(flatActions).not.toContain('manage');
      expect(flatResources).toEqual(expect.arrayContaining(['documents', 'skills', 'tools', 'mcp', 'mcp-servers', 'integrations', 'auth']));
      expect(flatActions).toEqual(expect.arrayContaining(['read', 'list', 'view', 'search', 'create', 'write', 'update', 'execute', 'delete']));
    });
  });

  describe('defaultKeyName', () => {
    it('embeds the date (YYYY-MM-DD)', () => {
      expect(defaultKeyName(new Date('2026-06-06T12:34:56.000Z'))).toBe('kablewy-cli 2026-06-06');
    });
  });

  describe('mfaFallbackMessage', () => {
    it('gives a clear tested fallback for MFA-required accounts', () => {
      expect(mfaFallbackMessage()).toContain('requires MFA');
      expect(mfaFallbackMessage()).toContain('desktop app');
      expect(mfaFallbackMessage()).toContain('rerun `kablewy login`');
    });
  });

  describe('resolveMagicLinkOrgId', () => {
    it('uses the organization ID returned through the desktop callback', () => {
      expect(resolveMagicLinkOrgId('org-from-callback')).toBe('org-from-callback');
    });

    it('falls back to a request-time organization ID for older backend responses', () => {
      expect(resolveMagicLinkOrgId('', 'org-from-request')).toBe('org-from-request');
    });

    it('throws when neither response contains an organization ID', () => {
      expect(() => resolveMagicLinkOrgId()).toThrow('sign-in callback did not include an organization ID');
    });
  });

  describe('describeHttp', () => {
    it('reads {error:{message}} envelopes', () => {
      expect(describeHttp('mint a key', { status: 403, body: { error: { message: 'forbidden' } } }))
        .toBe('Failed to mint a key (HTTP 403): forbidden');
    });

    it('reads {message} and {detail} envelopes', () => {
      expect(describeHttp('verify', { status: 401, body: { message: 'Invalid magic link' } }))
        .toBe('Failed to verify (HTTP 401): Invalid magic link');
      expect(describeHttp('verify', { status: 400, body: { detail: 'bad token' } }))
        .toBe('Failed to verify (HTTP 400): bad token');
    });

    it('reads a plain string body', () => {
      expect(describeHttp('reach backend', { status: 502, body: 'Bad Gateway' }))
        .toBe('Failed to reach backend (HTTP 502): Bad Gateway');
    });

    it('handles an empty body', () => {
      expect(describeHttp('request a magic link', { status: 503, body: undefined }))
        .toBe('Failed to request a magic link (HTTP 503)');
    });
  });

  describe('loadShellSession', () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function writeSession(contents: string): string {
      dir = mkdtempSync(join(tmpdir(), 'kablewy-session-'));
      const path = join(dir, 'session.yaml');
      writeFileSync(path, contents);
      return path;
    }

    it('parses the shell SessionFile schema', () => {
      const path = writeSession(
        [
          'org_id: org-123',
          'user_id: user-456',
          'session_token: jwt-abc',
          'session_expires_at: 2026-06-06T12:00:00Z',
          'refresh_token: rt-789',
          'refresh_token_expires_at: 2026-07-06T12:00:00Z',
          'user:',
          '  id: user-456',
          '  email: steve@landadvisors.com',
          '  display_name: Steve'
        ].join('\n')
      );
      const s = loadShellSession(path);
      expect(s).not.toBeNull();
      expect(s!.orgId).toBe('org-123');
      expect(s!.userId).toBe('user-456');
      expect(s!.sessionToken).toBe('jwt-abc');
      expect(s!.refreshToken).toBe('rt-789');
      expect(s!.email).toBe('steve@landadvisors.com');
      expect(s!.sessionExpiresAt).toBe(Date.parse('2026-06-06T12:00:00Z'));
      expect(s!.refreshTokenExpiresAt).toBe(Date.parse('2026-07-06T12:00:00Z'));
    });

    it('falls back to user.id when top-level user_id is absent', () => {
      const path = writeSession(
        [
          'org_id: org-1',
          'session_token: jwt',
          'refresh_token: rt',
          'session_expires_at: 2026-06-06T12:00:00Z',
          'refresh_token_expires_at: 2026-07-06T12:00:00Z',
          'user:',
          '  id: nested-user',
          '  email: a@b.com'
        ].join('\n')
      );
      const s = loadShellSession(path);
      expect(s!.userId).toBe('nested-user');
    });

    it('returns null when the file is missing', () => {
      expect(loadShellSession(join(tmpdir(), 'definitely-not-here-xyz', 'session.yaml'))).toBeNull();
    });

    it('returns null when required fields are missing', () => {
      const path = writeSession('org_id: org-1\nsession_token: jwt\n'); // no user id
      expect(loadShellSession(path)).toBeNull();
    });

    it('returns null on malformed YAML', () => {
      const path = writeSession(': : : not valid : yaml\n\t- broken');
      expect(loadShellSession(path)).toBeNull();
    });
  });
});
