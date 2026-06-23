#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { ConfigManager } from './core/config.js';
import { KablewyMCPClient } from './core/mcp-client.js';
import { CLIOutputHandler } from './ui/output.js';
import { CLIInputHandler } from './ui/input.js';
import { CommandRegistry } from './commands/registry.js';
import { CommandContext } from './types/index.js';
import { applyGlobalOptions } from './core/global-options.js';
import { cliTelemetryHeaders, commandPathForTelemetry } from './core/telemetry.js';
import chalk from 'chalk';
import { createRequire } from 'module';

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nExiting gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nExiting gracefully...');
  process.exit(0);
});

async function main() {
  try {
    // Initialize core components
    const config = new ConfigManager();
    config.loadFromEnv();
    
    const output = new CLIOutputHandler();
    const input = new CLIInputHandler();
    
    // Initialize MCP client with resolved (placeholder-replaced) server configs
    const mcpClient = new KablewyMCPClient(resolveMcpServersForCommand(config));
    
    // Create command context
    const context: CommandContext = {
      config: config as any,
      mcpClient,
      output,
      input,
      telemetry: {}
    };
    
    // Create command registry
    const registry = new CommandRegistry(context);
    
    // Create main program
    const program = registry.createProgram();
    
    // Handle global options
    program.hook('preAction', (thisCommand, actionCommand) => {
      applyGlobalOptions(thisCommand.opts(), config);
      context.telemetry = {
        command: commandPathForTelemetry(actionCommand)
      };
      // Global flags are one-shot runtime overrides, so rebuild the MCP client
      // after applying them. Otherwise `kablewy --api-key ... tools list` would
      // still use the client initialized from the persisted config.
      context.mcpClient = new KablewyMCPClient(resolveMcpServersForCommand(config, context.telemetry.command));
    });
    
    // Handle errors
    program.exitOverride();
    
    // Parse command line arguments
    await program.parseAsync(process.argv);
    
  } catch (error: any) {
    const code = error?.code;
    const exitCode = typeof error?.exitCode === 'number' ? error.exitCode : undefined;
    if (exitCode === 0 || code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
      process.exit(0);
    }
    console.error(chalk.red('Error:'), error?.message || String(error));
    if (process.env.KABLEWY_VERBOSE && error?.stack) {
      console.error(error.stack);
    }
    process.exit(typeof exitCode === 'number' ? exitCode : 1);
  }
}

// Run the CLI
main().catch((error: any) => {
  console.error(chalk.red('Fatal error:'), error.message);
  if (process.env.KABLEWY_VERBOSE) {
    console.error(error.stack);
  }
  process.exit(1);
});

function resolveMcpServersForCommand(config: ConfigManager, command?: string) {
  const servers = config.getResolvedMCPServers();
  const apiUrl = String(config.get('apiUrl') || '').replace(/\/+$/, '');
  const telemetryHeaders = cliTelemetryHeaders(command);
  if (!apiUrl || Object.keys(telemetryHeaders).length === 0) return servers;

  for (const server of Object.values(servers)) {
    const endpoint = server.httpUrl || server.url || '';
    if (!endpoint.startsWith(`${apiUrl}/v1/mcp-jsonrpc/`)) continue;
    server.headers = {
      ...telemetryHeaders,
      ...(server.headers || {})
    };
  }
  return servers;
}
