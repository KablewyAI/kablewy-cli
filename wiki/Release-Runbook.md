# Release Runbook

Do not publish without explicit release approval.

## Local Gates

```bash
npm run build
npm run test:ci
npm audit --omit=dev --json
npm pack --dry-run --json
npm run preflight:npm
```

## Tarball Smoke

```bash
npm pack
mkdir -p /tmp/kablewy-cli-smoke
cd /tmp/kablewy-cli-smoke
npm init -y
npm install /path/to/kablewy-cli-0.1.0.tgz
./node_modules/.bin/kablewy --help
./node_modules/.bin/kablewy --version
./node_modules/.bin/kablewy docs --help
./node_modules/.bin/kablewy mcp --help
```

## Authenticated Smoke

Use a throwaway config directory so release checks never read or write a developer's personal CLI profile:

```bash
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy login
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy status --json
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy docs list --json
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy tools list --json
```

Before publishing a public install, verify backend upload hardening is live in production.
