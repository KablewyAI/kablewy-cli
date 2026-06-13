# Getting Started

## Requirements

- Node.js 18 or newer.
- macOS or Linux. Windows is not yet tested.
- A Kablewy account and organization access.

## Install

```bash
npm install -g @kablewy/cli
kablewy --version
kablewy --help
```

## Sign In

```bash
kablewy login
kablewy whoami
kablewy status
```

`kablewy login` stores a scoped API key for CLI use. The preferred path reuses an existing Kablewy desktop session. If no reusable session is available, the CLI uses a browser magic-link loopback flow.

If your organization requires MFA, sign in through the Kablewy web or desktop app first, then rerun `kablewy login` so the CLI can reuse the authenticated session. Full in-CLI MFA entry is not part of `0.1.x`.

After login, normal commands use only scoped Kablewy API keys that start with `api_`. Session, magic-link, and refresh tokens are not accepted as configured CLI credentials.

## First Document Workflow

```bash
kablewy docs upload ./documents/*.pdf
kablewy docs list --limit 10
kablewy docs search "termination clause" --limit 5
kablewy docs get <documentId>
```

Top-level `upload` remains as a compatibility alias for `docs upload`:

```bash
kablewy upload ./documents/*.pdf
```

## First Chat Workflow

```bash
kablewy chat
kablewy chat --message "Summarize the uploaded renewal documents"
kablewy chat --message "Find contract risk and cite titles" --json
```
