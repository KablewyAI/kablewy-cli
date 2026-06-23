import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  executeLocalAgentToolCall,
  getLocalFsTools,
  resolveRequestToolsForChat,
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
      'fs_run_shell',
      'fs_write_file',
      'fs_edit_file',
      'LS',
      'Read',
      'Grep',
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
        arguments: { path: '.' },
      }, safety);
      expect(JSON.parse(lsResult.content).data.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'notes', type: 'directory' }),
      ]));

      const bashResult = await executeLocalAgentToolCall({
        id: 'call_bash',
        name: 'Bash',
        arguments: { command: 'ls notes' },
      }, safety);
      expect(JSON.parse(bashResult.content).data.stdout).toContain('todo.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
