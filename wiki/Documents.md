# Documents

Document commands live under `docs`.

```bash
kablewy docs upload ./documents/*.pdf
kablewy docs list --limit 50
kablewy docs search "renewal terms"
kablewy docs get <documentId>
kablewy docs status <documentId>
kablewy docs delete <documentId> --yes
```

## Uploads

```bash
kablewy docs upload ./documents ./notes/*.md --parse-mode balanced --concurrency 4
kablewy docs upload ./documents/*.pdf --dry-run
kablewy docs upload ./documents/*.pdf --session-id client-renewal-q2
kablewy docs upload ./documents/*.pdf --resume-from client-renewal-q2
```

Upload sessions are persisted so interrupted uploads can be inspected or resumed. `--resume-from` re-queues pending and failed files. `docs upload` exits `1` if any file in the batch fails.

`--skip-existing` computes each file's SHA-256 and skips files the backend already has. If the existence check fails, the CLI fails open and uploads the file.

## Container-Routed Ingestion

Use container-routed ingestion only when Kablewy provides a dedicated document-processing worker endpoint.

```bash
export KABLEWY_DOC_WORKER_URL=https://doc-worker.example.com
export KABLEWY_DOC_PROCESSOR_TOKEN=<doc-processor-token>
kablewy docs upload ./documents/*.pdf --use-container
```

For normal client use, omit `--use-container` and use the standard `docs upload` path.
