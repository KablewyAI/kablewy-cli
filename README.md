# Kablewy CLI

Command-line interface for Kablewy — upload documents, search your knowledge base, chat with context, call tools, and script repeatable AI workflows.

[![npm version](https://img.shields.io/npm/v/%40kablewy%2Fcli.svg)](https://www.npmjs.com/package/@kablewy/cli)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/KablewyAI/kablewy-cli/blob/main/LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

## Install

```bash
npm install -g @kablewy/cli
```

## 60-second quickstart

```bash
kablewy login                                       # sign in, store a scoped API key
kablewy docs upload ./documents/*.pdf               # upload documents
kablewy docs search "renewal terms"                 # search the knowledge base
kablewy chat --message "Summarize the renewal risk" # one-shot chat with context
```

Add `--json` to any automation-capable command when its output feeds another script:

```bash
kablewy status --json
kablewy docs list --json
kablewy chat --message "Return the top three open questions" --json
```

## Requirements & platform support

Node.js `>= 18`. macOS and Linux are supported; **Windows is not yet tested**.

## Authentication

`kablewy login` signs you in and stores a scoped API key for CLI use. The preferred path reuses an existing Kablewy desktop session; otherwise the CLI uses a browser magic-link loopback flow.

```bash
kablewy login
kablewy login --email you@example.com
kablewy login --ttl 12h --name "CI smoke key"
kablewy whoami                  # verifies the active credential with a real request
kablewy logout                  # clears local credentials, revokes the key when possible
```

API key inventory lives under `auth keys`:

```bash
kablewy auth keys list
kablewy auth keys revoke <keyId>
```

If your organization requires MFA, sign in through the Kablewy desktop or web app first, then rerun `kablewy login` so the CLI can reuse that authenticated session. Full in-CLI MFA entry is deferred in `0.1.0`.

Normal CLI commands use only scoped Kablewy API keys that start with `api_`. Browser, desktop, magic-link, and refresh tokens are used only during `kablewy login` and are rejected if passed through `--api-key`, `KABLEWY_API_KEY`, or `config --set apiKey=...`.

## Kablewy service

The public CLI connects to the Kablewy production service at `https://kablewy.ai`. Customers do not need to choose an environment. Run `kablewy login`, then use the commands normally.

## Configuration

Most users only need `kablewy login`. Use `config` to inspect local settings, validate required values, or set support-directed overrides.

```bash
kablewy config --show
kablewy config --init             # write the default config file
kablewy config --validate         # exits 2 when required fields are missing/invalid
kablewy config --get apiUrl
kablewy config --set orgId=<org-id>
```

Environment variables for CI or one-off shells: `KABLEWY_API_URL`, `KABLEWY_ORG_ID`, `KABLEWY_USER_ID`, `KABLEWY_API_KEY`. Set `KABLEWY_CONFIG_DIR` to read and write config in an isolated directory so automation never touches your personal CLI profile.

Global flags override config for a single invocation and are positional — place them before the subcommand:

```bash
kablewy --api-url https://kablewy.ai --org-id <org-id> --user-id <user-id> --api-key <api_-scoped-key> status --json
```

Human output and verbose diagnostics redact bearer tokens, refresh tokens, API keys, cookies, authorization headers, and related secret fields.

## Security boundary

The CLI is a Node.js program that runs on your machine with your user's filesystem and network permissions. It is not a sandbox and does not run inside Wasm. Treat file uploads, local config, shell history, external MCP headers, and any local MCP process you configure as part of your own trusted environment. Hosted skill and MCP execution runs on Kablewy's platform; the CLI only packages, configures, and invokes those platform surfaces.

## Status

Run `status` first when setting up a machine or debugging client access. It validates required configuration, backend reachability, credential validity, and tool discovery, and exits `0` when overall health is healthy or degraded and `1` when any check is unhealthy.

```bash
kablewy status
kablewy status --health
kablewy status --tools
kablewy status --json
```

## Documents

Document commands live under `docs` (top-level `upload` remains a compatibility alias). Supported extensions include PDF, Word, PowerPoint, Markdown, text, CSV, and Excel.

```bash
kablewy docs upload ./documents/*.pdf
kablewy docs upload ./documents ./notes/*.md --parse-mode balanced --concurrency 4
kablewy docs upload ./documents/*.pdf --dry-run
```

Upload sessions are persisted so interrupted uploads can be inspected or resumed. `--resume-from` re-queues pending and failed files, so it is the standard way to retry failures. `docs upload` exits `1` when any file fails (and `0` for success and `--dry-run`).

```bash
kablewy docs upload ./documents/*.pdf --session-id client-renewal-q2
kablewy docs upload ./documents/*.pdf --resume-from client-renewal-q2
kablewy docs status
```

`--skip-existing` computes each file's SHA-256 and skips files the backend already has (recorded as `skipped` in the session manifest). If the existence check itself fails, the CLI fails open and uploads the file.

List, search, inspect, and delete:

```bash
kablewy docs list --limit 50 --json
kablewy docs search "termination clause" --limit 5 --json
kablewy docs get <documentId>
kablewy docs status <documentId>
kablewy docs delete <documentId> --yes    # prompts without --yes
```

Container-routed ingestion is an enterprise/private deployment path. It only works when Kablewy has explicitly provisioned a dedicated document-processing worker endpoint and a processor token for that customer or deployment. Normal users should use `kablewy docs upload` without `--use-container`.

```bash
export KABLEWY_DOC_WORKER_URL=https://doc-worker.example.com
export KABLEWY_DOC_PROCESSOR_TOKEN=<doc-processor-token>
kablewy docs upload ./documents/*.pdf --use-container
```

`--use-container` requires both `KABLEWY_DOC_WORKER_URL` and `KABLEWY_DOC_PROCESSOR_TOKEN` (or the matching CLI flags). The CLI will not fall back to your normal scoped API key for this path.

## Chat

```bash
kablewy chat                                  # interactive session
kablewy chat --session renewal-review
kablewy chat --message "Summarize the uploaded renewal documents"   # one-shot
kablewy chat --message "Find contract risk and cite titles" --json
```

Useful options:

```bash
kablewy chat --message "Draft next steps" --model gpt-5.4
kablewy chat --message "Use the customer lookup tool" --tools '["customer_lookup"]'
kablewy chat --message "Use these tool definitions" --tools-json ./tools.json
kablewy chat --message "Stream the answer" --stream
```

## Tools

Tools expose the Kablewy MCP integrations available to the configured organization and user. Use `tools describe <toolName> --schema` before scripting a direct call.

```bash
kablewy tools list --search document
kablewy tools list --server kablewy --json
kablewy tools describe <toolName> --schema
kablewy tools call <toolName> --args '{"query":"renewal terms"}'
kablewy tools call <toolName> --interactive
kablewy tools test            # probes each server; exits 70 if any is unreachable
```

## MCP servers

`mcp` is the first-class surface for MCP servers: connect an externally hosted server, deploy a Kablewy-hosted catalog server, deploy a custom worker module, or manage hosted deployment lifecycle.

Connect a server you host elsewhere:

```bash
kablewy mcp test https://crm.example.com/mcp
kablewy mcp connect customer-crm \
  --url https://crm.example.com/mcp \
  --tool-prefix crm \
  --header 'Authorization=Bearer <remote-mcp-token>'
kablewy mcp list
kablewy mcp health customer-crm
kablewy mcp tools customer-crm
kablewy mcp show customer-crm
kablewy mcp disconnect customer-crm
kablewy mcp remove customer-crm --yes
```

Deploy a Kablewy-hosted catalog server:

```bash
kablewy mcp catalog list
kablewy mcp catalog show wheniwork
kablewy mcp catalog deploy wheniwork --credentials ./wheniwork-credentials.json
kablewy mcp deployment status <serverId>
kablewy mcp deployment upgrade <serverId>
kablewy mcp deployment stop <serverId> --yes
kablewy mcp deployment delete <serverId> --yes
```

Deploy a custom MCP worker module:

```bash
kablewy mcp deploy ./dist/worker.mjs \
  --name customer-crm \
  --description "Customer CRM lookup and renewal workflows" \
  --tool-prefix crm
```

The worker module must be a built ES module exporting a Worker `fetch` handler that implements MCP JSON-RPC methods such as `initialize`, `tools/list`, `tools/call`, and `ping`. OAuth catalog templates require browser OAuth setup in the Kablewy app in `0.1.0`; after setup, manage them from the CLI as usual.

## Quick Actions

Quick Actions are published, repeatable agent runs configured for an organization. They create a background chat, dispatch the agent task, and can emit `quick_action.completed` / `quick_action.failed` webhook events.

```bash
kablewy quick-actions list
kablewy quick-actions run renewal-review --input "Review Acme renewal"
kablewy quick-actions run "Renewal Review" --context ./context.json --wait
kablewy quick-actions status <taskId> --json
```

Use `--context` for structured JSON context (account IDs, CRM record IDs, run metadata). Long-running actions return a `taskId`; recheck with `quick-actions status`. Use `--callback-url` / `--callback-secret` only when the receiving system verifies signed task callbacks.

## Webhooks

Webhook commands manage outbound destinations and can manually trigger webhook-enabled Automation Jobs. Destinations receive signed Kablewy events (Quick Action, document, chat, MCP, tool, Automation Job, A2A).

```bash
kablewy webhooks list
kablewy webhooks create \
  --name CRM \
  --url https://hooks.example.com/kablewy \
  --event quick_action.completed \
  --event quick_action.failed
kablewy webhooks show <destinationId>
kablewy webhooks test <destinationId> --event quick_action.completed
kablewy webhooks deliveries <destinationId>
kablewy webhooks delete <destinationId> --yes
kablewy webhooks trigger <jobId> --payload ./event.json
```

Custom headers and auth config can be attached when the destination requires them:

```bash
kablewy webhooks create \
  --name "Customer Automation" \
  --url https://hooks.example.com/kablewy \
  --event automation_job.completed \
  --header 'X-Customer=acme' \
  --auth-type bearer \
  --auth 'token=<remote-webhook-token>'
```

The API returns a webhook signing secret on create. CLI output redacts secret fields, so configure HMAC verification through the Kablewy app or a controlled API workflow when the receiver needs the raw secret.

## Skills

`skills` is the canonical command group (`skill` is a compatibility alias).

```bash
kablewy skills list --json
kablewy skills show <skillId>
kablewy skills create <skillId> --name "Renewal Review"
kablewy skills upload <skillId> ./bundle.zip --version 0.1.0
kablewy skills execute <skillId> --runtime python --entry main.py
kablewy skills execute <skillId> --args '["customer-a"]' --json
kablewy skills versions <skillId>
kablewy skills delete <skillId> --force   # prompts without --force
```

## JSON and exit codes

Automation-capable commands support `--json` with a stable envelope:

```json
{ "success": true, "data": {} }
```

```json
{
  "success": false,
  "error": {
    "code": "AUTH_ERROR",
    "message": "Authentication failed",
    "requestId": "request-id-when-available"
  }
}
```

Exit codes are stable by category:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Unexpected failure |
| `2` | Usage or validation error |
| `65` | Authentication error |
| `66` | Not found |
| `70` | Network or backend error |
| `77` | Permission error |

Three diagnostics also reflect their findings in the exit code: `status` exits `1` when overall health is unhealthy, `config --validate` exits `2` when the configuration is invalid, and `tools test` exits `70` when any server fails its connectivity probe. `docs upload` exits `1` when any file in the batch fails, and `skills` subcommand failures map onto the table above (for example `404` exits `66` and network failures exit `70`).

## Scripting patterns

```bash
# Gate a batch job on healthy credentials (status exits nonzero when unhealthy)
kablewy status --json

# Upload, then search
kablewy docs upload ./client-docs/*.pdf --concurrency 3
kablewy docs search "open obligations" --limit 10 --json

# Run a published Quick Action and wait for the result
kablewy quick-actions run renewal-review \
  --input "Review Acme renewal" \
  --context ./acme-renewal-context.json \
  --wait --json

# Non-persistent overrides for CI
KABLEWY_API_KEY=<api_-scoped-key> \
KABLEWY_ORG_ID=<org-id> \
KABLEWY_USER_ID=<user-id> \
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-config \
kablewy docs list --json
```

## Public beta scope

`0.1.0` is a public beta for deterministic client workflows, not full web-app parity. The public command surface is: `login` / `logout` / `whoami`, `auth keys list|revoke`, `docs upload|list|search|get|delete|status` (with top-level `upload` alias), `chat`, `tools`, `mcp`, `quick-actions`, `webhooks`, `skills` (with `skill` alias), `config`, and `status`.

The first beta intentionally does not expose plugin management, graph exploration, workcells, image/video generation, queue/log inspection, full workflow-job authoring, or admin command groups. OAuth entry for MCP catalog templates remains app-led in `0.1.0`.

## Troubleshooting

**Authentication errors (exit `65`).** Your stored key is missing, expired, revoked, or not a scoped `api_` key. Re-run `kablewy login`, then verify with `kablewy whoami --json`. If login reports MFA is required, sign in through the Kablewy app first and rerun `kablewy login` to reuse that session.

**429 / rate limiting on bulk uploads.** `docs upload` retries rate-limited files automatically (default 3 attempts, configurable with `--retry` / `--retry-delay`), honors the server's `Retry-After` header (capped at 60 s), and adaptively backs off concurrency on repeated errors. For large batches, lower `--concurrency` and resume any remaining failures with `--resume-from <sessionId>`.

**CI isolation.** Set `KABLEWY_CONFIG_DIR` to a throwaway directory so CI jobs never read or write your real CLI config, and pass a scoped `api_` key via `KABLEWY_API_KEY` with `KABLEWY_ORG_ID` / `KABLEWY_USER_ID` environment variables.

**General checks.**

```bash
kablewy --help            # command discovery
kablewy config --show     # local configuration
kablewy config --validate # exits 2 when invalid
kablewy status --json     # connectivity + credentials
kablewy whoami --json     # active identity
```

If a backend or network command fails, rerun with `--json` and include `error.requestId` in the support request when present.

## Issues & feedback

Report bugs and feature requests at [github.com/KablewyAI/kablewy-cli/issues](https://github.com/KablewyAI/kablewy-cli/issues). See [CHANGELOG.md](https://github.com/KablewyAI/kablewy-cli/blob/main/CHANGELOG.md) for release history.

## Documentation

This README is the npm landing page. The GitHub wiki contains the expanded CLI guide, command workflows, troubleshooting, and release runbook. The wiki source lives in [`wiki/`](./wiki/) so documentation changes can be reviewed with code before being published to the GitHub wiki.

## License

[MIT](https://github.com/KablewyAI/kablewy-cli/blob/main/LICENSE)

---

### Maintainer release checklist

Do not publish from this checklist unless release approval is explicit.

```bash
npm run build
npm run test:ci
npm audit --omit=dev --json
npm pack --dry-run --json
npm run preflight:npm
```

Before release, also run an installed-tarball smoke test, scan the source and packed artifact for secrets, and complete an authenticated smoke against a test organization.
