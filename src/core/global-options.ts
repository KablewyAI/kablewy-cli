import chalk from 'chalk';
import { Command } from 'commander';

export interface GlobalCliOptions {
  verbose?: boolean;
  /** commander negated option: `--no-color` sets this to false */
  color?: boolean;
  apiUrl?: string;
  orgId?: string;
  userId?: string;
  apiKey?: string;
}

interface RuntimeConfig {
  setRuntime(key: 'apiUrl' | 'orgId' | 'userId' | 'apiKey', value: string): void;
}

export function addGlobalOptions(program: Command): Command {
  return program
    .option('-v, --verbose', 'Enable verbose output')
    .option('--no-color', 'Disable colored output')
    .option('--api-url <url>', 'Override API URL')
    .option('--org-id <id>', 'Override organization ID')
    .option('--user-id <id>', 'Override user ID')
    .option('--api-key <key>', 'Override API key');
}

export function applyGlobalOptions(opts: GlobalCliOptions, config: RuntimeConfig): void {
  if (opts.verbose) {
    process.env.KABLEWY_VERBOSE = 'true';
  }

  if (opts.color === false) {
    chalk.level = 0;
    process.env.FORCE_COLOR = '0';
  }

  if (opts.apiUrl) {
    config.setRuntime('apiUrl', opts.apiUrl);
  }
  if (opts.orgId) {
    config.setRuntime('orgId', opts.orgId);
  }
  if (opts.userId) {
    config.setRuntime('userId', opts.userId);
  }
  if (opts.apiKey) {
    config.setRuntime('apiKey', opts.apiKey);
  }
}
