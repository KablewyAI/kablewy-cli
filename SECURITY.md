# Security

## Supported Versions

The public beta supports the latest published `0.1.x` release of `@kablewy/cli`.

## Reporting a Vulnerability

Please do not open public issues for suspected vulnerabilities. Email security reports to `security@kablewy.com` with:

- A concise description of the issue.
- Steps to reproduce.
- Affected command(s), version, and operating system.
- Any request IDs or non-sensitive logs that help us trace the behavior.

Do not include API keys, bearer tokens, refresh tokens, cookies, or customer data in the report. The CLI redacts secret-like fields in normal output, but logs and shell histories can still contain user-provided values.

## Credential Handling

The CLI stores scoped API keys in the user's local config profile. Steady-state CLI credentials must start with `api_`; browser, desktop, magic-link, and refresh tokens are used only during `kablewy login` and are rejected as configured API keys. Use `kablewy logout` to clear local credentials and revoke the active key when possible. Use `KABLEWY_CONFIG_DIR` for CI and smoke tests so automation never reads or writes a developer's real profile.

## Runtime Boundary

The CLI is a Node.js process running with the invoking user's local filesystem and network permissions. It is not a sandbox and does not run inside Wasm. Hosted skill and MCP execution is a platform responsibility; any local MCP process a user deliberately configures runs in that user's own environment.
