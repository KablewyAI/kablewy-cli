import { beforeAll, afterAll } from 'vitest';

// Global test setup
beforeAll(() => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.KABLEWY_VERBOSE = 'false';
  process.env.KABLEWY_QUIET = 'false';
});

// Global test teardown
afterAll(() => {
  // Clean up any global resources
  process.env.NODE_ENV = 'development';
  delete process.env.KABLEWY_VERBOSE;
  delete process.env.KABLEWY_QUIET;
});