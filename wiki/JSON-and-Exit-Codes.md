# JSON and Exit Codes

Automation-capable commands support `--json` with a stable envelope.

Success:

```json
{ "success": true, "data": {} }
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "AUTH_ERROR",
    "message": "Authentication failed",
    "requestId": "request-id-when-available"
  }
}
```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Unexpected failure |
| `2` | Usage or validation error |
| `65` | Authentication error |
| `66` | Not found |
| `70` | Network or backend error |
| `77` | Permission error |

Diagnostics also use exit codes:

- `status` exits `1` when overall health is unhealthy.
- `config --validate` exits `2` when configuration is invalid.
- `tools test` exits `70` when any server fails its connectivity probe.
- `docs upload` exits `1` when any file in the batch fails.
