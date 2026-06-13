import { UploadErrorCategory } from '../types/index.js';

export interface ClassifiedError {
  category: UploadErrorCategory;
  message: string;
  code?: string | number;
  retryable: boolean;
  details?: Record<string, unknown> | string;
  /** Server-requested retry delay (parsed from Retry-After, capped at 60s). */
  retryAfterMs?: number;
}

/** undici timeout/connection codes plus common Node socket errors. */
const NETWORK_ERROR_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE'
]);

export function classifyError(error: unknown): ClassifiedError {
  if (isHttpError(error)) {
    return classifyHttpError(error);
  }

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
      return {
        category: 'NETWORK',
        message: error.message,
        code,
        retryable: true
      };
    }
    return {
      category: 'UNKNOWN',
      message: error.message,
      retryable: true
    };
  }

  return {
    category: 'UNKNOWN',
    message: typeof error === 'string' ? error : 'Unknown error',
    retryable: true
  };
}

interface HttpErrorLike {
  statusCode: number;
  body?: string;
  message?: string;
  error?: string;
  details?: unknown;
  retryAfter?: string;
}

function isHttpError(error: unknown): error is HttpErrorLike {
  return Boolean(error && typeof (error as HttpErrorLike).statusCode === 'number');
}

function classifyHttpError(error: HttpErrorLike): ClassifiedError {
  const { statusCode } = error;
  const message = error.message || `HTTP ${statusCode}`;
  let details: string | Record<string, unknown> | undefined;
  const raw = error.details ?? error.body ?? error.error;
  if (typeof raw === 'string') details = raw;
  else if (raw && typeof raw === 'object') details = raw as Record<string, unknown>;
  else details = undefined;
  if (statusCode === 401) {
    return { category: 'AUTHENTICATION', message, code: statusCode, retryable: false, details };
  }
  if (statusCode === 403) {
    return { category: 'AUTHORIZATION', message, code: statusCode, retryable: false, details };
  }
  if (statusCode === 429) {
    return {
      category: 'SERVER',
      message,
      code: statusCode,
      retryable: true,
      details,
      retryAfterMs: parseRetryAfterMs(error.retryAfter)
    };
  }
  if (statusCode >= 500) {
    return { category: 'SERVER', message, code: statusCode, retryable: true, details };
  }
  if (statusCode === 400 || statusCode === 422) {
    return { category: 'VALIDATION', message, code: statusCode, retryable: false, details };
  }
  if (statusCode === 404) {
    return { category: 'CLIENT', message, code: statusCode, retryable: false, details };
  }
  return { category: 'UNKNOWN', message, code: statusCode, retryable: true, details };
}

/** Parse a Retry-After header value in seconds; cap at 60s. */
function parseRetryAfterMs(retryAfter: string | undefined): number | undefined {
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, 60) * 1000;
}
