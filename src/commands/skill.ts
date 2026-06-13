import { Command } from 'commander';
import { CommandContext, SkillOptions, SkillManifest, SkillDetails } from '../types/index.js';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { basename } from 'path';
import FormData from 'form-data';
import { request } from 'undici';
import { writeJsonSuccess } from '../core/api-client.js';

export function createSkillCommand(context: CommandContext, commandName = 'skill'): Command {
  const command = new Command(commandName);

  command
    .description('Manage and execute skills')
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show detailed information')
    .action(async (options: SkillOptions) => {
      await handleSkill(resolveSkillOptions(options), context, commandName);
    });

  // Subcommand: list
  command
    .command('list')
    .description('List available skills')
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show detailed information')
    .action(async (options: SkillOptions, subcommand: Command) => {
      await handleSkillList(resolveSkillOptions(options, subcommand), context);
    });

  // Subcommand: show
  command
    .command('show')
    .description('Show skill details')
    .argument('<skillId>', 'Skill ID')
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show detailed information')
    .action(async (skillId: string, options: SkillOptions, subcommand: Command) => {
      await handleSkillShow(skillId, resolveSkillOptions(options, subcommand), context);
    });

  // Subcommand: create
  command
    .command('create')
    .description('Create a new skill')
    .argument('<skillId>', 'Skill ID (hyphen-case, e.g., my-skill)')
    .option('--name <name>', 'Skill display name')
    .option('--description <description>', 'Skill description')
    .option('--allowed-tools <tools>', 'Comma-separated list of allowed tools')
    .option('--github-url <url>', 'GitHub repository URL')
    .option('--github-branch <branch>', 'GitHub branch name')
    .option('--json', 'Output in JSON format')
    .action(async (skillId: string, options: SkillOptions, subcommand: Command) => {
      await handleSkillCreate(skillId, resolveSkillOptions(options, subcommand), context);
    });

  // Subcommand: upload
  command
    .command('upload')
    .description('Upload a skill bundle (ZIP file)')
    .argument('<skillId>', 'Skill ID')
    .argument('<zipPath>', 'Path to ZIP file')
    .option('--version <version>', 'Version string (e.g., 1.0.0)')
    .option('--json', 'Output in JSON format')
    .action(async (skillId: string, zipPath: string, options: SkillOptions, subcommand: Command) => {
      await handleSkillUpload(skillId, zipPath, resolveSkillOptions(options, subcommand), context);
    });

  // Subcommand: execute
  command
    .command('execute')
    .description('Execute a skill')
    .argument('<skillId>', 'Skill ID')
    .option('--runtime <runtime>', 'Runtime (python, bun, go). Auto-detected from entry file extension if not provided.')
    .option('--entry <entry>', 'Entry point file (e.g., main.py). Uses skill default if not specified.')
    .option('--args <args>', 'Arguments as JSON array (e.g., \'["arg1", "arg2"]\')')
    .option('--env <json>', 'Environment variables as JSON object')
    .option('--version <version>', 'Skill version to execute')
    .option('--timeout-ms <ms>', 'Timeout in milliseconds', '120000')
    .option('--json', 'Output in JSON format')
    .action(async (skillId: string, options: SkillOptions, subcommand: Command) => {
      await handleSkillExecute(skillId, resolveSkillOptions(options, subcommand), context);
    });

  // Subcommand: versions
  command
    .command('versions')
    .description('List skill versions')
    .argument('<skillId>', 'Skill ID')
    .option('--json', 'Output in JSON format')
    .action(async (skillId: string, options: SkillOptions, subcommand: Command) => {
      await handleSkillVersions(skillId, resolveSkillOptions(options, subcommand), context);
    });

  // Subcommand: delete
  command
    .command('delete')
    .description('Delete a skill')
    .argument('<skillId>', 'Skill ID')
    .option('--force', 'Skip confirmation prompt')
    .option('--json', 'Output in JSON format')
    .action(async (skillId: string, options: SkillOptions, subcommand: Command) => {
      await handleSkillDelete(skillId, resolveSkillOptions(options, subcommand), context);
    });

  return command;
}

function resolveSkillOptions(options: SkillOptions = {}, subcommand?: Command): SkillOptions {
  const parentOptions = subcommand?.parent?.opts?.() || {};
  const childOptions = subcommand?.opts?.() || {};
  return { ...parentOptions, ...childOptions, ...options };
}

// Helper function to get API configuration
function getSkillApiConfig(context: CommandContext): { baseUrl: string; orgId: string; userId: string; apiKey: string } {
  const cfg: any = context.config;
  return {
    baseUrl: (cfg?.get ? cfg.get('apiUrl') : process.env.KABLEWY_API_URL || '').replace(/\/+$/, ''),
    orgId: cfg?.get ? cfg.get('orgId') : process.env.KABLEWY_ORG_ID || '',
    userId: cfg?.get ? cfg.get('userId') : process.env.KABLEWY_USER_ID || '',
    apiKey: cfg?.get ? cfg.get('apiKey') : process.env.KABLEWY_API_KEY || '',
  };
}

// Helper function to check for missing config
function validateConfig(config: ReturnType<typeof getSkillApiConfig>, output: CommandContext['output']): boolean {
  const missing: string[] = [];
  if (!config.baseUrl) missing.push('apiUrl');
  if (!config.orgId) missing.push('orgId');
  if (!config.userId) missing.push('userId');
  if (!config.apiKey) missing.push('apiKey');

  if (missing.length > 0) {
    output.error(`Missing configuration: ${missing.join(', ')}`);
    output.info('Set via environment variables or:');
    output.list([
      'kablewy config --set apiUrl https://kablewy.ai',
      'kablewy config --set orgId <your-org-id>',
      'kablewy config --set userId <your-user-id>',
      'kablewy config --set apiKey <your-api-key>'
    ]);
    process.exitCode = 2; // usage error
    return false;
  }
  return true;
}

// Documented exit-code table: 65 auth, 77 permission, 66 not found,
// 70 network/backend, 2 usage, 1 anything else.
function exitCodeForStatus(status: number): number {
  if (status === 401) return 65;
  if (status === 403) return 77;
  if (status === 404) return 66;
  if (status >= 500) return 70;
  return 1;
}

/** Set the exit code for a CLI-side usage error and print the message. */
function failUsage(output: CommandContext['output'], message: string): void {
  output.error(message);
  process.exitCode = 2;
}

/** Set the exit code for a request that threw (network/backend failure). */
function failRequest(output: CommandContext['output'], message: string): void {
  output.error(message);
  process.exitCode = 70;
}

// Helper function to handle API errors
function handleApiError(status: number, body: any, output: CommandContext['output']): void {
  const message = body?.error || body?.message || `Request failed with status ${status}`;

  switch (status) {
    case 401:
      output.error('Authentication failed. Check your API key.');
      break;
    case 403:
      output.error('Skills may not be enabled for your organization.');
      break;
    case 404:
      output.error('Skill not found.');
      break;
    default:
      if (status >= 500) {
        output.error(`Server error (${status}). Try again later.`);
      } else {
        output.error(message);
      }
  }
  process.exitCode = exitCodeForStatus(status);
}

// Main handler - shows help
async function handleSkill(_options: SkillOptions, context: CommandContext, commandName = 'skill'): Promise<void> {
  const { output } = context;

  output.section('Skill Management');
  output.info('Use subcommands to manage skills:');
  output.list([
    `kablewy ${commandName} list - List available skills`,
    `kablewy ${commandName} show <skillId> - Show skill details`,
    `kablewy ${commandName} create <skillId> - Create a new skill`,
    `kablewy ${commandName} upload <skillId> <zipPath> - Upload a skill bundle`,
    `kablewy ${commandName} execute <skillId> - Execute a skill`,
    `kablewy ${commandName} versions <skillId> - List skill versions`,
    `kablewy ${commandName} delete <skillId> - Delete a skill`
  ]);
}

// List skills
async function handleSkillList(options: SkillOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}`;

    if (options.verbose) {
      output.info(`Fetching skills from: ${url}`);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      handleApiError(res.status, body, output);
      return;
    }

    const skills: SkillManifest[] = body.skills || body.data?.skills || [];

    if (options.json) {
      writeJsonSuccess(context, skills);
      return;
    }

    if (skills.length === 0) {
      output.info('No skills found');
      return;
    }

    output.section(`Available Skills (${skills.length})`);

    const tableData = skills.map((skill: SkillManifest) => ({
      ID: skill.id,
      Name: skill.name || skill.id,
      Version: skill.latestVersion || '-',
      Runtime: skill.latestRuntime || '-',
      Visibility: skill.visibility || 'private'
    }));

    output.table(tableData);

    if (options.verbose) {
      output.section('Detailed Information');
      skills.forEach((skill: SkillManifest) => {
        output.info(`\n${skill.id}`);
        output.info(`  Name: ${skill.name || skill.id}`);
        output.info(`  Description: ${skill.description || '(none)'}`);
        output.info(`  Latest Version: ${skill.latestVersion || 'none'}`);
        output.info(`  Runtime: ${skill.latestRuntime || 'none'}`);
        output.info(`  Created: ${skill.createdAt || 'unknown'}`);
      });
    }

  } catch (error: unknown) {
    failRequest(output, `Failed to list skills: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Show skill details
async function handleSkillShow(skillId: string, options: SkillOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}/${skillId}`;

    if (options.verbose) {
      output.info(`Fetching skill from: ${url}`);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      handleApiError(res.status, body, output);
      return;
    }

    const details: SkillDetails = body.data || body;

    if (options.json) {
      writeJsonSuccess(context, details);
      return;
    }

    const manifest = details.manifest || (details as any);

    output.section(`Skill: ${manifest.id}`);
    output.info(`Name: ${manifest.name || manifest.id}`);
    output.info(`Description: ${manifest.description || '(none)'}`);
    output.info(`Visibility: ${manifest.visibility || 'private'}`);
    output.info(`Latest Version: ${manifest.latestVersion || 'none'}`);
    output.info(`Runtime: ${manifest.latestRuntime || 'none'}`);
    output.info(`Created: ${manifest.createdAt || 'unknown'}`);
    output.info(`Updated: ${manifest.updatedAt || 'unknown'}`);

    if (details.body && options.verbose) {
      output.section('SKILL.md Content');
      output.code(details.body, 'markdown');
    }

  } catch (error: unknown) {
    failRequest(output, `Failed to get skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Create skill
async function handleSkillCreate(skillId: string, options: SkillOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}`;

    const skillName = options.name || skillId;
    const skillDescription = options.description || '';

    // Generate SKILL.md body with frontmatter - name in frontmatter must match skill_id
    const skillBody = `---
name: ${skillId}
description: ${skillDescription}
---

# ${skillName}

${skillDescription}
`;

    const payload: any = {
      skill_id: skillId,
      name: skillName,
      description: skillDescription,
      body: skillBody,
    };

    if (options.allowedTools) {
      payload.allowed_tools = options.allowedTools.split(',').map(t => t.trim());
    }
    if (options.githubUrl) {
      payload.github_url = options.githubUrl;
    }
    if (options.githubBranch) {
      payload.github_branch = options.githubBranch;
    }

    if (options.verbose) {
      output.info(`Creating skill at: ${url}`);
      output.json(payload);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      handleApiError(res.status, body, output);
      return;
    }

    if (options.json) {
      writeJsonSuccess(context, body);
      return;
    }

    output.success(`Skill '${skillId}' created successfully`);
    output.info('Next steps:');
    output.list([
      `kablewy skill upload ${skillId} ./bundle.zip - Upload a skill bundle`,
      `kablewy skill show ${skillId} - View skill details`
    ]);

  } catch (error: unknown) {
    failRequest(output, `Failed to create skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Upload skill bundle
async function handleSkillUpload(skillId: string, zipPath: string, options: SkillOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    // Validate file exists
    const fileStat = await stat(zipPath).catch(() => null);
    if (!fileStat) {
      failUsage(output, `File not found: ${zipPath}`);
      return;
    }

    if (!fileStat.isFile()) {
      failUsage(output, `Not a file: ${zipPath}`);
      return;
    }

    // Warn if file is large
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (fileStat.size > maxSize) {
      output.warning(`File is larger than 25MB (${formatBytes(fileStat.size)}). Upload may fail.`);
    }

    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}/${skillId}/bundle`;

    if (options.verbose) {
      output.info(`Uploading bundle to: ${url}`);
      output.info(`File: ${zipPath} (${formatBytes(fileStat.size)})`);
    }

    const form = new FormData();
    form.append('file', createReadStream(zipPath), {
      filename: basename(zipPath),
      contentType: 'application/zip'
    });
    if (options.version) {
      form.append('version', options.version);
    }

    const spinner = output.spinner(`Uploading ${basename(zipPath)}...`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.apiKey}`,
      ...form.getHeaders() as Record<string, string>
    };

    const res = await request(url, {
      method: 'POST',
      headers,
      body: form
    });

    const text = await res.body.text();
    let body: any = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text || 'Upload failed' };
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      spinner.fail('Upload failed');
      handleApiError(res.statusCode, body, output);
      return;
    }

    spinner.succeed('Bundle uploaded successfully');

    if (options.json) {
      writeJsonSuccess(context, body);
      return;
    }

    const version = body.version || body.data?.version || options.version || 'latest';
    output.success(`Skill '${skillId}' bundle uploaded (version: ${version})`);
    output.info('Execute with:');
    output.list([
      `kablewy skill execute ${skillId}`,
      `kablewy skill execute ${skillId} --entry main.py  # Runtime auto-detected from extension`
    ]);

  } catch (error: unknown) {
    failRequest(output, `Failed to upload bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Infer runtime from file extension per agentskills.io conventions.
 */
function inferRuntimeFromExtension(entry: string): string | undefined {
  const ext = entry.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py':
      return 'python';
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'bun';
    case 'go':
      return 'go';
    default:
      return undefined;
  }
}

/**
 * Find conventional entry point from skill files.
 */
function findConventionalEntry(files: string[]): string | undefined {
  const conventions = ['main.py', 'index.js', 'main.js', 'index.ts', 'main.ts', 'main.go'];
  // Check root level first
  for (const conv of conventions) {
    if (files.includes(conv)) return conv;
  }
  // Check scripts/ directory
  for (const conv of conventions) {
    const scripted = `scripts/${conv}`;
    if (files.includes(scripted)) return scripted;
  }
  return undefined;
}

// Execute skill
async function handleSkillExecute(skillId: string, options: SkillOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    let entry = options.entry;
    let runtime = options.runtime;

    // If entry not provided, try to get from skill details
    if (!entry) {
      if (options.verbose) {
        output.info('No --entry provided, fetching skill details...');
      }

      const detailsUrl = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}/${skillId}`;
      const detailsRes = await fetch(detailsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (detailsRes.ok) {
        const details = await detailsRes.json().catch(() => ({}));
        const manifest = details.manifest || details.data?.manifest || details;

        // Use latestEntry from manifest if available (database is source of truth)
        if (manifest.latestEntry) {
          entry = manifest.latestEntry;
          if (options.verbose) {
            output.info(`Using skill default entry: ${entry}`);
          }
        }
      }

      if (!entry) {
        failUsage(output, 'Could not determine entry point.');
        output.info('Either provide --entry or add metadata.entry to your SKILL.md');
        output.info('Example: kablewy skill execute my-skill --entry main.py');
        return;
      }
    }

    // If runtime not provided, infer from entry file extension
    if (!runtime && entry) {
      runtime = inferRuntimeFromExtension(entry);
      if (runtime && options.verbose) {
        output.info(`Inferred runtime from extension: ${runtime}`);
      }
    }

    if (!runtime) {
      failUsage(output, 'Could not determine runtime.');
      output.info('Either provide --runtime or use a recognized file extension (.py, .ts, .js, .go)');
      return;
    }

    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}/${skillId}/execute`;

    // Parse args and env
    let args: string[] = [];
    let env: Record<string, string> = {};

    if (options.args) {
      try {
        args = JSON.parse(options.args);
        if (!Array.isArray(args)) {
          failUsage(output, '--args must be a JSON array');
          return;
        }
      } catch {
        failUsage(output, 'Invalid JSON in --args');
        return;
      }
    }

    if (options.env) {
      try {
        env = JSON.parse(options.env);
        if (typeof env !== 'object' || Array.isArray(env)) {
          failUsage(output, '--env must be a JSON object');
          return;
        }
      } catch {
        failUsage(output, 'Invalid JSON in --env');
        return;
      }
    }

    const payload: any = {
      runtime,
      entry,
      args,
      env,
      timeoutMs: parseInt(String(options.timeoutMs || '120000'), 10)
    };

    if (options.version) {
      payload.version = options.version;
    }

    if (options.verbose) {
      output.info(`Executing skill at: ${url}`);
      output.json(payload);
    }

    const spinner = output.spinner(`Executing skill '${skillId}'...`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      spinner.fail('Execution failed');
      handleApiError(res.status, body, output);
      return;
    }

    spinner.succeed('Execution completed');

    if (options.json) {
      writeJsonSuccess(context, body);
      return;
    }

    const result = body.data || body;

    output.section('Execution Result');

    if (result.stdout) {
      output.info('stdout:');
      output.code(result.stdout, 'text');
    }

    if (result.stderr) {
      output.warning('stderr:');
      output.code(result.stderr, 'text');
    }

    if (result.exitCode !== undefined) {
      output.info(`Exit code: ${result.exitCode}`);
    }

    if (result.outputs && Object.keys(result.outputs).length > 0) {
      output.section('Outputs');
      output.json(result.outputs);
    }

  } catch (error: unknown) {
    failRequest(output, `Failed to execute skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// List skill versions (DEPRECATED - skills now have single version)
async function handleSkillVersions(skillId: string, options: SkillOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    // Fetch skill details - database is source of truth
    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}/${skillId}`;

    if (options.verbose) {
      output.info(`Fetching skill details from: ${url}`);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      handleApiError(res.status, body, output);
      return;
    }

    const details = body.data || body;
    const manifest = details.manifest || details;

    if (options.json) {
      writeJsonSuccess(context, {
        skillId,
        runtime: manifest.latestRuntime || null,
        entry: manifest.latestEntry || null,
        sha256: manifest.latestSha256 || null,
        _note: 'Skill versioning is deprecated. Skills now have a single bundle.'
      });
      return;
    }

    output.section(`Bundle Info for '${skillId}'`);
    output.warning('Note: Skill versioning is deprecated. Skills now have a single bundle.');

    if (!manifest.latestSha256) {
      output.info('No bundle uploaded');
      return;
    }

    output.info(`Runtime: ${manifest.latestRuntime || '-'}`);
    output.info(`Entry: ${manifest.latestEntry || '-'}`);
    output.info(`SHA256: ${manifest.latestSha256?.substring(0, 12) || '-'}...`);

  } catch (error: unknown) {
    failRequest(output, `Failed to get skill info: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Delete skill
async function handleSkillDelete(skillId: string, options: SkillOptions, context: CommandContext): Promise<void> {
  const { output, input } = context;
  const config = getSkillApiConfig(context);

  if (!validateConfig(config, output)) return;

  try {
    // Confirm deletion
    if (!options.force) {
      const confirmed = await input.confirm(`Are you sure you want to delete skill '${skillId}'? This cannot be undone.`);
      if (!confirmed) {
        output.info('Deletion cancelled');
        return;
      }
    }

    const url = `${config.baseUrl}/v1/skills/${config.orgId}/users/${config.userId}/${skillId}`;

    if (options.verbose) {
      output.info(`Deleting skill at: ${url}`);
    }

    const spinner = output.spinner(`Deleting skill '${skillId}'...`);

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      spinner.fail('Deletion failed');
      handleApiError(res.status, body, output);
      return;
    }

    spinner.succeed(`Skill '${skillId}' deleted successfully`);

    if (options.json) {
      writeJsonSuccess(context, { deleted: true, skillId });
    }

  } catch (error: unknown) {
    failRequest(output, `Failed to delete skill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Utility function to format bytes
function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}
