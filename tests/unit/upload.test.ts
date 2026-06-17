import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createUploadCommand } from '../../src/commands/upload.js';
import { CommandContext } from '../../src/types/index.js';

vi.mock('undici', () => ({ request: vi.fn() }));
import { request } from 'undici';

const mockRequest = vi.mocked(request);

const FILE_CONTENT = 'hello kablewy upload test';
const FILE_SHA256 = createHash('sha256').update(FILE_CONTENT).digest('hex');

function uploadResponse(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers,
    body: { text: async () => JSON.stringify(body) }
  } as any;
}

/** form-data keeps appended field headers as strings in `_streams`. */
function formFields(form: any): string {
  return (form?._streams || []).filter((part: unknown) => typeof part === 'string').join('\n');
}

describe('Upload Command', () => {
  let context: CommandContext;
  let tempDir: string;
  let sessionDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kablewy-upload-test-'));
    sessionDir = join(tempDir, 'sessions');
    filePath = join(tempDir, 'doc.txt');
    writeFileSync(filePath, FILE_CONTENT);

    context = {
      config: {
        get: vi.fn((key: string) => {
          const values: Record<string, string> = {
            apiUrl: 'http://localhost:8787',
            orgId: 'test-org',
            userId: 'test-user',
            apiKey: 'api_test_key'
          };
          return values[key];
        })
      },
      mcpClient: {} as any,
      output: {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        table: vi.fn(),
        section: vi.fn(),
        list: vi.fn(),
        json: vi.fn(),
        spinner: vi.fn(),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        code: vi.fn(),
        banner: vi.fn(),
        box: vi.fn(),
        clear: vi.fn()
      } as any,
      input: {} as any
    };

    mockRequest.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function runUpload(extraArgs: string[] = []): Promise<void> {
    const command = createUploadCommand(context);
    await command.parseAsync([
      'node', 'upload', filePath,
      '--session-dir', sessionDir,
      '--retry', '1',
      '--retry-delay', '1',
      ...extraArgs
    ]);
  }

  describe('exit codes', () => {
    it('sets exit code 1 when an upload fails', async () => {
      mockRequest.mockResolvedValue(uploadResponse(500, { error: 'boom' }));

      await runUpload();

      expect(process.exitCode).toBe(1);
      expect(context.output.warning).toHaveBeenCalledWith(
        expect.stringContaining('Upload finished with failures')
      );
    });

    it('keeps exit code 0 when all uploads succeed', async () => {
      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload();

      expect(process.exitCode).toBeUndefined();
      expect(context.output.success).toHaveBeenCalledWith(
        expect.stringContaining('Upload completed!')
      );
    });

    it('keeps exit code 0 on --dry-run and uploads nothing', async () => {
      await runUpload(['--dry-run']);

      expect(process.exitCode).toBeUndefined();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('sets exit code 1 when the upload run itself throws', async () => {
      // --session-dir pointing at an existing FILE makes session init throw.
      await runUpload(['--session-dir', filePath]);

      expect(process.exitCode).toBe(1);
      expect(context.output.error).toHaveBeenCalledWith(
        expect.stringContaining('Upload failed')
      );
    });
  });

  describe('--no-session-store', () => {
    it('does not write a session manifest', async () => {
      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload(['--no-session-store']);

      expect(context.output.info).toHaveBeenCalledWith(
        expect.stringContaining('no persistence')
      );
      expect(() => readdirSync(sessionDir)).toThrow(); // dir never created
    });
  });

  describe('--resume-from', () => {
    it('re-queues files persisted as failed', async () => {
      const sessionId = 'resume-test-session';
      const manifest = {
        id: sessionId,
        files: [{
          path: filePath,
          name: 'doc.txt',
          size: FILE_CONTENT.length,
          type: 'text/plain',
          status: 'failed',
          lastError: { category: 'SERVER', message: 'boom', retryable: true, timestamp: new Date().toISOString() }
        }],
        status: 'failed',
        progress: 0,
        createdAt: new Date().toISOString(),
        stats: { total: 1, completed: 0, failed: 1, skipped: 0, bytesUploaded: 0 }
      };
      const { mkdirSync } = await import('node:fs');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${sessionId}.json`), JSON.stringify(manifest));

      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload(['--resume-from', sessionId]);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
      const saved = JSON.parse(readFileSync(join(sessionDir, `${sessionId}.json`), 'utf8'));
      expect(saved.files[0].status).toBe('completed');
      expect(saved.status).toBe('completed');
    });
  });

  describe('--skip-existing', () => {
    it('skips a file whose hash already exists (HTTP 200)', async () => {
      const fetchMock = vi.fn(async () => new Response(
        JSON.stringify({ data: { id: 'doc-existing' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ));
      vi.stubGlobal('fetch', fetchMock);

      await runUpload(['--skip-existing']);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8787/v1/documents/test-org/users/test-user/search-by-hash',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ file_hash: FILE_SHA256 })
        })
      );
      expect(mockRequest).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(context.output.success).toHaveBeenCalledWith(
        expect.stringContaining('0 successful, 1 skipped, 0 failed')
      );
      const manifestFile = readdirSync(sessionDir).find(f => f.endsWith('.json'));
      const saved = JSON.parse(readFileSync(join(sessionDir, manifestFile!), 'utf8'));
      expect(saved.files[0].status).toBe('skipped');
      expect(saved.files[0].documentId).toBe('doc-existing');
      expect(saved.stats.skipped).toBe(1);
      expect(saved.status).toBe('completed');
    });

    it('uploads when the hash is not found (HTTP 404)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ data: null }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )));
      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload(['--skip-existing']);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(context.output.success).toHaveBeenCalledWith(
        expect.stringContaining('1 successful, 0 skipped, 0 failed')
      );
    });

    it('fails open when the existence check errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload(['--skip-existing']);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('upload request', () => {
    it('always sends the file_hash multipart field', async () => {
      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload();

      const [, requestOptions] = mockRequest.mock.calls[0];
      const fields = formFields((requestOptions as any).body);
      expect(fields).toContain('name="file_hash"');
      expect(fields).toContain(FILE_SHA256);
    });

    it('sets headers and body timeouts', async () => {
      mockRequest.mockResolvedValue(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload();

      const [, requestOptions] = mockRequest.mock.calls[0];
      expect(requestOptions).toMatchObject({
        headersTimeout: 60_000,
        bodyTimeout: 600_000
      });
    });

    it('retries a 429 and succeeds on the next attempt', async () => {
      mockRequest
        .mockResolvedValueOnce(uploadResponse(429, { error: 'rate limited' }, { 'retry-after': '0' }))
        .mockResolvedValueOnce(uploadResponse(200, { data: { document_id: 'doc-1' } }));

      await runUpload(['--retry', '2']);

      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBeUndefined();
      expect(context.output.success).toHaveBeenCalledWith(
        expect.stringContaining('1 successful, 0 skipped, 0 failed')
      );
    });

    it('requires a dedicated doc-processor token for container uploads', async () => {
      await runUpload([
        '--use-container',
        '--doc-worker-url',
        'https://doc-worker.example.com'
      ]);

      expect(process.exitCode).toBe(1);
      expect(mockRequest).not.toHaveBeenCalled();
      expect(context.output.error).toHaveBeenCalledWith(
        expect.stringContaining('Missing --doc-processor-token')
      );
    });

    it('routes container uploads to the doc-worker with the dedicated token', async () => {
      mockRequest.mockResolvedValue(uploadResponse(202, { data: { document_id: 'doc-queued' } }));

      await runUpload([
        '--use-container',
        '--doc-worker-url',
        'https://doc-worker.example.com/',
        '--doc-processor-token',
        'processor-token'
      ]);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const [url, requestOptions] = mockRequest.mock.calls[0];
      expect(url).toBe('https://doc-worker.example.com/v1/documents/test-org/users/test-user/process-upload');
      expect((requestOptions as any).headers.Authorization).toBe('Bearer processor-token');
      expect(process.exitCode).toBeUndefined();
    });
  });
});
