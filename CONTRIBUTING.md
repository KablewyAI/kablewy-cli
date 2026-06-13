# Contributing

This repository contains the public Kablewy CLI package.

## Development

```bash
npm ci
npm run build
npm run test:ci
node dist/cli.js --help
```

Use Node.js 18 or newer. CI tests Node.js 18, 20, and 24.

## Release Checks

Run these before proposing a release:

```bash
npm run build
npm run test:ci
npm audit --omit=dev --json
npm pack --dry-run --json
npm run preflight:npm
```

Do not publish without explicit release approval.

## Documentation

The npm README is the package landing page. The `wiki/` directory is the source for the GitHub wiki. Keep command examples aligned with `kablewy --help` and the public CLI guide before release.
