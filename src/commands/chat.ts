import { Command } from 'commander';
import { CommandContext, MCPMessage, ChatOptions } from '../types/index.js';
import { ChatTUI } from '../ui/tui-chat.js';
import React from 'react';
import { InkChat, runInkChat } from '../ui/ink-chat.js';
import os from 'os';
import fs from 'node:fs';
import path from 'node:path';
import { CliError, exitCodeFor, writeJsonError, writeJsonSuccess } from '../core/api-client.js';
import { isScopedApiKey, normalizeApiKey, scopedApiKeyErrorMessage } from '../core/credentials.js';
import { cliTelemetryHeaders } from '../core/telemetry.js';
import {
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  DEFAULT_AGENT_MAX_OUTPUT_BYTES,
  defaultAgentAuditLogPath
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

async function sendSingleMessage(sessionId: string | undefined, message: string, options: ChatOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;
  
  try {
    if (!options.json) {
      output.info(`Sending message: "${message}"`);
    }
    if ((options as any).stream) {
      const text = await streamProcessChat(sessionId, message, options, context);
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
      options: { createChatIfNeeded: true, ...(sessionId ? { chatId: sessionId } : {}) },
      ...(sessionId ? { chatId: sessionId } : {})
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
  
  output.section('Interactive Chat Mode');
  output.info('Type your messages below. Use /help for commands, /exit to quit.');
  output.info(`Session ID: ${sessionId || 'auto-generated'}`);
  
  const messages: MCPMessage[] = [];
  
  let sessionActive = true;
  while (sessionActive) {
    try {
      const userInput = await input.prompt('You: ');
      
      // Handle special commands
      if (userInput.startsWith('/')) {
        const handled = await handleChatCommand(userInput, sessionId || '', options, context);
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
        const streamed = await streamProcessChat(sessionId, userInput, options, context);
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
          options: { createChatIfNeeded: true, ...(sessionId ? { chatId: sessionId } : {}) },
          ...(sessionId ? { chatId: sessionId } : {})
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

function getLocalFsTools(): any[] {
  const cwd = process.cwd();
  const home = os.homedir?.() || '';
  // Minimal JSON Schemas for local tools exposed to the model
  return [
    {
      name: 'fs_list_files',
      description: `List files under a directory on the user's machine. CWD is ${cwd}. Use for non-destructive discovery.`,
      input_schema: {
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
      input_schema: {
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
      input_schema: {
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
      description: 'Run a shell command locally. Prefer read-only commands (ls, cat, rg). The UI will stream output and summarize.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run (use safe, non-destructive defaults)' },
          cwd: { type: 'string', description: 'Working directory (defaults to current working directory)', default: cwd },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds', default: 60000 }
        },
        required: ['command']
      }
    }
  ];
}

async function streamProcessChat(sessionId: string | undefined, message: string, _options: ChatOptions, context: CommandContext): Promise<string> {
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
    ...(sessionId ? { chatId: sessionId } : {}),
    options: { createChatIfNeeded: true, ...(sessionId ? { chatId: sessionId } : {}) }
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

  if (!res.ok || !res.body) {
    throw new Error(`Stream request failed (${res.status})`);
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
  const tui = new ChatTUI({
    onSubmit: async (text: string) => {
      try {
        // Phase: Thinking
        tui.setStatusPhase('Thinking');
        await streamProcessChatWithCallbacks(sessionId, text, options, context, {
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
  // Bridge: convert our existing streaming logic into async generators for Ink
  const streamController = createAsyncGenerator<string>();
  const toolController = createAsyncGenerator<string>();
  let liveChatId: string | undefined = sessionId;

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
      const payload = { role: 'user', content: text } as const;
      const mergedMessage = JSON.stringify({ _compose: true }); // marker not sent
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

function createAsyncGenerator<T>() {
  let queue: (T | symbol)[] = [];
  let resolve: ((value: IteratorResult<T>) => void) | null = null;
  const done = Symbol('done');
  const generator: AsyncGenerator<T> = {
    next() {
      if (queue.length) {
        const item = queue.shift()!;
        if (item === done) return Promise.resolve({ value: undefined as any, done: true });
        return Promise.resolve({ value: item as T, done: false });
      }
      return new Promise<IteratorResult<T>>((res) => { resolve = res; });
    },
    return() { return Promise.resolve({ value: undefined as any, done: true }); },
    throw(e: unknown) { return Promise.reject(e); },
    [Symbol.asyncIterator]() { return this; }
  } as any;
  const push = (val: T) => {
    if (resolve) { const r = resolve; resolve = null; r({ value: val, done: false }); } else { queue.push(val); }
  };
  const close = () => {
    if (resolve) { const r = resolve; resolve = null; r({ value: undefined as any, done: true }); } else { queue.push(done); }
  };
  return { generator, push, close };
}

async function streamProcessChatWithCallbacks(
  sessionId: string | undefined,
  message: string,
  _options: ChatOptions,
  context: CommandContext,
  cb: { onText: (chunk: string) => void; onToolEvent: (text: string) => void; onChatId?: (id: string) => void }
): Promise<string> {
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
      ? '- Shell: The user can execute shell commands by prefixing with !. Agent mode asks for approval before running local commands unless explicitly disabled. When you propose commands, output them in bash code fences or lines starting with "$ ". Keep them safe and reproducible. Prefer read-only commands by default. Use the current working directory as the project root unless stated otherwise.'
      : '- Shell: The user can execute shell commands directly by prefixing with !, and may enable autorun. When you propose commands, output them in bash code fences or lines starting with "$ ". Keep them safe and reproducible. Prefer read-only commands by default. Use the project root as the working directory unless stated otherwise.',
    '- File attachments: The user can attach files using @ path. You can assume attached files are included in the hidden context even if the transcript only shows the paths.',
    '- Tools: Only call tools that are explicitly provided in this request (tool_choice=auto). Do not assume local filesystem tools unless listed. Use document tools for Kablewy documents.',
    isAgentMode ? '- File edits: Do not claim to have edited local files unless the user ran a command that did so. Prefer proposing clear unified diffs or exact commands for the user to approve.' : '',
    'Guidelines:',
    '- When the user asks for a command, provide one or more exact commands in a bash code fence and optionally a 1–2 line note.',
    '- For searches, prefer ripgrep (rg) with sensible flags (e.g., rg -n -S "pattern" src/). If rg is unavailable, fall back to grep -rn.',
    '- Avoid destructive commands unless explicitly requested.',
  ].join('\n');
  const systemPrompt = userSystem ? `${injectedSystem}\n\n${userSystem}` : injectedSystem;
  const toolsList = await resolveToolsOption(((_options as any)?.tools), ((_options as any)?.toolsJson));
  const toolsMode = ((_options as any)?.toolsMode as 'exact' | 'none' | undefined);
  const msgArr: any[] = [];
  if (systemPrompt) msgArr.push({ role: 'system', content: systemPrompt });
  // Include prior turn history from TUI if provided
  const hist = ((_options as any)?.__history as Array<{ role: 'user' | 'assistant'; content: string }>) || [];
  const maxHistMsgs = Number(process.env.KABLEWY_HISTORY_MAX_MSGS || '16');
  const maxHistChars = Number(process.env.KABLEWY_HISTORY_TOTAL_CHARS || '64000');
  const histSlice = maxHistMsgs > 0 ? hist.slice(Math.max(0, hist.length - maxHistMsgs)) : [];
  let acc = 0;
  for (const h of histSlice) {
    const text = (h.content || '');
    if (acc >= maxHistChars) break;
    const remaining = maxHistChars - acc;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    msgArr.push({ role: h.role, content: clipped });
    acc += clipped.length;
  }
  msgArr.push({ role: 'user', content: message });
  const args: any = {
    messages: msgArr,
    model,
    ...(toolsMode === 'none' ? { tools: [] } : (toolsList && toolsList.length ? { tools: toolsList } : {})),
    stream: true,
    ...(sessionId ? { chatId: sessionId } : {}),
    options: { createChatIfNeeded: true, ...(sessionId ? { chatId: sessionId } : {}) }
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

  if (!res.ok || !res.body) {
    throw new Error(`Stream request failed (${res.status})`);
  }

  const reader = (res.body as any).getReader?.();
  if (!reader) {
    const data = await res.json();
    const text = extractProcessChatText({ data: data?.result });
    cb.onText(text + '\n');
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let aggregated = '';
  let emittedChatId = false;
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
        if (event.jsonrpc === '2.0' && event.result?.content) {
          const items = event.result.content;
          for (const item of items) {
            if (item.type === 'text' && item.text) {
              cb.onText(item.text);
              aggregated += item.text;
            }
          }
          continue;
        }
        switch (event.type) {
          case 'content': {
            const chunk = event.content || '';
            cb.onText(chunk);
            aggregated += chunk;
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
            cb.onToolEvent(`tool_call: ${event.tool_call?.name || ''}`);
            break;
          }
          case 'tool_result': {
            cb.onToolEvent('tool_result');
            break;
          }
        }
      } catch {}
    }
  }
  return aggregated;
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
