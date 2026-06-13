import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CommandContext } from '../types/index.js';
import {
  CliError,
  createApiClient,
  exitCodeFor,
  requireCoreApiConfig,
  writeJsonError,
  writeJsonSuccess
} from '../core/api-client.js';

interface QuickActionOptions {
  json?: boolean;
  input?: string;
  inputFile?: string;
  context?: string;
  callbackUrl?: string;
  callbackSecret?: string;
  chatTitle?: string;
  maxIterations?: string;
  personaId?: string;
  wait?: boolean;
  pollInterval?: string;
  timeout?: string;
}

type BackendEnvelope<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: unknown;
  details?: unknown;
  message?: string;
};

export function createQuickActionsCommand(context: CommandContext): Command {
  const command = new Command('quick-actions');
  command
    .alias('quick')
    .description('List and run published Quick Actions');

  command
    .command('list')
    .description('List Quick Actions available to the configured user')
    .option('--json', 'Output JSON')
    .action(async (options: QuickActionOptions) => handleQuickAction(context, options, () => listQuickActions(context, options)));

  command
    .command('run')
    .description('Run a Quick Action by slug or name')
    .argument('<action>', 'Quick Action slug or display name')
    .option('--input <text>', 'Input text for the action')
    .option('--input-file <path>', 'Read action input from a file')
    .option('--context <jsonOrPath>', 'Structured context as inline JSON or a path to a JSON file')
    .option('--callback-url <url>', 'Optional callback URL for terminal task notification')
    .option('--callback-secret <secret>', 'Optional callback signing secret')
    .option('--chat-title <title>', 'Title for the created background chat')
    .option('--max-iterations <number>', 'Override max agent iterations')
    .option('--persona-id <id>', 'Persona ID to run with')
    .option('--wait', 'Poll until the run completes or the timeout is reached')
    .option('--poll-interval <seconds>', 'Polling interval used with --wait', '2')
    .option('--timeout <seconds>', 'Maximum wait time used with --wait', '120')
    .option('--json', 'Output JSON')
    .action(async (action: string, options: QuickActionOptions) => handleQuickAction(context, options, () => runQuickAction(context, action, options)));

  command
    .command('status')
    .description('Show a Quick Action run status')
    .argument('<taskId>', 'Task ID returned by quick-actions run, usually orgId:chatId')
    .option('--json', 'Output JSON')
    .action(async (taskId: string, options: QuickActionOptions) => handleQuickAction(context, options, () => quickActionStatus(context, taskId, options)));

  command.action(() => {
    context.output.section('Quick Actions');
    context.output.list([
      'kablewy quick-actions list',
      'kablewy quick-actions run renewal-review --input "Review Acme renewal"',
      'kablewy quick-actions run "Renewal Review" --context ./context.json --wait',
      'kablewy quick-actions status <taskId> --json'
    ]);
  });

  return command;
}

async function handleQuickAction(context: CommandContext, options: QuickActionOptions, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (options.json) {
      writeJsonError(context, error);
    } else {
      context.output.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = exitCodeFor(error);
  }
}

async function listQuickActions(context: CommandContext, options: QuickActionOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const actions = await requestData<any[]>(context, 'GET', quickActionsPath(config));

  if (options.json) {
    writeJsonSuccess(context, { quickActions: actions });
    return;
  }

  context.output.section('Quick Actions');
  if (actions.length === 0) {
    context.output.info('No published Quick Actions are available to this user');
    return;
  }
  context.output.table(actions.map(quickActionRow));
}

async function runQuickAction(context: CommandContext, action: string, options: QuickActionOptions): Promise<void> {
  if (!action.trim()) throw new CliError('Quick Action name or slug is required', 'USAGE_ERROR', 2);

  const config = requireCoreApiConfig(context);
  const body: Record<string, unknown> = {};

  const input = await resolveInput(options);
  if (input !== undefined) body.input = input;
  if (options.context) body.context = await parseJsonObjectOrFile(options.context, 'context');
  if (options.callbackUrl) body.callbackUrl = options.callbackUrl;
  if (options.callbackSecret) body.callbackSecret = options.callbackSecret;
  if (options.chatTitle) body.chatTitle = options.chatTitle;
  if (options.maxIterations) body.maxIterations = parsePositiveInteger(options.maxIterations, 'max iterations');
  if (options.personaId) body.persona_id = options.personaId;

  const run = await requestData<any>(
    context,
    'POST',
    `${quickActionsPath(config)}/${encodeURIComponent(action)}/run`,
    body
  );

  let status: unknown;
  if (options.wait) {
    status = await waitForRun(context, String(run.taskId || ''), options);
  }

  if (options.json) {
    writeJsonSuccess(context, status ? { run, status } : run);
    return;
  }

  context.output.success(`Started Quick Action '${run.actionName || action}'`);
  if (run.taskId) context.output.info(`Task ID: ${run.taskId}`);
  if (run.chatId) context.output.info(`Chat ID: ${run.chatId}`);

  if (status) renderStatus(context, String(run.taskId || ''), status);
}

async function quickActionStatus(context: CommandContext, taskId: string, options: QuickActionOptions): Promise<void> {
  if (!taskId.trim()) throw new CliError('Task ID is required', 'USAGE_ERROR', 2);
  const status = await fetchRunStatus(context, taskId);

  if (options.json) {
    writeJsonSuccess(context, status);
    return;
  }

  renderStatus(context, taskId, status);
}

async function waitForRun(context: CommandContext, taskId: string, options: QuickActionOptions): Promise<unknown> {
  if (!taskId) throw new CliError('Quick Action run did not return a task ID', 'BACKEND_ERROR', 70);

  const pollMs = parsePositiveInteger(options.pollInterval || '2', 'poll interval') * 1000;
  const timeoutMs = parsePositiveInteger(options.timeout || '120', 'timeout') * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: any;

  while (Date.now() <= deadline) {
    lastStatus = await fetchRunStatus(context, taskId);
    if (!lastStatus?.running) return lastStatus;
    await sleep(pollMs);
  }

  return lastStatus || { running: true, task: { status: 'unknown' } };
}

async function fetchRunStatus(context: CommandContext, taskId: string): Promise<any> {
  const config = requireCoreApiConfig(context);
  return requestData<any>(context, 'GET', `${quickActionsPath(config)}/runs/${encodeURIComponent(taskId)}`);
}

function renderStatus(context: CommandContext, taskId: string, status: any): void {
  const task = status?.task || {};
  context.output.section(`Quick Action Run: ${taskId}`);
  context.output.info(`Status: ${task.status || 'unknown'}`);
  if (typeof task.progress === 'number') context.output.info(`Progress: ${task.progress}%`);
  if (task.currentIteration || task.maxIterations) {
    context.output.info(`Iterations: ${task.currentIteration || 0}/${task.maxIterations || '?'}`);
  }
  if (task.error) context.output.error(String(task.error));
  if (status?.result?.content) {
    context.output.section('Result');
    context.output.info(status.result.content);
  } else if (status?.running) {
    context.output.info('Run is still working. Recheck with `kablewy quick-actions status <taskId>`.');
  }
}

async function requestData<T = unknown>(context: CommandContext, method: string, path: string, body?: unknown): Promise<T> {
  const result = await createApiClient(context).request<BackendEnvelope<T>>(method, path, body === undefined ? {} : { body });
  const envelope = result.data;
  if (envelope && typeof envelope === 'object' && (envelope as BackendEnvelope).success === false) {
    throw new CliError(extractBackendMessage(envelope), 'BACKEND_ERROR', 70, result.requestId, envelope);
  }
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    return (envelope as BackendEnvelope<T>).data as T;
  }
  return envelope as T;
}

function quickActionsPath(config: { orgId: string; userId: string }): string {
  return `/v1/quick-actions/${encodeURIComponent(config.orgId)}/users/${encodeURIComponent(config.userId)}/quick-actions`;
}

async function resolveInput(options: QuickActionOptions): Promise<string | undefined> {
  if (options.input && options.inputFile) {
    throw new CliError('Use either --input or --input-file, not both', 'USAGE_ERROR', 2);
  }
  if (options.inputFile) {
    try {
      return await fs.readFile(path.resolve(options.inputFile), 'utf8');
    } catch (error) {
      throw new CliError(`Unable to read input file: ${error instanceof Error ? error.message : String(error)}`, 'USAGE_ERROR', 2);
    }
  }
  return options.input;
}

async function parseJsonObjectOrFile(source: string, label: string): Promise<Record<string, unknown>> {
  let raw = source.trim();
  if (!raw.startsWith('{')) {
    try {
      raw = await fs.readFile(path.resolve(source), 'utf8');
    } catch (error) {
      throw new CliError(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`, 'USAGE_ERROR', 2);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${label} must be a JSON object or a path to a JSON file`, 'USAGE_ERROR', 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${label} must be a JSON object`, 'USAGE_ERROR', 2);
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new CliError(`Invalid ${label}: ${raw}`, 'USAGE_ERROR', 2);
  }
  return Math.floor(value);
}

function quickActionRow(action: any): Record<string, unknown> {
  return {
    Slug: action.slug || '',
    Name: action.name || '',
    Description: action.description || '',
    Model: action.model || '',
    Input: action.input_question || action.inputQuestion || '',
    Iterations: action.max_iterations || action.maxIterations || ''
  };
}

function extractBackendMessage(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return 'Request failed';
  const obj = envelope as any;
  return String(obj.error?.message || obj.error || obj.message || obj.details || 'Request failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
