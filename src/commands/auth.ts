import { Command } from 'commander';
import { CommandContext } from '../types/index.js';
import {
  CliError,
  KablewyApiClient,
  createApiClient,
  exitCodeFor,
  getCoreApiConfig,
  requireCoreApiConfig,
  writeJsonError,
  writeJsonSuccess
} from '../core/api-client.js';
import { redactSecrets } from '../utils/redact.js';

interface JsonOption {
  json?: boolean;
}

export function createAuthCommand(context: CommandContext): Command {
  const command = new Command('auth');
  command.description('Manage authentication and API keys');

  const keys = command.command('keys').description('Manage API keys');
  keys
    .command('list')
    .description('List API keys for the configured organization')
    .option('--json', 'Output JSON')
    .action(async (options: JsonOption) => handleAuthAction(context, options, () => listKeys(context, options)));

  keys
    .command('revoke')
    .description('Revoke an API key')
    .argument('<keyId>', 'API key ID')
    .option('--json', 'Output JSON')
    .action(async (keyId: string, options: JsonOption) => handleAuthAction(context, options, () => revokeKey(context, keyId, options)));

  command.action(() => {
    context.output.section('Authentication');
    context.output.list([
      'kablewy login - Sign in and store a scoped API key',
      'kablewy whoami - Verify the active credential',
      'kablewy logout - Clear local credentials and revoke the active key when possible',
      'kablewy auth keys list - List API keys',
      'kablewy auth keys revoke <keyId> - Revoke an API key'
    ]);
  });

  return command;
}

export function createLogoutCommand(context: CommandContext): Command {
  return new Command('logout')
    .description('Clear local credentials and revoke the active API key when possible')
    .option('--json', 'Output JSON')
    .action(async (options: JsonOption) => handleAuthAction(context, options, () => logout(context, options)));
}

export function createWhoamiCommand(context: CommandContext): Command {
  return new Command('whoami')
    .description('Verify and display the active Kablewy CLI identity')
    .option('--json', 'Output JSON')
    .action(async (options: JsonOption) => handleAuthAction(context, options, () => whoami(context, options)));
}

async function handleAuthAction(context: CommandContext, options: JsonOption, fn: () => Promise<void>): Promise<void> {
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

async function whoami(context: CommandContext, options: JsonOption): Promise<void> {
  const config = requireCoreApiConfig(context);
  const client = new KablewyApiClient(config);
  const probe = await client.request('POST', `/v1/mcp-jsonrpc/${config.orgId}/users/${config.userId}/mcp/jsonrpc`, {
    body: { jsonrpc: '2.0', id: 'whoami', method: 'tools/list', params: {} }
  });
  const cfg: any = context.config;
  const payload = {
    apiUrl: config.baseUrl,
    orgId: config.orgId,
    userId: config.userId,
    apiKeyPrefix: cfg?.get?.('apiKeyPrefix') || undefined,
    apiKeyExpiresAt: cfg?.get?.('apiKeyExpiresAt') || undefined,
    credentialValid: true,
    toolCount: Array.isArray((probe.data as any)?.result?.tools) ? (probe.data as any).result.tools.length : undefined
  };

  if (options.json) {
    writeJsonSuccess(context, payload);
    return;
  }

  context.output.section('Active Kablewy Identity');
  context.output.table(Object.entries(payload).map(([Setting, Value]) => ({ Setting, Value: Value ?? 'unknown' })));
}

async function logout(context: CommandContext, options: JsonOption): Promise<void> {
  const cfg: any = context.config;
  const config = getCoreApiConfig(context);
  const keyId = String(cfg?.get?.('apiKeyId') || '');
  let revoked = false;
  let revokeError: string | undefined;

  if (config.baseUrl && config.orgId && config.apiKey && keyId) {
    try {
      await new KablewyApiClient(config).request('DELETE', selfServiceKeyPath(config, keyId));
      revoked = true;
    } catch (error) {
      revokeError = error instanceof Error ? error.message : String(error);
    }
  }

  for (const key of ['apiKey', 'apiKeyId', 'apiKeyPrefix', 'apiKeyExpiresAt']) {
    cfg?.set?.(key, '');
  }

  const payload = { localCredentialsCleared: true, revoked, ...(revokeError ? { revokeError } : {}) };
  if (options.json) {
    writeJsonSuccess(context, payload);
    return;
  }
  context.output.success('Local credentials cleared');
  if (revoked) {
    context.output.success('API key revoked');
  } else if (revokeError) {
    context.output.warning(`API key revoke was not completed: ${revokeError}`);
  }
}

async function listKeys(context: CommandContext, options: JsonOption): Promise<void> {
  const config = requireCoreApiConfig(context);
  const result = await createApiClient(context).request('GET', selfServiceKeysPath(config));
  const keys = (result.data as any)?.data || (result.data as any)?.apiKeys || result.data;
  if (options.json) {
    writeJsonSuccess(context, keys);
    return;
  }
  const rows = Array.isArray(keys) ? keys.map((key) => redactSecrets(key)) : [];
  context.output.section('API Keys');
  if (rows.length === 0) {
    context.output.info('No API keys found');
  } else {
    context.output.table(rows);
  }
}

async function revokeKey(context: CommandContext, keyId: string, options: JsonOption): Promise<void> {
  if (!keyId.trim()) {
    throw new CliError('API key ID is required', 'USAGE_ERROR', 2);
  }
  const config = requireCoreApiConfig(context);
  await createApiClient(context).request('DELETE', selfServiceKeyPath(config, keyId));
  const cfg: any = context.config;
  if (String(cfg?.get?.('apiKeyId') || '') === keyId) {
    for (const key of ['apiKey', 'apiKeyId', 'apiKeyPrefix', 'apiKeyExpiresAt']) {
      cfg?.set?.(key, '');
    }
  }
  const payload = { revoked: true, keyId };
  if (options.json) {
    writeJsonSuccess(context, payload);
  } else {
    context.output.success(`Revoked API key ${keyId}`);
  }
}

function selfServiceKeysPath(config: { orgId: string; userId: string }): string {
  return `/v1/org/${encodeURIComponent(config.orgId)}/users/${encodeURIComponent(config.userId)}/api-keys`;
}

function selfServiceKeyPath(config: { orgId: string; userId: string }, keyId: string): string {
  return `${selfServiceKeysPath(config)}/${encodeURIComponent(keyId)}`;
}
