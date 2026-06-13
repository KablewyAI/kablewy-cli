import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

/**
 * True end-to-end tests: spawn the built CLI binary and assert on its real
 * stdout/stderr/exit code. (The previous version used Mocha-style `done`
 * callbacks, which vitest does not await — every assertion ran after the test
 * had already passed.)
 *
 * Isolation: each run gets a throwaway KABLEWY_CONFIG_DIR so tests never read
 * or write the developer's real CLI config, and networked commands point at
 * an unreachable local port so they fail fast and deterministically.
 */

const cliPath = join(process.cwd(), 'dist', 'cli.js');
const cliBuilt = existsSync(cliPath);
const UNREACHABLE_API = 'http://127.0.0.1:9';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let configDir: string;

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [cliPath, ...args], {
      stdio: 'pipe',
      env: {
        ...process.env,
        KABLEWY_CONFIG_DIR: configDir,
        ...extraEnv
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe.skipIf(!cliBuilt)('CLI End-to-End Workflow Tests', () => {
  let testFiles: string[] = [];

  beforeAll(() => {
    if (!cliBuilt) {
      console.warn('CLI not built, skipping E2E tests');
    }
  });

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'kablewy-e2e-'));
    const testDoc = 'This is a test document for Kablewy CLI testing.';
    writeFileSync('test-document.txt', testDoc);
    testFiles.push('test-document.txt');
  });

  afterEach(() => {
    testFiles.forEach(file => {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    });
    testFiles = [];
    rmSync(configDir, { recursive: true, force: true });
  });

  describe('CLI Execution', () => {
    it('should execute CLI without errors', async () => {
      const { code, stdout, stderr } = await runCli(['--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('kablewy');
      expect(stdout).toContain('Public CLI');
      expect(stderr).toBe('');
    });

    it('should report exactly the package.json version (single source of truth)', async () => {
      const pkg = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf8')
      ) as { version: string };
      const { code, stdout } = await runCli(['--version']);

      expect(code).toBe(0);
      expect(stdout.trim()).toBe(pkg.version);
    });

    it('should list public commands in default help', async () => {
      const { code, stdout } = await runCli(['--help']);

      expect(code).toBe(0);
      for (const cmd of [
        'docs', 'upload', 'chat', 'config', 'status', 'tools', 'mcp',
        'quick-actions', 'webhooks', 'skills', 'skill', 'auth', 'logout',
        'whoami', 'login'
      ]) {
        expect(stdout).toContain(cmd);
      }
      expect(stdout).not.toContain('help-extended');
      expect(stdout).not.toContain('list-commands');
    });
  });

  describe('Configuration Workflow', () => {
    it('should show configuration', async () => {
      const { code, stdout } = await runCli(['config', '--show']);

      expect(code).toBe(0);
      expect(stdout).toContain('API URL');
    });

    it('should report missing identity via config --validate', async () => {
      // Fresh isolated config has no org/user/key, so validation must fail
      // with actionable errors (exit 2 = usage/validation in the exit table).
      const { code, stdout, stderr } = await runCli(['config', '--validate']);
      const combined = stdout + stderr;

      expect(code).toBe(2);
      expect(combined).toContain('Organization ID is required');
      expect(combined).toContain('API Key is required');
    });
  });

  describe('Status Workflow', () => {
    it('should exit nonzero and name every failing check when unconfigured', async () => {
      const { code, stdout } = await runCli(['status'], { KABLEWY_API_URL: UNREACHABLE_API });

      expect(code).toBe(1);
      expect(stdout).toContain('Kablewy CLI Status');
      expect(stdout).toContain('Configuration');
      expect(stdout).toContain('unreachable');
      expect(stdout).toContain('kablewy login');
    });

    it('should report unhealthy overall in JSON with the same exit code', async () => {
      const { code, stdout } = await runCli(['status', '--json'], { KABLEWY_API_URL: UNREACHABLE_API });

      expect(code).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.success).toBe(true);
      expect(envelope.data.overall).toBe('unhealthy');
      expect(envelope.data.checks.backend.status).toBe('unhealthy');
    });
  });

  describe('Tools Workflow', () => {
    it('should fail before tool discovery when unauthenticated', async () => {
      const { code, stdout } = await runCli(['tools', 'list'], { KABLEWY_API_URL: UNREACHABLE_API });

      expect(code).toBe(2);
      expect(stdout).toContain('Missing configuration: apiKey');
    });

    it('should fail tools test against an unreachable backend', async () => {
      const { code, stdout } = await runCli(['tools', 'test'], {
        KABLEWY_API_URL: UNREACHABLE_API,
        KABLEWY_API_KEY: 'api_test_key'
      });

      expect(code).toBe(70);
      expect(stdout).toContain('Testing MCP Tool Connectivity');
      expect(stdout).toContain('unreachable');
      expect(stdout).toContain('Successful: 0/1 servers');
    });
  });

  describe('Document Workflow', () => {
    it('should expose document list help', async () => {
      const { code, stdout } = await runCli(['docs', 'list', '--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('List documents');
      expect(stdout).toContain('--json');
    });

    it('should handle upload dry run', async () => {
      const { code, stdout } = await runCli(['docs', 'upload', 'test-document.txt', '--dry-run']);

      expect(code).toBe(0);
      expect(stdout).toContain('Dry Run');
      expect(stdout).toContain('test-document.txt');
    });
  });

  describe('Document Search Workflow', () => {
    it('should expose docs search help', async () => {
      const { code, stdout } = await runCli(['docs', 'search', '--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('Search documents');
      expect(stdout).toContain('--json');
    });
  });

  describe('Document Status Workflow', () => {
    it('should expose docs status help', async () => {
      const { code, stdout } = await runCli(['docs', 'status', '--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('processing status');
      expect(stdout).toContain('--json');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid commands gracefully', async () => {
      const { code, stderr } = await runCli(['invalid-command']);

      expect(code).not.toBe(0);
      expect(stderr).toContain('unknown command');
    });

    it('should handle invalid options gracefully', async () => {
      const { code, stderr } = await runCli(['upload', '--invalid-option']);

      expect(code).not.toBe(0);
      expect(stderr).toContain('unknown option');
    });
  });

  describe('Help System', () => {
    it('should show default help', async () => {
      const { code, stdout } = await runCli(['--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('Kablewy CLI');
      expect(stdout).toContain('Commands:');
    });

    it('should show command-specific help', async () => {
      const { code, stdout } = await runCli(['upload', '--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('Upload documents');
      expect(stdout).toContain('Options:');
    });
  });
});
