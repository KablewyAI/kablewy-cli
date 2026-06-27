# Agent

`kablewy agent` starts the beta local terminal agent mode. It can inspect a project, recursively inventory directories, read/search local files, write or edit files under the agent root, run safe read-only shell checks, use Kablewy context, and switch models from the terminal.

```bash
kablewy agent
kablewy agent --model gpt-5.4
kablewy agent --cwd ~/projects/acme-renewal
```

## Local Tool Self-Test

Before a client session, run:

```bash
kablewy agent --self-test
```

For automation:

```bash
kablewy agent --self-test --json
```

The self-test verifies that the CLI can write, read, edit, search, list files, run read-only shell checks, and block outside-root writes plus unsafe autonomous shell commands. It cleans up its temporary test directory after the check.

## Agent Root

The agent root defaults to the directory where you start the CLI. Set it explicitly when needed:

```bash
kablewy agent --cwd ./project
```

Local file tools are constrained to the agent root by default. Use `--allow-outside-cwd` only for trusted local sessions where the agent needs files outside that root.

Every agent turn includes a compact local workspace snapshot: cwd, platform, git root when available, top-level entries, key project files, and lightweight package metadata. This keeps common local tasks reliable even when the remote model does not choose a tool on its own.

For direct local requests such as `pwd`, checking a named subdirectory, reading a named file, recursively inventorying a project, or writing a test file and reading it back, the CLI can also run a targeted local operation first and pass the result into the model turn. Common read-only shell requests such as `pwd`, `ls`/`dir`, and `cat`/`type` are handled portably by the CLI when possible, so basic inspection works across macOS, Linux, and Windows.

Large listings are intentionally capped. A truncated listing proves returned entries exist, but it does not prove omitted paths are absent. Follow-up questions about a path, such as `what is in src?` after a truncated root listing, run a fresh targeted local check.

## Shell Boundary

Autonomous shell execution is restricted to recognized read-only inspection commands such as `pwd`, `ls`, `dir`, `cat`, `type`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `git status`, `git diff`, `git log`, `git show`, `npm test`, and `npm run test`.

Mutating, dangerous, or unrecognized shell commands are not run as autonomous tools. The agent should propose them through the explicit `!` shell approval path instead.

Inside the agent:

```text
! npm test                  propose a local shell command; approval is required
@ src/index.ts              attach a local file to the next message
/model gpt-5.4              switch the model for future turns
/help                       show agent controls
```

## Safety Options

```bash
kablewy agent --shell-timeout-ms 120000
kablewy agent --max-output-bytes 262144
kablewy agent --audit-log .kablewy/session.jsonl
kablewy agent --no-audit-log
kablewy agent --allow-outside-cwd
kablewy agent --allow-dangerous-shell
kablewy agent --allow-shell-without-confirmation
```

The CLI is not a sandbox or Wasm runtime. Approved local shell commands run with the local user's normal permissions. Hosted skills and MCP execution run on Kablewy's platform; local agent tools run on the user's machine.

Local workspace snapshots and local tool results are not passive telemetry, but they are sent as model context. Each agent turn includes the compact workspace snapshot. If you ask the agent to read a file or inspect command output, that local result is also included in the model turn.
