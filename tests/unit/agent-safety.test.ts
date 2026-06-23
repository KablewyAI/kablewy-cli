import { describe, expect, it } from 'vitest';
import {
  classifyShellCommand,
  defaultAgentAuditLogPath,
  isPathInside,
  redactText,
  takeOutputChunk
} from '../../src/utils/agent-safety.js';

describe('agent safety utilities', () => {
  it('classifies simple inspection commands as read risk', () => {
    const result = classifyShellCommand('rg -n "login" src');

    expect(result.risk).toBe('read');
    expect(result.blockedByDefault).toBe(false);
    expect(result.usesOutsideCwd).toBe(false);
  });

  it('classifies dependency installation as mutating risk', () => {
    const result = classifyShellCommand('npm install');

    expect(result.risk).toBe('mutating');
    expect(result.blockedByDefault).toBe(false);
    expect(result.reasons.join(' ')).toContain('change local files');
  });

  it('blocks dangerous shell patterns by default', () => {
    const result = classifyShellCommand('rm -rf dist');

    expect(result.risk).toBe('dangerous');
    expect(result.blockedByDefault).toBe(true);
  });

  it('flags commands that leave the working directory', () => {
    const result = classifyShellCommand('cd ../other-project && npm test');

    expect(result.usesOutsideCwd).toBe(true);
    expect(result.risk).not.toBe('read');
  });

  it('checks path containment without prefix confusion', () => {
    expect(isPathInside('/tmp/project', '/tmp/project/src/index.ts')).toBe(true);
    expect(isPathInside('/tmp/project', '/tmp/project-other/file.ts')).toBe(false);
  });

  it('redacts common token shapes in free text', () => {
    const text = redactText('Authorization: Bearer api_abcdefghijklmnop\nrefresh_token=rt_123456');

    expect(text).toContain('Authorization: ***');
    expect(text).toContain('refresh_token=***');
    expect(text).not.toContain('api_abcdefghijklmnop');
    expect(text).not.toContain('rt_123456');
  });

  it('truncates output by byte budget', () => {
    const first = takeOutputChunk('abc', 0, 5);
    const second = takeOutputChunk('def', first.usedBytes, 5);

    expect(first).toEqual({ text: 'abc', usedBytes: 3, truncated: false });
    expect(second).toEqual({ text: 'de', usedBytes: 5, truncated: true });
  });

  it('creates audit logs under .kablewy agent sessions', () => {
    const logPath = defaultAgentAuditLogPath('/tmp/project', new Date('2026-06-23T12:00:00.000Z'));

    expect(logPath).toBe('/tmp/project/.kablewy/agent-sessions/2026-06-23T12-00-00-000Z.jsonl');
  });
});
