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

The CLI stores scoped API keys in the user's local config profile. Use `kablewy logout` to clear local credentials and revoke the active key when possible. Use `KABLEWY_CONFIG_DIR` for CI and smoke tests so automation never reads or writes a developer's real profile.
