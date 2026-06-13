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
import { redactSecrets } from '../utils/redact.js';

interface WebhookOptions {
  json?: boolean;
  activeOnly?: boolean;
  name?: string;
  url?: string;
  description?: string;
  event?: string | string[];
  clearEvents?: boolean;
  header?: string[];
  authType?: 'none' | 'bearer' | 'api_key' | 'basic';
  auth?: string[];
  payload?: string;
  limit?: string;
  offset?: string;
  status?: string;
  yes?: boolean;
}

type BackendEnvelope<T = unknown> = {
  success?: boolean;
  data?: T;
  pagination?: unknown;
  test_result?: unknown;
  message?: string;
  error?: unknown;
};

export function createWebhooksCommand(context: CommandContext): Command {
  const command = new Command('webhooks');
  command.description('Manage outbound webhooks and trigger automation jobs');

  command
    .command('list')
    .description('List outbound webhook destinations')
    .option('--active-only', 'Only show active destinations')
    .option('--json', 'Output JSON')
    .action(async (options: WebhookOptions) => handleWebhookAction(context, options, () => listDestinations(context, options)));

  command
    .command('show')
    .description('Show an outbound webhook destination')
    .argument('<destinationId>', 'Webhook destination ID')
    .option('--json', 'Output JSON')
    .action(async (destinationId: string, options: WebhookOptions) => handleWebhookAction(context, options, () => showDestination(context, destinationId, options)));

  command
    .command('create')
    .description('Create an outbound webhook destination')
    .requiredOption('--name <name>', 'Destination name')
    .requiredOption('--url <url>', 'Destination HTTPS URL')
    .option('--description <text>', 'Destination description')
    .option('--event <eventType>', 'Event type to subscribe to; repeatable', collect, [])
    .option('--header <key=value>', 'Header to send with deliveries; repeatable', collect, [])
    .option('--auth-type <type>', 'Auth type: none|bearer|api_key|basic', 'none')
    .option('--auth <key=value>', 'Auth config value; repeatable', collect, [])
    .option('--json', 'Output JSON')
    .action(async (options: WebhookOptions) => handleWebhookAction(context, options, () => createDestination(context, options)));

  command
    .command('update')
    .description('Update an outbound webhook destination')
    .argument('<destinationId>', 'Webhook destination ID')
    .option('--name <name>', 'Destination name')
    .option('--url <url>', 'Destination HTTPS URL')
    .option('--description <text>', 'Destination description')
    .option('--event <eventType>', 'Replace event subscriptions; repeatable', collect, [])
    .option('--clear-events', 'Clear all event subscriptions')
    .option('--header <key=value>', 'Replace stored headers; repeatable', collect, [])
    .option('--auth-type <type>', 'Auth type: none|bearer|api_key|basic')
    .option('--auth <key=value>', 'Auth config value; repeatable', collect, [])
    .option('--json', 'Output JSON')
    .action(async (destinationId: string, options: WebhookOptions) => handleWebhookAction(context, options, () => updateDestination(context, destinationId, options)));

  command
    .command('delete')
    .description('Delete an outbound webhook destination')
    .argument('<destinationId>', 'Webhook destination ID')
    .option('--yes', 'Confirm deletion without prompting')
    .option('--json', 'Output JSON')
    .action(async (destinationId: string, options: WebhookOptions) => handleWebhookAction(context, options, () => deleteDestination(context, destinationId, options)));

  command
    .command('test')
    .description('Send a signed test delivery to a webhook destination')
    .argument('<destinationId>', 'Webhook destination ID')
    .option('--event <eventType>', 'Use a canned payload for this event type')
    .option('--payload <jsonOrPath>', 'Custom JSON payload or path to a JSON file')
    .option('--json', 'Output JSON')
    .action(async (destinationId: string, options: WebhookOptions) => handleWebhookAction(context, options, () => testDestination(context, destinationId, options)));

  command
    .command('deliveries')
    .description('List webhook delivery history for a destination')
    .argument('<destinationId>', 'Webhook destination ID')
    .option('--limit <number>', 'Maximum rows to return', '50')
    .option('--offset <number>', 'Pagination offset', '0')
    .option('--status <status>', 'Filter by delivery status: success|failed')
    .option('--json', 'Output JSON')
    .action(async (destinationId: string, options: WebhookOptions) => handleWebhookAction(context, options, () => listDeliveries(context, destinationId, options)));

  command
    .command('trigger')
    .description('Manually trigger a webhook-enabled Automation Job')
    .argument('<jobId>', 'Automation Job ID')
    .option('--payload <jsonOrPath>', 'Trigger payload as inline JSON or a path to a JSON file')
    .option('--json', 'Output JSON')
    .action(async (jobId: string, options: WebhookOptions) => handleWebhookAction(context, options, () => triggerWorkflowJob(context, jobId, options)));

  command.action(() => {
    context.output.section('Webhooks');
    context.output.list([
      'kablewy webhooks list',
      'kablewy webhooks create --name CRM --url https://example.com/webhooks/kablewy --event quick_action.completed',
      'kablewy webhooks test <destinationId> --event quick_action.completed',
      'kablewy webhooks deliveries <destinationId>',
      'kablewy webhooks trigger <jobId> --payload ./event.json'
    ]);
  });

  return command;
}

async function handleWebhookAction(context: CommandContext, options: WebhookOptions, fn: () => Promise<void>): Promise<void> {
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

async function listDestinations(context: CommandContext, options: WebhookOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const destinations = await requestData<any[]>(context, 'GET', destinationsPath(config), undefined, {
    active_only: options.activeOnly || undefined
  });

  if (options.json) {
    writeJsonSuccess(context, { destinations });
    return;
  }

  context.output.section('Webhook Destinations');
  if (destinations.length === 0) {
    context.output.info('No webhook destinations configured');
    return;
  }
  context.output.table(destinations.map(destinationRow));
}

async function showDestination(context: CommandContext, destinationId: string, options: WebhookOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const destination = await requestData<any>(context, 'GET', `${destinationsPath(config)}/${encodeURIComponent(destinationId)}`);

  if (options.json) {
    writeJsonSuccess(context, destination);
    return;
  }

  context.output.section(`Webhook Destination: ${destinationId}`);
  context.output.json(redactSecrets(destination));
}

async function createDestination(context: CommandContext, options: WebhookOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const body = destinationPayload(options, { requireNameAndUrl: true });
  const destination = await requestData<any>(context, 'POST', destinationsPath(config), body);

  if (options.json) {
    writeJsonSuccess(context, destination);
    return;
  }

  context.output.success(`Created webhook destination '${destination.name || options.name}'`);
  if (destination.id) context.output.info(`Destination ID: ${destination.id}`);
  if (destination.signing_secret) context.output.warning('Signing secret was returned by the API and redacted by the CLI output.');
}

async function updateDestination(context: CommandContext, destinationId: string, options: WebhookOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const body = destinationPayload(options, { requireNameAndUrl: false });
  if (Object.keys(body).length === 0) {
    throw new CliError('No update fields supplied', 'USAGE_ERROR', 2);
  }

  const destination = await requestData<any>(context, 'PUT', `${destinationsPath(config)}/${encodeURIComponent(destinationId)}`, body);
  if (options.json) {
    writeJsonSuccess(context, destination);
    return;
  }

  context.output.success(`Updated webhook destination ${destinationId}`);
}

async function deleteDestination(context: CommandContext, destinationId: string, options: WebhookOptions): Promise<void> {
  if (!options.yes) {
    const confirmed = await context.input.confirm(`Delete webhook destination ${destinationId}?`);
    if (!confirmed) {
      if (options.json) writeJsonSuccess(context, { deleted: false, destinationId });
      else context.output.info('Webhook destination deletion cancelled');
      return;
    }
  }

  const config = requireCoreApiConfig(context);
  await requestData(context, 'DELETE', `${destinationsPath(config)}/${encodeURIComponent(destinationId)}`);
  if (options.json) {
    writeJsonSuccess(context, { deleted: true, destinationId });
  } else {
    context.output.success(`Deleted webhook destination ${destinationId}`);
  }
}

async function testDestination(context: CommandContext, destinationId: string, options: WebhookOptions): Promise<void> {
  if (options.event && Array.isArray(options.event)) {
    throw new CliError('Use a single --event value with webhooks test', 'USAGE_ERROR', 2);
  }
  const config = requireCoreApiConfig(context);
  const body: Record<string, unknown> = {};
  const eventType = typeof options.event === 'string' ? options.event : Array.isArray(options.event) ? options.event[0] : undefined;
  if (eventType) body.event_type = eventType;
  if (options.payload) body.test_payload = await parseJsonObjectOrFile(options.payload, 'payload');

  const result = await requestData<any>(context, 'POST', `${destinationsPath(config)}/${encodeURIComponent(destinationId)}/test`, body);
  if (options.json) {
    writeJsonSuccess(context, result);
    return;
  }

  const testResult = result?.test_result || result;
  if (testResult?.success) {
    context.output.success(`Webhook test delivered (${testResult.status_code || 'unknown status'})`);
  } else {
    context.output.error(`Webhook test failed: ${testResult?.error || 'unknown error'}`);
  }
  context.output.json(redactSecrets(testResult));
}

async function listDeliveries(context: CommandContext, destinationId: string, options: WebhookOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const limit = parseNonNegativeInteger(options.limit || '50', 'limit');
  const offset = parseNonNegativeInteger(options.offset || '0', 'offset');
  const status = normalizeDeliveryStatus(options.status);
  const body = await requestData<any>(context, 'GET', `${destinationsPath(config)}/${encodeURIComponent(destinationId)}/deliveries`, undefined, {
    limit,
    offset,
    status
  });
  const deliveries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];

  if (options.json) {
    writeJsonSuccess(context, { deliveries, pagination: body?.pagination });
    return;
  }

  context.output.section(`Webhook Deliveries: ${destinationId}`);
  if (deliveries.length === 0) {
    context.output.info('No deliveries found');
    return;
  }
  context.output.table(deliveries.map(deliveryRow));
}

async function triggerWorkflowJob(context: CommandContext, jobId: string, options: WebhookOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const payload = options.payload
    ? await parseJsonObjectOrFile(options.payload, 'payload')
    : { event_type: 'manual.cli', data: {}, triggered_by: 'kablewy-cli' };

  const result = await requestData<any>(
    context,
    'POST',
    `/v1/workflow-jobs/${encodeURIComponent(config.orgId)}/trigger/${encodeURIComponent(jobId)}`,
    payload
  );

  if (options.json) {
    writeJsonSuccess(context, result);
    return;
  }

  context.output.success(`Triggered Automation Job ${jobId}`);
  if (result.eventId) context.output.info(`Event ID: ${result.eventId}`);
  if (result.runId) context.output.info(`Run ID: ${result.runId}`);
}

async function requestData<T = unknown>(
  context: CommandContext,
  method: string,
  requestPath: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const result = await createApiClient(context).request<BackendEnvelope<T>>(
    method,
    requestPath,
    body === undefined ? { query } : { body, query }
  );
  const envelope = result.data;
  if (envelope && typeof envelope === 'object' && (envelope as BackendEnvelope).success === false) {
    throw new CliError(extractBackendMessage(envelope), 'BACKEND_ERROR', 70, result.requestId, envelope);
  }
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    return (envelope as BackendEnvelope<T>).data as T;
  }
  return envelope as T;
}

function destinationsPath(config: { orgId: string; userId: string }): string {
  return `/v1/org/${encodeURIComponent(config.orgId)}/users/${encodeURIComponent(config.userId)}/webhook-destinations`;
}

function destinationPayload(options: WebhookOptions, mode: { requireNameAndUrl: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (mode.requireNameAndUrl || options.name) body.name = requireString(options.name, 'name');
  if (mode.requireNameAndUrl || options.url) body.url = requireString(options.url, 'url');
  if (options.description !== undefined) body.description = options.description;
  const events = eventValues(options.event);
  if (options.clearEvents && events.length > 0) {
    throw new CliError('Use either --event or --clear-events, not both', 'USAGE_ERROR', 2);
  }
  if (options.clearEvents) body.event_types = [];
  else if (events.length > 0) body.event_types = events;
  if (options.header && options.header.length > 0) body.headers = parseKeyValues(options.header, 'header');
  if (options.authType) body.auth_type = normalizeAuthType(options.authType);
  if (options.auth && options.auth.length > 0) body.auth_config = parseKeyValues(options.auth, 'auth');
  return body;
}

function normalizeAuthType(value: string): 'none' | 'bearer' | 'api_key' | 'basic' {
  if (value === 'none' || value === 'bearer' || value === 'api_key' || value === 'basic') return value;
  throw new CliError(`Invalid auth type '${value}'. Use none, bearer, api_key, or basic.`, 'USAGE_ERROR', 2);
}

function normalizeDeliveryStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === 'success' || value === 'failed') return value;
  throw new CliError(`Invalid delivery status '${value}'. Use success or failed.`, 'USAGE_ERROR', 2);
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function eventValues(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseKeyValues(values: string[] | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values || []) {
    const index = raw.indexOf('=');
    if (index <= 0) throw new CliError(`Invalid ${label} '${raw}'. Use key=value.`, 'USAGE_ERROR', 2);
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (!key || !value) throw new CliError(`Invalid ${label} '${raw}'. Use key=value.`, 'USAGE_ERROR', 2);
    out[key] = value;
  }
  return out;
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

function parseNonNegativeInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new CliError(`Invalid ${label}: ${raw}`, 'USAGE_ERROR', 2);
  }
  return Math.floor(value);
}

function requireString(value: string | undefined, label: string): string {
  if (!value || !value.trim()) throw new CliError(`Missing required ${label}`, 'USAGE_ERROR', 2);
  return value;
}

function destinationRow(destination: any): Record<string, unknown> {
  return {
    ID: destination.id || '',
    Name: destination.name || '',
    URL: destination.url || '',
    Events: formatEvents(destination.event_types),
    Active: destination.is_active === false || destination.is_active === 0 ? 'no' : 'yes',
    Used: destination.usage_count ?? '',
    LastUsed: destination.last_used || ''
  };
}

function deliveryRow(delivery: any): Record<string, unknown> {
  const metadata = parseJsonMaybe(delivery.metadata);
  return {
    ID: delivery.id || '',
    Event: delivery.event_type || '',
    Success: metadata?.success === false ? 'no' : metadata?.success === true ? 'yes' : '',
    Status: metadata?.status_code || '',
    Duration: metadata?.duration_ms ? `${metadata.duration_ms}ms` : '',
    Time: delivery.timestamp || delivery.created_at || ''
  };
}

function formatEvents(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.join(', ') : value;
    } catch {
      return value;
    }
  }
  return '';
}

function parseJsonMaybe(value: unknown): any {
  if (!value || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractBackendMessage(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') return 'Request failed';
  const obj = envelope as any;
  return String(obj.error?.message || obj.error || obj.message || 'Request failed');
}
