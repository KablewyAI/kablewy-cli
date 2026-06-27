# Agent

`kablewy agent` starts the beta local terminal agent mode. It can inspect a project, read/search local files, write or edit files under the agent root, run safe read-only shell checks, use Kablewy context, and switch models from the terminal.

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

## Shell Boundary

Autonomous shell execution is restricted to recognized read-only inspection commands such as `pwd`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `git status`, `git diff`, `git log`, `git show`, `npm test`, and `npm run test`.

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
