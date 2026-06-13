# Configuration and CI

The public CLI connects to the Kablewy production service at `https://kablewy.ai`. Customers do not need to choose an environment.

## Local Configuration

Most users only need:

```bash
kablewy login
kablewy whoami
kablewy status
```

Use `config` when Kablewy support asks you to inspect or update local settings:

```bash
kablewy config --show
kablewy config --validate
kablewy config --get apiUrl
kablewy config --set orgId=<org-id>
```

## CI Isolation

Never let CI read a developer's local CLI profile. Use a throwaway `KABLEWY_CONFIG_DIR` and pass credentials through CI secrets.

```bash
KABLEWY_API_KEY=<api-key> \
KABLEWY_ORG_ID=<org-id> \
KABLEWY_USER_ID=<user-id> \
KABLEWY_CONFIG_DIR=/tmp/kablewy-cli-config \
kablewy status --json
```

## One-Off Overrides

Global flags override config for one invocation. Place them before the subcommand:

```bash
kablewy \
  --org-id <org-id> \
  --user-id <user-id> \
  --api-key <api-key> \
  status --json
```
