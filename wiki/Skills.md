# Skills

`skills` is the canonical command group. `skill` remains as a compatibility alias.

```bash
kablewy skills list --json
kablewy skills show <skillId>
kablewy skills create <skillId> --name "Renewal Review"
kablewy skills upload <skillId> ./bundle.zip --version 0.1.0
kablewy skills execute <skillId> --runtime python --entry main.py
kablewy skills execute <skillId> --args '["customer-a"]' --json
kablewy skills versions <skillId>
kablewy skills delete <skillId> --force
```

For `skills execute`, the command-local `--env <json>` flag sets environment variables for the skill run:

```bash
kablewy skills execute renewal-review --env '{"CUSTOMER":"acme"}'
```
