import crypto from 'crypto';
import { UploadFile, UploadSession } from '../types/index.js';

export function createInitialSessionManifest(session: UploadSession): UploadSession {
  return {
    ...session,
    stats: {
      total: session.files.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      bytesUploaded: 0
    }
  };
}

export function recordFileStart(file: UploadFile): void {
  file.status = 'uploading';
  file.startedAt = new Date().toISOString();
  file.attempts = (file.attempts || 0) + 1;
}

export function recordFileSuccess(file: UploadFile, bytesUploaded: number): void {
  file.status = 'completed';
  file.completedAt = new Date().toISOString();
  file.lastError = undefined;
  if (!file.documentId) {
    file.documentId = generatePlaceholderDocumentId(file);
  }
  file.size = bytesUploaded;
}

export function recordFileSkipped(file: UploadFile): void {
  file.status = 'skipped';
  file.completedAt = new Date().toISOString();
  file.lastError = undefined;
}

export function recordFileFailure(
  file: UploadFile,
  error: UploadError,
  retryable: boolean
): void {
  file.status = 'failed';
  file.completedAt = new Date().toISOString();
  file.lastError = {
    category: error.category,
    message: error.message,
    code: error.code,
    retryable,
    timestamp: new Date().toISOString(),
    details: error.details
  };
}

export function updateSessionStats(session: UploadSession): void {
  if (!session.stats) return;
  const completed = session.files.filter(f => f.status === 'completed').length;
  const failed = session.files.filter(f => f.status === 'failed').length;
  const skipped = session.files.filter(f => f.status === 'skipped').length;
  const bytesUploaded = session.files
    .filter(f => f.status === 'completed')
    .reduce((sum, file) => sum + (file.size || 0), 0);

  session.stats = {
    total: session.files.length,
    completed,
    failed,
    skipped,
    bytesUploaded
  };

  session.progress = session.files.length
    ? Math.round(((completed + skipped) / session.files.length) * 100)
    : 0;
}

type UploadErrorCategory = NonNullable<UploadFile['lastError']>['category'];

interface UploadError {
  category: UploadErrorCategory;
  message: string;
  code?: string | number;
  details?: Record<string, unknown> | string;
}

function generatePlaceholderDocumentId(file: UploadFile): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${file.path}:${file.size}:${file.startedAt ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return `temp_${hash}`;
}
