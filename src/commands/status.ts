import { Command } from 'commander';
import { CommandContext, StatusOptions, MCPToolProperty } from '../types/index.js';
import { exitCodeFor, writeJsonError, writeJsonSuccess } from '../core/api-client.js';

type HealthState = 'healthy' | 'warning' | 'unhealthy';

interface HealthResult {
  name: string;
  status: HealthState;
  detail: string;
}

export function createStatusCommand(context: CommandContext): Command {
  const command = new Command('status');

  command
    .description('Check connectivity, credential validity, and available tools')
    .option('--health', 'Run health checks (configuration, backend, credential, tools)')
    .option('--tools', 'List available MCP tools')
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show detailed information')
    .action(async (options: StatusOptions) => {
      await handleStatus(options, context);
    });

  return command;
}

async function handleStatus(options: StatusOptions, context: CommandContext): Promise<void> {
  const { output } = context;

  try {
    if (options.tools) {
      await listTools(options, context);
    } else {
      // Default and --health both run the real checks; --health adds the issue list.
      await showHealth(options, context);
    }
  } catch (error: unknown) {
    if (options.json) {
      writeJsonError(context, error);
    } else {
      output.error(`Status check failed: ${errMessage(error)}`);
    }
    process.exitCode = exitCodeFor(error);
    if (options.verbose) {
      console.error(error);
    }
  }
}

async function showHealth(options: StatusOptions, context: CommandContext): Promise<void> {
  const { output, config } = context;
  const configData = (config as unknown as { getAll(): Record<string, unknown> }).getAll();

  if (!options.json) {
    output.section('Kablewy CLI Status');
    output.info(`API URL: ${configData.apiUrl}`);
    output.info(`Organization: ${configData.orgId}`);
    output.info(`User: ${configData.userId}`);
    output.info(`MCP Servers: ${Object.keys((configData.mcpServers as object) || {}).length} configured`);
  }

  const { results, toolCount } = await runHealthChecks(context);
  const issues = results.filter(r => r.status !== 'healthy');
  const overall = issues.some(i => i.status === 'unhealthy') ? 'unhealthy' : issues.length ? 'degraded' : 'healthy';

  // Scripts use `status` as a preflight gate (`set -e` + status --json), so an
  // unhealthy overall must be reflected in the exit code, not just the output.
  if (overall === 'unhealthy') {
    process.exitCode = 1;
  }

  if (options.json) {
    writeJsonSuccess(context, {
      overall,
      config: {
        apiUrl: configData.apiUrl,
        orgId: configData.orgId,
        userId: configData.userId
      },
      toolCount,
      checks: results.reduce((acc, r) => {
        acc[r.name.toLowerCase()] = { status: r.status, detail: r.detail };
        return acc;
      }, {} as Record<string, { status: HealthState; detail: string }>)
    });
    return;
  }

  output.section('Health');
  output.table(
    results.map(r => ({
      Check: r.name,
      Status: `${getStatusIcon(r.status)} ${r.status}`,
      Detail: r.detail
    }))
  );

  if (issues.length === 0) {
    output.success(`All checks passed — credential valid, ${toolCount} tools reachable.`);
  } else {
    output.section('Issues');
    issues.forEach(issue => {
      const fn = issue.status === 'warning' ? output.warning : output.error;
      fn.call(output, `${issue.name}: ${issue.detail}`);
    });
  }
}

/**
 * Runs the real connectivity + credential checks:
 *   1. Configuration  — required fields present (ConfigManager.validate)
 *   2. Backend        — unauthenticated GET /v1/public/health
 *   3. Credential     — authed MCP tools/list round-trip (proves the api key + org are valid)
 *   4. Tools          — at least one tool reachable
 * No mock data: every result reflects a real call.
 */
async function runHealthChecks(context: CommandContext): Promise<{ results: HealthResult[]; toolCount: number }> {
  const { config } = context;
  const cfg = (config as unknown as { getAll(): Record<string, unknown>; validate(): { valid: boolean; errors: string[] } });
  const configData = cfg.getAll();
  const results: HealthResult[] = [];

  // 1. Configuration
  const validation = cfg.validate();
  results.push({
    name: 'Configuration',
    status: validation.valid ? 'healthy' : 'unhealthy',
    detail: validation.valid ? 'all required fields set' : validation.errors.join('; ')
  });

  // 2. Backend reachability (unauthenticated)
  const base = String(configData.apiUrl || '').replace(/\/+$/, '');
  let backendUp = false;
  try {
    const res = await fetch(`${base}/v1/public/health`, { method: 'GET' });
    backendUp = res.ok;
    results.push({
      name: 'Backend',
      status: res.ok ? 'healthy' : 'unhealthy',
      detail: res.ok ? `reachable (${base})` : `HTTP ${res.status} from ${base}`
    });
  } catch (error: unknown) {
    results.push({ name: 'Backend', status: 'unhealthy', detail: `unreachable: ${errMessage(error)}` });
  }

  // 3 + 4. Credential validity + tool availability (direct authed probe).
  // We probe the JSON-RPC tools/list directly rather than via the MCP client, because the
  // client swallows HTTP errors and returns [] — which would mask a 401/403 as "0 tools".
  const apiKey = String(configData.apiKey || '');
  const orgId = String(configData.orgId || '');
  const userId = String(configData.userId || '');
  const probe = await probeCredential(base, orgId, userId, apiKey);

  results.push({
    name: 'Credential',
    status: probe.state === 'valid' ? 'healthy' : 'unhealthy',
    detail: probe.detail
  });
  results.push({
    name: 'Tools',
    status: probe.state !== 'valid' ? 'unhealthy' : probe.toolCount > 0 ? 'healthy' : 'warning',
    detail:
      probe.state !== 'valid'
        ? 'unavailable (credential not authorized)'
        : probe.toolCount > 0
          ? `${probe.toolCount} available`
          : 'authorized but none available'
  });

  return { results, toolCount: probe.toolCount };
}

interface CredentialProbe {
  state: 'valid' | 'unauthorized' | 'forbidden' | 'unreachable' | 'error';
  toolCount: number;
  detail: string;
}

/** Direct authed JSON-RPC tools/list probe that surfaces HTTP status (200/401/403/network). */
async function probeCredential(base: string, orgId: string, userId: string, apiKey: string): Promise<CredentialProbe> {
  if (!apiKey) {
    return { state: 'unauthorized', toolCount: 0, detail: 'no API key configured — run `kablewy login`' };
  }
  const url = `${base}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/jsonrpc`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
  } catch (error: unknown) {
    return { state: 'unreachable', toolCount: 0, detail: `backend unreachable: ${errMessage(error)}` };
  }

  if (res.status === 401) {
    return { state: 'unauthorized', toolCount: 0, detail: 'key rejected (401) — expired or invalid; re-run `kablewy login`' };
  }
  if (res.status === 403) {
    let reason = '';
    try {
      const b = (await res.json()) as { error?: { message?: string; details?: { reason?: string } } };
      reason = b?.error?.details?.reason || b?.error?.message || '';
    } catch {
      // ignore parse error
    }
    return { state: 'forbidden', toolCount: 0, detail: `forbidden (403)${reason ? `: ${reason}` : ''}` };
  }
  if (!res.ok) {
    return { state: 'error', toolCount: 0, detail: `unexpected HTTP ${res.status}` };
  }

  let toolCount = 0;
  try {
    const b = (await res.json()) as { result?: { tools?: unknown[] } };
    toolCount = Array.isArray(b?.result?.tools) ? b.result!.tools!.length : 0;
  } catch {
    // ignore parse error
  }
  return { state: 'valid', toolCount, detail: `valid (${toolCount} tools reachable)` };
}

async function listTools(options: StatusOptions, context: CommandContext): Promise<void> {
  const { output, mcpClient } = context;

  try {
    const tools = await mcpClient.listTools();

    if (options.json) {
      writeJsonSuccess(context, tools);
      return;
    }

    if (tools.length === 0) {
      output.info('No MCP tools available');
      return;
    }

    output.section('Available MCP Tools');

    const toolData = tools.map(tool => ({
      Name: tool.name,
      Server: tool.server,
      Description: tool.description,
      Parameters: Object.keys(tool.inputSchema?.properties || {}).length
    }));

    output.table(toolData);

    if (options.verbose) {
      output.section('Detailed Tool Information');
      tools.forEach(tool => {
        output.info(`\n${tool.name} (${tool.server})`);
        output.info(`  Description: ${tool.description}`);
        if (tool.inputSchema?.properties) {
          output.info('  Parameters:');
          Object.entries(tool.inputSchema.properties).forEach(([param, schema]: [string, MCPToolProperty]) => {
            output.info(`    - ${param}: ${schema.type} ${schema.description ? `(${schema.description})` : ''}`);
          });
        }
      });
    }
  } catch (error: unknown) {
    if (options.json) {
      writeJsonError(context, error);
    } else {
      output.error(`Failed to list tools: ${errMessage(error)}`);
    }
    process.exitCode = exitCodeFor(error);
  }
}

function getStatusIcon(status: HealthState): string {
  switch (status) {
    case 'healthy':
      return '✓';
    case 'warning':
      return '⚠';
    case 'unhealthy':
      return '✗';
    default:
      return '?';
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
