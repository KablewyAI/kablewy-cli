import { describe, it, expect } from 'vitest';
import { classifyError } from '../../src/utils/upload-error.js';

describe('classifyError', () => {
  describe('HTTP 429 (rate limit)', () => {
    it('classifies 429 as retryable', () => {
      const classified = classifyError({ statusCode: 429, message: 'Too Many Requests' });

      expect(classified.retryable).toBe(true);
      expect(classified.code).toBe(429);
    });

    it('parses Retry-After seconds into retryAfterMs', () => {
      const classified = classifyError({ statusCode: 429, retryAfter: '2' });

      expect(classified.retryAfterMs).toBe(2000);
    });

    it('caps Retry-After at 60 seconds', () => {
      const classified = classifyError({ statusCode: 429, retryAfter: '120' });

      expect(classified.retryAfterMs).toBe(60_000);
    });

    it('ignores a missing or unparseable Retry-After', () => {
      expect(classifyError({ statusCode: 429 }).retryAfterMs).toBeUndefined();
      expect(classifyError({ statusCode: 429, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }).retryAfterMs).toBeUndefined();
      expect(classifyError({ statusCode: 429, retryAfter: '-5' }).retryAfterMs).toBeUndefined();
    });
  });

  describe('network/timeout errors', () => {
    it.each([
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'ETIMEDOUT',
      'ECONNRESET'
    ])('classifies %s as a retryable NETWORK error', (code) => {
      const error = Object.assign(new Error('boom'), { code });

      const classified = classifyError(error);

      expect(classified.category).toBe('NETWORK');
      expect(classified.retryable).toBe(true);
      expect(classified.code).toBe(code);
    });

    it('keeps plain errors as retryable UNKNOWN', () => {
      const classified = classifyError(new Error('boom'));

      expect(classified.category).toBe('UNKNOWN');
      expect(classified.retryable).toBe(true);
    });
  });

  describe('existing HTTP classifications', () => {
    it('keeps 401 non-retryable', () => {
      const classified = classifyError({ statusCode: 401 });

      expect(classified.category).toBe('AUTHENTICATION');
      expect(classified.retryable).toBe(false);
    });

    it('keeps 500 retryable', () => {
      const classified = classifyError({ statusCode: 500 });

      expect(classified.category).toBe('SERVER');
      expect(classified.retryable).toBe(true);
    });
  });
});
