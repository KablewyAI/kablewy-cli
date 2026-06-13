import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../../src/core/config.js';

describe('ConfigManager', () => {
  let config: ConfigManager;

  beforeEach(() => {
    config = new ConfigManager();
  });

  afterEach(() => {
    // Clean up any test configuration
    config.reset();
  });

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const allConfig = config.getAll();
      
      expect(allConfig.apiUrl).toBe('https://kablewy.ai');
      expect(allConfig.orgId).toBe('');
      expect(allConfig.userId).toBe('');
      expect(allConfig.concurrency).toBe(3);
      expect(allConfig.parseMode).toBe('balanced');
      expect(allConfig.interactive).toBe(true);
    });

    it('should have default MCP server configuration', () => {
      const mcpServers = config.listMCPServers();

      // The default httpUrl is now stored as a template with ${...} placeholders
      // that getResolvedMCPServers() expands against the live apiUrl/orgId/userId.
      expect(mcpServers).toHaveProperty('kablewy');
      expect(mcpServers.kablewy.httpUrl).toBe(
        '${apiUrl}/v1/mcp-jsonrpc/${orgId}/users/${userId}/mcp/http'
      );
      expect(mcpServers.kablewy.trust).toBe(true);
    });

    it('should resolve the default MCP httpUrl against current config values', () => {
      config.set('orgId', 'org-test');
      config.set('userId', 'user-test');

      const resolved = config.getResolvedMCPServers();

      expect(resolved.kablewy.httpUrl).toBe(
        'https://kablewy.ai/v1/mcp-jsonrpc/org-test/users/user-test/mcp/http'
      );
    });
  });

  describe('get and set operations', () => {
    it('should get configuration values', () => {
      expect(config.get('apiUrl')).toBe('https://kablewy.ai');
      expect(config.get('concurrency')).toBe(3);
    });

    it('should set configuration values', () => {
      config.set('apiUrl', 'https://api.kablewy.com');
      config.set('concurrency', 5);
      
      expect(config.get('apiUrl')).toBe('https://api.kablewy.com');
      expect(config.get('concurrency')).toBe(5);
    });

    it('should set runtime-only values without persisting them', () => {
      config.setRuntime('apiKey', 'api_runtime_only_key');
      expect(config.get('apiKey')).toBe('api_runtime_only_key');

      const fresh = new ConfigManager();
      expect(fresh.get('apiKey')).not.toBe('api_runtime_only_key');
      fresh.reset();
    });

    it('should update multiple values at once', () => {
      const updates = {
        apiUrl: 'https://api.kablewy.com',
        concurrency: 8,
        parseMode: 'premium' as const
      };
      
      config.update(updates);
      
      expect(config.get('apiUrl')).toBe('https://api.kablewy.com');
      expect(config.get('concurrency')).toBe(8);
      expect(config.get('parseMode')).toBe('premium');
    });
  });

  describe('MCP server management', () => {
    it('should add MCP server', () => {
      const serverConfig = {
        httpUrl: 'http://localhost:8080/mcp',
        headers: { 'Authorization': 'Bearer token' },
        timeout: 5000,
        trust: false,
        description: 'Test server'
      };
      
      config.setMCPServer('test-server', serverConfig);
      
      const server = config.getMCPServer('test-server');
      expect(server).toEqual(serverConfig);
    });

    it('should remove MCP server', () => {
      config.setMCPServer('test-server', { httpUrl: 'http://localhost:8080' });
      expect(config.getMCPServer('test-server')).toBeDefined();
      
      config.removeMCPServer('test-server');
      expect(config.getMCPServer('test-server')).toBeUndefined();
    });

    it('should list MCP servers', () => {
      const servers = config.listMCPServers();
      expect(servers).toHaveProperty('kablewy');
      expect(Object.keys(servers)).toContain('kablewy');
    });
  });

  describe('plugin management', () => {
    it('should add plugin', () => {
      config.addPlugin('test-plugin');
      
      const plugins = config.listPlugins();
      expect(plugins).toContain('test-plugin');
    });

    it('should remove plugin', () => {
      config.addPlugin('test-plugin');
      expect(config.listPlugins()).toContain('test-plugin');
      
      config.removePlugin('test-plugin');
      expect(config.listPlugins()).not.toContain('test-plugin');
    });

    it('should not add duplicate plugins', () => {
      config.addPlugin('test-plugin');
      config.addPlugin('test-plugin');
      
      const plugins = config.listPlugins();
      expect(plugins.filter(p => p === 'test-plugin')).toHaveLength(1);
    });
  });

  describe('environment variable loading', () => {
    it('should support an explicit config directory for isolated CLI runs', () => {
      const originalConfigDir = process.env.KABLEWY_CONFIG_DIR;
      const isolatedDir = mkdtempSync(join(tmpdir(), 'kablewy-cli-config-'));

      try {
        process.env.KABLEWY_CONFIG_DIR = isolatedDir;
        const isolated = new ConfigManager();
        expect(isolated.configPath).toContain(isolatedDir);
        isolated.reset();
      } finally {
        if (originalConfigDir === undefined) {
          delete process.env.KABLEWY_CONFIG_DIR;
        } else {
          process.env.KABLEWY_CONFIG_DIR = originalConfigDir;
        }
      }
    });

    it('should load from environment variables', () => {
      const originalEnv = process.env;

      try {
        process.env = {
          ...originalEnv,
          KABLEWY_API_URL: 'https://env-api.kablewy.com',
          KABLEWY_DOC_WORKER_URL: 'https://doc-worker.example.com',
          KABLEWY_DOC_PROCESSOR_TOKEN: 'processor-token',
          KABLEWY_CONCURRENCY: '10',
          KABLEWY_PARSE_MODE: 'premium'
        };

        config.loadFromEnv();

        expect(config.get('apiUrl')).toBe('https://env-api.kablewy.com');
        expect(config.get('docWorkerUrl')).toBe('https://doc-worker.example.com');
        expect(config.get('docProcessorToken')).toBe('processor-token');
        expect(config.get('concurrency')).toBe(10);
        expect(config.get('parseMode')).toBe('premium');

        const fresh = new ConfigManager();
        expect(fresh.get('apiUrl')).toBe('https://kablewy.ai');
        expect(fresh.get('docProcessorToken')).toBe('');
        fresh.reset();
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('validation', () => {
    it('should validate correct configuration', () => {
      // orgId/userId/apiKey default to '' (public package ships no identity),
      // so a valid config must carry the values login normally persists.
      config.set('orgId', 'org-test');
      config.set('userId', 'user-test');
      config.set('apiKey', 'api_test_key');

      const validation = config.validate();
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should require an apiKey by default', () => {
      const validation = config.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('API Key is required');
    });

    it('should reject an empty apiUrl at the schema layer but report empty identity via validate()', () => {
      // apiUrl keeps its uri format constraint, so an empty value fails at
      // set() time. orgId/userId must be allowed to be empty at the schema
      // layer (the shipped defaults are empty until login persists real IDs);
      // requiredness for them is reported by validate() instead.
      expect(() => config.set('apiUrl', '')).toThrow();

      config.set('orgId', '');
      config.set('userId', '');
      const validation = config.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Organization ID is required');
      expect(validation.errors).toContain('User ID is required');
    });

    it('should detect a missing apiKey via validate()', () => {
      config.set('apiKey', '');

      const validation = config.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('API Key is required');
    });

    it('should reject non-scoped apiKey values at set() time', () => {
      expect(() => config.set('apiKey', 'eyJhbGciOi.fake.jwt')).toThrow(/starting with "api_"/);
    });

    it('should report non-scoped runtime apiKey values via validate()', () => {
      config.set('orgId', 'org-test');
      config.set('userId', 'user-test');
      config.setRuntime('apiKey', 'eyJhbGciOi.fake.jwt');

      const validation = config.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('API Key must be a scoped Kablewy API key starting with "api_". Run `kablewy login` to mint one; browser or desktop session tokens are only used during login.');
    });

    // Numeric ranges are now enforced fail-fast by the conf schema at set()
    // time (minimum/maximum), so out-of-range values throw before they can be
    // persisted — they never reach validate(). validate()'s redundant range
    // checks remain as a defense-in-depth backstop for values that bypass set().
    it('should reject out-of-range concurrency at the schema layer', () => {
      expect(() => config.set('concurrency', 0)).toThrow();
      expect(() => config.set('concurrency', 25)).toThrow();
    });

    it('should reject out-of-range retry attempts at the schema layer', () => {
      expect(() => config.set('retryAttempts', 0)).toThrow();
      expect(() => config.set('retryAttempts', 15)).toThrow();
    });

    it('should reject out-of-range retry delay at the schema layer', () => {
      expect(() => config.set('retryDelay', 50)).toThrow();
      expect(() => config.set('retryDelay', 15000)).toThrow();
    });
  });

  describe('reset functionality', () => {
    it('should reset to default values', () => {
      config.set('apiUrl', 'https://custom.api.com');
      config.set('concurrency', 10);
      config.addPlugin('test-plugin');
      
      config.reset();

      expect(config.get('apiUrl')).toBe('https://kablewy.ai');
      expect(config.get('concurrency')).toBe(3);
      expect(config.listPlugins()).toHaveLength(0);
    });
  });
});
