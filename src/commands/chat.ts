import { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import { CommandContext, MCPMessage, ChatOptions } from '../types/index.js';
import React from 'react';
import { InkChat, runInkChat } from '../ui/ink-chat.js';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { glob as globFiles } from 'glob';
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
    .option('--self-test', 'Run local filesystem/shell tool diagnostics and exit')
    .option('--json', 'Output self-test diagnostics as JSON')
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
      selfTest?: boolean;
      json?: boolean;
    }) => {
      const cwd = resolveAgentCwd(options.cwd);
      if (options.selfTest) {
        const result = await runAgentSelfTest({
          cwd,
          allowOutsideCwd: options.allowOutsideCwd === true,
          commandTimeoutMs: options.shellTimeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: options.maxOutputBytes ?? DEFAULT_AGENT_MAX_OUTPUT_BYTES,
        });
        if (options.json) {
          context.output.json(result.success
            ? { success: true, data: result }
            : {
                success: false,
                error: {
                  code: 'AGENT_SELF_TEST_FAILED',
                  message: 'One or more local agent tool diagnostics failed',
                },
                data: result,
              });
        } else if (result.success) {
          context.output.success('Agent local tool self-test passed');
          context.output.list(result.checks.map((check) => `${check.name}: ${check.detail || 'ok'}`), { bullet: '✓' });
        } else {
          context.output.error('Agent local tool self-test failed');
          context.output.list(result.checks.map((check) => `${check.name}: ${check.ok ? check.detail || 'ok' : check.error || 'failed'}`), { bullet: '-' });
        }
        process.exitCode = result.success ? 0 : 1;
        return;
      }
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

export interface AgentSelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface AgentSelfTestResult {
  success: boolean;
  root: string;
  testDir: string;
  checks: AgentSelfTestCheck[];
}

export async function runAgentSelfTest(options: {
  cwd?: string;
  allowOutsideCwd?: boolean;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
} = {}): Promise<AgentSelfTestResult> {
  const root = resolveAgentCwd(options.cwd);
  const testRelDir = path.join('.kablewy', 'agent-self-test', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  const testDir = path.join(root, testRelDir);
  const notePath = path.join(testRelDir, 'notes', 'probe.txt');
  const safety: AgentSafetyConfig = {
    cwd: root,
    allowDangerousShell: false,
    allowOutsideCwd: options.allowOutsideCwd === true,
    requireShellApproval: true,
    commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_AGENT_MAX_OUTPUT_BYTES,
  };
  const checks: AgentSelfTestCheck[] = [];

  const runCheck = async (
    name: string,
    toolCall: Record<string, any>,
    verify?: (payload: any) => Promise<string | boolean> | string | boolean
  ): Promise<void> => {
    const result = await executeLocalAgentToolCall(toolCall, safety);
    const payload = JSON.parse(result.content);
    if (payload.success === false) {
      checks.push({ name, ok: false, error: payload.error?.message || 'tool returned failure' });
      return;
    }
    const verified = verify ? await verify(payload) : true;
    checks.push({
      name,
      ok: verified !== false,
      detail: typeof verified === 'string' ? verified : undefined,
      error: verified === false ? 'verification failed' : undefined,
    });
  };

  const runBlockedCheck = async (
    name: string,
    toolCall: Record<string, any>,
    expectedMessage: string
  ): Promise<void> => {
    const result = await executeLocalAgentToolCall(toolCall, safety);
    const payload = JSON.parse(result.content);
    const message = String(payload.error?.message || '');
    checks.push({
      name,
      ok: payload.success === false && message.includes(expectedMessage),
      detail: payload.success === false ? message : undefined,
      error: payload.success === false ? undefined : 'expected tool to be blocked',
    });
  };

  try {
    await fsp.mkdir(testDir, { recursive: true });
    await runCheck('write_file', {
      id: 'selftest_write',
      name: 'Write',
      arguments: {
        file_path: notePath,
        content: 'alpha\nbeta\n',
      },
    }, () => notePath);
    await runCheck('read_file', {
      id: 'selftest_read',
      name: 'Read',
      arguments: { file_path: notePath, full: true },
    }, (payload) => String(payload.data?.content || '').includes('alpha') ? 'read content matched' : false);
    await runCheck('edit_file', {
      id: 'selftest_edit',
      name: 'Edit',
      arguments: { file_path: notePath, old_string: 'beta', new_string: 'gamma' },
    }, () => 'edited exact text');
    await runCheck('search_files', {
      id: 'selftest_grep',
      name: 'Grep',
      arguments: { path: testRelDir, pattern: 'gamma' },
    }, (payload) => Array.isArray(payload.data?.matches) && payload.data.matches.length > 0 ? 'found edited text' : false);
    await runCheck('list_files', {
      id: 'selftest_ls',
      name: 'LS',
      arguments: { path: testRelDir },
    }, (payload) => Array.isArray(payload.data?.entries) && payload.data.entries.some((entry: any) => entry.path.endsWith('notes')) ? 'listed test directory' : false);
    await runCheck('shell_pwd', {
      id: 'selftest_pwd',
      name: 'Bash',
      arguments: { command: 'pwd', cwd: testRelDir },
    }, async (payload) => {
      const actual = String(payload.data?.stdout || '').trim();
      const [actualReal, expectedReal] = await Promise.all([
        fsp.realpath(actual).catch(() => path.resolve(actual)),
        fsp.realpath(testDir).catch(() => path.resolve(testDir)),
      ]);
      return actualReal === expectedReal ? 'pwd matched agent cwd' : false;
    });
    await runCheck('shell_ls', {
      id: 'selftest_shell_ls',
      name: 'Bash',
      arguments: { command: 'ls notes', cwd: testRelDir },
    }, (payload) => String(payload.data?.stdout || '').includes('probe.txt') ? 'shell saw written file' : false);
    await runBlockedCheck('block_outside_write', {
      id: 'selftest_outside',
      name: 'Write',
      arguments: { file_path: '../kablewy-agent-self-test-outside.txt', content: 'nope' },
    }, 'outside the agent root');
    await runBlockedCheck('block_mutating_shell', {
      id: 'selftest_mutating',
      name: 'Bash',
      arguments: { command: 'touch nope.txt', cwd: testRelDir },
    }, 'mutating');
    await runBlockedCheck('block_unknown_shell', {
      id: 'selftest_unknown',
      name: 'Bash',
      arguments: { command: 'node --version', cwd: testRelDir },
    }, 'unknown');
  } catch (error: unknown) {
    checks.push({
      name: 'self_test_harness',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await fsp.rm(testDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    success: checks.length > 0 && checks.every((check) => check.ok),
    root,
    testDir: path.relative(root, testDir) || '.',
    checks,
  };
}

async function handleChat(options: ChatOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  
  try {
    const sessionId = options.session;
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
  const { output } = context;
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
  const { output, input } = context;
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
          glob: { type: 'string', description: 'Optional glob pattern to filter files' },
          max_entries: { type: 'number', description: 'Maximum entries returned in one result', default: 300 },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous truncated listing' }
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
      name: 'fs_inventory',
      description: 'Create a structured recursive inventory of a local directory with safe default ignores, caps, and truncation metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to inventory (relative to CWD if not absolute)', default: cwd },
          max_depth: { type: 'number', description: 'Maximum subdirectory depth', default: 6 },
          include_hidden: { type: 'boolean', description: 'Include dotfiles', default: false },
          max_entries: { type: 'number', description: 'Maximum entries returned in one result', default: 1000 },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous truncated inventory' }
        }
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
          include_hidden: { type: 'boolean', description: 'Include dotfiles', default: false },
          max_entries: { type: 'number', description: 'Maximum entries returned in one result', default: 300 },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous truncated listing' }
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
      name: 'Inventory',
      description: 'Create a recursive inventory of a local directory. Alias for fs_inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to inventory (relative to CWD if not absolute)', default: cwd },
          max_depth: { type: 'number', description: 'Maximum subdirectory depth', default: 6 },
          include_hidden: { type: 'boolean', description: 'Include dotfiles', default: false },
          max_entries: { type: 'number', description: 'Maximum entries returned in one result', default: 1000 },
          cursor: { type: 'string', description: 'Opaque cursor returned by a previous truncated inventory' }
        }
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
]);

function canonicalLocalToolName(name: string): string {
  switch (name) {
    case 'LS': return 'fs_list_files';
    case 'Read': return 'fs_read_file';
    case 'Grep': return 'fs_search_files';
    case 'Inventory': return 'fs_inventory';
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

interface AgentLocalBootstrapToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface AgentWorkspaceObservation {
  path: string;
  tool: string;
  truncated: boolean;
  timestamp: number;
  entryPaths: string[];
}

export interface AgentWorkspaceState {
  root: string;
  recentPaths: string[];
  lastRequestedPath?: string;
  observations: Record<string, AgentWorkspaceObservation>;
}

export function createAgentWorkspaceState(root = process.cwd()): AgentWorkspaceState {
  return {
    root: path.resolve(root),
    recentPaths: [],
    observations: {},
  };
}

function getAgentWorkspaceState(options: ChatOptions): AgentWorkspaceState | undefined {
  if (!(options as any)?.agent) return undefined;
  const safety = (options as any)?.agentSafety as AgentSafetyConfig | undefined;
  const root = safety?.cwd || process.cwd();
  const existing = (options as any).__agentWorkspaceState as AgentWorkspaceState | undefined;
  if (existing) return existing;
  const state = createAgentWorkspaceState(root);
  (options as any).__agentWorkspaceState = state;
  return state;
}

function normalizeWorkspacePath(root: string, value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : '.';
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const relative = path.relative(root, resolved) || '.';
  return relative.split(path.sep).join('/');
}

function rememberWorkspacePath(state: AgentWorkspaceState | undefined, value: unknown): void {
  if (!state) return;
  const normalized = normalizeWorkspacePath(state.root, value);
  if (!normalized || normalized.startsWith('..')) return;
  state.lastRequestedPath = normalized;
  state.recentPaths = [normalized, ...state.recentPaths.filter((item) => item !== normalized)].slice(0, 20);
}

function recordWorkspaceToolResult(
  state: AgentWorkspaceState | undefined,
  toolCall: AgentLocalBootstrapToolCall | any,
  result: LocalToolResultMessage
): void {
  if (!state) return;
  let payload: any;
  try {
    payload = JSON.parse(result.content);
  } catch {
    return;
  }
  if (payload?.success === false) return;
  const name = normalizeToolCallName(toolCall);
  const args = normalizeLocalToolArguments(name, parseToolCallArguments(toolCall));
  const canonicalName = canonicalLocalToolName(name);
  const data = payload?.data || {};
  const observedPath = data.path ?? args.path ?? args.file_path ?? '.';
  rememberWorkspacePath(state, observedPath);
  const entryPaths = Array.isArray(data.entries)
    ? data.entries.map((entry: any) => String(entry.path || '')).filter(Boolean).slice(0, 200)
    : Array.isArray(data.matches)
      ? data.matches.map((entry: any) => String(entry.path || '')).filter(Boolean).slice(0, 200)
      : [];
  const normalized = normalizeWorkspacePath(state.root, observedPath);
  state.observations[normalized] = {
    path: normalized,
    tool: canonicalName,
    truncated: data.truncated === true,
    timestamp: Date.now(),
    entryPaths,
  };
  for (const entryPath of entryPaths.slice(0, 50)) {
    rememberWorkspacePath(state, entryPath);
  }
}

function buildAgentWorkspaceContext(state: AgentWorkspaceState | undefined): string | null {
  if (!state) return null;
  const truncated = Object.values(state.observations)
    .filter((observation) => observation.truncated)
    .map((observation) => observation.path)
    .slice(0, 8);
  const lines = [
    '## Local Workspace State',
    `Agent root: ${state.root}`,
    state.lastRequestedPath ? `Last local path requested: ${state.lastRequestedPath}` : '',
    state.recentPaths.length ? `Recent local paths: ${state.recentPaths.slice(0, 10).join(', ')}` : '',
    truncated.length ? `Truncated observations: ${truncated.join(', ')}` : '',
    'A truncated local listing is incomplete evidence: it can prove returned entries exist, but it cannot prove missing paths do not exist. For follow-up path questions, use a fresh targeted local tool result.',
  ].filter(Boolean);
  return lines.join('\n');
}

function stripTrailingSentencePunctuation(value: string): string {
  let trimmed = value.trim();
  while (trimmed.endsWith('.') || trimmed.endsWith('?') || trimmed.endsWith('!')) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  return trimmed;
}

function cleanCandidatePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = stripTrailingSentencePunctuation(value)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[),;:]+$/g, '')
    .trim();
  if (!cleaned || /^(this|current|the|directory|folder|file|repo|repository)$/i.test(cleaned)) return undefined;
  return cleaned;
}

function extractTargetPathFromMessage(text: string, state?: AgentWorkspaceState): string | undefined {
  const explicitBacktick = text.match(/`([^`\n]{1,300})`/);
  const backtickPath = cleanCandidatePath(explicitBacktick?.[1]);
  if (backtickPath && /[./\\]|\.[A-Za-z0-9_-]+$/.test(backtickPath)) return backtickPath;

  const quoted = text.match(/["']([^"'\n]{1,300})["']/);
  const quotedPath = cleanCandidatePath(quoted?.[1]);
  if (quotedPath && /[./\\]|\.[A-Za-z0-9_-]+$/.test(quotedPath)) return quotedPath;

  const inDirectory = text.match(/\b(?:what(?:'s|\s+is)?|list|show|display|see)\b[\s\S]{0,80}?\b(?:in|inside|under|within)\s+(?:the\s+)?([A-Za-z0-9_./\\-]+)(?:\s+(?:directory|folder|dir))?\b/i);
  const inDirectoryPath = cleanCandidatePath(inDirectory?.[1]);
  if (inDirectoryPath && !/^(this|current)$/i.test(inDirectoryPath)) return inDirectoryPath;

  const trailingPath = text.match(/^(?:yes|yep|yeah|ok|okay|sure)?\s*([A-Za-z0-9_./\\-]+)\s*$/i);
  const trailing = cleanCandidatePath(trailingPath?.[1]);
  if (trailing && (trailing.includes('/') || trailing.includes('\\') || trailing.startsWith('.') || state?.recentPaths.includes(trailing))) {
    return trailing;
  }

  const directFile = text.match(/\b(?:read|open|show|display|edit|update)\s+(?:the\s+)?(?:file\s+)?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_-]+)\b/i);
  const directFilePath = cleanCandidatePath(directFile?.[1]);
  if (directFilePath) return directFilePath;

  if (/\b(that|this)\s+(?:directory|folder|file|path)\b/i.test(text) && state?.lastRequestedPath) {
    return state.lastRequestedPath;
  }

  return undefined;
}

function inferAgentLocalBootstrapToolCalls(message: string, state?: AgentWorkspaceState): AgentLocalBootstrapToolCall[] {
  const text = String(message || '').trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const idPrefix = `local_bootstrap_${Date.now()}`;

  const writeNamedFile = text.match(/\b(?:write|create)\s+(?:a\s+)?(?:small\s+)?(?:test\s+)?(?:file\s+)?(?:named|called)\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)(?:\s+(?:with|containing)\s+([\s\S]{1,500}))?/i);
  const writeReadback = /\b(?:write|create)\b[\s\S]{0,120}\b(?:test\s+)?file\b[\s\S]{0,120}\bread (?:it|that file|the file) back\b/i.test(text);
  if (writeNamedFile || writeReadback) {
    const filePath = writeNamedFile?.[1] || 'kablewy-agent-test.txt';
    const content = stripTrailingSentencePunctuation(writeNamedFile?.[2] || '')
      || `Kablewy agent local write test ${new Date().toISOString()}\n`;
    const calls: AgentLocalBootstrapToolCall[] = [{
      id: `${idPrefix}_write`,
      name: 'Write',
      arguments: { file_path: filePath, content },
    }];
    if (writeReadback || /\bread (?:it|that file|the file) back\b/i.test(text)) {
      calls.push({
        id: `${idPrefix}_read`,
        name: 'Read',
        arguments: { file_path: filePath, full: true },
      });
    }
    return calls;
  }

  const inlineCommand = text.match(/`([^`\n]{1,300})`/);
  if (inlineCommand && /\b(run|execute|shell|command|terminal)\b/i.test(text)) {
    return [{
      id: idPrefix,
      name: 'Bash',
      arguments: { command: stripTrailingSentencePunctuation(inlineCommand[1]) },
    }];
  }

  if (/\bpwd\b/.test(lower) && /\b(run|execute|access|show|print|tell|get|what|where)\b/.test(lower)) {
    return [{
      id: idPrefix,
      name: 'Bash',
      arguments: { command: 'pwd' },
    }];
  }

  const asksAboutLocalDirectory = (
    /\b(tell|describe|summarize|inspect|analy[sz]e|discover|overview|explain|what(?:'s| is)?)\b/.test(lower) &&
    /\b(local\s+directory|working\s+directory|current\s+directory|this\s+directory|cwd|workspace|project\s+root|repo|repository|where\s+i\s+am)\b/.test(lower)
  ) || /\btell me about (?:my|the|this|our) local directory\b/.test(lower);
  if (asksAboutLocalDirectory) {
    rememberWorkspacePath(state, '.');
    return [
      {
        id: `${idPrefix}_pwd`,
        name: 'Bash',
        arguments: { command: 'pwd' },
      },
      {
        id: `${idPrefix}_inventory`,
        name: 'Inventory',
        arguments: { path: '.', max_depth: 3, include_hidden: false, max_entries: 1000 },
      },
    ];
  }

  if (
    /\b(recursive|recursively|inventory|inventorize|tree|entire|whole)\b/.test(lower) &&
    /\b(directory|folder|repo|repository|project|cwd|this|current|inventory|list|map)\b/.test(lower)
  ) {
    const targetPath = extractTargetPathFromMessage(text, state) || '.';
    rememberWorkspacePath(state, targetPath);
    return [{
      id: idPrefix,
      name: 'Inventory',
      arguments: { path: targetPath, max_depth: 8, include_hidden: false, max_entries: 1000 },
    }];
  }

  const runCommand = text.match(/\b(?:run|execute)\s+((?:pwd|ls(?:\s+-[A-Za-z]+)?|git\s+(?:status|diff|log|show)(?:\s+[^\n.?!]*)?|rg\s+[^\n.?!]+|grep\s+[^\n.?!]+|find\s+[^\n.?!]+|cat\s+[^\n.?!]+|head\s+[^\n.?!]+|tail\s+[^\n.?!]+|wc\s+[^\n.?!]+))/i);
  if (runCommand) {
    return [{
      id: idPrefix,
      name: 'Bash',
      arguments: { command: stripTrailingSentencePunctuation(runCommand[1]) },
    }];
  }

  const targetedPath = extractTargetPathFromMessage(text, state);
  if (targetedPath && /^(?:yes|yep|yeah|ok|okay|sure)?\s*[A-Za-z0-9_./\\-]+\s*$/i.test(text)) {
    rememberWorkspacePath(state, targetedPath);
    return [{
      id: idPrefix,
      name: 'LS',
      arguments: { path: targetedPath, max_depth: 2, include_hidden: false },
    }];
  }

  if (
    targetedPath &&
    /\b(list|show|display|see|what(?:'s| is)?|contents?|inside|directory|folder|dir)\b/i.test(text) &&
    !/\.[A-Za-z0-9_-]+$/.test(targetedPath)
  ) {
    rememberWorkspacePath(state, targetedPath);
    return [{
      id: idPrefix,
      name: 'LS',
      arguments: { path: targetedPath, max_depth: 2, include_hidden: false },
    }];
  }

  if (
    /\b(list|show|display|see|tell|describe|inspect|discover|what(?:'s| is)?)\b/.test(lower) &&
    /\b(files|directory|folder|cwd|working directory|current directory|this directory|local directory)\b/.test(lower)
  ) {
    rememberWorkspacePath(state, '.');
    return [{
      id: idPrefix,
      name: 'LS',
      arguments: { path: '.', max_depth: 1, include_hidden: false },
    }];
  }

  const readFile = text.match(/\b(?:read|open|show|display)\s+(?:the\s+)?(?:file\s+)?([A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)\b/i);
  if (readFile) {
    return [{
      id: idPrefix,
      name: 'Read',
      arguments: { file_path: readFile[1], full: false },
    }];
  }

  return [];
}

function truncateAgentBootstrapContent(value: string): string {
  const maxChars = 12000;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...truncated ${value.length - maxChars} chars...`;
}

async function buildAgentLocalBootstrapMessages(
  message: string,
  options: ChatOptions,
  cb: { onToolEvent: (text: string) => void }
): Promise<Array<{ role: 'system'; content: string }>> {
  if ((options as any)?.toolsMode === 'none') return [];
  const workspaceState = getAgentWorkspaceState(options);
  const toolCalls = inferAgentLocalBootstrapToolCalls(message, workspaceState);
  if (toolCalls.length === 0) return [];

  const results: string[] = [];
  for (const toolCall of toolCalls) {
    cb.onToolEvent(`local_tool_call: ${toolCall.name}`);
    const result = await executeLocalAgentToolCall(toolCall, (options as any)?.agentSafety);
    cb.onToolEvent(`local_tool_result: ${toolCall.name}`);
    recordWorkspaceToolResult(workspaceState, toolCall, result);
    results.push([
      `Tool: ${toolCall.name}`,
      `Arguments: ${JSON.stringify(toolCall.arguments)}`,
      `Result: ${truncateAgentBootstrapContent(result.content)}`,
    ].join('\n'));
  }

  return [{
    role: 'system',
    content: [
      '## Local CLI Pre-Run Result',
      'The Kablewy CLI detected obvious local filesystem/shell request(s) and executed them locally before this model response.',
      'Use this current local result when answering. Do not say local filesystem or shell access is unavailable for this request.',
      'If a local listing is truncated, do not infer that missing paths are absent. Use the targeted result for the path named in this request.',
      '',
      results.join('\n\n'),
    ].join('\n'),
  }];
}

function nearestExistingPath(candidate: string): string | null {
  let current = candidate;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }
  return fs.existsSync(current) ? current : null;
}

function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function toDisplayPath(rootCwd: string, candidate: string): string {
  return (path.relative(rootCwd, candidate) || '.').split(path.sep).join('/');
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.08;
}

function resolveAgentToolPath(rootCwd: string, rawPath: unknown, allowOutsideCwd: boolean): string {
  const value = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';
  const resolved = path.resolve(rootCwd, value);
  if (!allowOutsideCwd && !isPathInside(rootCwd, resolved)) {
    throw new Error(`Path is outside the agent root: ${value}`);
  }
  if (!allowOutsideCwd) {
    const rootRealpath = realpathOrNull(rootCwd) || path.resolve(rootCwd);
    const existing = nearestExistingPath(fs.existsSync(resolved) ? resolved : path.dirname(resolved));
    const realExisting = existing ? realpathOrNull(existing) : null;
    if (realExisting && !isPathInside(rootRealpath, realExisting)) {
      throw new Error(`Path resolves outside the agent root: ${value}`);
    }
  }
  return resolved;
}

async function listAgentFiles(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const start = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const maxDepth = Math.max(0, Math.min(8, Number(args.max_depth ?? 2)));
  const includeHidden = args.include_hidden === true;
  const maxEntries = Math.max(1, Math.min(1000, Number(args.max_entries ?? args.limit ?? 300)));
  const cursor = Math.max(0, Number.parseInt(String(args.cursor || '0'), 10) || 0);
  const entries: Array<Record<string, any>> = [];
  let seen = 0;
  let truncated = false;

  const pushEntry = async (fullPath: string, typeHint?: string): Promise<void> => {
    if (!safety.allowOutsideCwd && !isPathInside(rootCwd, fullPath)) return;
    try {
      resolveAgentToolPath(rootCwd, fullPath, safety.allowOutsideCwd);
    } catch {
      return;
    }
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat) return;
    if (seen++ < cursor) return;
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    entries.push({
      path: toDisplayPath(rootCwd, fullPath),
      type: typeHint || (stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'),
      size: stat.size ?? null,
      modified: stat.mtime?.toISOString?.() ?? null,
    });
  };

  const globPattern = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : '';
  if (globPattern) {
    const matches = await globFiles(globPattern, {
      cwd: start,
      dot: includeHidden,
      nodir: false,
      withFileTypes: false,
      ignore: includeHidden ? [] : ['**/.*/**', '**/.*'],
    } as any);
    for (const match of matches.map(String).sort()) {
      await pushEntry(path.resolve(start, match));
      if (truncated) break;
    }
    return {
      root: rootCwd,
      path: toDisplayPath(rootCwd, start),
      glob: globPattern,
      count: entries.length,
      count_returned: entries.length,
      limit: maxEntries,
      cursor: String(cursor),
      truncated,
      next_cursor: truncated ? String(cursor + entries.length) : null,
      warning: truncated ? 'This listing is incomplete; absence cannot be inferred from omitted entries.' : undefined,
      entries,
    };
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    const dirents = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (truncated) break;
      if (!includeHidden && dirent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, dirent.name);
      if (!safety.allowOutsideCwd && !isPathInside(rootCwd, fullPath)) continue;
      await pushEntry(fullPath, dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other');
      if (dirent.isDirectory() && depth < maxDepth) {
        await walk(fullPath, depth + 1);
      }
    }
  };

  const stat = await fsp.stat(start);
  if (stat.isDirectory()) {
    await walk(start, 0);
  } else {
    await pushEntry(start, 'file');
  }

  return {
    root: rootCwd,
    path: toDisplayPath(rootCwd, start),
    count: entries.length,
    count_returned: entries.length,
    limit: maxEntries,
    cursor: String(cursor),
    truncated,
    next_cursor: truncated ? String(cursor + entries.length) : null,
    warning: truncated ? 'This listing is incomplete; absence cannot be inferred from omitted entries.' : undefined,
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
  const rel = toDisplayPath(rootCwd, filePath);
  if (isLikelyBinary(buffer)) {
    return {
      path: rel,
      size: stat.size,
      binary: true,
      truncated: false,
      sha256: sha256(buffer),
      warning: 'Binary-looking file detected; content was not decoded or sent as text.',
    };
  }
  if (full) {
    return {
      path: rel,
      size: stat.size,
      binary: false,
      truncated: false,
      sha256: sha256(buffer),
      content: redactText(buffer.toString('utf8')),
    };
  }
  return {
    path: rel,
    size: stat.size,
    binary: false,
    truncated: true,
    sha256: sha256(buffer),
    head_bytes: bytes,
    tail_bytes: bytes,
    warning: 'This file read is incomplete; absence cannot be inferred from omitted content.',
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
    try {
      resolveAgentToolPath(rootCwd, filePath, safety.allowOutsideCwd);
    } catch {
      return;
    }
    scannedFiles += 1;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return;
    const raw = await fsp.readFile(filePath).catch(() => null);
    if (!raw || isLikelyBinary(raw)) return;
    const content = raw.toString('utf8');
    if (content == null) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const haystack = caseInsensitive ? lines[i].toLowerCase() : lines[i];
      if (haystack.includes(needle)) {
        matches.push({
          path: toDisplayPath(rootCwd, filePath),
          line: i + 1,
          text: redactText(lines[i].slice(0, 500)),
        });
      }
    }
  };

  const walk = async (target: string): Promise<void> => {
    if (scannedFiles >= maxFiles || matches.length >= maxMatches) return;
    try {
      resolveAgentToolPath(rootCwd, target, safety.allowOutsideCwd);
    } catch {
      return;
    }
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
    path: toDisplayPath(rootCwd, start),
    pattern,
    scannedFiles,
    count: matches.length,
    truncated: scannedFiles >= maxFiles || matches.length >= maxMatches,
    matches,
  };
}

const DEFAULT_INVENTORY_IGNORES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
]);

async function inventoryAgentFiles(rootCwd: string, args: Record<string, any>, safety: AgentSafetyConfig): Promise<Record<string, any>> {
  const start = resolveAgentToolPath(rootCwd, args.path, safety.allowOutsideCwd);
  const maxDepth = Math.max(0, Math.min(12, Number(args.max_depth ?? 6)));
  const includeHidden = args.include_hidden === true;
  const maxEntries = Math.max(1, Math.min(5000, Number(args.max_entries ?? args.limit ?? 1000)));
  const cursor = Math.max(0, Number.parseInt(String(args.cursor || '0'), 10) || 0);
  const entries: Array<Record<string, any>> = [];
  const ignoredDirectories = new Set<string>();
  let seen = 0;
  let truncated = false;

  const pushEntry = async (fullPath: string, typeHint?: string): Promise<void> => {
    if (!safety.allowOutsideCwd && !isPathInside(rootCwd, fullPath)) return;
    try {
      resolveAgentToolPath(rootCwd, fullPath, safety.allowOutsideCwd);
    } catch {
      return;
    }
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat) return;
    if (seen++ < cursor) return;
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    entries.push({
      path: toDisplayPath(rootCwd, fullPath),
      type: typeHint || (stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'),
      size: stat.isFile() ? stat.size : null,
      modified: stat.mtime?.toISOString?.() ?? null,
    });
  };

  const shouldIgnoreDirectory = (direntName: string, fullPath: string): boolean => {
    if (!includeHidden && direntName.startsWith('.')) return true;
    if (DEFAULT_INVENTORY_IGNORES.has(direntName)) return true;
    const rel = toDisplayPath(rootCwd, fullPath);
    return /\.(tgz|zip|tar|gz)$/i.test(rel);
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    const dirents = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      if (truncated) break;
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory() && shouldIgnoreDirectory(dirent.name, fullPath)) {
        ignoredDirectories.add(toDisplayPath(rootCwd, fullPath));
        continue;
      }
      if (!includeHidden && dirent.name.startsWith('.')) continue;
      await pushEntry(fullPath, dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other');
      if (dirent.isDirectory() && depth < maxDepth) {
        await walk(fullPath, depth + 1);
      }
    }
  };

  const stat = await fsp.stat(start);
  if (stat.isDirectory()) {
    await pushEntry(start, 'directory');
    await walk(start, 0);
  } else {
    await pushEntry(start, 'file');
  }

  return {
    root: rootCwd,
    path: toDisplayPath(rootCwd, start),
    count: entries.length,
    count_returned: entries.length,
    limit: maxEntries,
    cursor: String(cursor),
    truncated,
    next_cursor: truncated ? String(cursor + entries.length) : null,
    ignored_directories: Array.from(ignoredDirectories).sort(),
    warning: truncated ? 'This inventory is incomplete; request the next cursor or narrow the path for full results.' : undefined,
    entries,
  };
}

function parsePortableShellWords(command: string): string[] | null {
  if (/[|;&<>`$()]/.test(command)) return null;
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) return null;
  if (current) words.push(current);
  return words.length > 0 ? words : null;
}

function finishPortableShellResult(command: string, cwd: string, rootCwd: string, stdoutRaw: string, stderrRaw = '', maxBytes = DEFAULT_AGENT_MAX_OUTPUT_BYTES): Record<string, any> {
  const stdout = takeOutputChunk(redactText(stdoutRaw), 0, maxBytes);
  const stderr = takeOutputChunk(redactText(stderrRaw), 0, maxBytes);
  return {
    command,
    cwd: path.relative(rootCwd, cwd) || '.',
    exitCode: 0,
    timedOut: false,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    portableShim: true,
    classification: classifyShellCommand(command),
  };
}

async function maybeRunPortableReadOnlyShell(rootCwd: string, cwd: string, command: string, safety: AgentSafetyConfig): Promise<Record<string, any> | null> {
  const words = parsePortableShellWords(command);
  if (!words) return null;
  const executable = words[0].toLowerCase();
  const args = words.slice(1);

  if ((executable === 'pwd' || executable === 'cd') && args.length === 0) {
    return finishPortableShellResult(command, cwd, rootCwd, `${cwd}\n`, '', safety.maxOutputBytes);
  }

  if (executable === 'ls' || executable === 'dir') {
    const targets: string[] = [];
    let includeHidden = false;
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (arg.startsWith('-')) {
        includeHidden ||= lower.includes('a');
        continue;
      }
      if (executable === 'dir' && lower.startsWith('/')) {
        includeHidden ||= lower.includes('a');
        continue;
      }
      targets.push(arg);
    }

    const requestedTargets = targets.length > 0 ? targets : ['.'];
    const lines: string[] = [];
    for (const target of requestedTargets) {
      const targetPath = resolveAgentToolPath(cwd, target, safety.allowOutsideCwd);
      if (!safety.allowOutsideCwd && !isPathInside(rootCwd, targetPath)) {
        throw new Error(`Path is outside the agent root: ${target}`);
      }
      const stat = await fsp.stat(targetPath);
      if (requestedTargets.length > 1) lines.push(`${toDisplayPath(rootCwd, targetPath)}:`);
      if (stat.isDirectory()) {
        const dirents = (await fsp.readdir(targetPath, { withFileTypes: true })).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (const dirent of dirents) {
          if (!includeHidden && dirent.name.startsWith('.')) continue;
          lines.push(`${dirent.name}${dirent.isDirectory() ? '/' : ''}`);
        }
      } else {
        lines.push(path.basename(targetPath));
      }
      if (requestedTargets.length > 1) lines.push('');
    }
    return finishPortableShellResult(command, cwd, rootCwd, lines.join('\n') + (lines.length ? '\n' : ''), '', safety.maxOutputBytes);
  }

  if (executable === 'cat' || executable === 'type') {
    if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) return null;
    let stdout = '';
    let stderr = '';
    for (const target of args) {
      const filePath = resolveAgentToolPath(cwd, target, safety.allowOutsideCwd);
      if (!safety.allowOutsideCwd && !isPathInside(rootCwd, filePath)) {
        throw new Error(`Path is outside the agent root: ${target}`);
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error(`Path is not a file: ${target}`);
      const buffer = await fsp.readFile(filePath);
      if (isLikelyBinary(buffer)) {
        stderr += `Binary-looking file omitted: ${toDisplayPath(rootCwd, filePath)}\n`;
        continue;
      }
      stdout += buffer.toString('utf8');
      if (!stdout.endsWith('\n')) stdout += '\n';
    }
    return finishPortableShellResult(command, cwd, rootCwd, stdout, stderr, safety.maxOutputBytes);
  }

  return null;
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
  const portableResult = await maybeRunPortableReadOnlyShell(rootCwd, cwd, command, safety);
  if (portableResult) return portableResult;
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
    path: toDisplayPath(rootCwd, filePath),
    created: !before,
    overwritten: Boolean(before),
    bytes: after.size,
    sha256: sha256(content),
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
    path: toDisplayPath(rootCwd, filePath),
    replacements: args.replace_all === true ? occurrences : 1,
    bytesBefore: Buffer.byteLength(original, 'utf8'),
    bytesAfter: Buffer.byteLength(edited, 'utf8'),
    sha256Before: sha256(original),
    sha256After: sha256(edited),
    preview: {
      old: redactText(oldText.slice(0, 500)),
      new: redactText(newText.slice(0, 500)),
    },
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
          : canonicalName === 'fs_inventory'
            ? await inventoryAgentFiles(rootCwd, args, safety)
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

async function startInkTuiChat(sessionId: string | undefined, options: ChatOptions, context: CommandContext): Promise<void> {
  let liveChatId: string | undefined = ensureChatId(sessionId);
  const agentWorkspaceState = (options as any).agent
    ? createAgentWorkspaceState(((options as any).agentSafety as AgentSafetyConfig | undefined)?.cwd || process.cwd())
    : undefined;

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
        __systemArray: systemMsg,
        ...(agentWorkspaceState ? { __agentWorkspaceState: agentWorkspaceState } : {})
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
  const workspaceState = getAgentWorkspaceState(options);
  const results: LocalToolResultMessage[] = [];
  for (const toolCall of payload.tool_calls) {
    const name = normalizeToolCallName(toolCall);
    cb.onToolEvent(`local_tool_call: ${name}`);
    const result = await executeLocalAgentToolCall(toolCall, safety);
    cb.onToolEvent(`local_tool_result: ${name}`);
    recordWorkspaceToolResult(workspaceState, toolCall, result);
    results.push(result);
  }
  return results;
}

export async function streamProcessChatWithCallbacks(
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
      ? '- Local tools: Prefer fs_list_files, fs_read_file, fs_search_files, fs_inventory, fs_write_file, fs_edit_file, and fs_run_shell under the current project root. Standard aliases LS, Read, Grep, Inventory, Write, Edit, and Bash are also supported. Use Inventory/fs_inventory for recursive repo or directory scans. fs_run_shell/Bash is restricted to read-only commands; use fs_write_file/fs_edit_file for file changes. Mutating or dangerous shell commands are blocked unless the user explicitly runs them with ! command approval.'
      : '- Shell: The user can execute shell commands directly by prefixing with !, and may enable autorun. When you propose commands, output them in bash code fences or lines starting with "$ ". Keep them safe and reproducible. Prefer read-only commands by default. Use the project root as the working directory unless stated otherwise.',
    isAgentMode ? '- Shell UX: If a command is mutating or destructive, propose it in a bash code fence or ask the user to run it with ! so the terminal approval flow can protect the workspace.' : '',
    '- File attachments: The user can attach files using @ path. You can assume attached files are included in the hidden context even if the transcript only shows the paths.',
    '- Tools: Only call tools that are explicitly provided in this request (tool_choice=auto). Do not assume local filesystem tools unless listed. Use document tools for Kablewy documents.',
    isAgentMode ? '- File edits: You may claim an edit only after Write/Edit or fs_write_file/fs_edit_file reports success, or after the user runs a command that changes files.' : '',
    isAgentMode ? '- Local discovery: When the user asks about the local directory, cwd, workspace, project, repo, or local files, use the Local CLI pre-run result or the local filesystem tools. Do not use Kablewy Bridge/resource tools such as search_tools or read_resource to discover the local machine.' : '',
    isAgentMode ? '- Local evidence: Truncated local listings are incomplete. They can prove returned entries exist, but they cannot prove a missing path does not exist. For follow-up path questions, rely on the fresh targeted local result in this request.' : '',
    'Guidelines:',
    '- When the user asks for a command, provide one or more exact commands in a bash code fence and optionally a 1–2 line note.',
    '- For searches, prefer ripgrep (rg) with sensible flags (e.g., rg -n -S "pattern" src/). If rg is unavailable, fall back to grep -rn.',
    '- Avoid destructive commands unless explicitly requested.',
  ].join('\n');
  const systemPrompt = userSystem ? `${injectedSystem}\n\n${userSystem}` : injectedSystem;
  const toolsList = await resolveRequestToolsForChat(_options);
  const toolsMode = ((_options as any)?.toolsMode as 'exact' | 'none' | undefined);
  const agentBootstrapMessages = isAgentMode
    ? await buildAgentLocalBootstrapMessages(message, _options, cb)
    : [];
  const agentWorkspaceContext = isAgentMode
    ? buildAgentWorkspaceContext(getAgentWorkspaceState(_options))
    : null;
  const hist = ((_options as any)?.__history as Array<{ role: 'user' | 'assistant'; content: string }>) || [];
  const maxHistMsgs = Number(process.env.KABLEWY_HISTORY_MAX_MSGS || '16');
  const maxHistChars = Number(process.env.KABLEWY_HISTORY_TOTAL_CHARS || '64000');
  const histSlice = maxHistMsgs > 0 ? hist.slice(Math.max(0, hist.length - maxHistMsgs)) : [];
  const baseMessages: any[] = [];
  if (systemPrompt) baseMessages.push({ role: 'system', content: systemPrompt });
  if (agentWorkspaceContext) baseMessages.push({ role: 'system', content: agentWorkspaceContext });
  baseMessages.push(...agentBootstrapMessages);
  const currentUserContent = agentBootstrapMessages.length > 0
    ? [
        message,
        '',
        'Local CLI pre-run result for this request:',
        ...agentBootstrapMessages.map((bootstrap) => bootstrap.content),
      ].join('\n')
    : message;
  let acc = 0;
  for (const h of histSlice) {
    const text = (h.content || '');
    if (acc >= maxHistChars) break;
    const remaining = maxHistChars - acc;
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    baseMessages.push({ role: h.role, content: clipped });
    acc += clipped.length;
  }
  baseMessages.push({ role: 'user', content: currentUserContent });

  let continuationMessages: LocalToolResultMessage[] = [];
  let continuation = false;
  let totalAggregated = '';

  for (let turn = 0; turn < 6; turn++) {
    const msgArr = [...baseMessages, ...continuationMessages];
    const args: any = {
      messages: msgArr,
      model,
      ...(toolsMode === 'none' ? { tools: [], tool_choice: 'none' } : (toolsList && toolsList.length ? { tools: toolsList, tool_choice: 'auto' } : {})),
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
