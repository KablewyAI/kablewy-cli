import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  cliTelemetryHeaders,
  commandPathForTelemetry,
  isCliTelemetryDisabled,
  sanitizeTelemetryCommand
} from '../../src/core/telemetry.js';

describe('CLI telemetry metadata', () => {
  const originalDisable = process.env.KABLEWY_DISABLE_TELEMETRY;

  afterEach(() => {
    if (originalDisable === undefined) delete process.env.KABLEWY_DISABLE_TELEMETRY;
    else process.env.KABLEWY_DISABLE_TELEMETRY = originalDisable;
    vi.unstubAllGlobals();
  });

  it('sanitizes command names to a short command-family token', () => {
    expect(sanitizeTelemetryCommand('kablewy docs upload --path /Users/someone/secrets')).toBe('docs.upload');
    expect(sanitizeTelemetryCommand(' quick-actions:run ')).toBe('quick-actions:run');
    expect(sanitizeTelemetryCommand('')).toBeUndefined();
  });

  it('derives command paths from commander hierarchy without arguments', () => {
    const program = new Command('kablewy');
    const docs = new Command('docs');
    const upload = new Command('upload');
    docs.addCommand(upload);
    program.addCommand(docs);

    expect(commandPathForTelemetry(upload)).toBe('docs.upload');
  });

  it('emits only client/version/command headers by default', () => {
    delete process.env.KABLEWY_DISABLE_TELEMETRY;

    expect(cliTelemetryHeaders('agent')).toMatchObject({
      'User-Agent': expect.stringContaining('@kablewy/cli/'),
      'X-Kablewy-Client': 'cli',
      'X-Kablewy-CLI-Version': expect.any(String),
      'X-Kablewy-CLI-Command': 'agent'
    });
    expect(cliTelemetryHeaders('agent')['User-Agent']).toContain('(command=agent)');
  });

  it('can be disabled with KABLEWY_DISABLE_TELEMETRY', () => {
    process.env.KABLEWY_DISABLE_TELEMETRY = 'true';

    expect(isCliTelemetryDisabled()).toBe(true);
    expect(cliTelemetryHeaders('docs.upload')).toEqual({});
  });
});
