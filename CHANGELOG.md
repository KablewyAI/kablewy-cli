# Changelog

All notable changes to `@kablewy/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-06-16

### Fixed

- **Install hygiene** — Updated the direct React runtime dependency to satisfy
  Ink's peer dependency chain, removing the remaining `ERESOLVE overriding peer
  dependency` warning during fresh global installs.

## [0.1.2] - 2026-06-16

### Fixed

- **Install hygiene** — Updated the direct `glob` dependency to a
  non-deprecated release so fresh `npm install -g @kablewy/cli` runs without
  the `glob@10.5.0` deprecation warning.

## [0.1.1] - 2026-06-16

### Fixed

- **Login** — `kablewy login` now accepts the backend's privacy-preserving
  generic magic-link response and waits for the emailed desktop callback to
  provide the organization ID. This fixes first-run CLI login for valid users
  whose org ID is intentionally not returned from the initial magic-link
  request.

## [0.1.0] - TBD

First public beta. Focused on deterministic client workflows, not full
web-app parity.

### Added

- **Authentication** — `login` (desktop-session reuse or browser magic-link
  loopback), `logout` (clears local credentials, revokes the server-side key
  when possible), `whoami`, and `auth keys list|revoke` for API key inventory.
- **Documents** — `docs upload|list|search|get|delete|status` with glob
  support, concurrency control, parse modes, `--dry-run`, `--skip-existing`
  (SHA-256 dedupe), and resumable upload sessions (`--session-id`,
  `--resume-from`). Top-level `upload` retained as a compatibility alias.
  Optional container-routed ingestion via `--use-container`.
- **Chat** — interactive sessions and one-shot `chat --message`, with
  `--model`, `--tools`, `--tools-json`, `--stream`, and `--session`.
- **Tools** — `tools list|describe|call|test` over the organization's MCP
  integrations, including `--schema` inspection and an exit-code-gated
  connectivity probe.
- **MCP servers** — `mcp test|connect|list|health|tools|show|disconnect|remove`
  for externally hosted servers, `mcp catalog list|show|deploy` plus
  `mcp deployment status|upgrade|stop|delete` for Kablewy-hosted catalog
  servers, and `mcp deploy` for custom worker modules.
- **Quick Actions** — `quick-actions list|run|status` with `--input`,
  `--context`, `--wait`, and optional signed task callbacks.
- **Webhooks** — `webhooks list|create|show|test|deliveries|delete` for
  outbound destinations (custom headers and auth config supported) and
  `webhooks trigger` for webhook-enabled Automation Jobs.
- **Skills** — `skills list|show|create|upload|execute|versions|delete`, with
  `skill` retained as a compatibility alias.
- **Config & status** — `config --show|--init|--validate|--get|--set`,
  environment-variable overrides, `KABLEWY_CONFIG_DIR` isolation for CI, and
  a `status` command that checks configuration, reachability, credentials,
  and tool discovery.
- **Scripting contract** — `--json` envelope (`{ success, data }` /
  `{ success, error: { code, message, requestId } }`) and stable exit codes:
  `0` success, `1` unexpected failure, `2` usage/validation, `65` auth,
  `66` not found, `70` network/backend, `77` permission.
- **Secret redaction** — bearer tokens, refresh tokens, API keys, cookies,
  and authorization headers are redacted in human output and diagnostics.

[0.1.3]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.3
[0.1.2]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.2
[0.1.1]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.0
