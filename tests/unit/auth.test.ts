import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthCommand, createLogoutCommand } from '../../src/commands/auth.js';
import type { CommandContext } from '../../src/types/index.js';

describe('auth commands', () => {
  let values: Record<string, string>;
  let context: CommandContext;

  beforeEach(() => {
    values = {
      apiUrl: 'https://api.example.com',
      orgId: 'org-1',
      userId: 'user-1',
      apiKey: 'api_test',
      apiKeyId: 'key-1'
    };

    context = {
      config: {
        get: vi.fn((key: string) => values[key] || ''),
        set: vi.fn((key: string, value: string) => {
          values[key] = value;
        })
      },
      mcpClient: {} as any,
      output: {
        json: vi.fn(),
        error: vi.fn(),
        section: vi.fn(),
        info: vi.fn(),
        table: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        list: vi.fn()
      } as any,
      input: {} as any
    };

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  it('lists API keys through the user-scoped self-service route', async () => {
    const command = createAuthCommand(context);

    await command.parseAsync(['node', 'auth', 'keys', 'list', '--json']);

    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/org/org-1/users/user-1/api-keys'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(context.output.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  it('revokes API keys through the user-scoped self-service route', async () => {
    const command = createAuthCommand(context);

    await command.parseAsync(['node', 'auth', 'keys', 'revoke', 'key-1', '--json']);

    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/org/org-1/users/user-1/api-keys/key-1'),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(context.output.json).toHaveBeenCalledWith({
      success: true,
      data: { revoked: true, keyId: 'key-1' }
    });
  });

  it('logout attempts self-service revoke before clearing local credentials', async () => {
    const command = createLogoutCommand(context);

    await command.parseAsync(['node', 'logout', '--json']);

    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/org/org-1/users/user-1/api-keys/key-1'),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(values.apiKey).toBe('');
    expect(values.apiKeyId).toBe('');
    expect(context.output.json).toHaveBeenCalledWith({
      success: true,
      data: { localCredentialsCleared: true, revoked: true }
    });
  });
});
