import { describe, expect, it, vi } from 'vitest';
import { CliError, errorEnvelope, exitCodeFor, KablewyApiClient, requireCoreApiConfig, successEnvelope, writeJsonSuccess } from '../../src/core/api-client.js';
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

describe('API client configuration', () => {
  function contextWithApiKey(apiKey: string): CommandContext {
    return {
      output: { json: vi.fn() },
      config: {
        get: (key: string) => ({
          apiUrl: 'https://kablewy.ai',
          orgId: 'org-1',
          userId: 'user-1',
          apiKey
        } as Record<string, string>)[key]
      },
      mcpClient: {},
      input: {}
    } as unknown as CommandContext;
  }

  it('accepts scoped api_ keys', () => {
    expect(requireCoreApiConfig(contextWithApiKey('api_test_key')).apiKey).toBe('api_test_key');
  });

  it('rejects session-shaped tokens before REST commands can use them', () => {
    expect(() => requireCoreApiConfig(contextWithApiKey('eyJhbGciOi.fake.jwt'))).toThrow(CliError);
    expect(() => requireCoreApiConfig(contextWithApiKey('eyJhbGciOi.fake.jwt'))).toThrow(/starting with "api_"/);
  });
});

describe('API client telemetry headers', () => {
  const originalDisable = process.env.KABLEWY_DISABLE_TELEMETRY;

  afterEach(() => {
    if (originalDisable === undefined) delete process.env.KABLEWY_DISABLE_TELEMETRY;
    else process.env.KABLEWY_DISABLE_TELEMETRY = originalDisable;
    vi.unstubAllGlobals();
  });

  it('adds privacy-safe CLI metadata to API requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new KablewyApiClient({
      baseUrl: 'https://kablewy.ai',
      orgId: 'org-1',
      userId: 'user-1',
      apiKey: 'api_test_key'
    }, 'docs.list');

    await client.request('GET', '/v1/test');

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://kablewy.ai/v1/test'), expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer api_test_key',
        'X-Kablewy-Client': 'cli',
        'X-Kablewy-CLI-Command': 'docs.list'
      })
    }));
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
