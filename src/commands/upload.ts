import { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import {
  CommandContext,
  UploadOptions,
  UploadSession,
  UploadFile
} from '../types/index.js';
import { globStream } from '../utils/glob-stream.js';
import { stat } from 'fs/promises';
import { basename, extname, resolve, relative } from 'path';
import { request } from 'undici';
import FormData from 'form-data';
import { createReadStream } from 'fs';
import {
  UploadSessionStore,
  createInitialSessionManifest,
  updateSessionStats,
  UploadRateLimiter
} from '../utils/index.js';
import { UploadLogger, classifyError } from '../utils/index.js';
import { recordFileFailure, recordFileSkipped, recordFileStart, recordFileSuccess } from '../utils/index.js';
import { pipeline } from 'stream/promises';
import { isScopedApiKey, normalizeApiKey, scopedApiKeyErrorMessage } from '../core/credentials.js';

const DEFAULT_ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.pptx',
  '.md',
  '.txt',
  '.csv',
  '.xls',
  '.xlsx'
]);
const DEFAULT_MAX_CONCURRENCY = 16;

export function createUploadCommand(context: CommandContext): Command {
  return createUploadSubcommand('upload', context);
}

export function createUploadSubcommand(name: string, context: CommandContext): Command {
  const command = new Command(name);

  command
    .description('Upload documents to Kablewy knowledge base')
    .argument('[patterns...]', 'File patterns to upload (e.g., ./docs/*.pdf)')
    .option('-t, --title <title>', 'Document title')
    .option('-d, --description <description>', 'Document description')
    .option('--public', 'Make uploaded documents visible to your workspace')
    .option('-p, --parse-mode <mode>', 'Parse mode: fast, balanced, premium, auto', 'balanced')
    .option('-c, --concurrency <number>', 'Number of concurrent uploads', '3')
    .option('--dry-run', 'Preview what would be uploaded without actually uploading')
    .option('--skip-existing', 'Skip files whose content already exists in the knowledge base (SHA-256 match)')
    .option('--resume-from <session>', 'Resume from a previous upload session')
    .option('--retry <attempts>', 'Number of retry attempts', '3')
    .option('--retry-delay <ms>', 'Delay between retries in milliseconds', '1000')
    .option('--session-dir <path>', 'Directory to store upload session manifests')
    .option('--session-id <id>', 'Explicit session identifier to use (resume compatible)')
    .option('--log-file <path>', 'Write structured upload logs to this file')
    .option('--max-requests-per-minute <number>', 'Throttle requests to this rate (optional)')
    .option('--max-bytes-per-minute <number>', 'Throttle uploaded bytes to this rate (optional)')
    .option('--max-concurrency <number>', 'Upper bound for adaptive concurrency adjustments (optional)')
    .option('--no-session-store', 'Disable session manifest persistence (advanced)')
    .option('--include-path-in-description', 'Append the source file path to the description when one is not provided explicitly')
    .option('--verbose', 'Show detailed progress information')
    // Container routing options (doc-worker)
    .option('--use-container', 'Route uploads to the doc-worker container path (asynchronous, 202)')
    .option('--doc-worker-url <url>', 'Doc-worker base URL (e.g., https://doc-worker.example.workers.dev)')
    .option('--doc-processor-token <token>', 'Bearer token for doc-worker path route authentication')
    .action(async (patterns: string[], options: UploadOptions) => {
      await handleUpload(patterns, options, context);
    });

  return command;
}

async function handleUpload(patterns: string[], options: UploadOptions, context: CommandContext): Promise<void> {
  const { output } = context;
  const allowedExtensions = DEFAULT_ALLOWED_EXTENSIONS;
  
  try {
    const validParseModes = ['fast', 'balanced', 'premium', 'auto'];
    if (!validParseModes.includes(options.parseMode as string)) {
      output.error(`Invalid parse mode: ${options.parseMode}. Must be one of: ${validParseModes.join(', ')}`);
      return;
    }

    const discovery = await discoverFiles(patterns, options, allowedExtensions, output);

    if (discovery.files.length === 0) {
      output.warning('No files found matching the specified patterns');
      return;
    }

    output.info(`Found ${discovery.files.length} files to upload`);

    // Session routing summary (API vs doc-worker)
    try {
      const configMgr = context.config as any;
      const apiUrlRaw = configMgr?.get ? (configMgr.get('apiUrl') as string) : (process.env.KABLEWY_API_URL as string);
      const baseUrl = (apiUrlRaw || '').replace(/\/+$/, '');
      const useContainer = Boolean((options as any).useContainer);
      const cfgDocWorkerUrl = configMgr?.get ? (configMgr.get('docWorkerUrl') as string) : (process.env.KABLEWY_DOC_WORKER_URL as string);
      const cfgDocProcessorToken = configMgr?.get ? (configMgr.get('docProcessorToken') as string) : (process.env.KABLEWY_DOC_PROCESSOR_TOKEN as string);
      const apiKey = normalizeApiKey(configMgr?.get ? (configMgr.get('apiKey') as string) : (process.env.KABLEWY_API_KEY as string));
      const docWorkerUrl = (((options as any).docWorkerUrl as string) || cfgDocWorkerUrl || '').replace(/\/+$/, '');
      const explicitToken = (options as any).docProcessorToken as string || cfgDocProcessorToken;
      const tokenSource = useContainer ? (explicitToken ? 'doc-processor-token' : 'apiKey(fallback)') : 'apiKey';
      if (useContainer) {
        output.info(`[container] Using doc-worker: ${docWorkerUrl || '(missing)'}, auth=${tokenSource}`);
      } else {
        output.info(`[api] Using backend API: ${baseUrl || '(missing baseUrl)'}`);
      }
    } catch {}

    if ((options as any).dryRun) {
      output.section('Dry Run - Files that would be uploaded:');
      discovery.files.forEach((file, index) => {
        output.info(`${index + 1}. ${file.path} (${formatFileSize(file.size)})`);
      });
      return;
    }

    const sessionId = options.sessionId || generateSessionId();
    const uploadSession: UploadSession = {
      id: sessionId,
      files: discovery.files.map(f => ({
        path: f.path,
        name: f.name,
        size: f.size,
        type: f.type,
        status: 'pending'
      })),
      status: 'uploading',
      progress: 0,
      createdAt: new Date().toISOString()
    };

    // commander's negated `--no-session-store` flag surfaces as `sessionStore === false`
    const sessionStore = options.sessionStore === false
      ? undefined
      : new UploadSessionStore({
          baseDir: options.sessionDir,
          sessionId: sessionId,
          resumeFrom: options.resumeFrom
        });
    const logger = new UploadLogger({ filePath: options.logFile, stdout: false, level: options.verbose ? 'debug' : 'info' });

    let manifest = createInitialSessionManifest(uploadSession);
    if (sessionStore) {
      const init = await sessionStore.initialize(manifest);
      manifest = createInitialSessionManifest(init.session);
      if (init.resumed) {
        output.info(`Resuming upload session: ${manifest.id}`);
      } else {
        output.info(`Starting upload session: ${manifest.id}`);
      }
    } else {
      output.info(`Starting upload session (no persistence): ${manifest.id}`);
    }

    const rawConcurrency = parseInt((options.concurrency as unknown as string) || '3', 10);
    const maxConcurrency = options.maxConcurrency ? Number(options.maxConcurrency) : DEFAULT_MAX_CONCURRENCY;
    const boundedConcurrency = Math.max(1, Math.min(rawConcurrency, maxConcurrency));
    const retryAttempts = parseInt((options as any).retry || '3', 10);
    const retryDelay = parseInt((options.retryDelay as unknown as string) || '1000', 10);

    await uploadFilesWithConcurrency({
      session: manifest,
      concurrency: boundedConcurrency,
      retryAttempts,
      retryDelay,
      options,
      context,
      sessionStore,
      logger,
      maxConcurrency,
      userConcurrency: rawConcurrency
    });

    manifest.status = manifest.files.every(f => f.status === 'completed' || f.status === 'skipped') ? 'completed' : 'failed';
    manifest.completedAt = new Date().toISOString();
    updateSessionStats(manifest);
    if (sessionStore) {
      await sessionStore.save(manifest);
    }
    logger.info('Upload session finished', { sessionId: manifest.id, status: manifest.status });
    logger.close();

    const summary = `${manifest.stats?.completed ?? 0} successful, ${manifest.stats?.skipped ?? 0} skipped, ${manifest.stats?.failed ?? 0} failed`;
    if (manifest.status === 'completed') {
      output.success(`Upload completed! Session ID: ${manifest.id}. Summary: ${summary}`);
    } else {
      output.warning(`Upload finished with failures. Session ID: ${manifest.id}. Summary: ${summary}`);
      // Exit-code contract: 0 = success. Any failed file is a failed upload run.
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    output.error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    if (options.verbose) {
      console.error(error);
    }
  }
}

async function discoverFiles(
  patterns: string[],
  options: UploadOptions,
  allowedExtensions: Set<string>,
  output: CommandContext['output']
): Promise<{ files: Array<{ path: string; name: string; size: number; type: string }> }> {
  const files: Array<{ path: string; name: string; size: number; type: string }> = [];
  const patternsToUse = patterns.length > 0
    ? patterns
    : ['./**/*.pdf', './**/*.doc', './**/*.docx', './**/*.pptx', './**/*.txt', './**/*.md', './**/*.csv', './**/*.xls', './**/*.xlsx'];

  for (const pattern of patternsToUse) {
    const stream = globStream(pattern, { nodir: true });
    for await (const filePath of stream) {
      try {
        const stats = await stat(filePath);
        const ext = extname(filePath).toLowerCase();
        if (!allowedExtensions.has(ext)) {
          output.warning?.(`Skipping unsupported file type: ${filePath}`);
          continue;
        }
        files.push({
          path: resolve(filePath),
          name: basename(filePath),
          size: stats.size,
          type: getMimeType(ext)
        });
      } catch (error: unknown) {
        output.warning(`Skipping ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { files };
}

interface UploadRunParams {
  session: UploadSession;
  concurrency: number;
  retryAttempts: number;
  retryDelay: number;
  options: UploadOptions;
  context: CommandContext;
  sessionStore?: UploadSessionStore;
  logger: UploadLogger;
  maxConcurrency: number;
  userConcurrency: number;
}

async function uploadFilesWithConcurrency(params: UploadRunParams): Promise<void> {
  const { session, concurrency, retryAttempts, retryDelay, options, context, sessionStore, logger, maxConcurrency, userConcurrency } = params;
  const { output } = context;

  const rateLimiter = new UploadRateLimiter(session, {
    maxRequestsPerMinute: options.maxRequestsPerMinute,
    maxBytesPerMinute: options.maxBytesPerMinute,
    adaptiveConcurrency: {
      min: 1,
      max: maxConcurrency,
      initial: Math.min(concurrency, maxConcurrency)
    }
  });

  let dynamicConcurrency = Math.max(1, Math.min(concurrency, rateLimiter.getSuggestedConcurrency(concurrency)));
  // Re-queue `failed` files too: --resume-from is documented as the way to retry failures.
  const pendingFiles = session.files.filter(f => f.status === 'pending' || f.status === 'uploading' || f.status === 'failed');
  const progress = output.progress(`Uploading ${pendingFiles.length} files`);
  let completed = session.files.filter(f => f.status === 'completed').length;
  let skipped = session.files.filter(f => f.status === 'skipped').length;
  // Previously-failed files are being retried, so they start from a clean slate.
  let failed = 0;

  const uploadQueue = [...pendingFiles];
  const activeUploads = new Set<Promise<void>>();

  const startNextUpload = () => {
    while (uploadQueue.length > 0 && activeUploads.size < dynamicConcurrency) {
      const file = uploadQueue.shift();
      if (!file) break;
      const uploadPromise = uploadFile(file, retryAttempts, retryDelay, options, context, logger, rateLimiter)
        .then((outcome) => {
          if (outcome === 'skipped') {
            skipped++;
          } else {
            completed++;
          }
        })
        .catch((error) => {
          failed++;
          rateLimiter.recordError();
          const errno = (error as NodeJS.ErrnoException)?.code;
          if (errno === 'EMFILE' || errno === 'ENFILE') {
            logger.warn('File descriptor limit hit, reducing concurrency', { errno });
          }
          const clampTarget = Math.min(userConcurrency, maxConcurrency);
          dynamicConcurrency = Math.max(
            1,
            Math.min(clampTarget, rateLimiter.getSuggestedConcurrency(dynamicConcurrency))
          );
          if (options.verbose) {
            const detail = typeof (error as any)?.details === 'string' ? (error as any).details : undefined;
            const extra = detail ? `\n  → ${detail}` : '';
            context.output.error(`Failed to upload ${file.name}: ${error?.message ?? error}${extra}`);
          }
        })
        .finally(async () => {
          activeUploads.delete(uploadPromise);
          updateSessionStats(session);
          const total = completed + skipped + failed;
          progress.update(pendingFiles.length ? (total / pendingFiles.length) * 100 : 100);
          if (sessionStore) {
            await sessionStore.save(session);
          }
          startNextUpload();
        });

      activeUploads.add(uploadPromise);
    }
  };

  startNextUpload();

  while (activeUploads.size > 0) {
    await Promise.race(activeUploads);
    dynamicConcurrency = Math.max(
      1,
      Math.min(userConcurrency, maxConcurrency, rateLimiter.getSuggestedConcurrency(dynamicConcurrency))
    );
    startNextUpload();
  }

  progress.stop();

  if (failed > 0) {
    const failedDetails = session.files
      .filter(f => f.status === 'failed' && f.lastError?.message)
      .slice(0, 3)
      .map(f => {
        const detail = typeof f.lastError?.details === 'string' ? f.lastError?.details : undefined;
        const base = `${f.name}: ${f.lastError?.message}`;
        return detail ? `${base} (details: ${detail})` : base;
      });
    output.warning(`${failed} files failed to upload. Use --resume-from ${session.id} to retry failures.`);
    if (failedDetails.length > 0) {
      output.list(failedDetails, { bullet: '-' });
      if (failed > failedDetails.length) {
        output.info('Additional failures omitted; rerun with --verbose for all details.');
      }
    }
  }

  output.success(`Upload completed: ${completed} successful, ${skipped} skipped, ${failed} failed`);

  // Write summary artifacts if requested
  try {
    if (options.logFile && typeof options.logFile === 'string' && options.logFile.length > 0) {
      const { writeFile } = await import('fs/promises');
      const summarize = (f: any) => ({
        path: f.path,
        size: f.size,
        status: f.status,
        documentId: f.documentId || null,
        attempts: f.attempts || 0,
        error: f.lastError?.message || null
      });
      const rows = session.files.map(summarize);
      const jsonPath = `${options.logFile}.summary.json`;
      await writeFile(jsonPath, JSON.stringify({ sessionId: session.id, stats: session.stats, files: rows }, null, 2));
      const csvHead = 'path,size,status,documentId,attempts,error\n';
      const csvRows = rows
        .map(r => [r.path, r.size, r.status, r.documentId ?? '', r.attempts, (r.error ?? '').toString().replaceAll('\n', ' ').replaceAll('"', "''")]
          .map(v => (typeof v === 'string' && v.includes(',') ? `"${v}"` : String(v)))
          .join(','))
        .join('\n');
      const csvPath = `${options.logFile}.summary.csv`;
      await writeFile(csvPath, csvHead + csvRows + '\n');
      output.info(`Wrote summary: ${jsonPath}, ${csvPath}`);
    }
  } catch (e) {
    if (options.verbose) {
      output.warning(`Failed to write summary files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function uploadFile(
  file: UploadFile,
  retryAttempts: number,
  retryDelay: number,
  options: UploadOptions,
  context: CommandContext,
  logger: UploadLogger,
  rateLimiter: UploadRateLimiter
): Promise<'completed' | 'skipped'> {
  const configMgr = context.config as any;
  const apiUrlRaw = configMgr?.get ? (configMgr.get('apiUrl') as string) : (process.env.KABLEWY_API_URL as string);
  const orgId = configMgr?.get ? (configMgr.get('orgId') as string) : (process.env.KABLEWY_ORG_ID as string);
  const userId = configMgr?.get ? (configMgr.get('userId') as string) : (process.env.KABLEWY_USER_ID as string);
  const apiKey = normalizeApiKey(configMgr?.get ? (configMgr.get('apiKey') as string) : (process.env.KABLEWY_API_KEY as string));
  if (apiKey && !isScopedApiKey(apiKey)) {
    throw new Error(scopedApiKeyErrorMessage('Configured API key'));
  }
  const baseUrl = (apiUrlRaw || '').replace(/\/+$/, '');

  // Container routing (optional)
  const useContainer = Boolean((options as any).useContainer);
  const cfgDocWorkerUrl = configMgr?.get ? (configMgr.get('docWorkerUrl') as string) : (process.env.KABLEWY_DOC_WORKER_URL as string);
  const cfgDocProcessorToken = configMgr?.get ? (configMgr.get('docProcessorToken') as string) : (process.env.KABLEWY_DOC_PROCESSOR_TOKEN as string);
  const docWorkerUrl = (((options as any).docWorkerUrl as string) || cfgDocWorkerUrl || '').replace(/\/+$/, '');
  let docProcessorToken = (options as any).docProcessorToken as string || cfgDocProcessorToken;

  const url = useContainer
    ? `${docWorkerUrl}/v1/documents/${orgId}/users/${userId}/process-upload`
    : `${baseUrl}/v1/documents/${orgId}/users/${userId}/upload`;

  // Compute the content hash once per file: it drives --skip-existing and is
  // always sent on the upload form so the backend can store/dedup by hash.
  let fileHash: string | undefined;
  try {
    fileHash = await computeFileSha256(file.path);
  } catch (error: unknown) {
    logger.debug('Failed to compute file hash; continuing without it', {
      file: toRelativePath(file.path),
      error: error instanceof Error ? error.message : String(error)
    });
  }

  if (options.skipExisting && fileHash) {
    const existing = await findExistingDocumentByHash(baseUrl, orgId, userId, apiKey, fileHash, logger);
    if (existing.exists) {
      if (existing.documentId) file.documentId = existing.documentId;
      recordFileSkipped(file);
      logger.info('Skipped existing document (hash match)', {
        file: toRelativePath(file.path),
        documentId: existing.documentId
      });
      return 'skipped';
    }
  }

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      recordFileStart(file);
      logger.debug('Uploading file', { file: file.path, attempt });

      await rateLimiter.beforeRequest(file.size);

      const form = new FormData();
      const relativePath = toRelativePath(file.path);
      const fileStream = createReadStream(file.path);
      fileStream.once('error', (err) => {
        logger.error('File stream error', { file: relativePath, error: err.message });
      });
      form.append('file', fileStream);
      form.append('title', ((options as any).title || file.name) as string);
      const descriptionFromCli = (options as any).description as string | undefined;
      if (descriptionFromCli && descriptionFromCli.length > 0) {
        form.append('description', descriptionFromCli);
      } else if ((options as any).includePathInDescription) {
        const defaultDesc = `${relativePath} (uploaded ${new Date().toISOString()})`;
        form.append('description', defaultDesc);
      }
      if (options.parseMode) {
        form.append('parse_mode', options.parseMode);
      }
      if (options.public) {
        form.append('visibility', 'public');
      }
      if (fileHash) {
        form.append('file_hash', fileHash);
      }

      const totalBytes = file.size;
      const headers: Record<string, string> = { ...form.getHeaders() } as any;
      if (useContainer) {
        if (!docWorkerUrl) {
          throw new Error('Missing --doc-worker-url (or KABLEWY_DOC_WORKER_URL) for --use-container');
        }
        // Fallback: if no dedicated doc-processor token is set, reuse API key
        if (!docProcessorToken) {
          docProcessorToken = apiKey;
          logger.debug('Using API key as doc-worker token (fallback). Consider setting KABLEWY_DOC_PROCESSOR_TOKEN.');
        }
        headers['Authorization'] = `Bearer ${docProcessorToken}`;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // Timeouts: a hung connection must not block an upload slot forever.
      const res = await request(url, {
        method: 'POST',
        headers,
        body: form,
        headersTimeout: 60_000,
        bodyTimeout: 600_000
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        const text = await res.body.text();
        let parsed: any = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(text || 'Upload failed');
        }
        const data = parsed?.data || parsed;
        const docId: string | undefined = data?.document_id || data?.id || data?.documentId;
        if (docId) file.documentId = docId;

        recordFileSuccess(file, file.size);
        if (useContainer) {
          logger.info('Submitted to doc-worker (queued)', { file: relativePath, worker: docWorkerUrl });
        } else {
          logger.info('Upload succeeded', { file: relativePath, documentId: file.documentId });
        }
        return 'completed';
      }

      const errBody = await res.body.text();
      let message = `Upload failed with status ${res.statusCode}`;
      let details: unknown;
      try {
        const errJson = JSON.parse(errBody);
        const data = errJson?.data || errJson;
        const docId: string | undefined = data?.document_id || data?.id || data?.documentId;
        if (docId) file.documentId = docId;
        message = errJson.error || errJson.message || message;
        details = errJson.details;
      } catch {
        details = errBody;
      }
      const retryAfterHeader = res.headers['retry-after'];
      throw {
        statusCode: res.statusCode,
        message,
        details,
        retryAfter: Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader
      };
    } catch (error: unknown) {
      const classified = classifyError(error);
      const retryable = attempt < retryAttempts && classified.retryable;
      recordFileFailure(file, classified, retryable);
      logger.warn('Upload attempt failed', {
        file: toRelativePath(file.path),
        attempt,
        error: classified.message,
        category: classified.category,
        retryable
      });
      if (!retryable) {
        throw new Error(classified.message);
      }
      // Honor an explicit Retry-After (already parsed and capped at 60s by
      // classifyError); otherwise fall back to the linear backoff.
      const delayMs = classified.retryAfterMs ?? retryDelay * attempt;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      dynamicSleepBackoff(rateLimiter, logger);
    }
  }
  // Unreachable: every loop iteration either returns or throws.
  throw new Error('Upload failed');
}

function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Check whether a document with this content hash already exists.
 * Fails OPEN: any unexpected outcome (non-200/404, network error) proceeds
 * with the upload — the existence check must never block uploading.
 */
async function findExistingDocumentByHash(
  baseUrl: string,
  orgId: string,
  userId: string,
  apiKey: string,
  fileHash: string,
  logger: UploadLogger
): Promise<{ exists: boolean; documentId?: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/documents/${orgId}/users/${userId}/search-by-hash`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file_hash: fileHash })
    });
    if (res.status === 200) {
      const body: any = await res.json().catch(() => ({}));
      if (body?.data) {
        return { exists: true, documentId: body.data.id || body.data.document_id };
      }
      return { exists: false };
    }
    if (res.status === 404) {
      return { exists: false };
    }
    logger.debug('search-by-hash returned unexpected status; proceeding with upload', { status: res.status });
    return { exists: false };
  } catch (error: unknown) {
    logger.debug('search-by-hash check failed; proceeding with upload', {
      error: error instanceof Error ? error.message : String(error)
    });
    return { exists: false };
  }
}

function dynamicSleepBackoff(rateLimiter: UploadRateLimiter, logger: UploadLogger) {
  rateLimiter.recordError();
  logger.debug('Adaptive concurrency backoff applied');
}

function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.rtf': 'application/rtf',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff'
  };
  
  return mimeTypes[extension] || 'application/octet-stream';
}

function formatFileSize(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function generateSessionId(): string {
  // CSPRNG: the session id is sent to the backend as a correlation key, so it must
  // not be predictable (Math.random() is not cryptographically secure).
  return `session-${Date.now()}-${randomUUID()}`;
}

function toRelativePath(filePath: string): string {
  const cwd = process.cwd();
  const resolvedFile = resolve(filePath);
  const relativePath = relative(cwd, resolvedFile);
  return relativePath.startsWith('..') ? resolvedFile : relativePath || filePath;
}
