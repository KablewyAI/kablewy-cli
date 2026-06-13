import { createRequire } from 'node:module';

/**
 * Single source of truth for the CLI version: package.json.
 *
 * Resolved at runtime with createRequire so the path works identically from
 * the compiled location (dist/core/version.js -> ../../package.json) and the
 * source location (src/core/version.ts -> ../../package.json). package.json
 * is always present in the published tarball, so this never dangles.
 */
const require = createRequire(import.meta.url);

const pkg = require('../../package.json') as { version: string };

export const CLI_VERSION: string = pkg.version;
