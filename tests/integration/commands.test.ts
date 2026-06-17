import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRegistry } from '../../src/commands/registry.js';
import { ConfigManager } from '../../src/core/config.js';
import { KablewyMCPClient } from '../../src/core/mcp-client.js';
import { CLIOutputHandler } from '../../src/ui/output.js';
import { CLIInputHandler } from '../../src/ui/input.js';
import { CommandContext } from '../../src/types/index.js';

describe('Command Integration Tests', () => {
  let context: CommandContext;
  let registry: CommandRegistry;

  beforeEach(() => {
    const config = new ConfigManager();
    const mcpClient = new KablewyMCPClient(config.getAll().mcpServers);
    const output = new CLIOutputHandler();
    const input = new CLIInputHandler();

    context = {
      config,
      mcpClient,
      output,
      input
    };

    registry = new CommandRegistry(context);
  });

  describe('Command Registry', () => {
    it('should register all built-in commands', () => {
      const commands = registry.listCommands();
      
      const expectedCommands = [
        'login', 'logout', 'whoami', 'auth', 'docs', 'upload',
        'chat', 'config', 'status', 'tools', 'mcp', 'quick-actions', 'webhooks', 'skills', 'skill'
      ];
      
      expectedCommands.forEach(commandName => {
        const command = commands.find(cmd => cmd.name === commandName);
        expect(command).toBeDefined();
        expect(command?.name).toBe(commandName);
        expect(command?.description).toBeDefined();
        expect(command?.version).toBeDefined();
        expect(command?.examples).toBeDefined();
      });
    });

    it('should create program with all commands', () => {
      const program = registry.createProgram();
      
      expect(program).toBeDefined();
      expect(program.name()).toBe('kablewy');
      expect(program.description()).toContain('Public CLI');
    });

    it('should register public global options without exposing internal environment selectors', () => {
      const program = registry.createProgram();

      const optionNames = program.options.map(opt => opt.long);
      expect(optionNames).not.toContain('--env');
      expect(optionNames).toContain('--api-url');
      const skills = program.commands.find(cmd => cmd.name() === 'skills')!;
      const execute = skills.commands.find(cmd => cmd.name() === 'execute')!;
      expect(execute.options.map(opt => opt.long)).toContain('--env');
    });

    it('should not expose non-public helper commands', () => {
      const program = registry.createProgram();
      
      const commands = program.commands;
      expect(commands.find(cmd => cmd.name() === 'help-extended')).toBeUndefined();
      expect(commands.find(cmd => cmd.name() === 'list-commands')).toBeUndefined();
    });
  });

  describe('Login Command Integration', () => {
    it('should create login command with correct options', () => {
      const loginCommand = registry.getCommand('login');
      expect(loginCommand).toBeDefined();

      const command = loginCommand!.createCommand(context);
      expect(command.name()).toBe('login');
      expect(command.description()).toContain('scoped API key');

      const optionNames = command.options.map(opt => opt.long);
      expect(optionNames).toContain('--email');
      expect(optionNames).toContain('--api-url');
      expect(optionNames).toContain('--ttl');
      expect(optionNames).toContain('--loopback');
      expect(optionNames).toContain('--shell');
      expect(optionNames).toContain('--no-browser');
    });
  });

  describe('Upload Command Integration', () => {
    it('should create upload command with correct options', () => {
      const uploadCommand = registry.getCommand('upload');
      expect(uploadCommand).toBeDefined();
      
      const command = uploadCommand!.createCommand(context);
      expect(command.name()).toBe('upload');
      expect(command.description()).toContain('Upload documents');
    });

    it('should handle upload command options', () => {
      const uploadCommand = registry.getCommand('upload');
      const command = uploadCommand!.createCommand(context);
      
      // Check that command has expected options
      const options = command.options;
      const optionNames = options.map(opt => opt.long);
      
      expect(optionNames).toContain('--title');
      expect(optionNames).toContain('--description');
      expect(optionNames).toContain('--parse-mode');
      expect(optionNames).toContain('--concurrency');
      expect(optionNames).toContain('--dry-run');
    });
  });

  describe('Auth Command Integration', () => {
    it('should create logout and whoami commands', () => {
      const logoutCommand = registry.getCommand('logout');
      const whoamiCommand = registry.getCommand('whoami');

      expect(logoutCommand).toBeDefined();
      expect(whoamiCommand).toBeDefined();
      expect(logoutCommand!.createCommand(context).name()).toBe('logout');
      expect(whoamiCommand!.createCommand(context).name()).toBe('whoami');
    });

    it('should create auth keys subcommands', () => {
      const authCommand = registry.getCommand('auth');
      expect(authCommand).toBeDefined();

      const command = authCommand!.createCommand(context);
      expect(command.name()).toBe('auth');

      const keys = command.commands.find(cmd => cmd.name() === 'keys');
      expect(keys).toBeDefined();
      const keySubcommands = keys!.commands.map(cmd => cmd.name());
      expect(keySubcommands).toContain('list');
      expect(keySubcommands).toContain('revoke');
    });
  });

  describe('Docs Command Integration', () => {
    it('should create docs command with public subcommands', () => {
      const docsCommand = registry.getCommand('docs');
      expect(docsCommand).toBeDefined();

      const command = docsCommand!.createCommand(context);
      expect(command.name()).toBe('docs');
      expect(command.description()).toContain('documents');

      const subcommandNames = command.commands.map(cmd => cmd.name());
      expect(subcommandNames).toContain('upload');
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('search');
      expect(subcommandNames).toContain('get');
      expect(subcommandNames).toContain('delete');
      expect(subcommandNames).toContain('status');
    });

    it('should expose JSON output and delete confirmation flags on docs subcommands', () => {
      const command = registry.getCommand('docs')!.createCommand(context);
      const byName = new Map(command.commands.map(cmd => [cmd.name(), cmd]));

      for (const name of ['list', 'search', 'get', 'delete', 'status']) {
        const subcommand = byName.get(name);
        expect(subcommand).toBeDefined();
        expect(subcommand!.options.map(opt => opt.long)).toContain('--json');
      }

      expect(byName.get('delete')!.options.map(opt => opt.long)).toContain('--yes');
    });

    it('should keep top-level upload as docs upload compatibility alias', () => {
      const docsCommand = registry.getCommand('docs')!.createCommand(context);
      const docsUpload = docsCommand.commands.find(cmd => cmd.name() === 'upload');
      const uploadCommand = registry.getCommand('upload')!.createCommand(context);

      expect(docsUpload).toBeDefined();
      expect(uploadCommand.name()).toBe('upload');
      expect(docsUpload!.description()).toBe(uploadCommand.description());
    });
  });


  describe('Chat Command Integration', () => {
    it('should create chat command with correct options', () => {
      const chatCommand = registry.getCommand('chat');
      expect(chatCommand).toBeDefined();
      
      const command = chatCommand!.createCommand(context);
      expect(command.name()).toBe('chat');
      expect(command.description()).toContain('AI chat session');
    });

    it('should handle chat command options', () => {
      const chatCommand = registry.getCommand('chat');
      const command = chatCommand!.createCommand(context);

      const options = command.options;
      const optionNames = options.map(opt => opt.long);

      expect(optionNames).toContain('--session');
      expect(optionNames).toContain('--message');
      // Removed flags: backend process_chat supports no chat-title or
      // context-document-IDs option, and --status was never read.
      expect(optionNames).not.toContain('--title');
      expect(optionNames).not.toContain('--context');
      expect(optionNames).not.toContain('--status');
    });
  });

  describe('Config Command Integration', () => {
    it('should create config command with subcommands', () => {
      const configCommand = registry.getCommand('config');
      expect(configCommand).toBeDefined();
      
      const command = configCommand!.createCommand(context);
      expect(command.name()).toBe('config');
      expect(command.description()).toContain('Manage CLI configuration');
      
      // Check for subcommands
      const subcommands = command.commands;
      const subcommandNames = subcommands.map(cmd => cmd.name());
      
      expect(subcommandNames).toContain('mcp');
      expect(subcommandNames).not.toContain('plugins');
    });
  });

  describe('Status Command Integration', () => {
    it('should create status command with correct options', () => {
      const statusCommand = registry.getCommand('status');
      expect(statusCommand).toBeDefined();
      
      const command = statusCommand!.createCommand(context);
      expect(command.name()).toBe('status');
      expect(command.description()).toContain('Check connectivity');
    });

    it('should handle status command options', () => {
      const statusCommand = registry.getCommand('status');
      const command = statusCommand!.createCommand(context);
      
      const options = command.options;
      const optionNames = options.map(opt => opt.long);

      expect(optionNames).toContain('--health');
      expect(optionNames).toContain('--tools');
      expect(optionNames).not.toContain('--sessions');
      expect(optionNames).not.toContain('--stats');
    });
  });


  describe('Tools Command Integration', () => {
    it('should create tools command with subcommands', () => {
      const toolsCommand = registry.getCommand('tools');
      expect(toolsCommand).toBeDefined();
      
      const command = toolsCommand!.createCommand(context);
      expect(command.name()).toBe('tools');
      expect(command.description()).toContain('Manage MCP tools');
      
      // Check for subcommands
      const subcommands = command.commands;
      const subcommandNames = subcommands.map(cmd => cmd.name());
      
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('describe');
      expect(subcommandNames).toContain('call');
      expect(subcommandNames).toContain('test');
    });

    it('should keep tools subcommand JSON output stable when --json is parsed by the parent command', async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      const output = {
        info: vi.fn(),
        section: vi.fn(),
        table: vi.fn(),
        error: vi.fn(),
        json: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        list: vi.fn(),
        spinner: vi.fn()
      };
      const toolsContext = {
        ...context,
        config: {
          ...context.config,
          get: (key: string) => key === 'apiKey' ? 'api_test_key' : (context.config as any).get(key)
        } as any,
        output: output as any,
        mcpClient: {
          listTools: vi.fn().mockResolvedValue([]),
          callTool: vi.fn()
        } as any
      };
      const command = registry.getCommand('tools')!.createCommand(toolsContext);

      try {
        await command.parseAsync(['node', 'script', 'list', '--json']);
        expect(output.json).toHaveBeenLastCalledWith({ success: true, data: [] });
        expect(output.info).not.toHaveBeenCalledWith('No MCP tools available');

        await command.parseAsync(['node', 'script', 'call', 'missing_tool', '--args', '{}', '--json']);
        expect(output.json).toHaveBeenLastCalledWith({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: "Tool 'missing_tool' not found"
          }
        });
        expect(output.error).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(66);
      } finally {
        process.exitCode = previousExitCode;
      }
    });
  });

  describe('MCP Command Integration', () => {
    it('should create mcp command with remote, catalog, deployment, and hosted deploy surfaces', () => {
      const mcpCommand = registry.getCommand('mcp');
      expect(mcpCommand).toBeDefined();

      const command = mcpCommand!.createCommand(context);
      expect(command.name()).toBe('mcp');
      expect(command.description()).toContain('MCP servers');

      const subcommandNames = command.commands.map(cmd => cmd.name());
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('show');
      expect(subcommandNames).toContain('connect');
      expect(subcommandNames).toContain('disconnect');
      expect(subcommandNames).toContain('remove');
      expect(subcommandNames).toContain('health');
      expect(subcommandNames).toContain('tools');
      expect(subcommandNames).toContain('test');
      expect(subcommandNames).toContain('deploy');
      expect(subcommandNames).toContain('catalog');
      expect(subcommandNames).toContain('deployment');

      const connect = command.commands.find(cmd => cmd.name() === 'connect')!;
      expect(connect.aliases()).toContain('add');
      expect(connect.options.map(opt => opt.long)).toContain('--url');
      expect(connect.options.map(opt => opt.long)).toContain('--header');
      expect(connect.options.map(opt => opt.long)).toContain('--tool-prefix');

      const deploy = command.commands.find(cmd => cmd.name() === 'deploy')!;
      expect(deploy.options.map(opt => opt.long)).toContain('--name');
      expect(deploy.options.map(opt => opt.long)).toContain('--tool-prefix');

      const catalog = command.commands.find(cmd => cmd.name() === 'catalog')!;
      expect(catalog.commands.map(cmd => cmd.name())).toEqual(expect.arrayContaining(['list', 'show', 'deploy']));

      const deployment = command.commands.find(cmd => cmd.name() === 'deployment')!;
      expect(deployment.commands.map(cmd => cmd.name())).toEqual(expect.arrayContaining(['status', 'stop', 'upgrade', 'delete']));
    });
  });

  describe('Quick Actions Command Integration', () => {
    it('should create quick-actions command with public subcommands', () => {
      const quickActionsCommand = registry.getCommand('quick-actions');
      expect(quickActionsCommand).toBeDefined();

      const command = quickActionsCommand!.createCommand(context);
      expect(command.name()).toBe('quick-actions');
      expect(command.aliases()).toContain('quick');

      const subcommandNames = command.commands.map(cmd => cmd.name());
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('run');
      expect(subcommandNames).toContain('status');

      const run = command.commands.find(cmd => cmd.name() === 'run')!;
      const runOptions = run.options.map(opt => opt.long);
      expect(runOptions).toContain('--input');
      expect(runOptions).toContain('--context');
      expect(runOptions).toContain('--callback-url');
      expect(runOptions).toContain('--wait');
      expect(runOptions).toContain('--json');
    });
  });

  describe('Webhooks Command Integration', () => {
    it('should create webhooks command with destination and trigger subcommands', () => {
      const webhooksCommand = registry.getCommand('webhooks');
      expect(webhooksCommand).toBeDefined();

      const command = webhooksCommand!.createCommand(context);
      expect(command.name()).toBe('webhooks');

      const subcommandNames = command.commands.map(cmd => cmd.name());
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('show');
      expect(subcommandNames).toContain('create');
      expect(subcommandNames).toContain('update');
      expect(subcommandNames).toContain('delete');
      expect(subcommandNames).toContain('test');
      expect(subcommandNames).toContain('deliveries');
      expect(subcommandNames).toContain('trigger');

      const create = command.commands.find(cmd => cmd.name() === 'create')!;
      const createOptions = create.options.map(opt => opt.long);
      expect(createOptions).toContain('--name');
      expect(createOptions).toContain('--url');
      expect(createOptions).toContain('--event');
      expect(createOptions).toContain('--header');

      const remove = command.commands.find(cmd => cmd.name() === 'delete')!;
      expect(remove.options.map(opt => opt.long)).toContain('--yes');
    });
  });

  describe('Skill Command Integration', () => {
    it('should create canonical skills command with subcommands', () => {
      const skillsCommand = registry.getCommand('skills');
      expect(skillsCommand).toBeDefined();

      const command = skillsCommand!.createCommand(context);
      expect(command.name()).toBe('skills');

      const subcommandNames = command.commands.map(cmd => cmd.name());
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('show');
      expect(subcommandNames).toContain('create');
      expect(subcommandNames).toContain('upload');
      expect(subcommandNames).toContain('execute');
      expect(subcommandNames).toContain('delete');
    });

    it('should create skill command with subcommands', () => {
      const skillCommand = registry.getCommand('skill');
      expect(skillCommand).toBeDefined();

      const command = skillCommand!.createCommand(context);
      expect(command.name()).toBe('skill');
      expect(command.description()).toContain('skill');

      // Check for subcommands
      const subcommands = command.commands;
      const subcommandNames = subcommands.map(cmd => cmd.name());

      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('show');
      expect(subcommandNames).toContain('create');
      expect(subcommandNames).toContain('upload');
      expect(subcommandNames).toContain('execute');
      expect(subcommandNames).toContain('versions');
      expect(subcommandNames).toContain('delete');
    });

    it('should have execute subcommand with runtime options', () => {
      const skillCommand = registry.getCommand('skill');
      const command = skillCommand!.createCommand(context);

      const executeCmd = command.commands.find(cmd => cmd.name() === 'execute');
      expect(executeCmd).toBeDefined();

      const options = executeCmd!.options.map(opt => opt.long);
      expect(options).toContain('--runtime');
      expect(options).toContain('--entry');
      expect(options).toContain('--args');
      expect(options).toContain('--env');
    });
  });

  describe('Command Context Integration', () => {
    it('should provide valid context to all commands', () => {
      const commands = registry.listCommands();

      commands.forEach(commandDef => {
        expect(() => {
          const command = commandDef.createCommand(context);
          expect(command).toBeDefined();
        }).not.toThrow();
      });
    });

    it('should have consistent context across commands', () => {
      const uploadCommand = registry.getCommand('upload');
      const chatCommand = registry.getCommand('chat');

      const uploadCmd = uploadCommand!.createCommand(context);
      const chatCmd = chatCommand!.createCommand(context);

      // Both commands should be able to access the same context
      expect(uploadCmd).toBeDefined();
      expect(chatCmd).toBeDefined();
    });
  });
});
