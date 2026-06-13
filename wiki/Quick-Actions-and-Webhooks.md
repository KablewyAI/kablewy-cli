# Quick Actions and Webhooks

## Quick Actions

Quick Actions are published, repeatable agent runs configured for an organization.

```bash
kablewy quick-actions list
kablewy quick-actions run renewal-review --input "Review Acme renewal"
kablewy quick-actions run "Renewal Review" --context ./context.json --wait
kablewy quick-actions status <taskId> --json
```

Use `--context` for structured JSON context such as account IDs, CRM record IDs, or run metadata. Long-running actions return a `taskId`; recheck with `quick-actions status`.

## Webhooks

Webhook commands manage outbound destinations and can manually trigger webhook-enabled Automation Jobs.

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

CLI output redacts secret fields. Configure HMAC verification through the Kablewy app or a controlled API workflow when the receiver needs the raw signing secret.
