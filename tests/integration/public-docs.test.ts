import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('public package and README contract', () => {
  const root = process.cwd();
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('uses the public package identity', () => {
    expect(packageJson.name).toBe('@kablewy/cli');
    expect(packageJson.version).toMatch(/^0\.1\.\d+$/);
    expect(packageJson.bin).toEqual({ kablewy: 'dist/cli.js' });
    expect(readme).toContain('npm install -g @kablewy/cli');
  });

  it('documents the public command surface', () => {
    [
      'kablewy login',
      'kablewy logout',
      'kablewy whoami',
      'kablewy auth keys list',
      'kablewy auth keys revoke <keyId>',
      'kablewy docs upload',
      'kablewy docs list',
      'kablewy docs search',
      'kablewy docs get <documentId>',
      'kablewy docs delete <documentId> --yes',
      'kablewy docs status <documentId>',
      'kablewy chat',
      'kablewy agent',
      'kablewy tools list',
      'kablewy mcp list',
      'kablewy quick-actions list',
      'kablewy quick-actions run',
      'kablewy quick-actions status <taskId>',
      'kablewy webhooks list',
      'kablewy webhooks create',
      'kablewy webhooks trigger <jobId>',
      'kablewy skills list',
      'kablewy skill'
    ].forEach((command) => {
      expect(readme).toContain(command);
    });
  });

  it('does not document out-of-scope public command groups', () => {
    expect(readme).not.toMatch(/\bkablewy plugin\b/);
    expect(readme).not.toMatch(/\bkablewy graph\b/);
    expect(readme).not.toMatch(/\bkablewy search\b/);
    expect(readme).not.toMatch(/\bkablewy interactive\b/);
  });

  it('uses Automation Job as the public webhook job event name', () => {
    expect(readme).toContain('--event automation_job.completed');
    expect(readme).not.toContain('--event workflow_job.completed');
    expect(readme).toContain('webhook-enabled Automation Job');
  });

  it('documents the privacy-safe telemetry boundary', () => {
    expect(readme).toContain('Privacy-safe reliability telemetry');
    expect(readme).toContain('KABLEWY_DISABLE_TELEMETRY=1');
    expect(readme).toContain('does **not** send prompts');
    expect(readme).toContain('file paths');
    expect(readme).toContain('shell commands');
    expect(readme).toContain('External MCP servers');
  });

  it('documents the actual chat default model', () => {
    const chatSource = readFileSync(join(root, 'src', 'commands', 'chat.ts'), 'utf8');
    const defaultModel = chatSource.match(/\.option\('--model <name>', '[^']*', '([^']+)'\)/)?.[1];
    expect(defaultModel).toBeTruthy();
    expect(readme).toContain(`--model ${defaultModel}`);
    // gpt-5.1 is hidden, non-default, and deprecation-remapped on the platform;
    // documenting it would steer customers to a key-required fallback model.
    expect(readme).not.toContain('gpt-5.1');
  });
});
