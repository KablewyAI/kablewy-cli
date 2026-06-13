import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { applyGlobalOptions } from '../../src/core/global-options.js';

describe('applyGlobalOptions', () => {
  let setRuntime: ReturnType<typeof vi.fn>;
  let originalChalkLevel: typeof chalk.level;
  let originalForceColor: string | undefined;
  let originalVerbose: string | undefined;

  beforeEach(() => {
    setRuntime = vi.fn();
    originalChalkLevel = chalk.level;
    originalForceColor = process.env.FORCE_COLOR;
    originalVerbose = process.env.KABLEWY_VERBOSE;
  });

  afterEach(() => {
    chalk.level = originalChalkLevel;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
    if (originalVerbose === undefined) delete process.env.KABLEWY_VERBOSE;
    else process.env.KABLEWY_VERBOSE = originalVerbose;
  });

  const makeConfig = () => ({
    setRuntime
  });

  it('disables chalk and sets FORCE_COLOR=0 when --no-color is passed', () => {
    applyGlobalOptions({ color: false }, makeConfig());

    expect(chalk.level).toBe(0);
    expect(process.env.FORCE_COLOR).toBe('0');
  });

  it('leaves color settings alone when color is enabled by default', () => {
    delete process.env.FORCE_COLOR;

    applyGlobalOptions({ color: true }, makeConfig());

    expect(chalk.level).toBe(originalChalkLevel);
    expect(process.env.FORCE_COLOR).toBeUndefined();
  });

  it('sets KABLEWY_VERBOSE on --verbose', () => {
    delete process.env.KABLEWY_VERBOSE;

    applyGlobalOptions({ verbose: true }, makeConfig());

    expect(process.env.KABLEWY_VERBOSE).toBe('true');
  });

  it('forwards explicit runtime overrides to config without changing environments', () => {
    applyGlobalOptions({
      apiUrl: 'https://example.com',
      orgId: 'org-1',
      userId: 'user-1',
      apiKey: 'api_key_1'
    }, makeConfig());

    expect(setRuntime).toHaveBeenCalledWith('apiUrl', 'https://example.com');
    expect(setRuntime).toHaveBeenCalledWith('orgId', 'org-1');
    expect(setRuntime).toHaveBeenCalledWith('userId', 'user-1');
    expect(setRuntime).toHaveBeenCalledWith('apiKey', 'api_key_1');
  });

  it('rejects non-scoped API key overrides', () => {
    expect(() => applyGlobalOptions({ apiKey: 'eyJhbGciOi.fake.jwt' }, makeConfig())).toThrow(/starting with "api_"/);

    expect(setRuntime).not.toHaveBeenCalled();
  });

  it('does not touch runtime config when no override flags are provided', () => {
    applyGlobalOptions({}, makeConfig());

    expect(setRuntime).not.toHaveBeenCalled();
  });
});
