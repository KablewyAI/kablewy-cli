#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const publicCommands = [
  'login',
  'logout',
  'whoami',
  'auth',
  'docs',
  'upload',
  'chat',
  'agent',
  'config',
  'status',
  'tools',
  'mcp',
  'quick-actions',
  'webhooks',
  'skills',
  'skill'
];

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'kablewy-cli-tarball-smoke-'));
  const keep = process.env.KABLEWY_KEEP_SMOKE_TMP === '1';

  try {
    const packDir = join(tempRoot, 'pack');
    const installDir = join(tempRoot, 'install');
    const npmEnv = {
      npm_config_cache: join(tempRoot, 'npm-cache'),
      // `npm publish --dry-run` exports npm_config_dry_run=true to lifecycle
      // scripts. This smoke test needs its nested `npm pack` to create a real
      // local tarball so the clean install path is exercised.
      npm_config_dry_run: 'false',
      NPM_CONFIG_DRY_RUN: 'false'
    };
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });

    await run('npm', ['run', 'build'], { cwd: repoRoot, env: npmEnv });

    const packed = await run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: repoRoot, env: npmEnv });
    const packInfo = JSON.parse(packed.stdout);
    const tarball = join(packDir, packInfo[0].filename);

    await writeFile(join(installDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], {
      cwd: installDir,
      env: npmEnv,
      timeout: 120_000
    });

    const bin = join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'kablewy.cmd' : 'kablewy');
    await expectSuccess(bin, ['--help'], { contains: ['Public CLI for Kablewy client workflows', 'docs', 'chat'] });

    for (const command of publicCommands) {
      await expectSuccess(bin, [command, '--help'], { contains: [command] });
    }

    await expectFailure(bin, ['--env', 'staging', 'status'], {
      exitCodes: [1],
      contains: ['unknown option']
    });

    await expectSuccess(bin, ['skills', 'execute', '--help'], { contains: ['--env <json>'] });

    await expectSuccess(bin, ['agent', '--self-test', '--json'], {
      cwd: installDir,
      contains: ['"success": true', '"shell_pwd"', '"block_unknown_shell"']
    });

    const cleanConfigDir = join(tempRoot, 'clean-config');
    const noAuth = await expectFailure(bin, ['docs', 'list', '--json'], {
      exitCodes: [2],
      contains: ['Missing configuration: orgId, userId, apiKey'],
      env: {
        KABLEWY_CONFIG_DIR: cleanConfigDir,
        KABLEWY_API_URL: 'http://127.0.0.1:9'
      }
    });
    assertJsonError(noAuth.stdout, 'USAGE_ERROR');

    const badSession = await expectFailure(bin, ['docs', 'list', '--json'], {
      exitCodes: [65],
      contains: ['scoped Kablewy API key'],
      env: {
        KABLEWY_CONFIG_DIR: join(tempRoot, 'bad-token-config'),
        KABLEWY_API_URL: 'http://127.0.0.1:9',
        KABLEWY_ORG_ID: 'org-smoke',
        KABLEWY_USER_ID: 'user-smoke',
        KABLEWY_API_KEY: 'eyJhbGciOi.fake.jwt'
      }
    });
    assertJsonError(badSession.stdout, 'AUTH_ERROR');

    console.log(`tarball smoke: PASS (${packInfo[0].filename})`);
  } finally {
    if (keep) {
      console.log(`tarball smoke temp kept: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function expectSuccess(command, args, options = {}) {
  const result = await run(command, args, options);
  assertContains(result.stdout + result.stderr, options.contains || [], `${command} ${args.join(' ')}`);
  return result;
}

async function expectFailure(command, args, options = {}) {
  try {
    const result = await run(command, args, options);
    throw new Error(`${command} ${args.join(' ')} unexpectedly exited 0:\n${result.stdout}${result.stderr}`);
  } catch (error) {
    if (error.expectedFailure) return error.result;
    throw error;
  }
}

async function run(command, args, options = {}) {
  const env = {
    ...process.env,
    ...(options.env || {}),
    NO_COLOR: '1',
    FORCE_COLOR: '0'
  };

  try {
    return await exec(command, args, {
      cwd: options.cwd || repoRoot,
      encoding: 'utf8',
      timeout: options.timeout || 30_000,
      env
    });
  } catch (error) {
    const exitCodes = options.exitCodes || [];
    if (exitCodes.includes(error.code)) {
      const result = { stdout: error.stdout || '', stderr: error.stderr || '' };
      assertContains(result.stdout + result.stderr, options.contains || [], `${command} ${args.join(' ')}`);
      const expected = new Error('expected failure');
      expected.expectedFailure = true;
      expected.result = result;
      throw expected;
    }
    throw new Error(`${command} ${args.join(' ')} failed (${error.code ?? 'unknown'}):\n${error.stdout || ''}${error.stderr || error.message}`);
  }
}

function assertContains(text, needles, label) {
  for (const needle of needles) {
    if (!text.includes(needle)) {
      throw new Error(`${label} did not include expected text ${JSON.stringify(needle)}:\n${text}`);
    }
  }
}

function assertJsonError(stdout, expectedCode) {
  const parsed = JSON.parse(stdout);
  if (parsed?.success !== false || parsed?.error?.code !== expectedCode) {
    throw new Error(`Expected JSON error ${expectedCode}, got:\n${stdout}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
