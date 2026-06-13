# MCP Servers

The `mcp` command is the CLI surface for MCP servers.

## Connect an External Server

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

## Deploy a Hosted Catalog Server

```bash
kablewy mcp catalog list
kablewy mcp catalog show wheniwork
kablewy mcp catalog deploy wheniwork --credentials ./wheniwork-credentials.json
kablewy mcp deployment status <serverId>
kablewy mcp deployment upgrade <serverId>
kablewy mcp deployment stop <serverId> --yes
kablewy mcp deployment delete <serverId> --yes
```

## Deploy a Custom MCP Worker

```bash
kablewy mcp deploy ./dist/worker.mjs \
  --name customer-crm \
  --description "Customer CRM lookup and renewal workflows" \
  --tool-prefix crm
```

The worker module must be a built ES module exporting a Worker `fetch` handler that implements MCP JSON-RPC methods such as `initialize`, `tools/list`, `tools/call`, and `ping`.

OAuth setup for catalog templates is app-led in `0.1.x`; after setup, manage deployments from the CLI.
