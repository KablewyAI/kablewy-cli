import { Command } from 'commander';
import { CommandContext, ToolsOptions, OutputHandler, MCPTool, MCPToolProperty, InputHandler } from '../types/index.js';
import { CliError, exitCodeFor, writeJsonError, writeJsonSuccess } from '../core/api-client.js';

export function createToolsCommand(context: CommandContext): Command {
  const command = new Command('tools');
  
  command
    .description('Manage MCP tools and integrations')
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show detailed information')
    .action(async (options: ToolsOptions, command: Command) => {
      await handleTools(resolveToolsOptions(options, command), context);
    });

  // Add subcommands
  command
    .command('list')
    .description('List available MCP tools')
    .option('-s, --server <server>', 'Filter tools by server name')
    .option('--search <query>', 'Search tools by name or description')
    .option('--json', 'Output in JSON format')
    .action(async (options: ToolsOptions, command: Command) => {
      await handleToolsList(resolveToolsOptions(options, command), context);
    });

  command
    .command('describe')
    .description('Show detailed information about a tool')
    .argument('<toolName>', 'Tool name')
    .option('--schema', 'Show input schema')
    .option('--examples', 'Show usage examples')
    .option('--json', 'Output in JSON format')
    .action(async (toolName: string, options: ToolsOptions, command: Command) => {
      await handleToolsDescribe(toolName, resolveToolsOptions(options, command), context);
    });

  command
    .command('call')
    .description('Call an MCP tool directly')
    .argument('<toolName>', 'Tool name')
    .option('-a, --args <args>', 'Tool arguments (JSON format)')
    .option('--interactive', 'Interactive argument input')
    .option('--json', 'Output in JSON format')
    .action(async (toolName: string, options: ToolsOptions, command: Command) => {
      await handleToolsCall(toolName, resolveToolsOptions(options, command), context);
    });

  command
    .command('test')
    .description('Test MCP tool connectivity (all configured servers by default)')
    .option('-s, --server <server>', 'Test specific server')
    .option('--json', 'Output in JSON format')
    .action(async (options: ToolsOptions, command: Command) => {
      await handleToolsTest(resolveToolsOptions(options, command), context);
    });

  return command;
}

function resolveToolsOptions(options: ToolsOptions, command?: Command): ToolsOptions {
  const commandOptions = typeof command?.opts === 'function' ? command.opts<ToolsOptions>() : {};
  const parentOptions = typeof command?.parent?.opts === 'function' ? command.parent.opts<ToolsOptions>() : {};
  return { ...parentOptions, ...commandOptions, ...options };
}

async function handleTools(options: ToolsOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  
  output.section('MCP Tools Management');
  output.info('Use subcommands to work with MCP tools:');
  output.list([
    'kablewy tools list - List available tools',
    'kablewy tools describe <name> - Show tool details',
    'kablewy tools call <name> - Call a tool directly',
    'kablewy tools test - Test tool connectivity'
  ]);
}

async function handleToolsList(options: ToolsOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;
  
  try {
    const tools = await mcpClient.listTools();

    // Apply filters
    let filteredTools = tools;
    
    if ((options as any).server) {
      filteredTools = filteredTools.filter((tool: MCPTool) => tool.server === (options as any).server);
    }
    
    if ((options as any).search) {
      const query = (options as any).search.toLowerCase();
      filteredTools = filteredTools.filter((tool: MCPTool) => 
        tool.name.toLowerCase().includes(query) || 
        tool.description.toLowerCase().includes(query)
      );
    }

    if (options.json) {
      writeJsonSuccess(context, filteredTools);
      return;
    }

    if (tools.length === 0) {
      output.info('No MCP tools available');
      return;
    }
    
    output.section(`Available MCP Tools (${filteredTools.length} of ${tools.length})`);
    
    const toolData = filteredTools.map((tool: MCPTool) => ({
      Name: tool.name,
      Server: tool.server,
      Description: truncateText(tool.description, 60),
      Parameters: Object.keys(tool.inputSchema?.properties || {}).length
    }));
    
    output.table(toolData);
    
    if (options.verbose) {
      output.section('Detailed Tool Information');
      filteredTools.forEach((tool: MCPTool) => {
        output.info(`\n${tool.name} (${tool.server})`);
        output.info(`  Description: ${tool.description}`);
        if (tool.inputSchema?.properties) {
          output.info('  Parameters:');
          Object.entries(tool.inputSchema.properties).forEach(([param, schema]: [string, MCPToolProperty]) => {
            const required = tool.inputSchema.required?.includes(param) ? ' (required)' : '';
            output.info(`    - ${param}: ${schema.type}${required}`);
            if (schema.description) {
              output.info(`      ${schema.description}`);
            }
          });
        }
      });
    }
    
  } catch (error: unknown) {
    handleToolsFailure(error, options, context, 'Failed to list tools');
  }
}

async function handleToolsDescribe(toolName: string, options: ToolsOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;
  
  try {
    const tools = await mcpClient.listTools();
    const tool = tools.find((t: MCPTool) => t.name === toolName);
    
    if (!tool) {
      handleToolsFailure(new CliError(`Tool '${toolName}' not found`, 'NOT_FOUND', 66), options, context, 'Failed to describe tool');
      return;
    }
    
    if (options.json) {
      writeJsonSuccess(context, tool);
      return;
    }
    
    output.section(`Tool: ${tool.name}`);
    output.info(`Server: ${tool.server}`);
    output.info(`Description: ${tool.description}`);
    
    if ((options as any).schema && tool.inputSchema) {
      output.section('Input Schema');
      output.json(tool.inputSchema);
    }
    
    if ((options as any).examples) {
      output.section('Usage Examples');
      showToolExamples(tool, output);
    }
    
    if (tool.inputSchema?.properties) {
      output.section('Parameters');
      Object.entries(tool.inputSchema.properties).forEach(([param, schema]: [string, MCPToolProperty]) => {
        const required = tool.inputSchema.required?.includes(param) ? ' (required)' : '';
        output.info(`\n${param}${required}`);
        output.info(`  Type: ${schema.type}`);
        if (schema.description) {
          output.info(`  Description: ${schema.description}`);
        }
        if (schema.enum) {
          output.info(`  Options: ${schema.enum.join(', ')}`);
        }
        if ((schema as any).default !== undefined) {
          output.info(`  Default: ${(schema as any).default}`);
        }
      });
    }
    
  } catch (error: unknown) {
    handleToolsFailure(error, options, context, 'Failed to describe tool');
  }
}

async function handleToolsCall(toolName: string, options: ToolsOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient, input } = context;
  
  try {
    const tools = await mcpClient.listTools();
    const tool = tools.find((t: MCPTool) => t.name === toolName);
    
    if (!tool) {
      handleToolsFailure(new CliError(`Tool '${toolName}' not found`, 'NOT_FOUND', 66), options, context, 'Tool call failed');
      return;
    }
    
    let args: unknown = {};
    
    if ((options as any).interactive) {
      // Interactive argument input
      args = await inputToolArguments(tool, input);
    } else if ((options as any).args) {
      // Parse JSON arguments
      try {
        args = JSON.parse((options as any).args);
      } catch (error: unknown) {
        handleToolsFailure(new CliError('Invalid JSON format for arguments', 'USAGE_ERROR', 2), options, context, 'Tool call failed');
        return;
      }
    } else {
      handleToolsFailure(new CliError('Provide arguments with --args or use --interactive', 'USAGE_ERROR', 2), options, context, 'Tool call failed');
      return;
    }
    
    if (!options.json) {
      output.info(`Calling tool: ${toolName}`);
    }
    if (options.verbose) {
      output.info(`Arguments: ${JSON.stringify(args, null, 2)}`);
    }
    
    const result = await mcpClient.callTool(toolName, args as Record<string, unknown>);
    
    if (options.json) {
      writeJsonSuccess(context, result);
    } else {
      output.section('Tool Result');
      if (typeof result === 'string') {
        output.info(result);
      } else if (typeof result === 'object') {
        output.json(result);
      } else {
        output.info(String(result));
      }
    }
    
  } catch (error: unknown) {
    handleToolsFailure(error, options, context, 'Tool call failed');
  }
}

async function handleToolsTest(options: ToolsOptions, context: CommandContext): Promise<void> {
  const { output, config } = context;

  try {
    if (!options.json) {
      output.section('Testing MCP Tool Connectivity');
    }

    const cfg = config as unknown as {
      listMCPServers(): Record<string, unknown>;
      getResolvedMCPServers?: () => Record<string, ResolvedServerConfig>;
    };
    const servers = cfg.listMCPServers();
    const resolvedServers: Record<string, ResolvedServerConfig> = cfg.getResolvedMCPServers
      ? cfg.getResolvedMCPServers()
      : (servers as Record<string, ResolvedServerConfig>);
    const serversToTest = (options as any).server ? [(options as any).server] : Object.keys(servers);

    if (serversToTest.length === 0) {
      if (options.json) {
        writeJsonSuccess(context, []);
      } else {
        output.info('No MCP servers configured');
      }
      return;
    }

    const testResults = [];

    for (const serverName of serversToTest) {
      if (!options.json) {
        output.info(`Testing server: ${serverName}`);
      }

      const server = resolvedServers[serverName];
      if (!server) {
        testResults.push({ server: serverName, status: 'failed', tools: 0, error: 'not configured' });
        if (!options.json) {
          output.error('  ✗ Failed: not configured');
        }
        continue;
      }

      const probe = await probeServerConnectivity(server);
      testResults.push({
        server: serverName,
        status: probe.ok ? 'connected' : 'failed',
        tools: probe.toolCount,
        error: probe.error
      });

      if (!options.json) {
        if (probe.ok) {
          output.success(`  ✓ Connected (${probe.toolCount} tools)`);
        } else {
          output.error(`  ✗ Failed: ${probe.error}`);
        }
      }
    }

    // Summary
    const successful = testResults.filter(r => r.status === 'connected').length;
    const total = testResults.length;

    // A connectivity test that found dead or unauthorized servers must say so
    // in its exit code (70 = network/backend error in the documented table).
    if (successful < total) {
      process.exitCode = 70;
    }

    if (options.json) {
      writeJsonSuccess(context, testResults);
    } else {
      output.section('Test Summary');
      output.info(`Successful: ${successful}/${total} servers`);
    }

  } catch (error: unknown) {
    handleToolsFailure(error, options, context, 'Tool testing failed');
  }
}

interface ResolvedServerConfig {
  httpUrl?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

/**
 * Direct JSON-RPC tools/list probe. The MCP client deliberately swallows HTTP
 * errors and returns [] (chat resilience), which would report a dead or
 * unauthorized server as "connected" here — a connectivity test has to
 * surface the real HTTP outcome instead.
 */
async function probeServerConnectivity(
  server: ResolvedServerConfig
): Promise<{ ok: boolean; toolCount: number; error: string | null }> {
  const endpoint = server.httpUrl || server.url;
  if (!endpoint) {
    return { ok: false, toolCount: 0, error: 'no endpoint configured' };
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(server.headers || {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(server.timeout ?? 15000)
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, toolCount: 0, error: `not authorized (HTTP ${res.status}) — run \`kablewy login\`` };
    }
    if (!res.ok) {
      return { ok: false, toolCount: 0, error: `HTTP ${res.status}` };
    }

    const body = (await res.json()) as { result?: { tools?: unknown[] }; error?: { message?: string } };
    if (body.error) {
      return { ok: false, toolCount: 0, error: body.error.message || 'JSON-RPC error' };
    }
    const toolCount = Array.isArray(body.result?.tools) ? body.result.tools.length : 0;
    return { ok: true, toolCount, error: null };
  } catch (error: unknown) {
    return { ok: false, toolCount: 0, error: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function handleToolsFailure(error: unknown, options: ToolsOptions, context: CommandContext, prefix: string): void {
  if (options.json) {
    writeJsonError(context, error);
  } else {
    context.output.error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = exitCodeFor(error);
}

async function inputToolArguments(tool: MCPTool, input: InputHandler): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  
  if (!tool.inputSchema?.properties) {
    return args;
  }
  
  for (const [paramName, schema] of Object.entries(tool.inputSchema.properties)) {
    const paramSchema = schema as MCPToolProperty;
    const isRequired = tool.inputSchema.required?.includes(paramName);
    
    let value: unknown;
    
    if (paramSchema.type === 'boolean') {
      value = await input.confirm(`${paramName}${isRequired ? ' (required)' : ''}: `);
    } else if (paramSchema.type === 'number') {
      value = await (input as any).number(`${paramName}${isRequired ? ' (required)' : ''}: `, {
        min: (paramSchema as any).minimum,
        max: (paramSchema as any).maximum
      });
    } else if (paramSchema.enum) {
      value = await input.select(`${paramName}${isRequired ? ' (required)' : ''}: `, paramSchema.enum);
    } else {
      value = await input.prompt(`${paramName}${isRequired ? ' (required)' : ''}: `);
    }
    
    if (value !== undefined && value !== '') {
      args[paramName] = value;
    }
  }
  
  return args;
}

function showToolExamples(tool: MCPTool, output: OutputHandler): void {
  // Generate examples based on tool type
  const examples: string[] = [];
  
  switch (tool.name) {
    case 'search_documents':
      examples.push('kablewy tools call search_documents --args \'{"query": "machine learning", "limit": 10}\'');
      break;
    case 'upload_document':
      examples.push('kablewy tools call upload_document --args \'{"file_path": "./doc.pdf", "title": "My Document"}\'');
      break;
    case 'create_chat_session':
      examples.push('kablewy tools call create_chat_session --args \'{"title": "Research Discussion"}\'');
      break;
    case 'get_graph_nodes':
      examples.push('kablewy tools call get_graph_nodes --args \'{"limit": 20}\'');
      break;
    default:
      examples.push(`kablewy tools call ${tool.name} --interactive`);
      examples.push(`kablewy tools call ${tool.name} --args '{"param": "value"}'`);
  }
  
  examples.forEach(example => {
    output.info(`  ${example}`);
  });
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}
