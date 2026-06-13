import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { createSkillCommand } from '../../src/commands/skill.js';
import { CommandContext } from '../../src/types/index.js';

describe('Skill Command', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = {
      config: {
        get: vi.fn((key: string) => {
          const values: Record<string, string> = {
            apiUrl: 'http://localhost:8787',
            orgId: 'test-org',
            userId: 'test-user',
            apiKey: 'api_test_key'
          };
          return values[key];
        })
      },
      mcpClient: {} as any,
      output: {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        table: vi.fn(),
        section: vi.fn(),
        list: vi.fn(),
        json: vi.fn(),
        spinner: vi.fn(() => ({
          start: vi.fn(),
          stop: vi.fn(),
          succeed: vi.fn(),
          fail: vi.fn(),
          update: vi.fn()
        })),
        progress: vi.fn(),
        code: vi.fn(),
        banner: vi.fn(),
        box: vi.fn(),
        clear: vi.fn()
      } as any,
      input: {
        confirm: vi.fn(),
        prompt: vi.fn(),
        select: vi.fn(),
        multiSelect: vi.fn()
      } as any
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('command structure', () => {
    it('should create skill command', () => {
      const command = createSkillCommand(mockContext);
      expect(command.name()).toBe('skill');
      expect(command.description()).toContain('skill');
    });

    it('should create plural skills command when requested', () => {
      const command = createSkillCommand(mockContext, 'skills');
      expect(command.name()).toBe('skills');
      expect(command.description()).toContain('skill');
    });

    it('should have all subcommands', () => {
      const command = createSkillCommand(mockContext);
      const subcommandNames = command.commands.map(cmd => cmd.name());
      expect(subcommandNames).toContain('list');
      expect(subcommandNames).toContain('show');
      expect(subcommandNames).toContain('create');
      expect(subcommandNames).toContain('upload');
      expect(subcommandNames).toContain('execute');
      expect(subcommandNames).toContain('versions');
      expect(subcommandNames).toContain('delete');
    });

    it('should have 7 subcommands', () => {
      const command = createSkillCommand(mockContext);
      expect(command.commands.length).toBe(7);
    });
  });

  describe('list subcommand', () => {
    it('should have correct options', () => {
      const command = createSkillCommand(mockContext);
      const listCmd = command.commands.find(cmd => cmd.name() === 'list');
      expect(listCmd).toBeDefined();

      const options = listCmd!.options.map(opt => opt.long);
      expect(options).toContain('--json');
      expect(options).toContain('--verbose');
    });

    it('honors --json on the plural skills list command', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        skills: [{ id: 'client-smoke', name: 'Client Smoke' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })));

      const command = createSkillCommand(mockContext, 'skills');
      await command.parseAsync(['node', 'skills', 'list', '--json']);

      expect(mockContext.output.json).toHaveBeenCalledWith({
        success: true,
        data: [{ id: 'client-smoke', name: 'Client Smoke' }]
      });
      expect(mockContext.output.table).not.toHaveBeenCalled();
    });
  });

  describe('show subcommand', () => {
    it('should require skillId argument', () => {
      const command = createSkillCommand(mockContext);
      const showCmd = command.commands.find(cmd => cmd.name() === 'show');
      expect(showCmd).toBeDefined();

      // Commander stores required args
      const args = showCmd!.registeredArguments;
      expect(args.length).toBeGreaterThan(0);
      expect(args[0].name()).toBe('skillId');
      expect(args[0].required).toBe(true);
    });
  });

  describe('create subcommand', () => {
    it('should have name and description options', () => {
      const command = createSkillCommand(mockContext);
      const createCmd = command.commands.find(cmd => cmd.name() === 'create');
      expect(createCmd).toBeDefined();

      const options = createCmd!.options.map(opt => opt.long);
      expect(options).toContain('--name');
      expect(options).toContain('--description');
      expect(options).toContain('--allowed-tools');
      expect(options).toContain('--github-url');
      expect(options).toContain('--github-branch');
    });
  });

  describe('upload subcommand', () => {
    it('should require skillId and zipPath arguments', () => {
      const command = createSkillCommand(mockContext);
      const uploadCmd = command.commands.find(cmd => cmd.name() === 'upload');
      expect(uploadCmd).toBeDefined();

      const args = uploadCmd!.registeredArguments;
      expect(args.length).toBe(2);
      expect(args[0].name()).toBe('skillId');
      expect(args[1].name()).toBe('zipPath');
    });

    it('should have version option', () => {
      const command = createSkillCommand(mockContext);
      const uploadCmd = command.commands.find(cmd => cmd.name() === 'upload');
      expect(uploadCmd).toBeDefined();

      const options = uploadCmd!.options.map(opt => opt.long);
      expect(options).toContain('--version');
      // --force removed: the backend bundle endpoint reads only
      // file/version/manifest form fields — there is no overwrite param.
      expect(options).not.toContain('--force');
    });
  });

  describe('execute subcommand', () => {
    it('should have runtime and entry options', () => {
      const command = createSkillCommand(mockContext);
      const executeCmd = command.commands.find(cmd => cmd.name() === 'execute');
      expect(executeCmd).toBeDefined();

      const options = executeCmd!.options.map(opt => opt.long);
      expect(options).toContain('--runtime');
      expect(options).toContain('--entry');
      expect(options).toContain('--args');
      expect(options).toContain('--env');
      expect(options).toContain('--timeout-ms');
    });
  });

  describe('versions subcommand', () => {
    it('should require skillId argument', () => {
      const command = createSkillCommand(mockContext);
      const versionsCmd = command.commands.find(cmd => cmd.name() === 'versions');
      expect(versionsCmd).toBeDefined();

      const args = versionsCmd!.registeredArguments;
      expect(args.length).toBe(1);
      expect(args[0].name()).toBe('skillId');
    });
  });

  describe('exit codes', () => {
    afterEach(() => {
      process.exitCode = undefined;
    });

    async function run(args: string[]): Promise<void> {
      const command = createSkillCommand(mockContext);
      await command.parseAsync(['node', 'skill', ...args]);
    }

    it.each([
      [401, 65],
      [403, 77],
      [404, 66],
      [500, 70],
      [503, 70]
    ])('maps HTTP %i to exit code %i', async (status, exitCode) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ error: 'nope' }),
        { status, headers: { 'content-type': 'application/json' } }
      )));

      await run(['list']);

      expect(process.exitCode).toBe(exitCode);
      expect(mockContext.output.error).toHaveBeenCalled();
    });

    it('sets exit code 70 when the request throws (network error)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));

      await run(['list']);

      expect(process.exitCode).toBe(70);
    });

    it('sets exit code 2 for invalid --args JSON on execute', async () => {
      await run(['execute', 'my-skill', '--entry', 'main.py', '--args', 'not-json']);

      expect(process.exitCode).toBe(2);
      expect(mockContext.output.error).toHaveBeenCalledWith('Invalid JSON in --args');
    });

    it('sets exit code 2 when configuration is missing', async () => {
      (mockContext.config as any).get = vi.fn(() => '');

      await run(['list']);

      expect(process.exitCode).toBe(2);
      expect(mockContext.output.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing configuration')
      );
    });

    it('leaves exit code unset on success', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ skills: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )));

      await run(['list']);

      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('delete subcommand', () => {
    it('should require skillId argument', () => {
      const command = createSkillCommand(mockContext);
      const deleteCmd = command.commands.find(cmd => cmd.name() === 'delete');
      expect(deleteCmd).toBeDefined();

      const args = deleteCmd!.registeredArguments;
      expect(args.length).toBe(1);
      expect(args[0].name()).toBe('skillId');
    });

    it('should have force option', () => {
      const command = createSkillCommand(mockContext);
      const deleteCmd = command.commands.find(cmd => cmd.name() === 'delete');
      expect(deleteCmd).toBeDefined();

      const options = deleteCmd!.options.map(opt => opt.long);
      expect(options).toContain('--force');
    });
  });
});
