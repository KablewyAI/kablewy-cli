# Release Runbook

Do not publish without explicit release approval.

## Local Gates

```bash
npm run build
npm run test:ci
npm audit --omit=dev --json
npm pack --dry-run --json
npm run smoke:tarball
npm run preflight:npm
```

## Tarball Smoke

```bash
npm run smoke:tarball
```

The smoke script builds, packs, installs the generated tarball into a clean temp project, verifies help for the public command surface, confirms there is no global internal environment selector, and confirms a session-shaped token is rejected before network.

## Authenticated Smoke

Use a throwaway config directory so release checks never read or write a developer's personal CLI profile:

```bash
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy login
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy status --json
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy docs list --json
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-release-smoke kablewy tools list --json
```

Before publishing a public install, verify backend upload hardening is live in production.
