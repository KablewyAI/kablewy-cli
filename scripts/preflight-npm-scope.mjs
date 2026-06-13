#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const expectedName = '@kablewy/cli';

async function main() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.name !== expectedName) {
    throw new Error(`package.json name must be ${expectedName}, got ${pkg.name}`);
  }
  if (pkg.bin?.kablewy !== './dist/cli.js') {
    throw new Error('package.json must expose bin.kablewy = ./dist/cli.js');
  }

  const whoami = await run('npm', ['whoami']);
  console.log(`npm user: ${whoami.stdout.trim()}`);

  await run('npm', ['access', 'list', 'packages', '@kablewy', '--json']);
  console.log('npm scope visibility: @kablewy is reachable by the current npm user');

  const view = await runAllowNotFound('npm', ['view', expectedName, 'name', 'version', '--json']);
  if (view.notFound) {
    console.log(`npm package availability: ${expectedName} is not currently published`);
  } else {
    console.log(`npm package exists: ${view.stdout.trim()}`);
  }

  console.log('npm preflight: PASS');
}

async function run(command, args) {
  try {
    return await exec(command, args, { encoding: 'utf8' });
  } catch (error) {
    const message = `${command} ${args.join(' ')} failed: ${error.stderr || error.message}`;
    throw new Error(message.trim());
  }
}

async function runAllowNotFound(command, args) {
  try {
    const result = await exec(command, args, { encoding: 'utf8' });
    return { ...result, notFound: false };
  } catch (error) {
    const stderr = String(error.stderr || error.message || '');
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) {
      return { stdout: '', stderr, notFound: true };
    }
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`.trim());
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
