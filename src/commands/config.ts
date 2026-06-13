import { Command } from 'commander';
import { CommandContext, ConfigOptions, OutputHandler, KablewyConfig, MCPServerConfig } from '../types/index.js';
import { redactSecrets, isSecretKey, maskSecret } from '../utils/redact.js';
import { isScopedApiKey, normalizeApiKey, scopedApiKeyErrorMessage } from '../core/credentials.js';

export function createConfigCommand(context: CommandContext): Command {
  const command = new Command('config');
  
  command
    .description('Manage CLI configuration')
    .option('--show', 'Show current configuration')
    .option('--init', 'Initialize configuration with defaults')
    .option('--set <key=value>', 'Set a configuration value')
    .option('--get <key>', 'Get a configuration value')
    .option('--reset', 'Reset configuration to defaults')
    .option('--validate', 'Validate current configuration')
    .action(async (options: ConfigOptions) => {
      await handleConfig(options, context);
    });

  // Add subcommands for MCP servers
  command
    .command('mcp')
    .description('Manage MCP server configurations')
    .option('--list', 'List configured MCP servers')
    .option('--add <name>', 'Add a new MCP server')
    .option('--remove <name>', 'Remove an MCP server')
    .option('--show <name>', 'Show MCP server configuration')
    .action(async (options: ConfigOptions) => {
      await handleMCPConfig(options, context);
    });

  return command;
}

async function handleConfig(options: ConfigOptions, context: CommandContext): Promise<void> {
  const { output, config } = context;
  
  try {
    if ((options as any).show) {
      showConfiguration(config, output);
    } else if ((options as any).init) {
      await initializeConfiguration(config, output);
    } else if ((options as any).set) {
      await setConfigurationValue((options as any).set, config, output);
    } else if ((options as any).get) {
      await getConfigurationValue((options as any).get, config, output);
    } else if (options.reset) {
      await resetConfiguration(config, output, context);
    } else if ((options as any).validate) {
      await validateConfiguration(config, output);
    } else {
      // Show help if no options provided
      output.info('Use --help to see available configuration options');
      showConfiguration(config, output);
    }
  } catch (error: unknown) {
    output.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showConfiguration(config: unknown, output: { section: (title: string) => void; info: (msg: string) => void; success: (msg: string) => void; warning: (msg: string) => void; error: (msg: string) => void; table: (data: unknown[]) => void }): void {
  output.section('Current Configuration');
  
  const configData = (config as any).getAll();
  const displayConfig = {
    'API URL': configData.apiUrl,
    'Organization ID': configData.orgId,
    'User ID': configData.userId,
    'API Key': configData.apiKey ? '***' + configData.apiKey.slice(-4) : 'Not set',
    'API Key ID': configData.apiKeyId || 'Not set',
    'API Key Prefix': configData.apiKeyPrefix || 'Not set',
    'API Key Expires': configData.apiKeyExpiresAt || 'Not set',
    'Doc Worker URL': configData.docWorkerUrl || 'Not set',
    'Doc Processor Token': configData.docProcessorToken ? '***' + configData.docProcessorToken.slice(-4) : 'Not set',
    'Concurrency': configData.concurrency,
    'Retry Attempts': configData.retryAttempts,
    'Retry Delay': configData.retryDelay + 'ms',
    'Parse Mode': configData.parseMode,
    'Interactive Mode': configData.interactive,
    'Theme': configData.theme,
    'MCP Servers': Object.keys(configData.mcpServers).length
  };
  
  output.table(Object.entries(displayConfig).map(([key, value]) => ({ Setting: key, Value: value })));
}

async function initializeConfiguration(config: unknown, output: OutputHandler): Promise<void> {
  output.info('Initializing configuration...');
  
  // Set up default configuration
  (config as any).reset();
  
  output.success('Configuration initialized with defaults');
  output.info('You may want to update the following settings:');
  output.list([
    'API URL (if not using localhost)',
    'Organization ID',
    'User ID', 
    'API Key'
  ]);
}

async function setConfigurationValue(keyValue: string, config: unknown, output: OutputHandler): Promise<void> {
  // Split on the FIRST '=' only: values may legitimately contain '='
  // (URLs with query strings, base64 API keys, ...).
  const separatorIndex = keyValue.indexOf('=');
  const key = separatorIndex === -1 ? keyValue : keyValue.slice(0, separatorIndex);
  const value = separatorIndex === -1 ? '' : keyValue.slice(separatorIndex + 1);

  if (!key || !value) {
    output.error('Invalid format. Use: --set key=value');
    return;
  }
  
  // Validate and set the value
  const validKeys = ['apiUrl', 'orgId', 'userId', 'apiKey', 'apiKeyId', 'apiKeyPrefix', 'apiKeyExpiresAt', 'docWorkerUrl', 'docProcessorToken', 'concurrency', 'retryAttempts', 'retryDelay', 'parseMode', 'interactive', 'theme'];
  
  if (!validKeys.includes(key)) {
    output.error(`Invalid configuration key: ${key}`);
    output.info(`Valid keys: ${validKeys.join(', ')}`);
    return;
  }
  
  // Type conversion for numeric values
  let convertedValue: string | number | boolean = value;
  if (['concurrency', 'retryAttempts', 'retryDelay'].includes(key)) {
    convertedValue = parseInt(value);
    if (isNaN(convertedValue)) {
      output.error(`Invalid number value for ${key}: ${value}`);
      return;
    }
  } else if (key === 'interactive') {
    convertedValue = value.toLowerCase() === 'true';
  } else if (key === 'apiKey') {
    convertedValue = normalizeApiKey(value);
    if (!isScopedApiKey(convertedValue)) {
      output.error(scopedApiKeyErrorMessage('API key'));
      process.exitCode = 2;
      return;
    }
  }
  
  (config as any).set(key as keyof KablewyConfig, convertedValue);
  output.success(`Set ${key} = ${isSecretKey(key) ? maskSecret(String(convertedValue)) : convertedValue}`);
}

async function getConfigurationValue(key: string, config: unknown, output: OutputHandler): Promise<void> {
  const value = (config as any).get(key);
  if (value === undefined) {
    output.error(`Configuration key not found: ${key}`);
    return;
  }
  
  // Mask sensitive values
  const displayValue = isSecretKey(key) && value ? maskSecret(String(value)) : value;
  output.info(`${key} = ${displayValue}`);
}

async function resetConfiguration(config: unknown, output: OutputHandler, context: CommandContext): Promise<void> {
  const confirmed = await context.input.confirm('Are you sure you want to reset all configuration to defaults?');
  if (confirmed) {
    (config as any).reset();
    output.success('Configuration reset to defaults');
  } else {
    output.info('Configuration reset cancelled');
  }
}

async function validateConfiguration(config: unknown, output: OutputHandler): Promise<void> {
  const validation = (config as any).validate();

  if (validation.valid) {
    output.success('Configuration is valid');
  } else {
    output.error('Configuration validation failed:');
    validation.errors.forEach((error: unknown) => output.error(`  - ${error}`));
    // Scripts gate on --validate, so an invalid config must exit nonzero
    // (2 = usage/validation error in the documented exit-code table).
    process.exitCode = 2;
  }
}

async function handleMCPConfig(options: ConfigOptions, context: CommandContext): Promise<void> {
  const { output, config } = context;
  
  try {
    if ((options as any).list) {
      listMCPServers(config, output);
    } else if ((options as any).add) {
      await addMCPServer((options as any).add, config, output, context);
    } else if ((options as any).remove) {
      await removeMCPServer((options as any).remove, config, output, context);
    } else if ((options as any).show) {
      await showMCPServer((options as any).show, config, output);
    } else {
      output.info('Use --help to see available MCP configuration options');
    }
  } catch (error: unknown) {
    output.error(`MCP configuration error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function listMCPServers(config: unknown, output: OutputHandler): void {
  const servers = (config as any).listMCPServers();
  
  if (Object.keys(servers).length === 0) {
    output.info('No MCP servers configured');
    return;
  }
  
  output.section('Configured MCP Servers');
  const serverData = Object.entries(servers).map(([name, serverConfig]: [string, unknown]) => ({
    Name: name,
    Type: (serverConfig as MCPServerConfig).httpUrl ? 'HTTP' : (serverConfig as MCPServerConfig).url ? 'SSE' : (serverConfig as MCPServerConfig).command ? 'Process' : 'Unknown',
    Description: (serverConfig as MCPServerConfig).description || 'No description',
    Trusted: (serverConfig as MCPServerConfig).trust ? 'Yes' : 'No'
  }));
  
  output.table(serverData);
}

async function addMCPServer(name: string, config: unknown, output: OutputHandler, context: CommandContext): Promise<void> {
  const { input } = context;
  
  output.info(`Adding MCP server: ${name}`);
  
  const serverConfig = {
    command: await input.prompt('Command (optional): ') || undefined,
    args: (await input.prompt('Arguments (comma-separated, optional): ') || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    env: {},
    cwd: await input.prompt('Working directory (optional): ') || undefined,
    url: await input.prompt('SSE URL (optional): ') || undefined,
    httpUrl: await input.prompt('HTTP URL (optional): ') || undefined,
    headers: {},
    timeout: parseInt(await input.prompt('Timeout (ms, default 30000): ') || '30000'),
    trust: await input.confirm('Trust this server?'),
    description: await input.prompt('Description: ') || undefined
  };
  
  // Clean up undefined values
  Object.keys(serverConfig).forEach(key => {
    const value = (serverConfig as Record<string, unknown>)[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete (serverConfig as Record<string, unknown>)[key];
    }
  });
  
  (config as any).setMCPServer(name, serverConfig);
  output.success(`MCP server '${name}' added successfully`);
}

async function removeMCPServer(name: string, config: unknown, output: OutputHandler, context: CommandContext): Promise<void> {
  const confirmed = await context.input.confirm(`Are you sure you want to remove MCP server '${name}'?`);
  if (confirmed) {
    (config as any).removeMCPServer(name);
    output.success(`MCP server '${name}' removed`);
  } else {
    output.info('MCP server removal cancelled');
  }
}

async function showMCPServer(name: string, config: unknown, output: OutputHandler): Promise<void> {
  const serverConfig = (config as any).getMCPServer(name);
  if (!serverConfig) {
    output.error(`MCP server '${name}' not found`);
    return;
  }
  
  output.section(`MCP Server: ${name}`);
  output.json(redactSecrets(serverConfig));
}
