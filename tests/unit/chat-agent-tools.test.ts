import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  executeLocalAgentToolCall,
  getLocalFsTools,
  resolveRequestToolsForChat,
  runAgentSelfTest,
  streamProcessChatWithCallbacks,
} from '../../src/commands/chat.js';
import type { AgentSafetyConfig } from '../../src/utils/agent-safety.js';

function tempSafety(): { dir: string; safety: AgentSafetyConfig } {
  const dir = mkdtempSync(path.join(tmpdir(), 'kablewy-agent-tools-'));
  return {
    dir,
    safety: {
      cwd: dir,
      allowDangerousShell: false,
      allowOutsideCwd: false,
      requireShellApproval: true,
      commandTimeoutMs: 10_000,
      maxOutputBytes: 20_000,
    },
  };
}

describe('agent local tools', () => {
  it('exposes fs tools and familiar aliases with schemas', () => {
    const names = getLocalFsTools().map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'fs_list_files',
      'fs_read_file',
      'fs_search_files',
      'fs_inventory',
      'fs_run_shell',
      'fs_write_file',
      'fs_edit_file',
      'LS',
      'Read',
      'Grep',
      'Inventory',
      'Bash',
      'Write',
      'Edit',
    ]));
    for (const tool of getLocalFsTools()) {
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('adds local tools automatically for agent mode only', async () => {
    const agentTools = await resolveRequestToolsForChat({ agent: true } as any);
    const chatTools = await resolveRequestToolsForChat({} as any);
    const disabledTools = await resolveRequestToolsForChat({ agent: true, toolsMode: 'none' } as any);

    expect(agentTools?.map((tool) => tool.name)).toContain('Read');
    expect(agentTools?.map((tool) => tool.name)).toContain('Write');
    expect(chatTools).toBeNull();
    expect(disabledTools).toBeNull();
  });

  it('sends agent local tools with explicit auto tool choice in streamed requests', async () => {
    const { dir, safety } = tempSafety();
    let capturedBody: any;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response('data: {"type":"content","content":"ok"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const chunks: string[] = [];
      await streamProcessChatWithCallbacks('chat-1', 'list the files in this directory', {
        agent: true,
        agentSafety: safety,
      } as any, {
        config: {
          get: (key: string) => ({
            apiUrl: 'https://api.example.com',
            orgId: 'org-1',
            userId: 'user-1',
            apiKey: 'api_test_key',
          } as Record<string, string>)[key],
        },
        telemetry: { command: 'agent' },
      } as any, {
        onText: (chunk) => chunks.push(chunk),
        onToolEvent: () => undefined,
      });

      const args = capturedBody?.params?.arguments;
      const toolNames = args?.tools?.map((tool: any) => tool.name) || [];
      expect(args?.tool_choice).toBe('auto');
      expect(toolNames).toContain('fs_list_files');
      expect(toolNames).toContain('fs_run_shell');
      expect(chunks.join('')).toContain('ok');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('executes backend-returned local tool calls and continues with the result', async () => {
    const { dir, safety } = tempSafety();
    const capturedBodies: any[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'));
      capturedBodies.push(body);
      if (capturedBodies.length === 1) {
        return new Response([
          'data: {"type":"tool_calls_response","success":true,"requiresContinuation":true,"tool_calls":[{"id":"call_pwd","name":"fs_run_shell","arguments":"{\\"command\\":\\"pwd\\"}"}],"response":""}',
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('data: {"type":"content","content":"done"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const chunks: string[] = [];
      const toolEvents: string[] = [];
      await streamProcessChatWithCallbacks('chat-1', 'please continue with the backend tool call', {
        agent: true,
        agentSafety: safety,
      } as any, {
        config: {
          get: (key: string) => ({
            apiUrl: 'https://api.example.com',
            orgId: 'org-1',
            userId: 'user-1',
            apiKey: 'api_test_key',
          } as Record<string, string>)[key],
        },
        telemetry: { command: 'agent' },
      } as any, {
        onText: (chunk) => chunks.push(chunk),
        onToolEvent: (event) => toolEvents.push(event),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(toolEvents).toEqual([
        'local_tool_call: fs_run_shell',
        'local_tool_result: fs_run_shell',
      ]);
      const continuationArgs = capturedBodies[1]?.params?.arguments;
      expect(continuationArgs?.options?.continuation).toBe(true);
      const toolMessage = continuationArgs?.messages?.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_pwd');
      expect(toolMessage).toBeTruthy();
      const toolPayload = JSON.parse(toolMessage.content);
      expect(toolPayload.success).toBe(true);
      expect(realpathSync(toolPayload.data.stdout.trim())).toBe(realpathSync(dir));
      expect(chunks.join('')).toContain('done');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('pre-runs obvious pwd requests before the model response', async () => {
    const { dir, safety } = tempSafety();
    let capturedBody: any;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response('data: {"type":"content","content":"done"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const toolEvents: string[] = [];
      await streamProcessChatWithCallbacks('chat-1', 'can you run pwd?', {
        agent: true,
        agentSafety: safety,
      } as any, {
        config: {
          get: (key: string) => ({
            apiUrl: 'https://api.example.com',
            orgId: 'org-1',
            userId: 'user-1',
            apiKey: 'api_test_key',
          } as Record<string, string>)[key],
        },
        telemetry: { command: 'agent' },
      } as any, {
        onText: () => undefined,
        onToolEvent: (event) => toolEvents.push(event),
      });

      expect(toolEvents).toEqual([
        'local_tool_call: Bash',
        'local_tool_result: Bash',
      ]);
      const messages = capturedBody?.params?.arguments?.messages || [];
      const bootstrap = messages.find((message: any) => message.role === 'system' && String(message.content).includes('Local CLI Pre-Run Result'));
      expect(bootstrap).toBeTruthy();
      expect(bootstrap.content).toContain('"command":"pwd"');
      expect(bootstrap.content).toContain(path.basename(dir));
      const userMessage = messages.find((message: any) => message.role === 'user');
      expect(userMessage.content).toContain('Local CLI pre-run result for this request');
      expect(userMessage.content).toContain(path.basename(dir));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('pre-runs obvious directory listing requests before the model response', async () => {
    const { dir, safety } = tempSafety();
    writeFileSync(path.join(dir, 'alpha.txt'), 'hello\n');
    let capturedBody: any;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response('data: {"type":"content","content":"done"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const toolEvents: string[] = [];
      await streamProcessChatWithCallbacks('chat-1', 'list the files in this directory', {
        agent: true,
        agentSafety: safety,
      } as any, {
        config: {
          get: (key: string) => ({
            apiUrl: 'https://api.example.com',
            orgId: 'org-1',
            userId: 'user-1',
            apiKey: 'api_test_key',
          } as Record<string, string>)[key],
        },
        telemetry: { command: 'agent' },
      } as any, {
        onText: () => undefined,
        onToolEvent: (event) => toolEvents.push(event),
      });

      expect(toolEvents).toEqual([
        'local_tool_call: LS',
        'local_tool_result: LS',
      ]);
      const messages = capturedBody?.params?.arguments?.messages || [];
      const bootstrap = messages.find((message: any) => message.role === 'system' && String(message.content).includes('Local CLI Pre-Run Result'));
      expect(bootstrap).toBeTruthy();
      expect(bootstrap.content).toContain('alpha.txt');
      const userMessage = messages.find((message: any) => message.role === 'user');
      expect(userMessage.content).toContain('Local CLI pre-run result for this request');
      expect(userMessage.content).toContain('alpha.txt');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('keeps local filesystem evidence fresh across truncated listing follow-ups', async () => {
    const { dir, safety } = tempSafety();
    for (let i = 0; i < 360; i++) {
      writeFileSync(path.join(dir, `a${String(i).padStart(3, '0')}.txt`), `file ${i}\n`);
    }
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const index = true;\n');
    writeFileSync(path.join(dir, 'src', 'agent.ts'), 'export const agent = true;\n');

    const capturedBodies: any[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      capturedBodies.push(JSON.parse(String(init?.body || '{}')));
      return new Response('data: {"type":"content","content":"ok"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const context = {
      config: {
        get: (key: string) => ({
          apiUrl: 'https://api.example.com',
          orgId: 'org-1',
          userId: 'user-1',
          apiKey: 'api_test_key',
        } as Record<string, string>)[key],
      },
      telemetry: { command: 'agent' },
    } as any;
    const agentOptions = {
      agent: true,
      agentSafety: safety,
    } as any;
    const toolEvents: string[] = [];

    const send = async (message: string) => {
      await streamProcessChatWithCallbacks(`chat-${Date.now()}`, message, agentOptions, context, {
        onText: () => undefined,
        onToolEvent: (event) => toolEvents.push(event),
      });
    };

    const bootstrapForRequest = (index: number) => {
      const messages = capturedBodies[index]?.params?.arguments?.messages || [];
      return messages.find((message: any) => message.role === 'system' && String(message.content).includes('Local CLI Pre-Run Result'))?.content || '';
    };

    try {
      await send('list the files in this directory');
      await send('what is in the src directory?');
      await send('yes ./src');
      await send('just recursively inventory this whole directory.');

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(bootstrapForRequest(0)).toContain('"path":"."');
      expect(bootstrapForRequest(0)).toContain('"truncated":true');
      expect(bootstrapForRequest(1)).toContain('"path":"src"');
      expect(bootstrapForRequest(1)).toContain('src/index.ts');
      expect(bootstrapForRequest(2)).toContain('"path":"src"');
      expect(bootstrapForRequest(3)).toContain('Inventory');
      expect(bootstrapForRequest(3)).toContain('src/agent.ts');
      expect(toolEvents).toEqual(expect.arrayContaining([
        'local_tool_call: LS',
        'local_tool_result: LS',
        'local_tool_call: Inventory',
        'local_tool_result: Inventory',
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('pre-runs explicit write-and-readback requests before the model response', async () => {
    const { dir, safety } = tempSafety();
    let capturedBody: any;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response('data: {"type":"content","content":"done"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const toolEvents: string[] = [];
      await streamProcessChatWithCallbacks('chat-1', 'write a small test file named sample.txt and read it back', {
        agent: true,
        agentSafety: safety,
      } as any, {
        config: {
          get: (key: string) => ({
            apiUrl: 'https://api.example.com',
            orgId: 'org-1',
            userId: 'user-1',
            apiKey: 'api_test_key',
          } as Record<string, string>)[key],
        },
        telemetry: { command: 'agent' },
      } as any, {
        onText: () => undefined,
        onToolEvent: (event) => toolEvents.push(event),
      });

      expect(toolEvents).toEqual([
        'local_tool_call: Write',
        'local_tool_result: Write',
        'local_tool_call: Read',
        'local_tool_result: Read',
      ]);
      expect(readFileSync(path.join(dir, 'sample.txt'), 'utf8')).toContain('Kablewy agent local write test');
      const messages = capturedBody?.params?.arguments?.messages || [];
      const bootstrap = messages.find((message: any) => message.role === 'system' && String(message.content).includes('Local CLI Pre-Run Result'));
      expect(bootstrap).toBeTruthy();
      expect(bootstrap.content).toContain('sample.txt');
      expect(bootstrap.content).toContain('Kablewy agent local write test');
      const userMessage = messages.find((message: any) => message.role === 'user');
      expect(userMessage.content).toContain('Local CLI pre-run result for this request');
      expect(userMessage.content).toContain('sample.txt');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('writes, reads, edits, searches, lists, and runs read-only shell commands under cwd', async () => {
    const { dir, safety } = tempSafety();
    try {
      const writeResult = await executeLocalAgentToolCall({
        id: 'call_write',
        name: 'Write',
        arguments: { file_path: 'notes/todo.txt', content: 'alpha\nbeta\n' },
      }, safety);
      expect(JSON.parse(writeResult.content).success).toBe(true);
      expect(readFileSync(path.join(dir, 'notes/todo.txt'), 'utf8')).toBe('alpha\nbeta\n');

      const readResult = await executeLocalAgentToolCall({
        id: 'call_read',
        name: 'Read',
        arguments: { file_path: 'notes/todo.txt', full: true },
      }, safety);
      expect(JSON.parse(readResult.content).data.content).toContain('alpha');

      const editResult = await executeLocalAgentToolCall({
        id: 'call_edit',
        name: 'Edit',
        arguments: { file_path: 'notes/todo.txt', old_string: 'beta', new_string: 'gamma' },
      }, safety);
      expect(JSON.parse(editResult.content).success).toBe(true);
      expect(readFileSync(path.join(dir, 'notes/todo.txt'), 'utf8')).toContain('gamma');

      const grepResult = await executeLocalAgentToolCall({
        id: 'call_grep',
        name: 'Grep',
        arguments: { pattern: 'gamma', path: '.' },
      }, safety);
      expect(JSON.parse(grepResult.content).data.matches[0].path).toBe('notes/todo.txt');

      const lsResult = await executeLocalAgentToolCall({
        id: 'call_ls',
        name: 'LS',
        arguments: { path: '.', glob: '**/*.txt' },
      }, safety);
      expect(JSON.parse(lsResult.content).data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'notes/todo.txt', type: 'file' }),
      ]));

      const inventoryResult = await executeLocalAgentToolCall({
        id: 'call_inventory',
        name: 'Inventory',
        arguments: { path: '.', max_depth: 4 },
      }, safety);
      expect(JSON.parse(inventoryResult.content).data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'notes/todo.txt', type: 'file' }),
      ]));

      const bashResult = await executeLocalAgentToolCall({
        id: 'call_bash',
        name: 'Bash',
        arguments: { command: 'ls notes' },
      }, safety);
      const bashPayload = JSON.parse(bashResult.content);
      expect(bashPayload.data.stdout).toContain('todo.txt');
      expect(bashPayload.data.portableShim).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shims common read-only shell commands portably across host shells', async () => {
    const { dir, safety } = tempSafety();
    try {
      mkdirSync(path.join(dir, 'notes'), { recursive: true });
      writeFileSync(path.join(dir, 'notes/todo.txt'), 'portable shell\n');

      const pwdResult = await executeLocalAgentToolCall({
        id: 'call_pwd',
        name: 'Bash',
        arguments: { command: 'pwd' },
      }, safety);
      const pwdPayload = JSON.parse(pwdResult.content);
      expect(pwdPayload.success).toBe(true);
      expect(realpathSync(pwdPayload.data.stdout.trim())).toBe(realpathSync(dir));
      expect(pwdPayload.data.portableShim).toBe(true);

      const dirResult = await executeLocalAgentToolCall({
        id: 'call_dir',
        name: 'Bash',
        arguments: { command: 'dir notes' },
      }, safety);
      const dirPayload = JSON.parse(dirResult.content);
      expect(dirPayload.success).toBe(true);
      expect(dirPayload.data.stdout).toContain('todo.txt');
      expect(dirPayload.data.portableShim).toBe(true);

      const typeResult = await executeLocalAgentToolCall({
        id: 'call_type',
        name: 'Bash',
        arguments: { command: 'type notes/todo.txt' },
      }, safety);
      const typePayload = JSON.parse(typeResult.content);
      expect(typePayload.success).toBe(true);
      expect(typePayload.data.stdout).toContain('portable shell');
      expect(typePayload.data.portableShim).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns binary metadata instead of decoding binary file content', async () => {
    const { dir, safety } = tempSafety();
    try {
      writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 4, 255, 0, 8]));

      const readResult = await executeLocalAgentToolCall({
        id: 'call_binary',
        name: 'Read',
        arguments: { file_path: 'blob.bin', full: true },
      }, safety);
      const payload = JSON.parse(readResult.content);

      expect(payload.success).toBe(true);
      expect(payload.data.binary).toBe(true);
      expect(payload.data.content).toBeUndefined();
      expect(payload.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks symlink escapes outside the agent root by default', async () => {
    const { dir, safety } = tempSafety();
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'kablewy-agent-outside-'));
    try {
      writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside\n');
      try {
        symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(dir, 'linked-secret.txt'));
      } catch {
        return;
      }

      const readResult = await executeLocalAgentToolCall({
        id: 'call_symlink',
        name: 'Read',
        arguments: { file_path: 'linked-secret.txt', full: true },
      }, safety);
      const payload = JSON.parse(readResult.content);

      expect(payload.success).toBe(false);
      expect(payload.error.message).toContain('outside the agent root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('blocks outside-root writes and autonomous mutating shell commands', async () => {
    const { dir, safety } = tempSafety();
    try {
      const outside = await executeLocalAgentToolCall({
        id: 'call_outside',
        name: 'Write',
        arguments: { file_path: '../outside.txt', content: 'nope' },
      }, safety);
      expect(JSON.parse(outside.content).success).toBe(false);
      expect(JSON.parse(outside.content).error.message).toContain('outside the agent root');

      const mutating = await executeLocalAgentToolCall({
        id: 'call_mutating',
        name: 'Bash',
        arguments: { command: 'touch nope.txt' },
      }, safety);
      expect(JSON.parse(mutating.content).success).toBe(false);
      expect(JSON.parse(mutating.content).error.message).toContain('mutating');

      const unknown = await executeLocalAgentToolCall({
        id: 'call_unknown',
        name: 'Bash',
        arguments: { command: 'node --version' },
      }, safety);
      expect(JSON.parse(unknown.content).success).toBe(false);
      expect(JSON.parse(unknown.content).error.message).toContain('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a deterministic local agent self-test', async () => {
    const { dir } = tempSafety();
    try {
      const result = await runAgentSelfTest({
        cwd: dir,
        commandTimeoutMs: 10_000,
        maxOutputBytes: 20_000,
      });

      expect(result.success).toBe(true);
      expect(result.checks.map((check) => check.name)).toEqual([
        'write_file',
        'read_file',
        'edit_file',
        'search_files',
        'list_files',
        'shell_pwd',
        'shell_ls',
        'block_outside_write',
        'block_mutating_shell',
        'block_unknown_shell',
      ]);
      expect(result.checks.every((check) => check.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
