# Chat and Tools

## Chat

```bash
kablewy chat
kablewy chat --session renewal-review
kablewy chat --message "Summarize the uploaded renewal documents"
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

Tools expose the Kablewy MCP integrations available to the configured organization and user.

```bash
kablewy tools list --search document
kablewy tools list --server kablewy --json
kablewy tools describe <toolName> --schema
kablewy tools call <toolName> --args '{"query":"renewal terms"}'
kablewy tools call <toolName> --interactive
kablewy tools test
```

Run `tools describe <toolName> --schema` before scripting a direct call. `tools test` exits `70` if any configured server is unreachable.
