import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigCommand } from '../../src/commands/config.js';
import { CommandContext } from '../../src/types/index.js';

describe('Config Command --set', () => {
  let context: CommandContext;
  let setMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setMock = vi.fn();
    context = {
      config: {
        set: setMock,
        get: vi.fn(),
        getAll: vi.fn(() => ({ mcpServers: {} }))
      },
      mcpClient: {} as any,
      output: {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        table: vi.fn(),
        section: vi.fn(),
        list: vi.fn(),
        json: vi.fn(),
        spinner: vi.fn(),
        progress: vi.fn(),
        code: vi.fn(),
        banner: vi.fn(),
        box: vi.fn(),
        clear: vi.fn()
      } as any,
      input: {} as any
    };
  });

  async function runSet(keyValue: string): Promise<void> {
    const command = createConfigCommand(context);
    await command.parseAsync(['node', 'config', '--set', keyValue]);
  }

  it('keeps the full value when it contains "="', async () => {
    await runSet('apiUrl=https://kablewy.ai/path?a=b&c=d');

    expect(setMock).toHaveBeenCalledWith('apiUrl', 'https://kablewy.ai/path?a=b&c=d');
  });

  it('keeps base64-style padding in secret values', async () => {
    await runSet('apiKey=abc123==');

    expect(setMock).toHaveBeenCalledWith('apiKey', 'abc123==');
  });

  it('sets a simple key=value pair', async () => {
    await runSet('orgId=org-123');

    expect(setMock).toHaveBeenCalledWith('orgId', 'org-123');
    expect(context.output.success).toHaveBeenCalled();
  });

  it('rejects input without a value', async () => {
    await runSet('apiUrl');

    expect(setMock).not.toHaveBeenCalled();
    expect(context.output.error).toHaveBeenCalledWith('Invalid format. Use: --set key=value');
  });

  it('rejects an unknown key', async () => {
    await runSet('nope=value');

    expect(setMock).not.toHaveBeenCalled();
    expect(context.output.error).toHaveBeenCalledWith('Invalid configuration key: nope');
  });
});
