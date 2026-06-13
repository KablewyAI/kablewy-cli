import { Command } from 'commander';
import { CommandContext } from '../types/index.js';
import { addGlobalOptions } from '../core/global-options.js';
import { CLI_VERSION } from '../core/version.js';
import { createLoginCommand } from './login.js';
import { createUploadCommand } from './upload.js';
import { createDocsCommand } from './docs.js';
import { createChatCommand } from './chat.js';
import { createConfigCommand } from './config.js';
import { createStatusCommand } from './status.js';
import { createToolsCommand } from './tools.js';
import { createSkillCommand } from './skill.js';
import { createMcpCommand } from './mcp.js';
import { createQuickActionsCommand } from './quick-actions.js';
import { createWebhooksCommand } from './webhooks.js';
import { createAuthCommand, createLogoutCommand, createWhoamiCommand } from './auth.js';

export interface CommandDefinition {
  name: string;
  description: string;
  version: string;
  examples: string[];
  createCommand: (context: CommandContext) => Command;
}

export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();
  private context: CommandContext;

  constructor(context: CommandContext) {
    this.context = context;
    this.registerBuiltInCommands();
  }

  private registerBuiltInCommands(): void {
    const builtInCommands: CommandDefinition[] = [
      {
        name: 'login',
        description: 'Sign in with a magic link and store a scoped API key',
        version: CLI_VERSION,
        examples: [
          'kablewy login',
          'kablewy login --email you@org.com',
          'kablewy login --email ci@org.com --ttl 15m'
        ],
        createCommand: createLoginCommand
      },
      {
        name: 'logout',
        description: 'Clear local credentials and revoke the active API key when possible',
        version: CLI_VERSION,
        examples: [
          'kablewy logout',
          'kablewy logout --json'
        ],
        createCommand: createLogoutCommand
      },
      {
        name: 'whoami',
        description: 'Verify and display the active Kablewy CLI identity',
        version: CLI_VERSION,
        examples: [
          'kablewy whoami',
          'kablewy whoami --json'
        ],
        createCommand: createWhoamiCommand
      },
      {
        name: 'auth',
        description: 'Manage authentication and API keys',
        version: CLI_VERSION,
        examples: [
          'kablewy auth keys list',
          'kablewy auth keys revoke <keyId>'
        ],
        createCommand: createAuthCommand
      },
      {
        name: 'docs',
        description: 'Upload, inspect, search, and manage documents',
        version: CLI_VERSION,
        examples: [
          'kablewy docs upload ./documents/*.pdf',
          'kablewy docs list --json',
          'kablewy docs search "renewal terms"',
          'kablewy docs status <documentId>',
          'kablewy docs delete <documentId> --yes'
        ],
        createCommand: createDocsCommand
      },
      {
        name: 'upload',
        description: 'Compatibility alias for docs upload',
        version: CLI_VERSION,
        examples: [
          'kablewy upload ./documents/*.pdf',
          'kablewy upload ./files/* --parse-mode premium',
          'kablewy upload ./docs/* --concurrency 5 --dry-run'
        ],
        createCommand: createUploadCommand
      },
      {
        name: 'chat',
        description: 'Start an AI chat session with your knowledge base',
        version: CLI_VERSION,
        examples: [
          'kablewy chat',
          'kablewy chat --message "Summarize the renewal terms" --json',
          'kablewy chat --session my-project'
        ],
        createCommand: createChatCommand
      },
      {
        name: 'config',
        description: 'Manage CLI configuration',
        version: CLI_VERSION,
        examples: [
          'kablewy config --show',
          'kablewy config --set apiUrl=https://kablewy.ai',
          'kablewy config --init'
        ],
        createCommand: createConfigCommand
      },
      {
        name: 'status',
        description: 'Check connectivity, credential validity, and available tools',
        version: CLI_VERSION,
        examples: [
          'kablewy status',
          'kablewy status --health',
          'kablewy status --tools'
        ],
        createCommand: createStatusCommand
      },
      {
        name: 'tools',
        description: 'Manage MCP tools and integrations',
        version: CLI_VERSION,
        examples: [
          'kablewy tools list',
          'kablewy tools describe <toolName>',
          'kablewy tools call <toolName> --args \'{"query":"AI research"}\''
        ],
        createCommand: createToolsCommand
      },
      {
        name: 'mcp',
        description: 'Connect, deploy, and manage MCP servers',
        version: CLI_VERSION,
        examples: [
          'kablewy mcp connect customer-crm --url https://crm.example.com/mcp',
          'kablewy mcp catalog list',
          'kablewy mcp deploy ./dist/worker.mjs --name customer-crm'
        ],
        createCommand: createMcpCommand
      },
      {
        name: 'quick-actions',
        description: 'List and run published Quick Actions',
        version: CLI_VERSION,
        examples: [
          'kablewy quick-actions list',
          'kablewy quick-actions run renewal-review --input "Review Acme renewal"',
          'kablewy quick-actions status <taskId> --json'
        ],
        createCommand: createQuickActionsCommand
      },
      {
        name: 'webhooks',
        description: 'Manage outbound webhooks and trigger automation jobs',
        version: CLI_VERSION,
        examples: [
          'kablewy webhooks list',
          'kablewy webhooks create --name CRM --url https://example.com/webhooks/kablewy --event quick_action.completed',
          'kablewy webhooks trigger <jobId> --payload ./event.json'
        ],
        createCommand: createWebhooksCommand
      },
      {
        name: 'skills',
        description: 'Manage and execute skills',
        version: CLI_VERSION,
        examples: [
          'kablewy skills list',
          'kablewy skills show my-skill',
          'kablewy skills execute my-skill --runtime python --entry main.py'
        ],
        createCommand: (context) => createSkillCommand(context, 'skills')
      },
      {
        name: 'skill',
        description: 'Compatibility alias for skills',
        version: CLI_VERSION,
        examples: [
          'kablewy skill list',
          'kablewy skill show my-skill',
          'kablewy skill execute my-skill --runtime python --entry main.py'
        ],
        createCommand: createSkillCommand
      }
    ];

    builtInCommands.forEach(cmd => {
      this.registerCommand(cmd.name, cmd);
    });
  }

  registerCommand(name: string, definition: CommandDefinition): void {
    this.commands.set(name, definition);
  }

  unregisterCommand(name: string): void {
    this.commands.delete(name);
  }

  getCommand(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  listCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  createProgram(): Command {
    const program = new Command();
    
    program
      .name('kablewy')
      .description('Public CLI for Kablewy client workflows')
      .version(CLI_VERSION)
      // Global flags are positional: recognized only before the subcommand.
      .enablePositionalOptions();
    addGlobalOptions(program);

    // Add all registered commands
    this.commands.forEach((definition, _name) => {
      const command = definition.createCommand(this.context);
      program.addCommand(command);
    });

    return program;
  }
}
