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

interface McpOptions {
  json?: boolean;
  url?: string;
  description?: string;
  toolPrefix?: string;
  header?: string[];
  force?: boolean;
  noConnect?: boolean;
  credentials?: string;
  credentialsFile?: string;
  credential?: string[];
  name?: string;
  yes?: boolean;
}

type BackendEnvelope<T = unknown> = {
  status?: string;
  data?: T;
  message?: string;
  error?: unknown;
  errors?: unknown;
};

export function createMcpCommand(context: CommandContext): Command {
  const command = new Command('mcp');
  command.description('Connect, deploy, and manage MCP servers');

  command
    .command('list')
    .description('List MCP servers connected to the configured Kablewy user')
    .option('--json', 'Output JSON')
    .action(async (options: McpOptions) => handleMcpAction(context, options, () => listServers(context, options)));

  command
    .command('show')
    .description('Show a connected MCP server')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => showServer(context, server, options)));

  command
    .command('connect')
    .alias('add')
    .description('Connect an existing or externally hosted MCP server')
    .argument('<server>', 'Existing server ID/name, or display name when --url is provided')
    .option('--url <url>', 'External MCP endpoint URL, usually ending in /mcp')
    .option('--description <text>', 'Description for a newly added server')
    .option('--tool-prefix <prefix>', 'Tool prefix for a newly added server')
    .option('--header <key=value>', 'Static auth/header to store with the server; repeatable', collect, [])
    .option('--force', 'Add the server even if the preflight test fails')
    .option('--no-connect', 'Add the server record without connecting it')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => connectServer(context, server, options)));

  command
    .command('disconnect')
    .description('Disconnect an MCP server without deleting it')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => disconnectServer(context, server, options)));

  command
    .command('remove')
    .alias('delete')
    .description('Remove an MCP server connection')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--yes', 'Confirm removal without prompting')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => removeServer(context, server, options)));

  command
    .command('health')
    .description('Check MCP server health')
    .argument('[server]', 'Server ID, name, or tool prefix. Omit to probe every enabled server.')
    .option('--json', 'Output JSON')
    .action(async (server: string | undefined, options: McpOptions) => handleMcpAction(context, options, () => healthCheck(context, server, options)));

  command
    .command('tools')
    .description('List tools exposed by one connected MCP server')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => listServerTools(context, server, options)));

  command
    .command('test')
    .description('Test an external MCP endpoint without saving it')
    .argument('<url>', 'External MCP endpoint URL')
    .option('--header <key=value>', 'Static auth/header to use for the test; repeatable', collect, [])
    .option('--json', 'Output JSON')
    .action(async (url: string, options: McpOptions) => handleMcpAction(context, options, () => testConnection(context, url, options)));

  command
    .command('validate-url')
    .description('Validate an external MCP endpoint URL against org policy')
    .argument('<url>', 'External MCP endpoint URL')
    .option('--json', 'Output JSON')
    .action(async (url: string, options: McpOptions) => handleMcpAction(context, options, () => validateUrl(context, url, options)));

  command
    .command('deploy')
    .description('Deploy a custom MCP worker module to Kablewy-hosted Workers for Platforms')
    .argument('<workerModulePath>', 'Built Worker ES module file, for example dist/worker.mjs')
    .requiredOption('--name <name>', 'Server display name')
    .option('--description <text>', 'What this server does')
    .option('--tool-prefix <prefix>', 'Optional lowercase alphanumeric tool prefix')
    .option('--json', 'Output JSON')
    .action(async (workerModulePath: string, options: McpOptions) => handleMcpAction(context, options, () => deployCustomWorker(context, workerModulePath, options)));

  const catalog = command.command('catalog').description('Browse and deploy Kablewy-hosted MCP server templates');
  catalog
    .command('list')
    .description('List available MCP catalog templates')
    .option('--json', 'Output JSON')
    .action(async (options: McpOptions) => handleMcpAction(context, options, () => listCatalog(context, options)));
  catalog
    .command('show')
    .description('Show a catalog template and required credentials')
    .argument('<templateId>', 'Catalog template ID')
    .option('--json', 'Output JSON')
    .action(async (templateId: string, options: McpOptions) => handleMcpAction(context, options, () => showCatalogTemplate(context, templateId, options)));
  catalog
    .command('deploy')
    .description('Deploy a Kablewy-hosted MCP catalog template')
    .argument('<templateId>', 'Catalog template ID')
    .option('--credentials <jsonOrPath>', 'Credential object as inline JSON or a path to a JSON file')
    .option('--credentials-file <path>', 'Path to a JSON credential file')
    .option('--credential <key=value>', 'Credential value; repeatable', collect, [])
    .option('--json', 'Output JSON')
    .action(async (templateId: string, options: McpOptions) => handleMcpAction(context, options, () => deployCatalogTemplate(context, templateId, options)));

  const deployment = command.command('deployment').description('Manage Kablewy-hosted MCP deployments');
  deployment
    .command('status')
    .description('Show deployment status for an MCP server')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => deploymentStatus(context, server, options)));
  deployment
    .command('stop')
    .description('Stop a hosted MCP deployment and disable its server')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--yes', 'Confirm stop without prompting')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => stopDeployment(context, server, options)));
  deployment
    .command('upgrade')
    .description('Upgrade a catalog-hosted MCP deployment to the latest bundle')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => upgradeDeployment(context, server, options)));
  deployment
    .command('delete')
    .description('Delete a hosted MCP deployment and remove its server')
    .argument('<server>', 'Server ID, name, or tool prefix')
    .option('--yes', 'Confirm deletion without prompting')
    .option('--json', 'Output JSON')
    .action(async (server: string, options: McpOptions) => handleMcpAction(context, options, () => deleteDeployment(context, server, options)));

  command.action(() => {
    context.output.section('MCP Servers');
    context.output.list([
      'kablewy mcp connect customer-crm --url https://crm.example.com/mcp',
      'kablewy mcp list',
      'kablewy mcp health <server>',
      'kablewy mcp tools <server>',
      'kablewy mcp catalog list',
      'kablewy mcp catalog deploy wheniwork --credentials ./credentials.json',
      'kablewy mcp deploy ./dist/worker.mjs --name customer-crm',
      'kablewy mcp deployment status <server>'
    ]);
  });

  return command;
}

async function handleMcpAction(context: CommandContext, options: McpOptions, fn: () => Promise<void>): Promise<void> {
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

async function listServers(context: CommandContext, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const body = await requestData<{ servers?: unknown[] }>(context, 'GET', serverPath(config));
  const servers = Array.isArray(body?.servers) ? body.servers : [];
  if (options.json) {
    writeJsonSuccess(context, { servers });
    return;
  }
  context.output.section('MCP Servers');
  if (servers.length === 0) {
    context.output.info('No MCP servers connected');
    return;
  }
  context.output.table(servers.map(serverRow));
}

async function showServer(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  const body = await requestData<{ server?: unknown }>(context, 'GET', `${serverPath(config)}/${encodeURIComponent(serverId)}`);
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  context.output.section(`MCP Server: ${serverRef}`);
  context.output.json(redactSecrets(body.server ?? body));
}

async function connectServer(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  let serverId = serverRef;
  let addedServer: unknown;
  let testResult: unknown;

  if (options.url) {
    const authHeaders = parseHeaders(options.header);
    testResult = await testConnectionPayload(context, options.url, authHeaders);
    const testOk = (testResult as any)?.success === true;
    if (!testOk && !options.force) {
      throw new CliError(`MCP endpoint test failed: ${(testResult as any)?.error || 'unknown error'}`, 'NETWORK_ERROR', 70, undefined, testResult);
    }

    const body = await requestData<{ server?: any }>(context, 'POST', serverPath(config), {
      name: serverRef,
      url: options.url,
      tool_prefix: options.toolPrefix,
      auth_headers: Object.keys(authHeaders).length > 0 ? authHeaders : undefined,
      description: options.description
    });
    addedServer = body.server;
    serverId = String((body.server as any)?.id || serverRef);
  } else {
    serverId = await resolveServerId(context, serverRef);
  }

  if (options.noConnect) {
    const payload = { connected: false, server: addedServer ?? { id: serverId }, test: testResult };
    if (options.json) writeJsonSuccess(context, payload);
    else context.output.success(`MCP server '${serverRef}' saved`);
    return;
  }

  const connected = await requestData<{ server?: unknown; toolsCount?: number }>(context, 'POST', `${serverPath(config)}/${encodeURIComponent(serverId)}/connect`);
  const payload = { connected: true, ...connected, ...(testResult ? { test: testResult } : {}) };
  if (options.json) {
    writeJsonSuccess(context, payload);
    return;
  }
  context.output.success(`MCP server '${serverRef}' connected`);
  if (typeof connected.toolsCount === 'number') context.output.info(`Tools discovered: ${connected.toolsCount}`);
}

async function disconnectServer(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  const body = await requestData(context, 'POST', `${serverPath(config)}/${encodeURIComponent(serverId)}/disconnect`);
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  context.output.success(`MCP server '${serverRef}' disconnected`);
}

async function removeServer(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  if (!options.yes) {
    const confirmed = await context.input.confirm(`Remove MCP server ${serverRef}?`);
    if (!confirmed) {
      if (options.json) writeJsonSuccess(context, { removed: false, serverId });
      else context.output.info('MCP server removal cancelled');
      return;
    }
  }
  const body = await requestData(context, 'DELETE', `${serverPath(config)}/${encodeURIComponent(serverId)}`);
  if (options.json) {
    writeJsonSuccess(context, { removed: true, serverId, ...asObject(body) });
    return;
  }
  context.output.success(`MCP server '${serverRef}' removed`);
}

async function healthCheck(context: CommandContext, serverRef: string | undefined, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const body = serverRef
    ? await requestData(context, 'GET', `${serverPath(config)}/${encodeURIComponent(await resolveServerId(context, serverRef))}/health`)
    : await requestData(context, 'POST', `${serverPath(config)}/health-batch`, {});
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  context.output.section(serverRef ? `MCP Health: ${serverRef}` : 'MCP Health');
  if (serverRef) {
    context.output.json(redactSecrets(body));
    return;
  }
  const results = Array.isArray((body as any)?.results) ? (body as any).results : [];
  if (results.length === 0) {
    context.output.info('No enabled MCP servers were probed');
    return;
  }
  context.output.table(results.map((result: any) => ({
    Server: result.serverId,
    Healthy: result.healthy ? 'yes' : 'no',
    State: result.connection_state || '',
    Latency: result.latencyMs ? `${result.latencyMs}ms` : '',
    Error: result.error || ''
  })));
}

async function listServerTools(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  const body = await requestData<{ tools?: unknown[] }>(context, 'GET', `${serverPath(config)}/${encodeURIComponent(serverId)}/tools`);
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (options.json) {
    writeJsonSuccess(context, { tools });
    return;
  }
  context.output.section(`MCP Tools: ${serverRef}`);
  if (tools.length === 0) {
    context.output.info('No tools returned by this server');
    return;
  }
  context.output.table(tools.map((tool: any) => ({
    Name: tool.name,
    Description: truncate(String(tool.description || ''), 80),
    Parameters: Object.keys(tool.inputSchema?.properties || tool.input_schema?.properties || {}).length
  })));
}

async function testConnection(context: CommandContext, url: string, options: McpOptions): Promise<void> {
  const result = await testConnectionPayload(context, url, parseHeaders(options.header));
  if (options.json) {
    writeJsonSuccess(context, result);
    return;
  }
  if ((result as any)?.success) {
    context.output.success(`MCP endpoint responded: ${(result as any).serverName || 'unknown server'}`);
    if ((result as any).latencyMs) context.output.info(`Latency: ${(result as any).latencyMs}ms`);
  } else {
    context.output.error(`MCP endpoint test failed: ${(result as any)?.error || 'unknown error'}`);
    process.exitCode = 70;
  }
}

async function validateUrl(context: CommandContext, url: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const body = await requestData(context, 'POST', `${serverPath(config)}/validate-url`, { url });
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  if ((body as any)?.valid) context.output.success('MCP endpoint URL is allowed');
  else context.output.error(`MCP endpoint URL is not allowed: ${(body as any)?.error || 'unknown reason'}`);
}

async function deployCustomWorker(context: CommandContext, workerModulePath: string, options: McpOptions): Promise<void> {
  const fullPath = path.resolve(workerModulePath);
  let workerModule: string;
  try {
    workerModule = await fs.readFile(fullPath, 'utf8');
  } catch (error) {
    throw new CliError(`Unable to read worker module: ${error instanceof Error ? error.message : String(error)}`, 'USAGE_ERROR', 2);
  }
  if (!workerModule.trim()) throw new CliError('Worker module file is empty', 'USAGE_ERROR', 2);

  const normalized = await callKablewyMcpTool(context, 'deploy_mcp_server', {
    name: options.name,
    description: options.description,
    worker_module: workerModule,
    tool_prefix: options.toolPrefix
  });
  if (options.json) {
    writeJsonSuccess(context, normalized);
    return;
  }
  const payload = asObject(normalized);
  context.output.success(`Hosted MCP server '${options.name}' deployed`);
  if (payload.endpointUrl) context.output.info(`Endpoint: ${payload.endpointUrl}`);
  if (payload.mcpServerId) context.output.info(`Server ID: ${payload.mcpServerId}`);
  if (payload.workerName) context.output.info(`Worker: ${payload.workerName}`);
  if (payload.adminSecret) context.output.info('Admin secret generated and redacted from CLI output.');
}

async function listCatalog(context: CommandContext, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const body = await requestData<{ templates?: unknown[] }>(context, 'GET', `/v1/mcp-servers/${encodeURIComponent(config.orgId)}/catalog`);
  const templates = Array.isArray(body?.templates) ? body.templates : [];
  if (options.json) {
    writeJsonSuccess(context, { templates });
    return;
  }
  context.output.section('MCP Catalog');
  if (templates.length === 0) {
    context.output.info('No catalog templates available');
    return;
  }
  context.output.table(templates.map((template: any) => ({
    ID: template.id,
    Name: template.name,
    Category: template.category,
    Tools: template.toolCount,
    Auth: template.authType || 'api_key',
    Status: template.status
  })));
}

async function showCatalogTemplate(context: CommandContext, templateId: string, options: McpOptions): Promise<void> {
  const template = await getCatalogTemplate(context, templateId);
  if (options.json) {
    writeJsonSuccess(context, template);
    return;
  }
  context.output.section(`MCP Catalog Template: ${templateId}`);
  context.output.json(redactSecrets(template));
}

async function deployCatalogTemplate(context: CommandContext, templateId: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const template = await getCatalogTemplate(context, templateId);
  if ((template as any)?.authType === 'oauth2') {
    throw new CliError(`Catalog template '${templateId}' uses OAuth. Start OAuth setup from the Kablewy app, then use 'kablewy mcp list' and 'kablewy mcp deployment status <server>'.`, 'USAGE_ERROR', 2);
  }
  const credentials = await loadCredentials(options);
  const body = await requestData(context, 'POST', `${serverPath(config)}/catalog/${encodeURIComponent(templateId)}/deploy`, { credentials });
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  context.output.success(`Catalog MCP server '${templateId}' deployed`);
  const payload = asObject(body);
  if (payload.endpointUrl) context.output.info(`Endpoint: ${payload.endpointUrl}`);
  if (payload.mcpServerId) context.output.info(`Server ID: ${payload.mcpServerId}`);
  if (payload.toolCount !== undefined) context.output.info(`Tools: ${payload.toolCount}`);
}

async function deploymentStatus(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  const body = await requestData(context, 'GET', `${serverPath(config)}/${encodeURIComponent(serverId)}/deployment`);
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  context.output.section(`MCP Deployment: ${serverRef}`);
  context.output.json(redactSecrets(body));
}

async function stopDeployment(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  if (!options.yes) {
    const confirmed = await context.input.confirm(`Stop hosted MCP deployment ${serverRef}?`);
    if (!confirmed) {
      if (options.json) writeJsonSuccess(context, { stopped: false, serverId });
      else context.output.info('MCP deployment stop cancelled');
      return;
    }
  }
  const body = await requestData(context, 'POST', `${serverPath(config)}/${encodeURIComponent(serverId)}/deployment/stop`);
  if (options.json) {
    writeJsonSuccess(context, { stopped: true, serverId, ...asObject(body) });
    return;
  }
  context.output.success(`Hosted MCP deployment '${serverRef}' stopped`);
}

async function upgradeDeployment(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  const body = await requestData(context, 'POST', `${serverPath(config)}/${encodeURIComponent(serverId)}/deployment/upgrade`);
  if (options.json) {
    writeJsonSuccess(context, body);
    return;
  }
  context.output.section(`MCP Deployment Upgrade: ${serverRef}`);
  context.output.json(redactSecrets(body));
}

async function deleteDeployment(context: CommandContext, serverRef: string, options: McpOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const serverId = await resolveServerId(context, serverRef);
  if (!options.yes) {
    const confirmed = await context.input.confirm(`Delete hosted MCP deployment ${serverRef}? This removes the worker and server entry.`);
    if (!confirmed) {
      if (options.json) writeJsonSuccess(context, { deleted: false, serverId });
      else context.output.info('MCP deployment deletion cancelled');
      return;
    }
  }
  const body = await requestData(context, 'DELETE', `${serverPath(config)}/${encodeURIComponent(serverId)}/deployment`);
  if (options.json) {
    writeJsonSuccess(context, { deleted: true, serverId, ...asObject(body) });
    return;
  }
  context.output.success(`Hosted MCP deployment '${serverRef}' deleted`);
}

async function requestData<T = unknown>(context: CommandContext, method: string, path: string, body?: unknown): Promise<T> {
  const result = await createApiClient(context).request<BackendEnvelope<T>>(method, path, body === undefined ? {} : { body });
  const envelope = result.data;
  if (envelope && typeof envelope === 'object' && (envelope as BackendEnvelope).status === 'error') {
    throw new CliError(extractBackendMessage(envelope), 'BACKEND_ERROR', 70, result.requestId, envelope);
  }
  if (envelope && typeof envelope === 'object' && 'data' in envelope) {
    return (envelope as BackendEnvelope<T>).data as T;
  }
  return envelope as T;
}

async function callKablewyMcpTool(context: CommandContext, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const config = requireCoreApiConfig(context);
  const result = await createApiClient(context).request<any>('POST', `/v1/mcp-jsonrpc/${encodeURIComponent(config.orgId)}/users/${encodeURIComponent(config.userId)}/mcp/jsonrpc`, {
    body: {
      jsonrpc: '2.0',
      id: `kablewy-cli-${Date.now()}`,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    }
  });
  const body = result.data;
  if (body?.error) {
    throw new CliError(body.error.message || `MCP tool '${toolName}' failed`, 'BACKEND_ERROR', 70, result.requestId, body);
  }
  return normalizeToolResult(body?.result ?? body);
}

async function resolveServerId(context: CommandContext, serverRef: string): Promise<string> {
  const config = requireCoreApiConfig(context);
  const body = await requestData<{ servers?: any[] }>(context, 'GET', serverPath(config));
  const servers = Array.isArray(body?.servers) ? body.servers : [];
  const exact = servers.filter((server) =>
    server?.id === serverRef ||
    server?.name === serverRef ||
    server?.tool_prefix === serverRef ||
    server?.toolPrefix === serverRef
  );
  if (exact.length === 1) return String(exact[0].id);
  if (exact.length > 1) throw new CliError(`MCP server reference '${serverRef}' is ambiguous; use the server ID.`, 'USAGE_ERROR', 2);
  if (/^[A-Za-z0-9_-]{8,}$/.test(serverRef)) return serverRef;
  throw new CliError(`MCP server '${serverRef}' not found`, 'NOT_FOUND', 66);
}

async function testConnectionPayload(context: CommandContext, url: string, authHeaders: Record<string, string>): Promise<unknown> {
  const config = requireCoreApiConfig(context);
  return requestData(context, 'POST', `${serverPath(config)}/test-connection`, {
    url,
    auth_headers: Object.keys(authHeaders).length > 0 ? authHeaders : undefined
  });
}

async function getCatalogTemplate(context: CommandContext, templateId: string): Promise<unknown> {
  const config = requireCoreApiConfig(context);
  return requestData(context, 'GET', `/v1/mcp-servers/${encodeURIComponent(config.orgId)}/catalog/${encodeURIComponent(templateId)}`);
}

function serverPath(config: { orgId: string; userId: string }): string {
  return `/v1/mcp-servers/${encodeURIComponent(config.orgId)}/users/${encodeURIComponent(config.userId)}`;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function parseHeaders(values: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values || []) {
    const index = raw.indexOf('=');
    if (index <= 0) {
      throw new CliError(`Invalid header '${raw}'. Use key=value.`, 'USAGE_ERROR', 2);
    }
    const key = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).trim();
    if (!key || !value) {
      throw new CliError(`Invalid header '${raw}'. Use key=value.`, 'USAGE_ERROR', 2);
    }
    headers[key] = value;
  }
  return headers;
}

async function loadCredentials(options: McpOptions): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};
  const source = options.credentialsFile || options.credentials;
  if (source) {
    Object.assign(credentials, await parseJsonOrFile(source));
  }
  for (const raw of options.credential || []) {
    const index = raw.indexOf('=');
    if (index <= 0) {
      throw new CliError(`Invalid credential '${raw}'. Use key=value.`, 'USAGE_ERROR', 2);
    }
    credentials[raw.slice(0, index).trim()] = raw.slice(index + 1).trim();
  }
  return credentials;
}

async function parseJsonOrFile(source: string): Promise<Record<string, string>> {
  let raw = source.trim();
  if (!raw.startsWith('{')) {
    try {
      raw = await fs.readFile(path.resolve(source), 'utf8');
    } catch (error) {
      throw new CliError(`Unable to read credentials: ${error instanceof Error ? error.message : String(error)}`, 'USAGE_ERROR', 2);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('Credentials must be a JSON object or a path to a JSON file', 'USAGE_ERROR', 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('Credentials must be a JSON object', 'USAGE_ERROR', 2);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function normalizeToolResult(result: unknown): unknown {
  const data = (result as any)?.data ?? result;
  const content = (data as any)?.content;
  if (Array.isArray(content)) {
    const textPart = content.find((part: any) => part?.type === 'text' && typeof part.text === 'string');
    if (textPart) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return { text: textPart.text };
      }
    }
  }
  return data;
}

function extractBackendMessage(envelope: unknown): string {
  const obj = asObject(envelope);
  return String((obj.error as any)?.message || obj.message || obj.errors || 'Request failed');
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function serverRow(server: any): Record<string, unknown> {
  return {
    ID: server.id,
    Name: server.name,
    URL: server.url,
    Prefix: server.tool_prefix || server.toolPrefix || '',
    State: server.connection_state || server.connectionState || '',
    Tools: server.tools_count ?? server.toolsCount ?? '',
    Enabled: server.enabled === 0 ? 'no' : 'yes'
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
