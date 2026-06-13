import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import os from 'os';

export type UploadLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface UploadLoggerOptions {
  filePath?: string;
  level?: UploadLogLevel;
  stdout?: boolean;
}

export interface UploadLogEntry {
  level: UploadLogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export class UploadLogger {
  private stream?: ReturnType<typeof createWriteStream>;
  private readonly levelPriority: Record<UploadLogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  };

  constructor(private readonly options: UploadLoggerOptions = {}) {
    if (options.filePath) {
      const resolved = resolve(options.filePath);
      const dir = dirname(resolved);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.stream = createWriteStream(resolved, { flags: 'a' });
    }
  }

  log(entry: UploadLogEntry): void {
    if (this.shouldSkip(entry.level)) {
      return;
    }
    const payload = JSON.stringify(entry);
    if (this.options.stdout) {
      // eslint-disable-next-line no-console
      console.log(payload);
    }
    if (this.stream) {
      this.stream.write(payload + os.EOL);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log({ level: 'info', message, timestamp: new Date().toISOString(), context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log({ level: 'warn', message, timestamp: new Date().toISOString(), context });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log({ level: 'error', message, timestamp: new Date().toISOString(), context });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log({ level: 'debug', message, timestamp: new Date().toISOString(), context });
  }

  close(): void {
    this.stream?.end();
  }

  private shouldSkip(level: UploadLogLevel): boolean {
    const configuredLevel = this.options.level || 'info';
    return this.levelPriority[level] > this.levelPriority[configuredLevel];
  }
}
