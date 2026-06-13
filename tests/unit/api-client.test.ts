import { describe, expect, it, vi } from 'vitest';
import { CliError, errorEnvelope, exitCodeFor, successEnvelope, writeJsonSuccess } from '../../src/core/api-client.js';
import { maskSecret, redactSecrets } from '../../src/utils/redact.js';
import { CommandContext } from '../../src/types/index.js';

describe('API client output helpers', () => {
  it('wraps successful JSON output in the public envelope', () => {
    expect(successEnvelope({ id: 'doc-1' })).toEqual({
      success: true,
      data: { id: 'doc-1' }
    });
  });

  it('wraps CLI errors in the public failure envelope', () => {
    expect(errorEnvelope(new CliError('Missing API key', 'AUTH_ERROR', 65, 'req-123'))).toEqual({
      success: false,
      error: {
        code: 'AUTH_ERROR',
        message: 'Missing API key',
        requestId: 'req-123'
      }
    });
  });

  it('maps CLI errors to their exit code', () => {
    expect(exitCodeFor(new CliError('Forbidden', 'PERMISSION_ERROR', 77))).toBe(77);
    expect(exitCodeFor(new Error('boom'))).toBe(1);
  });

  it('redacts nested secret fields before writing JSON success', () => {
    const json = vi.fn();
    const context = {
      output: { json },
      config: {},
      mcpClient: {},
      input: {}
    } as unknown as CommandContext;

    writeJsonSuccess(context, {
      id: 'doc-1',
      authorization: 'Bearer secret-token-value',
      nested: {
        apiKey: 'placeholder'
      }
    });

    expect(json).toHaveBeenCalledWith({
      success: true,
      data: {
        id: 'doc-1',
        authorization: '***alue',
        nested: {
          apiKey: '***lder'
        }
      }
    });
  });
});

describe('redaction utilities', () => {
  it('masks short and long secrets predictably', () => {
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('abcdef123456')).toBe('***3456');
  });

  it('redacts arrays and nested objects by secret-like key name', () => {
    expect(redactSecrets([{ cookie: 'session-cookie-value', label: 'ok' }])).toEqual([
      { cookie: '***alue', label: 'ok' }
    ]);
  });
});
