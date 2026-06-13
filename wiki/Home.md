# Kablewy CLI

`@kablewy/cli` is the public command-line interface for deterministic Kablewy client workflows: login, status checks, document upload/search/retrieval, chat, tools, MCP servers, Quick Actions, webhooks, skills, and safe scripting.

## Install

```bash
npm install -g @kablewy/cli
```

## Quick Workflow

```bash
kablewy login
kablewy docs upload ./documents/*.pdf
kablewy docs search "renewal terms"
kablewy chat --message "Summarize the renewal risk"
```

Use `--json` for automation:

```bash
kablewy status --json
kablewy docs list --json
kablewy chat --message "Return the top three risks" --json
```

## Public Beta Scope

The `0.1.x` public beta targets client-ready deterministic workflows, not full web-app parity. It intentionally excludes admin command groups, queue/log inspection, graph exploration, workcells, plugin management, and full workflow-job authoring.

## Core Commands

```text
login, logout, whoami
auth keys list|revoke
docs upload|list|search|get|delete|status
chat
tools
mcp
quick-actions
webhooks
skills
config
status
```
