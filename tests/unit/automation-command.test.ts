import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickActionsCommand } from '../../src/commands/quick-actions.js';
import { createWebhooksCommand } from '../../src/commands/webhooks.js';
import { CommandContext } from '../../src/types/index.js';

describe('automation commands', () => {
  const originalFetch = global.fetch;
  let output: Record<string, any>;
  let input: Record<string, any>;
  let context: CommandContext;

  beforeEach(() => {
    process.exitCode = undefined;
    output = {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      progress: vi.fn(),
      spinner: vi.fn(),
      section: vi.fn(),
      list: vi.fn(),
      json: vi.fn(),
      code: vi.fn(),
      banner: vi.fn(),
      box: vi.fn(),
      clear: vi.fn()
    };
    input = {
      prompt: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      select: vi.fn(),
      multiSelect: vi.fn()
    };
    context = {
      config: {
        get: (key: string) => ({
          apiUrl: 'https://api.example.com',
          orgId: 'org-1',
          userId: 'user-1',
          apiKey: 'api_key_secret'
        } as Record<string, string>)[key]
      },
      output: output as any,
      input: input as any,
      mcpClient: {} as any
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('lists Quick Actions from the backend route', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: [{ slug: 'renewal-review', name: 'Renewal Review', model: 'gpt-5' }]
    }));

    const command = createQuickActionsCommand(context);
    await command.parseAsync(['node', 'script', 'list', '--json']);

    expect(global.fetch).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/quick-actions/org-1/users/user-1/quick-actions'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer api_key_secret' })
      })
    );
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        quickActions: [{ slug: 'renewal-review', name: 'Renewal Review', model: 'gpt-5' }]
      }
    });
  });

  it('runs a Quick Action with structured context and can wait for completion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        chatId: 'chat-1',
        taskId: 'org-1:chat-1',
        actionName: 'Renewal Review'
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        running: false,
        task: { id: 'org-1:chat-1', status: 'completed', updatedAt: '2026-06-10T00:00:00.000Z' },
        result: { content: 'Done', completedAt: '2026-06-10T00:00:00.000Z' }
      }));
    global.fetch = fetchMock;

    const command = createQuickActionsCommand(context);
    await command.parseAsync([
      'node',
      'script',
      'run',
      'renewal-review',
      '--input',
      'Review Acme renewal',
      '--context',
      '{"account":"Acme"}',
      '--wait',
      '--json'
    ]);

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/quick-actions/org-1/users/user-1/quick-actions/renewal-review/run');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
      input: 'Review Acme renewal',
      context: { account: 'Acme' }
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.example.com/v1/quick-actions/org-1/users/user-1/quick-actions/runs/org-1%3Achat-1');
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        run: {
          success: true,
          chatId: 'chat-1',
          taskId: 'org-1:chat-1',
          actionName: 'Renewal Review'
        },
        status: {
          success: true,
          running: false,
          task: { id: 'org-1:chat-1', status: 'completed', updatedAt: '2026-06-10T00:00:00.000Z' },
          result: { content: 'Done', completedAt: '2026-06-10T00:00:00.000Z' }
        }
      }
    });
  });

  it('creates a webhook destination and redacts the signing secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: {
        id: 'wh-1',
        name: 'CRM',
        url: 'https://hooks.example.com/kablewy',
        signing_secret: 'placeholder'
      }
    }, 201));
    global.fetch = fetchMock;

    const command = createWebhooksCommand(context);
    await command.parseAsync([
      'node',
      'script',
      'create',
      '--name',
      'CRM',
      '--url',
      'https://hooks.example.com/kablewy',
      '--event',
      'quick_action.completed',
      '--header',
      'X-Customer=acme',
      '--json'
    ]);

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/org/org-1/users/user-1/webhook-destinations');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
      name: 'CRM',
      url: 'https://hooks.example.com/kablewy',
      event_types: ['quick_action.completed'],
      headers: { 'X-Customer': 'acme' },
      auth_type: 'none'
    });
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        id: 'wh-1',
        name: 'CRM',
        url: 'https://hooks.example.com/kablewy',
        signing_secret: '***lder'
      }
    });
  });

  it('triggers a webhook-enabled Automation Job with a JSON payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      eventId: 'evt-1',
      runId: 'run-1',
      message: 'Webhook job triggered'
    }, 202));
    global.fetch = fetchMock;

    const command = createWebhooksCommand(context);
    await command.parseAsync(['node', 'script', 'trigger', 'job-1', '--payload', '{"event_type":"manual.test"}', '--json']);

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/workflow-jobs/org-1/trigger/job-1');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({ event_type: 'manual.test' });
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        success: true,
        eventId: 'evt-1',
        runId: 'run-1',
        message: 'Webhook job triggered'
      }
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req-test'
    }
  });
}
