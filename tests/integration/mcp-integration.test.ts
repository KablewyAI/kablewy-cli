import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigManager } from '../../src/core/config.js';
import { KablewyMCPClient } from '../../src/core/mcp-client.js';
import { CLIOutputHandler } from '../../src/ui/output.js';
import { CLIInputHandler } from '../../src/ui/input.js';

describe('MCP Integration Tests', () => {
  let config: ConfigManager;
  let mcpClient: KablewyMCPClient;
  let output: CLIOutputHandler;
  let input: CLIInputHandler;

  beforeEach(() => {
    config = new ConfigManager();
    mcpClient = new KablewyMCPClient(config.getAll().mcpServers);
    output = new CLIOutputHandler();
    input = new CLIInputHandler();
  });

  describe('MCP Client Initialization', () => {
    it('should initialize with default server configuration', () => {
      expect(mcpClient).toBeDefined();
    });

    it('should handle multiple server configurations', () => {
      const multiServerConfig = {
        kablewy: {
          httpUrl: 'http://localhost:8787/v1/mcp/stream',
          headers: { 'Authorization': 'Bearer token1' },
          timeout: 30000,
          trust: true,
          description: 'Kablewy backend'
        },
        customServer: {
          httpUrl: 'http://localhost:8080/mcp',
          headers: { 'Authorization': 'Bearer token2' },
          timeout: 15000,
          trust: false,
          description: 'Custom server'
        }
      };

      const multiClient = new KablewyMCPClient(multiServerConfig);
      expect(multiClient).toBeDefined();
    });
  });

  describe('Tool Discovery', () => {
    it('should return a well-typed tool array (empty without a reachable server)', async () => {
      // The slimmed client only surfaces tools advertised by a real server
      // over JSON-RPC. With no backend reachable in the test environment it
      // discovers nothing and returns an empty array.
      const tools = await mcpClient.listTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(0);

      // Any discovered tool must carry the standard shape.
      tools.forEach(tool => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('server');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.server).toBe('string');
      });
    });

    it('should not fabricate a built-in Kablewy tool catalog', async () => {
      // The old client shipped a canned mock catalog (search_documents,
      // create_chat_session, ...). The slimmed client no longer does — tool
      // names come exclusively from the live server's tools/list response.
      const tools = await mcpClient.listTools();
      const toolNames = tools.map(tool => tool.name);

      expect(toolNames).not.toContain('search_documents');
      expect(toolNames).not.toContain('create_chat_session');
      expect(toolNames).not.toContain('get_graph_nodes');
      expect(toolNames).not.toContain('create_graph_relationship');
    });
  });

  describe('Tool Execution', () => {
    // The previous suite exercised a built-in mock catalog (search_documents,
    // upload_document, create_chat_session, send_chat_message, get_graph_nodes,
    // create_graph_relationship) that returned fabricated results. That mock
    // catalog was removed in the slimming refactor — the client now dispatches
    // ONLY tools advertised by a live server. With no reachable server, every
    // such call rejects with "Tool <name> not found".
    const removedMockTools = [
      ['search_documents', { query: 'test query', limit: 5 }],
      ['upload_document', { file_path: '/path/to/test.pdf', title: 'Test Document', parse_mode: 'balanced' }],
      ['create_chat_session', { title: 'Test Chat Session', context: [] }],
      ['send_chat_message', { session_id: 'test-session-123', message: 'Hello, AI!' }],
      ['get_graph_nodes', { limit: 10 }],
      ['create_graph_relationship', { source_id: 'node1', target_id: 'node2', relationship_type: 'relates to', properties: {} }]
    ] as const;

    it.each(removedMockTools)('should reject %s (no built-in mock catalog)', async (name, args) => {
      await expect(mcpClient.callTool(name, args as Record<string, unknown>))
        .rejects.toThrow(`Tool ${name} not found`);
    });

    it('should handle tool execution errors', async () => {
      await expect(mcpClient.callTool('non_existent_tool', {}))
        .rejects.toThrow('Tool non_existent_tool not found');
    });
  });

  describe('Message Handling', () => {
    it('should reject sendMessage before any server is connected', async () => {
      // The slimmed client no longer returns a mock reply when there is no
      // connection — it surfaces the error so callers know nothing is wired.
      await expect(mcpClient.sendMessage({
        role: 'user' as const,
        content: 'Hello, how are you?',
        toolCalls: [],
        toolResults: []
      })).rejects.toThrow('No MCP servers connected');
    });

    it('should send and receive messages once connected', async () => {
      // The default config server is registered on connect (even though it is
      // unreachable here), so sendMessage routes to the first connection.
      await mcpClient.connect();

      const response = await mcpClient.sendMessage({
        role: 'user' as const,
        content: 'Hello, how are you?',
        toolCalls: [],
        toolResults: []
      });

      expect(response).toBeDefined();
      expect(response.role).toBe('assistant');
      expect(response.content).toBeDefined();
      expect(typeof response.content).toBe('string');
    });

    it('should reject streaming chat before any server is connected', async () => {
      const chatStream = mcpClient.startChat([{
        role: 'user' as const,
        content: 'Tell me about machine learning',
        toolCalls: [],
        toolResults: []
      }]);

      await expect((async () => {
        for await (const _response of chatStream) {
          // generator throws before yielding when nothing is connected
        }
      })()).rejects.toThrow('No MCP servers connected');
    });

    it('should handle streaming chat once connected', async () => {
      await mcpClient.connect();

      const chatStream = mcpClient.startChat([{
        role: 'user' as const,
        content: 'Tell me about machine learning',
        toolCalls: [],
        toolResults: []
      }]);

      let responseCount = 0;
      for await (const response of chatStream) {
        expect(response).toBeDefined();
        expect(response.role).toBe('assistant');
        expect(response.content).toBeDefined();
        responseCount++;
        if (responseCount >= 1) break;
      }

      expect(responseCount).toBeGreaterThan(0);
    });
  });

  describe('Connection Management', () => {
    it('should connect to MCP servers', async () => {
      await expect(mcpClient.connect()).resolves.not.toThrow();
    });

    it('should disconnect from MCP servers', async () => {
      await expect(mcpClient.disconnect()).resolves.not.toThrow();
    });

    it('should handle connection events', (done) => {
      mcpClient.on('connected', () => {
        done();
      });
      
      mcpClient.connect().catch(() => {
        // Ignore connection errors in test
      });
    });

    it('should handle disconnection events', (done) => {
      mcpClient.on('disconnected', () => {
        done();
      });
      
      mcpClient.disconnect().catch(() => {
        // Ignore disconnection errors in test
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid server configurations gracefully', async () => {
      const invalidConfig = {
        invalidServer: {
          httpUrl: 'http://invalid-url:9999/mcp',
          timeout: 1000
        }
      };
      
      const invalidClient = new KablewyMCPClient(invalidConfig);
      
      // Should not throw during initialization
      expect(invalidClient).toBeDefined();
      
      // Should handle connection failures gracefully
      await expect(invalidClient.connect()).resolves.not.toThrow();
    });

    it('should reject calls to undiscovered tools', async () => {
      // No mock catalog, so an unknown tool rejects regardless of arguments.
      await expect(mcpClient.callTool('search_documents', {
        invalidParam: 'invalid'
      })).rejects.toThrow('Tool search_documents not found');
    });

    it('should surface an error when sending with no connection', async () => {
      const invalidMessage = {
        role: 'user' as const,
        content: '',
        toolCalls: [],
        toolResults: []
      };

      // With nothing connected, the client surfaces the error rather than
      // returning a fabricated mock response.
      await expect(mcpClient.sendMessage(invalidMessage))
        .rejects.toThrow('No MCP servers connected');
    });
  });

  describe('Server Type Support', () => {
    it('should support HTTP-based servers', () => {
      const httpConfig = {
        httpServer: {
          httpUrl: 'http://localhost:8080/mcp',
          headers: { 'Authorization': 'Bearer token' },
          timeout: 30000
        }
      };
      
      const httpClient = new KablewyMCPClient(httpConfig);
      expect(httpClient).toBeDefined();
    });

    it('should support SSE-based servers', () => {
      const sseConfig = {
        sseServer: {
          url: 'http://localhost:8080/sse',
          headers: { 'Authorization': 'Bearer token' },
          timeout: 30000
        }
      };
      
      const sseClient = new KablewyMCPClient(sseConfig);
      expect(sseClient).toBeDefined();
    });

    it('should support process-based servers', () => {
      const processConfig = {
        processServer: {
          command: 'node',
          args: ['server.js'],
          cwd: '/tmp',
          env: { NODE_ENV: 'test' }
        }
      };
      
      const processClient = new KablewyMCPClient(processConfig);
      expect(processClient).toBeDefined();
    });
  });

  describe('Integration with CLI Components', () => {
    it('should work with configuration manager', () => {
      const mcpServers = config.listMCPServers();
      expect(mcpServers).toBeDefined();
      expect(typeof mcpServers).toBe('object');
    });

    it('should work with output handler', async () => {
      const tools = await mcpClient.listTools();
      
      // Should be able to display tools using output handler
      expect(() => {
        output.info(`Found ${tools.length} tools`);
        output.table(tools.map(tool => ({
          Name: tool.name,
          Description: tool.description,
          Server: tool.server
        })));
      }).not.toThrow();
    });

    it('should work with input handler', async () => {
      // Mock inquirer to avoid actual prompts in tests
      vi.spyOn(input, 'prompt').mockResolvedValue('test input');
      
      const userInput = await input.prompt('Enter tool name:');
      expect(userInput).toBe('test input');
    });
  });
});