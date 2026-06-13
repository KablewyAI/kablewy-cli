# Troubleshooting

## Authentication Errors

Authentication failures exit `65`. Re-run:

```bash
kablewy login
kablewy whoami --json
kablewy status --json
```

If login reports MFA is required, sign in through the Kablewy app first and rerun `kablewy login`.

If the error says the API key must start with `api_`, a browser session, desktop session, magic-link token, or refresh token was supplied where a scoped CLI key belongs. Run `kablewy login` and use the stored key, or pass a scoped `api_` key through CI secrets.

## Upload Rate Limits

`docs upload` retries rate-limited files automatically, honors `Retry-After`, and backs off concurrency on repeated errors.

For large batches:

```bash
kablewy docs upload ./documents/*.pdf --concurrency 3
kablewy docs upload ./documents/*.pdf --resume-from <sessionId>
```

## Configuration Checks

```bash
kablewy --help
kablewy config --show
kablewy config --validate
kablewy status --json
kablewy whoami --json
```

If a backend or network command fails, rerun with `--json` and include `error.requestId` in the support request when present.
