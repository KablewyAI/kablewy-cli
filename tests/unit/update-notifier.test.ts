import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandRequestedJson,
  compareSemver,
  maybeShowUpdateNotice,
  shouldCheckForUpdates
} from '../../src/core/update-notifier.js';

describe('update notifier', () => {
  let originalCi: string | undefined;
  let originalDisable: string | undefined;

  beforeEach(() => {
    originalCi = process.env.CI;
    originalDisable = process.env.KABLEWY_DISABLE_UPDATE_CHECK;
    delete process.env.CI;
    delete process.env.KABLEWY_DISABLE_UPDATE_CHECK;
  });

  afterEach(() => {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalDisable === undefined) delete process.env.KABLEWY_DISABLE_UPDATE_CHECK;
    else process.env.KABLEWY_DISABLE_UPDATE_CHECK = originalDisable;
    vi.restoreAllMocks();
  });

  it('prints a non-blocking update notice when a newer version exists', async () => {
    const config = memoryConfig('');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: '0.1.8' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await maybeShowUpdateNotice(config, {
      now: new Date('2026-06-23T12:00:00Z'),
      currentVersion: '0.1.7',
      fetchImpl: fetchImpl as any,
      stdoutIsTTY: true
    });

    expect(config.value).toBe('2026-06-23T12:00:00.000Z');
    expect(errorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('Update available: @kablewy/cli 0.1.7 -> 0.1.8');
    expect(errorSpy.mock.calls.map(call => call.join(' ')).join('\n')).toContain('npm install -g @kablewy/cli@latest');
  });

  it('stays silent when current version is up to date', async () => {
    const config = memoryConfig('');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: '0.1.7' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await maybeShowUpdateNotice(config, {
      currentVersion: '0.1.7',
      fetchImpl: fetchImpl as any,
      stdoutIsTTY: true
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips checks in JSON, CI, disabled, non-TTY, and fresh-rate-limit contexts', () => {
    const now = new Date('2026-06-23T12:00:00Z');
    const fresh = memoryConfig('2026-06-23T01:00:00.000Z');

    expect(shouldCheckForUpdates(fresh, { now, stdoutIsTTY: true })).toBe(false);
    expect(shouldCheckForUpdates(memoryConfig(''), { command: commandWithOpts({ json: true }), now, stdoutIsTTY: true })).toBe(false);
    expect(shouldCheckForUpdates(memoryConfig(''), { now, stdoutIsTTY: false })).toBe(false);

    process.env.CI = 'true';
    expect(shouldCheckForUpdates(memoryConfig(''), { now, stdoutIsTTY: true })).toBe(false);

    delete process.env.CI;
    process.env.KABLEWY_DISABLE_UPDATE_CHECK = '1';
    expect(shouldCheckForUpdates(memoryConfig(''), { now, stdoutIsTTY: true })).toBe(false);
  });

  it('checks again after the 24 hour interval', () => {
    const config = memoryConfig('2026-06-22T11:59:59.000Z');

    expect(shouldCheckForUpdates(config, {
      now: new Date('2026-06-23T12:00:00Z'),
      stdoutIsTTY: true
    })).toBe(true);
  });

  it('detects JSON options on parent commands', () => {
    expect(commandRequestedJson(commandWithOpts({}, commandWithOpts({ json: true })))).toBe(true);
    expect(commandRequestedJson(commandWithOpts({ json: false }))).toBe(false);
  });

  it('compares semver versions', () => {
    expect(compareSemver('0.1.8', '0.1.7')).toBe(1);
    expect(compareSemver('0.2.0', '0.1.99')).toBe(1);
    expect(compareSemver('0.1.7', '0.1.7')).toBe(0);
    expect(compareSemver('0.1.6', '0.1.7')).toBe(-1);
  });
});

function memoryConfig(initial: string) {
  return {
    value: initial,
    get: vi.fn(() => initial),
    set: vi.fn(function (this: { value: string }, _key: string, value: string) {
      this.value = value;
    })
  };
}

function commandWithOpts(opts: Record<string, unknown>, parent?: any) {
  return {
    opts: () => opts,
    parent
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body
  } as Response;
}
