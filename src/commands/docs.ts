import { Command } from 'commander';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CommandContext } from '../types/index.js';
import { createUploadSubcommand } from './upload.js';
import { CliError, createApiClient, exitCodeFor, requireCoreApiConfig, writeJsonError, writeJsonSuccess } from '../core/api-client.js';
import { redactSecrets } from '../utils/redact.js';

interface DocsOptions {
  json?: boolean;
  limit?: string;
  yes?: boolean;
  sessionDir?: string;
}

export function createDocsCommand(context: CommandContext): Command {
  const command = new Command('docs');
  command.description('Upload, inspect, search, and manage documents');

  command.addCommand(createUploadSubcommand('upload', context));

  command
    .command('list')
    .description('List documents')
    .option('--limit <number>', 'Maximum number of documents to display', '25')
    .option('--json', 'Output JSON')
    .action(async (options: DocsOptions) => handleDocsAction(context, options, () => listDocuments(context, options)));

  command
    .command('search')
    .description('Search documents')
    .argument('<query>', 'Search query')
    .option('--limit <number>', 'Maximum number of results', '10')
    .option('--json', 'Output JSON')
    .action(async (query: string, options: DocsOptions) => handleDocsAction(context, options, () => searchDocuments(context, query, options)));

  command
    .command('get')
    .description('Get document metadata')
    .argument('<documentId>', 'Document ID')
    .option('--json', 'Output JSON')
    .action(async (documentId: string, options: DocsOptions) => handleDocsAction(context, options, () => getDocument(context, documentId, options)));

  command
    .command('delete')
    .description('Delete a document')
    .argument('<documentId>', 'Document ID')
    .option('--yes', 'Confirm deletion without prompting')
    .option('--json', 'Output JSON')
    .action(async (documentId: string, options: DocsOptions) => handleDocsAction(context, options, () => deleteDocument(context, documentId, options)));

  command
    .command('status')
    .description('Show document processing status or recent upload sessions')
    .argument('[documentId]', 'Document ID')
    .option('--session-dir <path>', 'Upload session manifest directory')
    .option('--json', 'Output JSON')
    .action(async (documentId: string | undefined, options: DocsOptions) => handleDocsAction(context, options, () => documentStatus(context, documentId, options)));

  command.action(() => {
    context.output.section('Documents');
    context.output.list([
      'kablewy docs upload ./docs',
      'kablewy docs list',
      'kablewy docs search "renewal terms"',
      'kablewy docs get <documentId>',
      'kablewy docs status <documentId>',
      'kablewy docs delete <documentId> --yes'
    ]);
  });

  return command;
}

async function handleDocsAction(context: CommandContext, options: DocsOptions, fn: () => Promise<void>): Promise<void> {
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

async function listDocuments(context: CommandContext, options: DocsOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const limit = parseLimit(options.limit, 25);
  const result = await createApiClient(context).request('GET', `/v1/documents/${config.orgId}/users/${config.userId}`, {
    query: { limit }
  });
  const docs = normalizeArray(result.data, ['documents', 'data']);
  if (options.json) {
    writeJsonSuccess(context, docs);
    return;
  }
  context.output.section('Documents');
  if (docs.length === 0) {
    context.output.info('No documents found');
    return;
  }
  context.output.table(docs.slice(0, limit).map(documentRow));
}

async function searchDocuments(context: CommandContext, query: string, options: DocsOptions): Promise<void> {
  if (!query.trim()) throw new CliError('Search query is required', 'USAGE_ERROR', 2);
  const config = requireCoreApiConfig(context);
  const limit = parseLimit(options.limit, 10);
  const result = await createApiClient(context).request('POST', `/v1/documents/${config.orgId}/users/${config.userId}/search`, {
    body: { query, limit }
  });
  const results = normalizeArray(result.data, ['results', 'documents', 'data']);
  if (options.json) {
    writeJsonSuccess(context, results);
    return;
  }
  context.output.section('Document Search Results');
  if (results.length === 0) {
    context.output.info('No matching documents found');
    return;
  }
  context.output.table(results.slice(0, limit).map(documentRow));
}

async function getDocument(context: CommandContext, documentId: string, options: DocsOptions): Promise<void> {
  const config = requireCoreApiConfig(context);
  const result = await createApiClient(context).request('GET', `/v1/documents/${config.orgId}/users/${config.userId}/document/${encodeURIComponent(documentId)}`);
  if (options.json) {
    writeJsonSuccess(context, result.data);
    return;
  }
  context.output.section(`Document: ${documentId}`);
  context.output.json(redactSecrets(result.data));
}

async function deleteDocument(context: CommandContext, documentId: string, options: DocsOptions): Promise<void> {
  if (!options.yes) {
    const confirmed = await context.input.confirm(`Delete document ${documentId}?`);
    if (!confirmed) {
      if (options.json) writeJsonSuccess(context, { deleted: false, documentId });
      else context.output.info('Document deletion cancelled');
      return;
    }
  }
  const config = requireCoreApiConfig(context);
  await createApiClient(context).request('DELETE', `/v1/documents/${config.orgId}/users/${config.userId}/document/${encodeURIComponent(documentId)}`);
  if (options.json) {
    writeJsonSuccess(context, { deleted: true, documentId });
  } else {
    context.output.success(`Deleted document ${documentId}`);
  }
}

async function documentStatus(context: CommandContext, documentId: string | undefined, options: DocsOptions): Promise<void> {
  if (!documentId) {
    const sessions = await recentUploadSessions(options.sessionDir);
    if (options.json) {
      writeJsonSuccess(context, { uploadSessions: sessions });
      return;
    }
    context.output.section('Recent Upload Sessions');
    if (sessions.length === 0) {
      context.output.info('No upload sessions found. Pass a document ID to check backend processing status.');
      return;
    }
    context.output.table(sessions);
    return;
  }

  const config = requireCoreApiConfig(context);
  const result = await createApiClient(context).request('GET', `/v1/documents/${config.orgId}/users/${config.userId}/document/${encodeURIComponent(documentId)}/processing-status`);
  if (options.json) {
    writeJsonSuccess(context, result.data);
    return;
  }
  context.output.section(`Document Status: ${documentId}`);
  context.output.json(redactSecrets(result.data));
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const value = Number(raw || fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), 500);
}

function normalizeArray(body: unknown, keys: string[]): any[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of keys) {
    const value = (body as any)[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.documents)) return value.documents;
    if (value && Array.isArray(value.results)) return value.results;
  }
  return [];
}

function documentRow(doc: any): Record<string, unknown> {
  const value = doc?.metadata || doc?.document || doc;
  return {
    ID: value?.id || value?.document_id || doc?.id || '',
    Title: value?.title || value?.name || doc?.title || '',
    Status: value?.status || doc?.status || '',
    Type: value?.mime_type || value?.type || doc?.type || '',
    Updated: value?.updated_at || value?.updatedAt || value?.created_at || value?.createdAt || ''
  };
}

async function recentUploadSessions(sessionDir?: string): Promise<Array<Record<string, unknown>>> {
  const dir = sessionDir ? path.resolve(sessionDir) : path.resolve(os.homedir(), '.kablewy-cli', 'upload-sessions');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const sessions = await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (file) => {
    const fullPath = path.join(dir, file);
    try {
      const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));
      const stats = raw.stats || {};
      return {
        Session: raw.id || path.basename(file, '.json'),
        Status: raw.status || 'unknown',
        Total: stats.total ?? raw.files?.length ?? 0,
        Completed: stats.completed ?? raw.files?.filter?.((f: any) => f.status === 'completed').length ?? 0,
        Failed: stats.failed ?? raw.files?.filter?.((f: any) => f.status === 'failed').length ?? 0,
        Updated: raw.completedAt || raw.createdAt || '',
        Manifest: fullPath
      };
    } catch {
      return null;
    }
  }));
  return sessions.filter(Boolean).slice(-10).reverse() as Array<Record<string, unknown>>;
}

