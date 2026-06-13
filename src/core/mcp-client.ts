import { EventEmitter } from 'events';
import { MCPClient, MCPMessage, MCPTool, MCPServerConfig, MCPToolResponse } from '../types/index.js';

type HttpConnection = { type: 'http'; url: string; headers: Record<string, string>; timeout: number };
type SseConnection = { type: 'sse'; url: string; headers: Record<string, string>; timeout: number };
type ProcessConnection = { type: 'process'; command: string; args: string[]; env: Record<string, string>; cwd: string; process?: { kill: () => void } };
type Connection = HttpConnection | SseConnection | ProcessConnection;

function warnVerbose(message: string, error: unknown): void {
  if (process.env.KABLEWY_VERBOSE === 'true') {
    console.warn(message, error);
  }
}

export class KablewyMCPClient extends EventEmitter implements MCPClient {
  private servers: Map<string, MCPServerConfig> = new Map();
  private connections: Map<string, Connection> = new Map();
  private tools: Map<string, MCPTool> = new Map();
  private isConnected = false;

  constructor(servers: Record<string, MCPServerConfig>) {
    super();
    Object.entries(servers).forEach(([name, config]) => {
      this.servers.set(name, config);
    });
  }

  async connect(): Promise<void> {
    for (const [name, config] of this.servers) {
      try {
        await this.connectToServer(name, config);
      } catch (error) {
        warnVerbose(`Failed to connect to MCP server ${name}:`, error);
      }
    }
    this.isConnected = true;
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    for (const [name, connection] of this.connections) {
      try {
        await this.disconnectFromServer(name, connection);
      } catch (error) {
        warnVerbose(`Failed to disconnect from MCP server ${name}:`, error);
      }
    }
    this.connections.clear();
    this.tools.clear();
    this.isConnected = false;
    this.emit('disconnected');
  }

  async listTools(): Promise<MCPTool[]> {
    if (!this.isConnected || this.connections.size === 0) {
      await this.connect();
    }

    const allTools: MCPTool[] = [];

    for (const [name, connection] of this.connections) {
      try {
        const serverTools = await this.getServerTools(name, connection);
        serverTools.forEach(t => {
          this.tools.set(t.name, { ...t, server: name });
          this.tools.set(`${name}__${t.name}`, { ...t, server: name });
        });
        allTools.push(...serverTools);
      } catch (error) {
        warnVerbose(`Failed to get tools from server ${name}:`, error);
      }
    }
    
    return allTools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResponse> {
    let tool = this.tools.get(name) || this.tools.get(`default__${name}`);
    if (!tool) {
      await this.listTools();
      tool = this.tools.get(name) || this.tools.get(`default__${name}`);
      if (!tool) {
        // As a last resort, try to find by suffix
        for (const [key, value] of this.tools) {
          if (key.endsWith(`__${name}`)) { tool = value; break; }
        }
      }
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }
    }

    const connection = this.connections.get(tool.server);
    if (!connection) {
      throw new Error(`Connection to server ${tool.server} not found`);
    }

    return await this.executeToolCall(connection, name, args);
  }

  async sendMessage(message: MCPMessage): Promise<MCPMessage> {
    // For now, route to the first available server
    // In a more sophisticated implementation, we'd route based on context
    const firstEntry = this.connections.entries().next().value;
    if (!firstEntry) {
      throw new Error('No MCP servers connected');
    }
    const [, connection] = firstEntry;

    return await this.sendMessageToServer(connection, message);
  }

  async *startChat(messages: MCPMessage[]): AsyncGenerator<MCPMessage> {
    const firstEntry = this.connections.entries().next().value;
    if (!firstEntry) {
      throw new Error('No MCP servers connected');
    }
    const [, connection] = firstEntry;

    yield* this.startChatWithServer(connection, messages);
  }

  private async connectToServer(name: string, config: MCPServerConfig): Promise<void> {
    // Prefer SSE when available
    if (config.url) {
      await this.connectSSE(name, config);
    } else if (config.httpUrl) {
      await this.connectHTTP(name, config);
    } else if (config.command) {
      await this.connectProcess(name, config);
    } else {
      throw new Error(`No connection method specified for server ${name}`);
    }
  }

  private async connectHTTP(name: string, config: MCPServerConfig): Promise<void> {
    // HTTP-based MCP connection
    const connection: HttpConnection = {
      type: 'http',
      url: config.httpUrl!,
      headers: config.headers || {},
      timeout: config.timeout || 30000
    };
    
    this.connections.set(name, connection);
    
    // Test connection and get available tools
    try {
      const tools = await this.getServerTools(name, connection);
      tools.forEach(tool => {
        this.tools.set(tool.name, { ...tool, server: name });
        this.tools.set(`${name}__${tool.name}`, { ...tool, server: name });
      });
    } catch (error) {
      warnVerbose(`Failed to initialize HTTP connection to ${name}:`, error);
    }
  }

  private async connectSSE(name: string, config: MCPServerConfig): Promise<void> {
    // Server-Sent Events based MCP connection
    const connection: SseConnection = {
      type: 'sse',
      url: config.url!,
      headers: config.headers || {},
      timeout: config.timeout || 30000
    };
    
    this.connections.set(name, connection);
    
    try {
      const tools = await this.getServerTools(name, connection);
      tools.forEach(tool => {
        this.tools.set(tool.name, { ...tool, server: name });
        this.tools.set(`${name}__${tool.name}`, { ...tool, server: name });
      });
    } catch (error) {
      warnVerbose(`Failed to initialize SSE connection to ${name}:`, error);
    }
  }

  private async connectProcess(name: string, config: MCPServerConfig): Promise<void> {
    // Process-based MCP connection
    const connection: ProcessConnection = {
      type: 'process',
      command: config.command!,
      args: config.args || [],
      env: config.env || {},
      cwd: config.cwd || process.cwd()
    };
    
    this.connections.set(name, connection);
    
    try {
      const tools = await this.getServerTools(name, connection);
      tools.forEach(tool => {
        this.tools.set(tool.name, { ...tool, server: name });
        this.tools.set(`${name}__${tool.name}`, { ...tool, server: name });
      });
    } catch (error) {
      warnVerbose(`Failed to initialize process connection to ${name}:`, error);
    }
  }

  private async disconnectFromServer(name: string, connection: Connection): Promise<void> {
    if (connection.type === 'process' && connection.process) {
      connection.process.kill();
    }
    // Clean up other connection types as needed
  }

  private async getServerTools(name: string, connection: Connection): Promise<MCPTool[]> {
    // Prefer JSON-RPC via HTTP. Derive JSON-RPC URL from connection URL when possible
    const jsonRpcUrl = this.getJsonRpcUrl(connection);
    if (!jsonRpcUrl) {
      return [];
    }

    const body = {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: Date.now()
    };

    const headers = { 'Content-Type': 'application/json', ...(connection as any).headers } as Record<string, string>;

    const res = await fetch(jsonRpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Failed to list tools (${res.status})`);
    }
    const data = await res.json();
    const tools = (data?.result?.tools || []) as any[];
    return tools.map((t) => {
      const inputSchema = t.input_schema || t.inputSchema || { type: 'object', properties: {} };
      return {
        name: t.name,
        description: t.description || '',
        inputSchema,
        server: name
      } as MCPTool;
    });
  }

  private getJsonRpcUrl(connection: Connection): string | null {
    const url = (connection as any).url as string | undefined;
    if (!url) return null;
    if (url.includes('${')) return null; // unresolved placeholders; skip (would produce an invalid fetch)
    // Common derivations
    if (url.includes('/mcp/http')) return url.replace('/mcp/http', '/mcp/jsonrpc');
    if (url.includes('/mcp/sse')) return url.replace('/mcp/sse', '/mcp/jsonrpc');
    if (url.endsWith('/jsonrpc')) return url;
    return null;
  }

  private async executeToolCall(connection: Connection, toolName: string, args: Record<string, unknown>): Promise<MCPToolResponse> {
    const jsonRpcUrl = this.getJsonRpcUrl(connection);
    if (!jsonRpcUrl) {
      throw new Error('No JSON-RPC endpoint available for tool call');
    }

    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: Date.now()
    };
    const headers = { 'Content-Type': 'application/json', ...(connection as any).headers } as Record<string, string>;
    const res = await fetch(jsonRpcUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok || data.error) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      throw new Error(`Tool call failed: ${msg}`);
    }
    return { success: true, data: data.result };
  }

  private async sendMessageToServer(_connection: unknown, message: MCPMessage): Promise<MCPMessage> {
    // This would make an actual MCP message request
    // For now, return a mock response
    return {
      role: 'assistant',
      content: `I received your message: "${message.content}". This is a mock response from the MCP server.`,
      toolCalls: [],
      toolResults: []
    };
  }

  private async *startChatWithServer(_connection: unknown, _messages: MCPMessage[]): AsyncGenerator<MCPMessage> {
    // This would establish a streaming chat connection
    // For now, yield mock responses
    yield {
      role: 'assistant',
      content: 'Hello! I\'m ready to help you with your knowledge work. What would you like to explore?',
      toolCalls: [],
      toolResults: []
    };
  }
}
