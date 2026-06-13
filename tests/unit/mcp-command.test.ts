import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpCommand } from '../../src/commands/mcp.js';
import { CommandContext } from '../../src/types/index.js';

describe('mcp command', () => {
  const originalFetch = global.fetch;
  let output: Record<string, any>;
  let input: Record<string, any>;
  let mcpClient: Record<string, any>;
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
    mcpClient = {
      callTool: vi.fn()
    };
    context = {
      config: {
        get: (key: string) => ({
          apiUrl: 'https://api.example.com',
          orgId: 'org-1',
          userId: 'user-1',
          apiKey: 'api-key-secret'
        } as Record<string, string>)[key]
      },
      output: output as any,
      input: input as any,
      mcpClient: mcpClient as any
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('lists connected MCP servers from the backend REST surface', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      status: 'success',
      data: {
        servers: [
          { id: 'srv-1', name: 'Customer CRM', url: 'https://crm.example.com/mcp', tool_prefix: 'crm', connection_state: 'connected' }
        ]
      }
    }));

    const command = createMcpCommand(context);
    await command.parseAsync(['node', 'script', 'list', '--json']);

    expect(global.fetch).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/mcp-servers/org-1/users/user-1'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer api-key-secret' })
      })
    );
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        servers: [
          { id: 'srv-1', name: 'Customer CRM', url: 'https://crm.example.com/mcp', tool_prefix: 'crm', connection_state: 'connected' }
        ]
      }
    });
  });

  it('connects an externally hosted MCP server with stored headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'success', data: { success: true, serverName: 'crm', latencyMs: 20 } }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        data: { server: { id: 'srv-2', name: 'Customer CRM', url: 'https://crm.example.com/mcp', tool_prefix: 'crm' } }
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        data: { server: { id: 'srv-2', connection_state: 'connected' }, toolsCount: 3 }
      }));
    global.fetch = fetchMock;

    const command = createMcpCommand(context);
    await command.parseAsync([
      'node',
      'script',
      'connect',
      'Customer CRM',
      '--url',
      'https://crm.example.com/mcp',
      '--tool-prefix',
      'crm',
      '--header',
      'Authorization=Bearer remote-token',
      '--json'
    ]);

    const testBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(testBody).toEqual({
      url: 'https://crm.example.com/mcp',
      auth_headers: { Authorization: 'Bearer remote-token' }
    });

    const addBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(addBody).toEqual({
      name: 'Customer CRM',
      url: 'https://crm.example.com/mcp',
      tool_prefix: 'crm',
      auth_headers: { Authorization: 'Bearer remote-token' }
    });

    expect(String(fetchMock.mock.calls[2][0])).toBe('https://api.example.com/v1/mcp-servers/org-1/users/user-1/srv-2/connect');
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        connected: true,
        server: { id: 'srv-2', connection_state: 'connected' },
        toolsCount: 3,
        test: { success: true, serverName: 'crm', latencyMs: 20 }
      }
    });
  });

  it('deploys a custom worker module through the hosted MCP deploy tool and redacts the admin secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kablewy-mcp-command-'));
    const workerPath = join(dir, 'worker.mjs');
    await writeFile(workerPath, 'export default { fetch() { return new Response("ok"); } };');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 'deploy-1',
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            deploymentId: 'dep-1',
            mcpServerId: 'srv-3',
            endpointUrl: 'https://mcp.example.com/org/custom/mcp',
            workerName: 'mcp-org-custom',
            adminSecret: 'generated-admin-secret'
          })
        }]
      }
    }));
    global.fetch = fetchMock;

    try {
      const command = createMcpCommand(context);
      await command.parseAsync(['node', 'script', 'deploy', workerPath, '--name', 'Custom CRM', '--tool-prefix', 'crm', '--json']);

      expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/mcp-jsonrpc/org-1/users/user-1/mcp/jsonrpc');
      expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'deploy_mcp_server',
          arguments: {
            name: 'Custom CRM',
            worker_module: 'export default { fetch() { return new Response("ok"); } };',
            tool_prefix: 'crm'
          }
        }
      });
      expect(output.json).toHaveBeenCalledWith({
        success: true,
        data: {
          success: true,
          deploymentId: 'dep-1',
          mcpServerId: 'srv-3',
          endpointUrl: 'https://mcp.example.com/org/custom/mcp',
          workerName: 'mcp-org-custom',
          adminSecret: '***cret'
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deploys API-key catalog templates with credentials from CLI flags', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        data: { id: 'wheniwork', name: 'WhenIWork', authType: 'api_key', credentials: [] }
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'success',
        data: {
          deploymentId: 'dep-2',
          mcpServerId: 'srv-4',
          endpointUrl: 'https://mcp.example.com/org/wheniwork/mcp',
          toolCount: 16
        }
      }, 201));
    global.fetch = fetchMock;

    const command = createMcpCommand(context);
    await command.parseAsync([
      'node',
      'script',
      'catalog',
      'deploy',
      'wheniwork',
      '--credential',
      'WHEN_I_WORK_API_KEY=iws-secret',
      '--credential',
      'WHENIWORK_USERNAME=user@example.com',
      '--json'
    ]);

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/mcp-servers/org-1/catalog/wheniwork');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.example.com/v1/mcp-servers/org-1/users/user-1/catalog/wheniwork/deploy');
    expect(JSON.parse((fetchMock.mock.calls[1][1] as any).body)).toEqual({
      credentials: {
        WHEN_I_WORK_API_KEY: 'iws-secret',
        WHENIWORK_USERNAME: 'user@example.com'
      }
    });
    expect(output.json).toHaveBeenCalledWith({
      success: true,
      data: {
        deploymentId: 'dep-2',
        mcpServerId: 'srv-4',
        endpointUrl: 'https://mcp.example.com/org/wheniwork/mcp',
        toolCount: 16
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
