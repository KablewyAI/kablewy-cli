import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { CommandContext, MCPMessage, ChatOptions } from '../types/index.js';
import { ChatTUI } from '../ui/tui-chat.js';
import React from 'react';
import { InkChat, runInkChat } from '../ui/ink-chat.js';
import os from 'os';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliError, exitCodeFor, writeJsonError, writeJsonSuccess } from '../core/api-client.js';
import { isScopedApiKey, normalizeApiKey, scopedApiKeyErrorMessage } from '../core/credentials.js';
import { cliTelemetryHeaders } from '../core/telemetry.js';
import {
  AgentSafetyConfig,
  classifyShellCommand,
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  DEFAULT_AGENT_MAX_OUTPUT_BYTES,
  defaultAgentAuditLogPath,
  isPathInside,
  redactText,
  takeOutputChunk
} from '../utils/agent-safety.js';

export function createChatCommand(context: CommandContext): Command {
  const command = new Command('chat');
  
  command
    .description('Start an AI chat session with your knowledge base')
    .option('-s, --session <id>', 'Use existing chat session ID')
    .option('-m, --message <message>', 'Send a single message and exit')
    .option('--system <prompt>', 'Set a system prompt for the assistant')
    .option('--model <name>', 'Model name (default: gpt-5.4)', 'gpt-5.4')
    .option('--tools <json>', 'JSON array of tool names or full tool objects')
    .option('--tools-json <pathOrJson>', 'Path to JSON file or inline JSON with full tool definitions')
    .option('--tools-mode <mode>', 'Tool selection mode: exact|none (default: exact when tools provided)', (v: string) => v as any)
    .option('--ui', 'Enable full-screen TUI chat experience')
    .option('--stream', 'Stream responses in real-time')
    .option('--json', 'Output responses in JSON format')
    .option('--verbose', 'Show detailed conversation information')
    .action(async (options: ChatOptions) => {
      await handleChat(options, context);
    });

  return command;
}

export function createAgentCommand(context: CommandContext): Command {
  const command = new Command('agent');

  command
    .description('Start the Kablewy local agent terminal mode (beta)')
    .option('-s, --session <id>', 'Use existing chat session ID')
    .option('--system <prompt>', 'Set an additional system prompt for the agent')
    .option('--model <name>', 'Model name (default: gpt-5.4)', 'gpt-5.4')
    .option('--tools <json>', 'JSON array of tool names or full tool objects')
    .option('--tools-json <pathOrJson>', 'Path to JSON file or inline JSON with full tool definitions')
    .option('--tools-mode <mode>', 'Tool selection mode: exact|none (default: exact when tools provided)', (v: string) => v as any)
    .option('--cwd <path>', 'Project root for local file reads and shell commands')
    .option('--shell-timeout-ms <ms>', `Local shell command timeout (default: ${DEFAULT_AGENT_COMMAND_TIMEOUT_MS})`, parsePositiveInt)
    .option('--max-output-bytes <bytes>', `Max retained stdout/stderr bytes per stream (default: ${DEFAULT_AGENT_MAX_OUTPUT_BYTES})`, parsePositiveInt)
    .option('--audit-log <path>', 'Write redacted JSONL session audit log to this path')
    .option('--no-audit-log', 'Disable the local redacted JSONL session audit log')
    .option('--allow-dangerous-shell', 'Allow dangerous shell patterns after explicit confirmation')
    .option('--allow-outside-cwd', 'Allow local file attachments and shell commands outside the working directory')
    .option('--allow-shell-without-confirmation', 'Run ! shell commands immediately instead of asking for approval')
    .action(async (options: ChatOptions & {
      allowShellWithoutConfirmation?: boolean;
      allowDangerousShell?: boolean;
      allowOutsideCwd?: boolean;
      cwd?: string;
      shellTimeoutMs?: number;
      maxOutputBytes?: number;
      auditLog?: string | false;
    }) => {
      const cwd = resolveAgentCwd(options.cwd);
      process.chdir(cwd);
      const auditLogPath = options.auditLog === false
        ? undefined
        : typeof options.auditLog === 'string'
          ? path.resolve(cwd, options.auditLog)
          : defaultAgentAuditLogPath(cwd);
      await startInkTuiChat(options.session, {
        ...(options as any),
        ui: true,
        agent: true,
        requireShellApproval: options.allowShellWithoutConfirmation !== true,
        agentSafety: {
          cwd,
          allowDangerousShell: options.allowDangerousShell === true,
          allowOutsideCwd: options.allowOutsideCwd === true,
          requireShellApproval: options.allowShellWithoutConfirmation !== true,
          commandTimeoutMs: options.shellTimeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: options.maxOutputBytes ?? DEFAULT_AGENT_MAX_OUTPUT_BYTES,
          auditLogPath
        }
      } as any, context);
    });

  return command;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function resolveAgentCwd(value: string | undefined): string {
  const cwd = path.resolve(value || process.cwd());
  const stat = fs.existsSync(cwd) ? fs.statSync(cwd) : null;
  if (!stat?.isDirectory()) {
    throw new Error(`Agent cwd is not a directory: ${cwd}`);
  }
  return cwd;
}

async function handleChat(options: ChatOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;
  
  try {
    let sessionId = options.session;
    if (sessionId && !options.json) output.info(`Using existing chat session: ${sessionId}`);

    // If single message mode
    if ((options as any).message) {
      await sendSingleMessage(sessionId, (options as any).message, options, context);
      return;
    }

    // If TUI mode
    if ((options as any).ui) {
      // Use Ink-based TUI
      await startInkTuiChat(sessionId, options, context);
      return;
    }

    // Interactive chat mode
    await startInteractiveChat(sessionId, options, context);
    
  } catch (error: unknown) {
    if (options.json) {
      writeJsonError(context, error);
    } else {
      output.error(`Chat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = exitCodeFor(error);
    if (options.verbose) {
      console.error(error);
    }
  }
}

function safeParseArray(maybeJson: unknown): string[] | null {
  if (!maybeJson) return null;
  if (Array.isArray(maybeJson)) return maybeJson as string[];
  if (typeof maybeJson === 'string') {
    try {
      const parsed = JSON.parse(maybeJson);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      // support comma-separated list fallback
      if (maybeJson.includes(',')) return maybeJson.split(',').map((s) => s.trim()).filter(Boolean);
      return [maybeJson];
    }
  }
  return null;
}

async function resolveToolsOption(toolsOpt: unknown, toolsJsonOpt: unknown): Promise<any[] | null> {
  // Accept either list of names, list of objects, or a JSON file path
  const merged: any[] = [];

  const pushNormalized = (item: any) => {
    if (!item) return;
    if (typeof item === 'string') {
      merged.push({ name: item });
    } else if (typeof item === 'object' && (item as any).name) {
      merged.push(item);
    }
  };

  const fromInline = (() => {
    const arr = safeParseArray(toolsOpt);
    return arr as any[] | null;
  })();
  if (fromInline && fromInline.length) {
    for (const it of fromInline) pushNormalized(it);
  }

  if (toolsJsonOpt) {
    let raw = String(toolsJsonOpt);
    // If value looks like a path, try reading file
    if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) {
      try {
        const fs = await import('fs/promises');
        raw = await fs.readFile(raw, 'utf-8');
      } catch {}
    }
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of arr) pushNormalized(it);
    } catch {
      // ignore parse errors silently
    }
  }

  return merged.length ? merged : null;
}

export async function resolveRequestToolsForChat(options: ChatOptions): Promise<any[] | null> {
  const requested = await resolveToolsOption((options as any).tools, (options as any).toolsJson);
  const toolsMode = (options as any)?.toolsMode as 'exact' | 'none' | undefined;
  const includeLocalTools = Boolean((options as any)?.agent) && toolsMode !== 'none';
  const merged = mergeToolsByName([
    ...(requested || []),
    ...(includeLocalTools ? getLocalFsTools() : [])
  ]);
  return merged.length ? merged : null;
}

function mergeToolsByName(tools: any[]): any[] {
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push(tool);
  }
  return merged;
}

async function sendSingleMessage(sessionId: string | undefined, message: string, options: ChatOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;
  const chatId = ensureChatId(sessionId);
  
  try {
    if (!options.json) {
      output.info(`Sending message: "${message}"`);
    }
    if ((options as any).stream) {
      const text = await streamProcessChat(chatId, message, options, context);
      if (options.json) {
        writeJsonSuccess(context, { response: text });
      } else {
        // stream already printed; ensure newline end
        if (text && !text.endsWith('\n')) process.stdout.write('\n');
      }
      return;
    }
    // Call process_chat directly via JSON-RPC (not as a tool)
    const { apiUrl, orgId, userId, apiKey } = getCoreConfig(context);
    const missing: string[] = [];
    if (!apiUrl) missing.push('apiUrl');
    if (!orgId) missing.push('orgId');
    if (!userId) missing.push('userId');
    if (!apiKey) missing.push('apiKey');
    if (missing.length) {
      const error = new CliError(`Missing configuration: ${missing.join(', ')}`, 'USAGE_ERROR', 2);
      if (options.json) {
        writeJsonError(context, error);
      } else {
        output.error(error.message);
        output.info('Set via environment variables or:');
        output.list([
          'kablewy config --set apiUrl https://kablewy.ai',
          'kablewy config --set orgId <your-org-id>',
          'kablewy config --set userId <your-user-id>',
          'kablewy config --set apiKey <your-api-key>'
        ]);
      }
      process.exitCode = error.exitCode;
      return;
    }
    const baseUrl = (apiUrl || '').replace(/\/+$/, '');
    const url = `${baseUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/jsonrpc`;
    if ((options as any).verbose || process.env.KABLEWY_VERBOSE) {
      console.log(`[chat] POST ${url}`);
    }
    
    const toolsList = await resolveToolsOption((options as any).tools, (options as any).toolsJson);
    const systemPrompt = (options as any).system as string | undefined;
    const model = ((options as any).model as string) || 'gpt-5.4';
    const messagesArr: any[] = [];
    if (systemPrompt) messagesArr.push({ role: 'system', content: systemPrompt });
    messagesArr.push({ role: 'user', content: message });
    const args: any = {
      messages: messagesArr,
      model,
      ...(toolsList && toolsList.length ? { tools: toolsList, tool_choice: 'auto' } : {}),
      options: { createChatIfNeeded: true, chatId },
      chatId
    };

    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: { name: 'process_chat', arguments: args }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: chatRequestHeaders(context, apiKey),
      body: JSON.stringify(body)
    } as any);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Chat request failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`Chat error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    const result = data.result;
    const text = extractProcessChatText(result);

    if (options.json) {
      writeJsonSuccess(context, { response: text });
    } else {
      output.section('AI Response');
      output.info(text);
    }
    
  } catch (error: unknown) {
    const err = error as any;
    if ((options as any).verbose || process.env.KABLEWY_VERBOSE) {
      console.error('[chat] request failed', err?.cause || err);
    }
    if (options.json) {
      writeJsonError(context, error);
    } else {
      output.error(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = exitCodeFor(error);
  }
}

async function startInteractiveChat(sessionId: string | undefined, options: ChatOptions, context: CommandContext): Promise<void> {
  const { output, input, mcpClient } = context;
  const chatId = ensureChatId(sessionId);
  
  output.section('Interactive Chat Mode');
  output.info('Type your messages below. Use /help for commands, /exit to quit.');
  output.info(`Session ID: ${chatId}`);
  
  const messages: MCPMessage[] = [];
  
  let sessionActive = true;
  while (sessionActive) {
    try {
      const userInput = await input.prompt('You: ');
      
      // Handle special commands
      if (userInput.startsWith('/')) {
        const handled = await handleChatCommand(userInput, chatId, options, context);
        if (!handled) {
          sessionActive = false;
        }
        continue;
      }
      
      // Add user message to history
      messages.push({
        role: 'user',
        content: userInput,
        toolCalls: [],
        toolResults: []
      });
      
      // Send message and get response
      output.info('AI: ');
      
      if ((options as any).stream) {
        // Stream the response over MCP HTTP (SSE)
        const streamed = await streamProcessChat(chatId, userInput, options, context);
        messages.push({ role: 'assistant', content: streamed || '', toolCalls: [], toolResults: [] });
      } else {
        // Get complete response
        const { apiUrl, orgId, userId, apiKey } = getCoreConfig(context);
        const missing: string[] = [];
        if (!apiUrl) missing.push('apiUrl');
        if (!orgId) missing.push('orgId');
        if (!userId) missing.push('userId');
        if (!apiKey) missing.push('apiKey');
        if (missing.length) {
          output.error(`Missing configuration: ${missing.join(', ')}`);
          output.list([
            'kablewy config --set apiUrl https://kablewy.ai',
            'kablewy config --set orgId <your-org-id>',
            'kablewy config --set userId <your-user-id>',
            'kablewy config --set apiKey <your-api-key>'
          ]);
          return;
        }
        const baseUrl = (apiUrl || '').replace(/\/+$/, '');
        const url = `${baseUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/jsonrpc`;
        if ((options as any).verbose || process.env.KABLEWY_VERBOSE) {
          console.log(`[chat] POST ${url}`);
        }
        
        const toolsList = await resolveToolsOption((options as any).tools, (options as any).toolsJson);
        const systemPrompt = (options as any).system as string | undefined;
        const model = ((options as any).model as string) || 'gpt-5.4';
        const msgArr: any[] = [];
        if (systemPrompt) msgArr.push({ role: 'system', content: systemPrompt });
        msgArr.push(...messages);
        msgArr.push({ role: 'user', content: userInput });
        const args: any = {
          messages: msgArr,
          model,
          ...(toolsList ? { tools: toolsList, tool_choice: 'auto' } : {}),
          options: { createChatIfNeeded: true, chatId },
          chatId
        };

        const body = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: Date.now(),
          params: { name: 'process_chat', arguments: args }
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: chatRequestHeaders(context, apiKey),
          body: JSON.stringify(body)
        } as any);

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Chat request failed (${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (data.error) {
          throw new Error(`Chat error: ${data.error.message || JSON.stringify(data.error)}`);
        }
        const result = data.result;
        const text = extractProcessChatText(result);
        output.info(text);
        messages.push({
          role: 'assistant',
          content: text,
          toolCalls: [],
          toolResults: []
        });
        
        // Show sources if available (omitted for CLI)
      }
      
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'User interrupted') {
        output.info('\nChat interrupted by user');
        break;
      }
      output.error(`Chat error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  output.info('Chat session ended');
}

function extractProcessChatText(result: any): string {
  // mcpClient returns { success, data }
  const data = result?.data ?? result;
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.response && typeof data.response === 'string') return data.response;
  if (Array.isArray(data.content) && data.content[0]?.text) return data.content[0].text as string;
  return JSON.stringify(data);
}

function getCoreConfig(context: CommandContext): { apiUrl: string; orgId: string; userId: string; apiKey: string } {
  const cfg: any = context.config;
  const apiKey = normalizeApiKey(cfg?.get ? cfg.get('apiKey') : process.env.KABLEWY_API_KEY);
  if (apiKey && !isScopedApiKey(apiKey)) {
    throw new CliError(scopedApiKeyErrorMessage('Configured API key'), 'AUTH_ERROR', 65);
  }
  return {
    apiUrl: cfg?.get ? cfg.get('apiUrl') : process.env.KABLEWY_API_URL,
    orgId: cfg?.get ? cfg.get('orgId') : process.env.KABLEWY_ORG_ID,
    userId: cfg?.get ? cfg.get('userId') : process.env.KABLEWY_USER_ID,
    apiKey,
  } as any;
}

function chatRequestHeaders(context: CommandContext, apiKey: string, acceptEventStream = false): Record<string, string> {
  return {
    ...cliTelemetryHeaders(context.telemetry?.command),
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(acceptEventStream ? { 'Accept': 'text/event-stream' } : {})
  };
}

export function getLocalFsTools(): any[] {
  const cwd = process.cwd();
  // Minimal JSON Schemas for local tools exposed to the model
  return [
    {
      name: 'fs_list_files',
      description: `List files under a directory on the user's machine. CWD is ${cwd}. Use for non-destructive discovery.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative to CWD if not absolute)' },
          max_depth: { type: 'number', description: 'Maximum subdirectory depth', default: 2 },
          include_hidden: { type: 'boolean', description: 'Include dotfiles', default: false },
          glob: { type: 'string', description: 'Optional glob pattern to filter files' }
        }
      }
    },
    {
      name: 'fs_read_file',
      description: 'Read a file from the local filesystem with optional byte window (head/tail).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to CWD if not absolute)' },
          bytes: { type: 'number', description: 'Read this many bytes from head and tail (default by env)', default: Number(process.env.KABLEWY_ATTACH_BYTES || '65536') },
          full: { type: 'boolean', description: 'If true, read entire file (use with caution)' }
        },
        required: ['path']
      }
    },
    {
      name: 'fs_search_files',
      description: 'Search for text in files using ripgrep (rg) if available, else grep.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern' },
          path: { type: 'string', description: 'Directory to search from', default: cwd },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search', default: false }
        },
        required: ['pattern']
      }
    },
    {
      name: 'fs_run_shell',
      description: 'Run a read-only shell command locally. Mutating or dangerous commands are blocked and must be explicitly run by the user with ! command approval.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run (use safe, non-destructive defaults)' },
          cwd: { type: 'string', description: 'Working directory (defaults to current working directory)', default: cwd },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds', default: 60000 }
        },
        required: ['command']
      }
    },
    {
      name: 'fs_write_file',
      description: 'Create or overwrite a text file under the agent root. Use for explicit file writes requested by the user.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write (relative to CWD if not absolute)' },
          content: { type: 'string', description: 'Complete UTF-8 text content to write' },
          create_directories: { type: 'boolean', description: 'Create parent directories if missing', default: true }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'fs_edit_file',
      description: 'Edit a text file under the agent root by replacing an exact string. Use before fs_write_file when preserving most existing content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit (relative to CWD if not absolute)' },
          old_text: { type: 'string', description: 'Exact text to replace' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences instead of exactly one', default: false }
        },
        required: ['path', 'old_text', 'new_text']
      }
    },
    {
      name: 'LS',
      description: 'List files under a directory on the user machine. Alias for fs_list_files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative to CWD if not absolute)' },
          max_depth: { type: 'number', description: 'Maximum subdirectory depth', default: 2 },
          include_hidden: { type: 'boolean', description: 'Include dotfiles', default: false }
        }
      }
    },
    {
      name: 'Read',
      description: 'Read a text file from the local filesystem. Alias for fs_read_file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path to read (relative to CWD if not absolute)' },
          bytes: { type: 'number', description: 'Read this many bytes from head and tail for large files' },
          full: { type: 'boolean', description: 'If true, read the entire file' }
        },
        required: ['file_path']
      }
    },
    {
      name: 'Grep',
      description: 'Search for text in files under the agent root. Alias for fs_search_files.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern' },
          path: { type: 'string', description: 'Directory or file to search from', default: cwd },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search', default: false }
        },
        required: ['pattern']
      }
    },
    {
      name: 'Bash',
      description: 'Run a read-only shell command locally. Mutating or dangerous commands are blocked and should use explicit ! approval.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Read-only command to run' },
          cwd: { type: 'string', description: 'Working directory under the agent root', default: cwd },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds', default: 60000 }
        },
        required: ['command']
      }
    },
    {
      name: 'Write',
      description: 'Create or overwrite a text file under the agent root. Alias for fs_write_file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path to write (relative to CWD if not absolute)' },
          content: { type: 'string', description: 'Complete UTF-8 text content to write' },
          create_directories: { type: 'boolean', description: 'Create parent directories if missing', default: true }
        },
        required: ['file_path', 'content']
      }
    },
    {
      name: 'Edit',
      description: 'Edit a text file under the agent root by replacing an exact string. Alias for fs_edit_file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path to edit (relative to CWD if not absolute)' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences instead of exactly one', default: false }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    }
  ];
}

function ensureChatId(sessionId: string | undefined): string {
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  return trimmed || randomUUID();
}

async function buildStreamHttpError(res: Response): Promise<Error> {
  const requestIdText = formatResponseRequestId(res);
  const text = await res.text().catch(() => '');
  const detail = streamErrorDetail(text);
  return new Error(`Stream request failed (${res.status})${detail ? `: ${detail}` : ''}${requestIdText}`);
}

function formatResponseRequestId(res: Response): string {
  const requestId = res.headers.get('x-request-id') || res.headers.get('cf-ray');
  return requestId ? ` (requestId: ${requestId})` : '';
}

function streamErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.error ||
      parsed?.detail ||
      parsed?.details;
    if (typeof message === 'string') return message;
    return JSON.stringify(parsed).slice(0, 500);
  } catch {
    return trimmed.slice(0, 500);
  }
}

type LocalToolResultMessage = {
  role: 'tool';
  content: string;
  tool_call_id: string;
  name?: string;
};

type StreamContinuationPayload = {
  tool_calls: any[];
  response?: string;
  chat_id?: string;
};

const LOCAL_AGENT_TOOL_NAMES = new Set([
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
]);

function canonicalLocalToolName(name: string): string {
  switch (name) {
    case 'LS': return 'fs_list_files';
    case 'Read': return 'fs_read_file';
    case 'Grep': return 'fs_search_files';
    case 'Bash': return 'fs_run_shell';
    case 'Write': return 'fs_write_file';
    case 'Edit': return 'fs_edit_file';
    default: return name;
  }
}

function normalizeToolCallName(toolCall: any): string {
  return String(toolCall?.name || toolCall?.function?.name || '').trim();
}

function normalizeToolCallId(toolCall: any): string {
  return String(toolCall?.id || toolCall?.tool_call_id || `${normalizeToolCallName(toolCall)}-${Date.now()}`);
}

function parseToolCallArguments(toolCall: any): Record<string, any> {
  const raw = toolCall?.arguments ?? toolCall?.function?.arguments ?? {};
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function normalizeLocalToolArguments(name: string, args: Record<string, any>): Record<string, any> {
  if (name === 'Read') return { ...args, path: args.path ?? args.file_path };
  if (name === 'Write') return { ...args, path: args.path ?? args.file_path };
  if (name === 'Edit') {
    return {
      ...args,
      path: args.path ?? args.file_path,
      old_text: args.old_text ?? args.old_string,
      new_text: args.new_text ?? args.new_string,
    };
  }
  return args;
}

function resolveAgentToolPath(rootCwd: string, rawPath: unknown, allowOutsideCwd: boolean): string {
  const value = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';
  const resolved = path.resolve(rootCwd, value);
  if (!allowOutsideCwd && !isPathInside(rootCwd, resolved)) {
    throw new Error(`Path is outside the agent root: ${value}`);
  }
  return resolved;
}

async function listAgentFiles(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const start = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const maxDepth = Math.max(0, Math.min(8, Number(args.max_depth ?? 2)));
  const includeHidden = args.include_hidden === true;
  const maxEntries = Math.max(1, Math.min(1000, Number(args.max_entries ?? 300)));
  const entries: Array<Record<string, any>> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries.length >= maxEntries) return;
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) break;
      if (!includeHidden && dirent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, dirent.name);
      if (!safety.allowOutsideCwd && !isPathInside(rootCwd, fullPath)) continue;
      const rel = path.relative(rootCwd, fullPath) || '.';
      const stat = await fsp.stat(fullPath).catch(() => null);
      entries.push({
        path: rel,
        type: dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other',
        size: stat?.size ?? null,
        modified: stat?.mtime?.toISOString?.() ?? null,
      });
      if (dirent.isDirectory() && depth < maxDepth) {
        await walk(fullPath, depth + 1);
      }
    }
  };

  const stat = await fsp.stat(start);
  if (stat.isDirectory()) {
    await walk(start, 0);
  } else {
    entries.push({
      path: path.relative(rootCwd, start) || '.',
      type: 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return {
    root: rootCwd,
    path: path.relative(rootCwd, start) || '.',
    count: entries.length,
    truncated: entries.length >= maxEntries,
    entries,
  };
}

async function readAgentFile(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const filePath = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('Path is not a file');
  const bytes = Math.max(1024, Math.min(512 * 1024, Number(args.bytes ?? process.env.KABLEWY_ATTACH_BYTES ?? 65536)));
  const full = args.full === true || stat.size <= bytes * 2;
  const buffer = await fsp.readFile(filePath);
  const rel = path.relative(rootCwd, filePath) || '.';
  if (full) {
    return {
      path: rel,
      size: stat.size,
      truncated: false,
      content: redactText(buffer.toString('utf8')),
    };
  }
  return {
    path: rel,
    size: stat.size,
    truncated: true,
    head_bytes: bytes,
    tail_bytes: bytes,
    head: redactText(buffer.subarray(0, bytes).toString('utf8')),
    tail: redactText(buffer.subarray(Math.max(0, buffer.length - bytes)).toString('utf8')),
  };
}

async function searchAgentFiles(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const pattern = String(args.pattern || '').trim();
  if (!pattern) throw new Error('pattern is required');
  const start = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const caseInsensitive = args.case_insensitive === true;
  const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
  const maxFiles = Math.max(1, Math.min(3000, Number(args.max_files ?? 1000)));
  const maxMatches = Math.max(1, Math.min(500, Number(args.max_matches ?? 100)));
  const matches: Array<Record<string, any>> = [];
  let scannedFiles = 0;

  const scanFile = async (filePath: string): Promise<void> => {
    if (scannedFiles >= maxFiles || matches.length >= maxMatches) return;
    scannedFiles += 1;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return;
    const content = await fsp.readFile(filePath, 'utf8').catch(() => null);
    if (content == null) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const haystack = caseInsensitive ? lines[i].toLowerCase() : lines[i];
      if (haystack.includes(needle)) {
        matches.push({
          path: path.relative(rootCwd, filePath) || '.',
          line: i + 1,
          text: redactText(lines[i].slice(0, 500)),
        });
      }
    }
  };

  const walk = async (target: string): Promise<void> => {
    if (scannedFiles >= maxFiles || matches.length >= maxMatches) return;
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) return;
    if (stat.isFile()) {
      await scanFile(target);
      return;
    }
    if (!stat.isDirectory()) return;
    const dirents = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || ['node_modules', 'dist', 'coverage', '.git'].includes(dirent.name)) continue;
      await walk(path.join(target, dirent.name));
      if (scannedFiles >= maxFiles || matches.length >= maxMatches) break;
    }
  };

  await walk(start);
  return {
    root: rootCwd,
    path: path.relative(rootCwd, start) || '.',
    pattern,
    scannedFiles,
    count: matches.length,
    truncated: scannedFiles >= maxFiles || matches.length >= maxMatches,
    matches,
  };
}

async function runReadOnlyAgentShell(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command is required');
  const classification = classifyShellCommand(command);
  if (classification.usesOutsideCwd && !safety.allowOutsideCwd) {
    throw new Error('Shell command references paths outside the agent root. Ask the user to run it with ! approval.');
  }
  if (classification.risk !== 'read') {
    throw new Error(`Shell command is ${classification.risk}; ask the user to run it with ! approval instead of executing it as an autonomous tool.`);
  }
  const cwd = resolveAgentToolPath(rootCwd, args.cwd || '.', safety.allowOutsideCwd);
  const timeoutMs = Math.max(1000, Math.min(safety.commandTimeoutMs, Number(args.timeout_ms ?? safety.commandTimeoutMs)));
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, { shell: true, cwd });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      const limited = takeOutputChunk(redactText(data.toString()), stdoutBytes, safety.maxOutputBytes);
      stdoutBytes = limited.usedBytes;
      stdout += limited.text;
      stdoutTruncated ||= limited.truncated;
    });
    child.stderr.on('data', (data) => {
      const limited = takeOutputChunk(redactText(data.toString()), stderrBytes, safety.maxOutputBytes);
      stderrBytes = limited.usedBytes;
      stderr += limited.text;
      stderrTruncated ||= limited.truncated;
    });
    child.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  return {
    command,
    cwd: path.relative(rootCwd, cwd) || '.',
    exitCode,
    timedOut,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    classification,
  };
}

async function writeAgentFile(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const filePath = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const content = typeof args.content === 'string' ? args.content : '';
  if (args.create_directories !== false) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
  }
  const before = await fsp.stat(filePath).catch(() => null);
  await fsp.writeFile(filePath, content, 'utf8');
  const after = await fsp.stat(filePath);
  return {
    path: path.relative(rootCwd, filePath) || '.',
    created: !before,
    bytes: after.size,
  };
}

async function editAgentFile(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const filePath = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const oldText = typeof args.old_text === 'string' ? args.old_text : '';
  const newText = typeof args.new_text === 'string' ? args.new_text : '';
  if (!oldText) throw new Error('old_text is required');
  const original = await fsp.readFile(filePath, 'utf8');
  const occurrences = original.split(oldText).length - 1;
  if (occurrences === 0) throw new Error('old_text was not found');
  if (occurrences > 1 && args.replace_all !== true) {
    throw new Error(`old_text matched ${occurrences} times; set replace_all=true or provide a more specific old_text`);
  }
  const edited = args.replace_all === true
    ? original.split(oldText).join(newText)
    : original.replace(oldText, newText);
  await fsp.writeFile(filePath, edited, 'utf8');
  return {
    path: path.relative(rootCwd, filePath) || '.',
    replacements: args.replace_all === true ? occurrences : 1,
    bytesBefore: Buffer.byteLength(original, 'utf8'),
    bytesAfter: Buffer.byteLength(edited, 'utf8'),
  };
}

export async function executeLocalAgentToolCall(toolCall: any, safetyConfig?: AgentSafetyConfig): Promise<LocalToolResultMessage> {
  const name = normalizeToolCallName(toolCall);
  const canonicalName = canonicalLocalToolName(name);
  const toolCallId = normalizeToolCallId(toolCall);
  const rootCwd = safetyConfig?.cwd ? path.resolve(safetyConfig.cwd) : process.cwd();
  const safety: AgentSafetyConfig = safetyConfig || {
    cwd: rootCwd,
    allowDangerousShell: false,
    allowOutsideCwd: false,
    requireShellApproval: true,
    commandTimeoutMs: DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_AGENT_MAX_OUTPUT_BYTES,
  };
  const args = normalizeLocalToolArguments(name, parseToolCallArguments(toolCall));

  const finish = (payload: Record<string, any>): LocalToolResultMessage => ({
    role: 'tool',
    name,
    tool_call_id: toolCallId,
    content: JSON.stringify(payload),
  });

  try {
    if (!LOCAL_AGENT_TOOL_NAMES.has(name)) {
      throw new Error(`Tool ${name || '(unknown)'} is not available as a local CLI tool`);
    }
    const result = canonicalName === 'fs_list_files'
      ? await listAgentFiles(rootCwd, args, safety)
      : canonicalName === 'fs_read_file'
        ? await readAgentFile(rootCwd, args, safety)
        : canonicalName === 'fs_search_files'
          ? await searchAgentFiles(rootCwd, args, safety)
          : canonicalName === 'fs_write_file'
            ? await writeAgentFile(rootCwd, args, safety)
            : canonicalName === 'fs_edit_file'
              ? await editAgentFile(rootCwd, args, safety)
              : await runReadOnlyAgentShell(rootCwd, args, safety);
    return finish({ success: true, data: result });
  } catch (error: unknown) {
    return finish({
      success: false,
      error: {
        code: 'LOCAL_TOOL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function streamProcessChat(sessionId: string | undefined, message: string, _options: ChatOptions, context: CommandContext): Promise<string> {
  const chatId = ensureChatId(sessionId);
  const { apiUrl, orgId, userId, apiKey } = getCoreConfig(context);
  const missing: string[] = [];
  if (!apiUrl) missing.push('apiUrl');
  if (!orgId) missing.push('orgId');
  if (!userId) missing.push('userId');
  if (!apiKey) missing.push('apiKey');
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}`);
  }
  const baseUrl = (apiUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/http`;
  if (((_options as any)?.verbose) || process.env.KABLEWY_VERBOSE) {
    console.log(`[chat] SSE ${url}`);
  }

  const model = ((_options as any)?.model as string) || 'gpt-5.4';
  const systemPrompt = ((_options as any)?.system as string) || undefined;
  const toolsList = await resolveToolsOption(((_options as any)?.tools), ((_options as any)?.toolsJson));
  const msgArr: any[] = [];
  if (systemPrompt) msgArr.push({ role: 'system', content: systemPrompt });
  msgArr.push({ role: 'user', content: message });
  const args: any = {
    messages: msgArr,
    model,
    ...(toolsList && toolsList.length ? { tools: toolsList, tool_choice: 'auto' } : {}),
    stream: true,
    chatId,
    options: { createChatIfNeeded: true, chatId }
  };

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: `chat-${Date.now()}`,
    params: { name: 'process_chat', arguments: args }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: chatRequestHeaders(context, apiKey, true),
    body: JSON.stringify(body)
  } as any);

  if (!res.ok) {
    throw await buildStreamHttpError(res);
  }
  if (!res.body) {
    throw new Error(`Stream request failed (${res.status}): response body was empty${formatResponseRequestId(res)}`);
  }

  const reader = (res.body as any).getReader?.();
  if (!reader) {
    // Fallback: non-stream JSON
    const data = await res.json();
    const text = extractProcessChatText({ data: data?.result });
    process.stdout.write(text + '\n');
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let aggregated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') break;
      try {
        const event = JSON.parse(payload);
        // JSON-RPC envelope
        if (event.jsonrpc === '2.0' && event.result?.content) {
          const items = event.result.content;
          for (const item of items) {
            if (item.type === 'text' && item.text) {
              process.stdout.write(item.text);
              aggregated += item.text;
            }
          }
          continue;
        }
        // Stream event types from MCP HTTP worker
        switch (event.type) {
          case 'content': {
            const chunk = event.content || '';
            process.stdout.write(chunk);
            aggregated += chunk;
            break;
          }
          case 'message_end': {
            // no-op; handled by loop end
            break;
          }
          case 'tool_call': {
            if (process.env.KABLEWY_VERBOSE) process.stdout.write(`\n[tool_call] ${event.tool_call?.name || ''}\n`);
            break;
          }
          case 'tool_result': {
            if (process.env.KABLEWY_VERBOSE) process.stdout.write(`\n[tool_result]\n`);
            break;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  process.stdout.write('\n');
  return aggregated;
}

async function startTuiChat(sessionId: string | undefined, options: ChatOptions, context: CommandContext): Promise<void> {
  const chatId = ensureChatId(sessionId);
  const tui = new ChatTUI({
    onSubmit: async (text: string) => {
      try {
        // Phase: Thinking
        tui.setStatusPhase('Thinking');
        await streamProcessChatWithCallbacks(chatId, text, options, context, {
          onText: (chunk) => {
            tui.setStatusPhase('Generating');
            // Do not print status label on every chunk; only first entry triggers phase update
            tui.appendAssistantChunk(chunk);
          },
          onToolEvent: (evt) => {
            // Detect specific tool event names
            const match = /tool_call: (.+)$/.exec(evt || '');
            if (match && match[1]) {
              tui.setStatusPhase('Tool', match[1]);
            } else if ((evt || '').includes('tool_result')) {
              tui.setStatusPhase('Waiting');
            }
            tui.appendToolEvent(evt);
          }
        });
        tui.setStatusPhase('Done');
      } catch (e: any) {
        tui.appendToolEvent(`Error: ${e?.message || String(e)}`);
      }
    },
    onExit: () => {}
  });
}

async function startInkTuiChat(sessionId: string | undefined, options: ChatOptions, context: CommandContext): Promise<void> {
  let liveChatId: string | undefined = ensureChatId(sessionId);

  const ui = React.createElement(InkChat, {
    title: (options as any).agent ? 'Kablewy Agent' : 'Kablewy Chat',
    mode: (options as any).agent ? 'agent' : 'chat',
    model: (options as any).model || 'gpt-5.4',
    requireShellApproval: Boolean((options as any).requireShellApproval),
    safety: (options as any).agentSafety,
    startStreaming: async (
      text: string,
      history: Array<{ role: 'user' | 'assistant'; content: string }>,
      handlers: { onText: (chunk: string) => void; onTool: (evt: string) => void; onDone: () => void },
      request?: { model: string }
    ) => {
      // For each submit, stream with compact history so backend sees prior turns
      const histPrefix = history.flatMap(h => [{ role: h.role, content: h.content }]);
      const sys = (((options as any)?.system as string) || '').trim();
      const systemMsg = sys ? [{ role: 'system', content: sys }] : [] as any[];
      await streamProcessChatWithCallbacks(liveChatId, text, {
        ...(options as any),
        model: request?.model || (options as any).model || 'gpt-5.4',
        __history: histPrefix,
        __systemArray: systemMsg
      } as any, context, {
        onText: (chunk) => handlers.onText(chunk),
        onToolEvent: (evt) => handlers.onTool(evt),
        onChatId: (id: string) => { liveChatId = id; }
      });
      handlers.onDone();
    },
    onExit: () => {
      // nothing special; Ink will exit
    }
  });
  runInkChat(ui);
}

function extractContinuationPayload(payload: any): StreamContinuationPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const toolCalls = Array.isArray(payload.tool_calls)
    ? payload.tool_calls
    : Array.isArray(payload.pending_tool_calls)
      ? payload.pending_tool_calls
      : [];
  const requiresContinuation =
    payload.requiresContinuation === true ||
    payload.requires_continuation === true ||
    payload.status === 'awaiting_confirmation' ||
    toolCalls.length > 0;
  if (!requiresContinuation) return null;
  return {
    tool_calls: toolCalls,
    response: typeof payload.response === 'string' ? payload.response : '',
    chat_id: payload.chat_id ?? payload.chatId,
  };
}

function parseTextContinuationPayload(text: string): StreamContinuationPayload | null {
  try {
    return extractContinuationPayload(JSON.parse(text));
  } catch {
    return null;
  }
}

async function executeLocalContinuationTools(
  payload: StreamContinuationPayload,
  options: ChatOptions,
  cb: { onToolEvent: (text: string) => void }
): Promise<LocalToolResultMessage[]> {
  const safety = (options as any)?.agentSafety as AgentSafetyConfig | undefined;
  const results: LocalToolResultMessage[] = [];
  for (const toolCall of payload.tool_calls) {
    const name = normalizeToolCallName(toolCall);
    cb.onToolEvent(`local_tool_call: ${name}`);
    const result = await executeLocalAgentToolCall(toolCall, safety);
    cb.onToolEvent(`local_tool_result: ${name}`);
    results.push(result);
  }
  return results;
}

async function streamProcessChatWithCallbacks(
  sessionId: string | undefined,
  message: string,
  _options: ChatOptions,
  context: CommandContext,
  cb: { onText: (chunk: string) => void; onToolEvent: (text: string) => void; onChatId?: (id: string) => void }
): Promise<string> {
  const chatId = ensureChatId(sessionId);
  const { apiUrl, orgId, userId, apiKey } = getCoreConfig(context);
  const missing: string[] = [];
  if (!apiUrl) missing.push('apiUrl');
  if (!orgId) missing.push('orgId');
  if (!userId) missing.push('userId');
  if (!apiKey) missing.push('apiKey');
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}`);
  }
  const baseUrl = (apiUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/http`;

  const model = ((_options as any)?.model as string) || 'gpt-5.4';
  const userSystem = ((_options as any)?.system as string) || undefined;
  const isAgentMode = Boolean((_options as any)?.agent);
  const injectedSystem = [
    isAgentMode ? 'You are running inside Kablewy Agent, a beta local terminal agent mode.' : 'You are running inside the Kablewy CLI Enhanced TUI.',
    'Capabilities for this terminal session:',
    isAgentMode
      ? '- Local tools: Prefer LS, Read, Grep, Write, Edit, and Bash under the current project root. Bash is restricted to read-only commands; use Write/Edit for file changes. Mutating or dangerous shell commands are blocked unless the user explicitly runs them with ! command approval.'
      : '- Shell: The user can execute shell commands directly by prefixing with !, and may enable autorun. When you propose commands, output them in bash code fences or lines starting with "$ ". Keep them safe and reproducible. Prefer read-only commands by default. Use the project root as the working directory unless stated otherwise.',
    isAgentMode ? '- Shell UX: If a command is mutating or destructive, propose it in a bash code fence or ask the user to run it with ! so the terminal approval flow can protect the workspace.' : '',
    '- File attachments: The user can attach files using @ path. You can assume attached files are included in the hidden context even if the transcript only shows the paths.',
    '- Tools: Only call tools that are explicitly provided in this request (tool_choice=auto). Do not assume local filesystem tools unless listed. Use document tools for Kablewy documents.',
    isAgentMode ? '- File edits: You may claim an edit only after Write/Edit or fs_write_file/fs_edit_file reports success, or after the user runs a command that changes files.' : '',
    'Guidelines:',
    '- When the user asks for a command, provide one or more exact commands in a bash code fence and optionally a 1–2 line note.',
    '- For searches, prefer ripgrep (rg) with sensible flags (e.g., rg -n -S "pattern" src/). If rg is unavailable, fall back to grep -rn.',
    '- Avoid destructive commands unless explicitly requested.',
  ].join('\n');
  const systemPrompt = userSystem ? `${injectedSystem}\n\n${userSystem}` : injectedSystem;
  const toolsList = await resolveRequestToolsForChat(_options);
  const toolsMode = ((_options as any)?.toolsMode as 'exact' | 'none' | undefined);
  const hist = ((_options as any)?.__history as Array<{ role: 'user' | 'assistant'; content: string }>) || [];
  const maxHistMsgs = Number(process.env.KABLEWY_HISTORY_MAX_MSGS || '16');
  const maxHistChars = Number(process.env.KABLEWY_HISTORY_TOTAL_CHARS || '64000');
  const histSlice = maxHistMsgs > 0 ? hist.slice(Math.max(0, hist.length - maxHistMsgs)) : [];
  const baseMessages: any[] = [];
  if (systemPrompt) baseMessages.push({ role: 'system', content: systemPrompt });
  let acc = 0;
  for (const h of histSlice) {
    const text = (h.content || '');
    if (acc >= maxHistChars) break;
    const remaining = maxHistChars - acc;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    baseMessages.push({ role: h.role, content: clipped });
    acc += clipped.length;
  }
  baseMessages.push({ role: 'user', content: message });

  let continuationMessages: LocalToolResultMessage[] = [];
  let continuation = false;
  let totalAggregated = '';

  for (let turn = 0; turn < 6; turn++) {
    const msgArr = [...baseMessages, ...continuationMessages];
    const args: any = {
      messages: msgArr,
      model,
      ...(toolsMode === 'none' ? { tools: [] } : (toolsList && toolsList.length ? { tools: toolsList } : {})),
      stream: true,
      chatId,
      options: { createChatIfNeeded: true, chatId, ...(continuation ? { continuation: true } : {}) }
    };

    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: `chat-${Date.now()}-${turn}`,
      params: { name: 'process_chat', arguments: args }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: chatRequestHeaders(context, apiKey, true),
      body: JSON.stringify(body)
    } as any);

    if (!res.ok) {
      throw await buildStreamHttpError(res);
    }
    if (!res.body) {
      throw new Error(`Stream request failed (${res.status}): response body was empty${formatResponseRequestId(res)}`);
    }

    const reader = (res.body as any).getReader?.();
    if (!reader) {
      const data = await res.json();
      const text = extractProcessChatText({ data: data?.result });
      const parsedContinuation = parseTextContinuationPayload(text);
      if (parsedContinuation) {
        continuationMessages = await executeLocalContinuationTools(parsedContinuation, _options, cb);
        continuation = true;
        continue;
      }
      cb.onText(text + '\n');
      return totalAggregated + text;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let turnAggregated = '';
    let emittedChatId = false;
    let pendingContinuation: StreamContinuationPayload | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') break;
        try {
          const event = JSON.parse(payload);
          const progressMeta = event?.method === 'notifications/progress' ? event?.params?._meta : null;
          if (progressMeta?.tool_call) {
            cb.onToolEvent(`tool_call: ${normalizeToolCallName(progressMeta.tool_call)}`);
            continue;
          }
          if (progressMeta?.tool_result) {
            cb.onToolEvent(`tool_result: ${progressMeta.tool_result?.name || progressMeta.tool_result?.toolName || ''}`);
            continue;
          }
          const metaContinuation = extractContinuationPayload(progressMeta);
          if (metaContinuation) {
            pendingContinuation = metaContinuation;
            if (metaContinuation.chat_id && !emittedChatId && cb.onChatId) {
              cb.onChatId(metaContinuation.chat_id);
              emittedChatId = true;
            }
            continue;
          }
          if (event.jsonrpc === '2.0' && event.result?.content) {
            const items = event.result.content;
            for (const item of items) {
              if (item.type === 'text' && item.text) {
                const parsedContinuation = parseTextContinuationPayload(item.text);
                if (parsedContinuation) {
                  pendingContinuation = parsedContinuation;
                } else {
                  cb.onText(item.text);
                  turnAggregated += item.text;
                }
              }
            }
            continue;
          }
          const directContinuation = event.type === 'tool_calls_response'
            ? extractContinuationPayload({ ...event, requiresContinuation: true })
            : extractContinuationPayload(event);
          if (directContinuation) {
            pendingContinuation = directContinuation;
            if (directContinuation.chat_id && !emittedChatId && cb.onChatId) {
              cb.onChatId(directContinuation.chat_id);
              emittedChatId = true;
            }
            continue;
          }
          switch (event.type) {
            case 'content': {
              const chunk = event.content || '';
              cb.onText(chunk);
              turnAggregated += chunk;
              break;
            }
            case 'message_end': {
              const cid = event?.chatId || event?.data?.chatId;
              if (!emittedChatId && cid && cb.onChatId) {
                cb.onChatId(cid);
                emittedChatId = true;
              }
              break;
            }
            case 'tool_call': {
              cb.onToolEvent(`tool_call: ${normalizeToolCallName(event.tool_call)}`);
              break;
            }
            case 'tool_result': {
              cb.onToolEvent(`tool_result: ${event.tool_result?.name || event.tool_result?.toolName || ''}`);
              break;
            }
          }
        } catch {}
      }
    }

    if (pendingContinuation?.response && !turnAggregated.trim()) {
      cb.onText(pendingContinuation.response);
      turnAggregated += pendingContinuation.response;
    }
    totalAggregated += turnAggregated;
    if (!pendingContinuation || pendingContinuation.tool_calls.length === 0) {
      return totalAggregated;
    }
    if (!isAgentMode) {
      cb.onToolEvent(`tool_calls_pending: ${pendingContinuation.tool_calls.map(normalizeToolCallName).filter(Boolean).join(', ')}`);
      return totalAggregated;
    }
    continuationMessages = await executeLocalContinuationTools(pendingContinuation, _options, cb);
    continuation = true;
  }

  throw new Error('Local tool continuation exceeded the maximum turn limit');
}

async function streamChatResponse(sessionId: string, message: string, options: ChatOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;
  
  try {
    // Start streaming chat
    const chatStream = mcpClient.startChat([{
      role: 'user',
      content: message,
      toolCalls: [],
      toolResults: []
    }]);
    
    for await (const response of chatStream) {
      if (response.content) {
        process.stdout.write(response.content);
      }
      
      if (response.toolCalls && response.toolCalls.length > 0) {
        output.info('\n[Using tools...]');
        for (const toolCall of response.toolCalls) {
          output.info(`  - ${toolCall.name}`);
        }
      }
    }
    
    process.stdout.write('\n');
    
  } catch (error: unknown) {
    output.error(`Streaming failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleChatCommand(command: string, sessionId: string, options: ChatOptions, context: CommandContext): Promise<boolean> {
  const { output } = context;
  
  const [cmd, ...args] = command.slice(1).split(' ');
  
  switch (cmd) {
    case 'help':
      output.section('Chat Commands');
      output.list([
        '/help - Show this help message',
        '/exit - Exit the chat session',
        '/clear - Clear the conversation history',
        '/context - Show current context documents',
        '/session - Show session information',
        '/save <filename> - Save conversation to file'
      ]);
      return true;
      
    case 'exit':
    case 'quit':
      output.info('Exiting chat...');
      return false;
      
    case 'clear':
      output.info('Conversation history cleared');
      return true;
      
    case 'context':
      output.info(`Current session: ${sessionId}`);
      // TODO: Show context documents
      return true;
      
    case 'session':
      output.info(`Session ID: ${sessionId}`);
      // TODO: Show session details
      return true;
      
    case 'save': {
      const filename = args[0] || `chat-${sessionId}-${Date.now()}.txt`;
      output.info(`Saving conversation to ${filename}...`);
      // TODO: Implement save functionality
      return true;
    }
      
    default:
      output.warning(`Unknown command: /${cmd}. Use /help for available commands.`);
      return true;
  }
}
