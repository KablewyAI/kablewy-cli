import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KablewyMCPClient } from '../../src/core/mcp-client.js';
import { MCPServerConfig } from '../../src/types/index.js';

describe('KablewyMCPClient', () => {
  let client: KablewyMCPClient;
  let mockServers: Record<string, MCPServerConfig>;

  beforeEach(() => {
    mockServers = {
      testServer: {
        httpUrl: 'http://localhost:8080/mcp',
        headers: { 'Authorization': 'Bearer test-token' },
        timeout: 30000,
        trust: true,
        description: 'Test MCP server'
      }
    };
    
    client = new KablewyMCPClient(mockServers);
  });

  describe('initialization', () => {
    it('should initialize with server configurations', () => {
      expect(client).toBeDefined();
      // The servers are stored internally, so we can't directly access them
      // but we can test the public interface
    });
  });

  describe('connection management', () => {
    it('should connect to MCP servers', async () => {
      // Mock the connection process
      const connectSpy = vi.spyOn(client, 'connect');
      
      await client.connect();
      
      expect(connectSpy).toHaveBeenCalled();
    });

    it('should disconnect from MCP servers', async () => {
      const disconnectSpy = vi.spyOn(client, 'disconnect');
      
      await client.disconnect();
      
      expect(disconnectSpy).toHaveBeenCalled();
    });
  });

  describe('tool management', () => {
    it('should return only tools discovered from real servers (no built-in mock catalog)', async () => {
      // The slimmed client no longer ships a canned mock tool catalog.
      // Against an unreachable server it discovers nothing and returns an
      // empty array (errors are swallowed gracefully).
      const tools = await client.listTools();

      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(0);

      // Any tool that IS discovered must carry the standard shape.
      tools.forEach((tool) => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('server');
      });
    });

    it('should reject calls to tools that were never discovered', async () => {
      // No mock catalog means search_documents is unknown unless a real
      // server advertises it — so the call rejects rather than returning a
      // fabricated result.
      await expect(client.callTool('search_documents', {
        query: 'test query',
        limit: 10
      })).rejects.toThrow('Tool search_documents not found');
    });

    it('should handle tool call errors', async () => {
      // Test with a non-existent tool
      await expect(client.callTool('non_existent_tool', {}))
        .rejects.toThrow('Tool non_existent_tool not found');
    });
  });

  describe('message handling', () => {
    it('should reject sendMessage when no server is connected', async () => {
      // The slimmed client no longer fabricates a mock assistant reply when
      // there is no connection — it surfaces the error instead.
      const message = {
        role: 'user' as const,
        content: 'Hello, AI!',
        toolCalls: [],
        toolResults: []
      };

      await expect(client.sendMessage(message))
        .rejects.toThrow('No MCP servers connected');
    });

    it('should route sendMessage to the first connection once connected', async () => {
      // After connecting, an HTTP server is registered (even if tool
      // discovery yields nothing), so sendMessage routes to it and returns
      // the server-level response.
      await client.connect();

      const response = await client.sendMessage({
        role: 'user' as const,
        content: 'Hello, AI!',
        toolCalls: [],
        toolResults: []
      });

      expect(response).toBeDefined();
      expect(response.role).toBe('assistant');
      expect(response.content).toContain('Hello, AI!');
    });

    it('should reject startChat when no server is connected', async () => {
      const messages = [{
        role: 'user' as const,
        content: 'Start a conversation',
        toolCalls: [],
        toolResults: []
      }];

      const chatGenerator = client.startChat(messages);

      await expect((async () => {
        for await (const _response of chatGenerator) {
          // The generator throws before yielding when nothing is connected.
        }
      })()).rejects.toThrow('No MCP servers connected');
    });

    it('should stream chat once connected', async () => {
      await client.connect();

      const chatGenerator = client.startChat([{
        role: 'user' as const,
        content: 'Start a conversation',
        toolCalls: [],
        toolResults: []
      }]);

      let responseCount = 0;
      for await (const response of chatGenerator) {
        expect(response).toBeDefined();
        expect(response.role).toBe('assistant');
        responseCount++;
        if (responseCount >= 1) break;
      }

      expect(responseCount).toBeGreaterThan(0);
    });
  });

  describe('event handling', () => {
    it('should emit connection events', (done) => {
      client.on('connected', () => {
        done();
      });
      
      client.connect().catch(() => {
        // Ignore connection errors in test
      });
    });

    it('should emit disconnection events', (done) => {
      client.on('disconnected', () => {
        done();
      });
      
      client.disconnect().catch(() => {
        // Ignore disconnection errors in test
      });
    });
  });

  describe('error handling', () => {
    it('should handle connection failures gracefully', async () => {
      // Create client with invalid server config
      const invalidServers = {
        invalidServer: {
          httpUrl: 'http://invalid-url:9999/mcp',
          timeout: 1000
        }
      };
      
      const invalidClient = new KablewyMCPClient(invalidServers);
      
      // Should not throw, but handle errors gracefully
      await expect(invalidClient.connect()).resolves.not.toThrow();
    });

    it('should reject calls to undiscovered tools', async () => {
      // Without a built-in mock catalog, an unknown tool name rejects
      // regardless of the arguments passed.
      await expect(client.callTool('search_documents', {
        invalidParam: 'invalid'
      })).rejects.toThrow('Tool search_documents not found');
    });
  });

  describe('server configuration', () => {
    it('should handle HTTP-based servers', async () => {
      const httpServers = {
        httpServer: {
          httpUrl: 'http://localhost:8080/mcp',
          headers: { 'Authorization': 'Bearer token' },
          timeout: 30000
        }
      };
      
      const httpClient = new KablewyMCPClient(httpServers);
      await expect(httpClient.connect()).resolves.not.toThrow();
    });

    it('should handle SSE-based servers', async () => {
      const sseServers = {
        sseServer: {
          url: 'http://localhost:8080/sse',
          headers: { 'Authorization': 'Bearer token' },
          timeout: 30000
        }
      };
      
      const sseClient = new KablewyMCPClient(sseServers);
      await expect(sseClient.connect()).resolves.not.toThrow();
    });

    it('should handle process-based servers', async () => {
      const processServers = {
        processServer: {
          command: 'node',
          args: ['server.js'],
          cwd: '/tmp',
          env: { NODE_ENV: 'test' }
        }
      };
      
      const processClient = new KablewyMCPClient(processServers);
      await expect(processClient.connect()).resolves.not.toThrow();
    });
  });
});