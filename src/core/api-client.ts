import { randomUUID } from 'node:crypto';
import { CommandContext } from '../types/index.js';
import { redactSecrets } from '../utils/redact.js';
import { isScopedApiKey, normalizeApiKey, scopedApiKeyErrorMessage } from './credentials.js';
import { cliTelemetryHeaders } from './telemetry.js';

export type ApiErrorCode =
  | 'USAGE_ERROR'
  | 'AUTH_ERROR'
  | 'PERMISSION_ERROR'
  | 'NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'BACKEND_ERROR'
  | 'UNKNOWN_ERROR';

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: ApiErrorCode = 'UNKNOWN_ERROR',
    public readonly exitCode = 1,
    public readonly requestId?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CoreApiConfig {
  baseUrl: string;
  orgId: string;
  userId: string;
  apiKey: string;
}

export interface ApiResult<T = unknown> {
  data: T;
  requestId?: string;
  status: number;
}

export function getCoreApiConfig(context: CommandContext): CoreApiConfig {
  const cfg: any = context.config;
  return {
    baseUrl: String(cfg?.get ? cfg.get('apiUrl') : process.env.KABLEWY_API_URL || '').replace(/\/+$/, ''),
    orgId: String(cfg?.get ? cfg.get('orgId') : process.env.KABLEWY_ORG_ID || ''),
    userId: String(cfg?.get ? cfg.get('userId') : process.env.KABLEWY_USER_ID || ''),
    apiKey: normalizeApiKey(cfg?.get ? cfg.get('apiKey') : process.env.KABLEWY_API_KEY || ''),
  };
}

export function requireCoreApiConfig(context: CommandContext): CoreApiConfig {
  const config = getCoreApiConfig(context);
  const missing: string[] = [];
  if (!config.baseUrl) missing.push('apiUrl');
  if (!config.orgId) missing.push('orgId');
  if (!config.userId) missing.push('userId');
  if (!config.apiKey) missing.push('apiKey');
  if (missing.length > 0) {
    throw new CliError(`Missing configuration: ${missing.join(', ')}`, 'USAGE_ERROR', 2);
  }
  if (!isScopedApiKey(config.apiKey)) {
    throw new CliError(scopedApiKeyErrorMessage('Configured API key'), 'AUTH_ERROR', 65);
  }
  return config;
}

export function successEnvelope<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function errorEnvelope(error: unknown): { success: false; error: { code: string; message: string; requestId?: string } } {
  if (error instanceof CliError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.requestId ? { requestId: error.requestId } : {})
      }
    };
  }
  return {
    success: false,
    error: {
      code: 'UNKNOWN_ERROR',
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

export function writeJsonSuccess(context: CommandContext, data: unknown): void {
  context.output.json(successEnvelope(redactSecrets(data)));
}

export function writeJsonError(context: CommandContext, error: unknown): void {
  context.output.json(errorEnvelope(error));
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  return 1;
}

export class KablewyApiClient {
  constructor(private readonly config: CoreApiConfig, private readonly telemetryCommand?: string) {}

  async request<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string> } = {}
  ): Promise<ApiResult<T>> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const requestId = options.headers?.['x-request-id'] || options.headers?.['X-Request-Id'] || `kablewy-cli-${randomUUID()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...cliTelemetryHeaders(this.telemetryCommand),
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'x-request-id': requestId,
          ...(options.headers || {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error), 'NETWORK_ERROR', 70);
    }

    const responseRequestId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || requestId;
    const data = await parseResponseBody(res);
    if (!res.ok) {
      throw httpError(res.status, data, responseRequestId);
    }
    return { data: data as T, requestId: responseRequestId, status: res.status };
  }
}

export function createApiClient(context: CommandContext): KablewyApiClient {
  return new KablewyApiClient(requireCoreApiConfig(context), context.telemetry?.command);
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function httpError(status: number, body: unknown, requestId?: string): CliError {
  const message = extractMessage(body) || `Request failed with HTTP ${status}`;
  if (status === 401) return new CliError(message, 'AUTH_ERROR', 65, requestId, body);
  if (status === 403) return new CliError(message, 'PERMISSION_ERROR', 77, requestId, body);
  if (status === 404) return new CliError(message, 'NOT_FOUND', 66, requestId, body);
  if (status >= 500) return new CliError(message, 'BACKEND_ERROR', 70, requestId, body);
  return new CliError(message, 'USAGE_ERROR', 2, requestId, body);
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as any;
  return obj.error?.message || obj.error || obj.message || obj.details || obj.detail;
}
