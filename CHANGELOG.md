# Changelog

All notable changes to `@kablewy/cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] - 2026-06-26

### Added

- **Agent self-test** — Added `kablewy agent --self-test` for deterministic
  local filesystem/shell diagnostics. The check verifies local write, read,
  edit, search, list, read-only shell execution, and safety blocks for
  outside-root writes plus unsafe autonomous shell commands.

### Fixed

- **Agent shell safety** — Autonomous `Bash`/`fs_run_shell` now blocks
  unrecognized shell commands by default instead of treating them as read-only.
  Users can still run arbitrary local commands through the explicit `!` shell
  approval path.

## [0.1.9] - 2026-06-23

### Fixed

- **Agent local tool selection** — `kablewy agent` streamed requests now send
  local filesystem and shell tools with explicit automatic tool choice, so
  backend tool selection can expose them to the model instead of falling back
  to `search_tools` only.

## [0.1.8] - 2026-06-23

### Added

- **Update notice** — Interactive terminal commands now check npm at most once
  per day and print a short advisory notice when a newer `@kablewy/cli`
  version is available. The CLI never auto-updates itself.

### Changed

- Update notices are suppressed in CI, non-interactive output, JSON mode, and
  when `KABLEWY_DISABLE_UPDATE_CHECK=1` is set.

## [0.1.7] - 2026-06-23

### Fixed

- **Agent local tools** — `kablewy agent` now sends local filesystem/shell tool
  schemas to the backend and handles frontend-tool continuation events, so the
  agent can inspect project files instead of asking users to paste `ls` output.
- **Agent writes** — Added root-bound local write/edit tools for requested file
  changes, with exact replacement semantics for edits.
- **Agent aliases** — Added familiar local tool names for models that prefer
  standard terminal-agent vocabulary.
- **Safety** — Autonomous shell execution is restricted to read-only commands;
  mutating or dangerous shell commands still require the
  explicit `!` approval flow.

## [0.1.6] - 2026-06-23

### Fixed

- **Agent/chat streaming** — First-turn streamed requests now include a
  CLI-generated `chatId`, matching the backend streaming contract when no
  `--session` is supplied.
- **Agent TUI recovery** — Backend stream failures now render as recoverable
  transcript errors instead of crashing the terminal process.
- **Diagnostics** — Stream HTTP failures now include the backend error message
  and request id when available.
- **Package hygiene** — Local `.kablewy/` agent audit/session output is ignored
  so it cannot enter the public repo or npm tarball.

## [0.1.5] - 2026-06-23

### Added

- **Agent** — Added `kablewy agent`, a beta local terminal agent mode for
  Kablewy-powered project inspection, model-switched terminal sessions, local
  file attachments with `@ path`, and approval-gated shell commands.
- **Agent safety** — Added command risk classification, cwd boundary checks,
  shell timeouts, retained-output caps, redacted local JSONL audit logs, and
  explicit escape hatches for outside-cwd, dangerous-shell, and no-confirmation
  sessions.
- **Privacy-safe CLI telemetry** — Added Kablewy API request metadata for
  package version and command family only, with `KABLEWY_DISABLE_TELEMETRY=1`
  as an opt-out. Prompts, paths, shell commands, outputs, environment variables,
  and credentials are not sent as telemetry.

### Changed

- **TUI chat** — `/model <name>` now changes the model used for future TUI
  requests instead of only displaying a banner.

## [0.1.4] - 2026-06-16

### Changed

- **Login** — `kablewy login` now defaults to browser OAuth Authorization Code
  + PKCE, matching the Kablewy desktop sign-in model. The browser handles normal
  web login, SSO, and MFA, then returns a one-time code to the CLI loopback
  callback. The previous email magic-link loopback remains available with
  `--loopback` or `--email`.

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

- **Authentication** — `login` (desktop-session reuse or browser OAuth + PKCE,
  with legacy email loopback fallback), `logout` (clears local credentials, revokes the server-side key
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

[0.1.8]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.8
[0.1.7]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.7
[0.1.6]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.6
[0.1.5]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.5
[0.1.4]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.4
[0.1.3]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.3
[0.1.2]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.2
[0.1.1]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/KablewyAI/kablewy-cli/releases/tag/v0.1.0
