import Conf from 'conf';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KablewyConfig, MCPServerConfig } from '../types/index.js';
import { isScopedApiKey, normalizeApiKey, scopedApiKeyErrorMessage } from './credentials.js';

const defaultConfig: KablewyConfig = {
  // Public production API. `kablewy login` overwrites org/user/key; internal
  // dev against a local backend sets apiUrl via config/env explicitly.
  apiUrl: 'https://kablewy.ai',
  orgId: '',
  userId: '',
  apiKey: '',
  apiKeyId: '',
  apiKeyPrefix: '',
  apiKeyExpiresAt: '',
  docWorkerUrl: '',
  docProcessorToken: '',
  concurrency: 3,
  retryAttempts: 3,
  retryDelay: 1000,
  parseMode: 'balanced',
  interactive: true,
  theme: 'auto',
  mcpServers: {
    kablewy: {
      url: '${apiUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/sse',
      httpUrl: '${apiUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/http',
      headers: {
        'Authorization': 'Bearer ${apiKey}',
        'Content-Type': 'application/json'
      },
      timeout: 30000,
      trust: true,
      description: 'Kablewy backend MCP server with knowledge work tools'
    }
  },
  plugins: []
};

export class ConfigManager {
  private conf: Conf<KablewyConfig>;
  private config: KablewyConfig;

  constructor() {
    const vitestWorkerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? '0';
    const configuredConfigCwd = process.env.KABLEWY_CONFIG_DIR
      ? resolve(process.env.KABLEWY_CONFIG_DIR)
      : undefined;
    const configCwd = configuredConfigCwd ?? (process.env.VITEST
      ? join(tmpdir(), 'kablewy-cli-tests', vitestWorkerId)
      : undefined);

    if (configCwd) {
      mkdirSync(configCwd, { recursive: true });
    }

    this.conf = new Conf<KablewyConfig>({
      // Isolate the test store from a developer's real CLI config so running the
      // suite never reads or clobbers the public CLI config file.
      // Scope per vitest worker so parallel test files never race on one shared
      // config file (config.test.ts's reset() would otherwise clobber concurrent
      // readers). vitest sets VITEST + a per-worker id during runs.
      projectName: process.env.VITEST
        ? `kablewy-cli-test-${vitestWorkerId}`
        : 'kablewy-cli',
      cwd: configCwd,
      defaults: defaultConfig,
      schema: {
        apiUrl: {
          type: 'string',
          format: 'uri'
        },
        orgId: {
          type: 'string'
        },
        userId: {
          type: 'string'
        },
        apiKey: {
          type: 'string'
        },
        apiKeyId: {
          type: 'string'
        },
        apiKeyPrefix: {
          type: 'string'
        },
        apiKeyExpiresAt: {
          type: 'string'
        },
        docWorkerUrl: {
          type: 'string'
        },
        docProcessorToken: {
          type: 'string'
        },
        concurrency: {
          type: 'number',
          minimum: 1,
          maximum: 20
        },
        retryAttempts: {
          type: 'number',
          minimum: 1,
          maximum: 10
        },
        retryDelay: {
          type: 'number',
          minimum: 100,
          maximum: 10000
        },
        parseMode: {
          type: 'string',
          enum: ['fast', 'balanced', 'premium', 'auto']
        },
        interactive: {
          type: 'boolean'
        },
        theme: {
          type: 'string',
          enum: ['light', 'dark', 'auto']
        },
        mcpServers: {
          type: 'object'
        },
        plugins: {
          type: 'array',
          items: {
            type: 'string'
          }
        }
      }
    });
    
    this.config = this.conf.store;
  }

  // Absolute path to the on-disk config file (conf keeps it private).
  // Used by `login` to chmod the credential-bearing file to 0o600.
  get configPath(): string {
    return this.conf.path;
  }

  get<K extends keyof KablewyConfig>(key: K): KablewyConfig[K] {
    return this.config[key];
  }

  set<K extends keyof KablewyConfig>(key: K, value: KablewyConfig[K]): void {
    if (key === 'apiKey') {
      const normalized = normalizeApiKey(value);
      if (normalized && !isScopedApiKey(normalized)) {
        throw new Error(scopedApiKeyErrorMessage('API key'));
      }
      value = normalized as KablewyConfig[K];
    }
    this.config[key] = value;
    this.conf.set(key, value);
  }

  setRuntime<K extends keyof KablewyConfig>(key: K, value: KablewyConfig[K]): void {
    if (key === 'apiKey') {
      value = normalizeApiKey(value) as KablewyConfig[K];
    }
    this.config[key] = value;
  }

  getAll(): KablewyConfig {
    return { ...this.config };
  }

  update(updates: Partial<KablewyConfig>): void {
    if (typeof updates.apiKey === 'string') {
      const normalized = normalizeApiKey(updates.apiKey);
      if (normalized && !isScopedApiKey(normalized)) {
        throw new Error(scopedApiKeyErrorMessage('API key'));
      }
      updates = { ...updates, apiKey: normalized };
    }
    Object.assign(this.config, updates);
    this.conf.store = this.config;
  }

  reset(): void {
    this.conf.clear();
    this.config = { ...defaultConfig };
  }

  getMCPServer(name: string): MCPServerConfig | undefined {
    return this.config.mcpServers[name];
  }

  setMCPServer(name: string, config: MCPServerConfig): void {
    this.config.mcpServers[name] = config;
    this.conf.set('mcpServers', this.config.mcpServers);
  }

  removeMCPServer(name: string): void {
    delete this.config.mcpServers[name];
    this.conf.set('mcpServers', this.config.mcpServers);
  }

  listMCPServers(): Record<string, MCPServerConfig> {
    return { ...this.config.mcpServers };
  }

  // Resolve placeholders in MCP server configs using current config values
  getResolvedMCPServers(): Record<string, MCPServerConfig> {
    const resolved: Record<string, MCPServerConfig> = {};

    const apiUrl = (this.config.apiUrl || '').replace(/\/+$/, '');
    const orgId = this.config.orgId;
    const userId = this.config.userId;
    const apiKey = this.config.apiKey;

    const replacePlaceholders = (value: string | undefined): string | undefined => {
      if (typeof value !== 'string') return value;
      return value
        .replace(/\$\{apiUrl\}/g, apiUrl)
        .replace(/\$\{orgId\}/g, orgId)
        .replace(/\$\{userId\}/g, userId)
        .replace(/\$\{apiKey\}/g, apiKey);
    };

    for (const [name, server] of Object.entries(this.config.mcpServers)) {
      const cloned: MCPServerConfig = { ...server };

      // Resolve httpUrl/url or build defaults if missing
      const rawUrl = cloned.httpUrl || '${apiUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/http';
      cloned.httpUrl = replacePlaceholders(rawUrl);
      if (cloned.url) {
        cloned.url = replacePlaceholders(cloned.url);
      } else {
        cloned.url = replacePlaceholders('${apiUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/sse');
      }

      // Resolve headers
      if (cloned.headers) {
        const newHeaders: Record<string, string> = {};
        for (const [hKey, hVal] of Object.entries(cloned.headers)) {
          newHeaders[hKey] = replacePlaceholders(hVal) || '';
        }
        cloned.headers = newHeaders;
      }

      resolved[name] = cloned;
    }

    return resolved;
  }

  addPlugin(pluginName: string): void {
    if (!this.config.plugins.includes(pluginName)) {
      this.config.plugins.push(pluginName);
      this.conf.set('plugins', this.config.plugins);
    }
  }

  removePlugin(pluginName: string): void {
    this.config.plugins = this.config.plugins.filter(p => p !== pluginName);
    this.conf.set('plugins', this.config.plugins);
  }

  listPlugins(): string[] {
    return [...this.config.plugins];
  }

  // Environment variable overrides
  loadFromEnv(): void {
    const setRuntime = <K extends keyof KablewyConfig>(key: K, value: KablewyConfig[K]) => {
      this.setRuntime(key, value);
    };
    
    if (process.env.KABLEWY_API_URL) {
      setRuntime('apiUrl', process.env.KABLEWY_API_URL);
    }
    if (process.env.KABLEWY_ORG_ID) {
      setRuntime('orgId', process.env.KABLEWY_ORG_ID);
    }
    if (process.env.KABLEWY_USER_ID) {
      setRuntime('userId', process.env.KABLEWY_USER_ID);
    }
    if (process.env.KABLEWY_API_KEY) {
      setRuntime('apiKey', process.env.KABLEWY_API_KEY);
    }
    if (process.env.KABLEWY_DOC_WORKER_URL) {
      setRuntime('docWorkerUrl', process.env.KABLEWY_DOC_WORKER_URL);
    }
    if (process.env.KABLEWY_DOC_PROCESSOR_TOKEN) {
      setRuntime('docProcessorToken', process.env.KABLEWY_DOC_PROCESSOR_TOKEN);
    }
    if (process.env.KABLEWY_CONCURRENCY) {
      setRuntime('concurrency', parseInt(process.env.KABLEWY_CONCURRENCY, 10));
    }
    if (process.env.KABLEWY_RETRY_ATTEMPTS) {
      setRuntime('retryAttempts', parseInt(process.env.KABLEWY_RETRY_ATTEMPTS, 10));
    }
    if (process.env.KABLEWY_RETRY_DELAY) {
      setRuntime('retryDelay', parseInt(process.env.KABLEWY_RETRY_DELAY, 10));
    }
    if (process.env.KABLEWY_PARSE_MODE) {
      setRuntime('parseMode', process.env.KABLEWY_PARSE_MODE as 'fast' | 'balanced' | 'premium' | 'auto');
    }
    if (process.env.KABLEWY_INTERACTIVE) {
      setRuntime('interactive', process.env.KABLEWY_INTERACTIVE === 'true');
    }
    if (process.env.KABLEWY_THEME) {
      setRuntime('theme', process.env.KABLEWY_THEME as 'light' | 'dark' | 'auto');
    }
  }

  // Validate configuration
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.apiUrl) {
      errors.push('API URL is required');
    }
    if (!this.config.orgId) {
      errors.push('Organization ID is required');
    }
    if (!this.config.userId) {
      errors.push('User ID is required');
    }
    if (!this.config.apiKey) {
      errors.push('API Key is required');
    } else if (!isScopedApiKey(this.config.apiKey)) {
      errors.push(scopedApiKeyErrorMessage('API Key'));
    }
    if (this.config.concurrency < 1 || this.config.concurrency > 20) {
      errors.push('Concurrency must be between 1 and 20');
    }
    if (this.config.retryAttempts < 1 || this.config.retryAttempts > 10) {
      errors.push('Retry attempts must be between 1 and 10');
    }
    if (this.config.retryDelay < 100 || this.config.retryDelay > 10000) {
      errors.push('Retry delay must be between 100 and 10000 milliseconds');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
