# Change intents

Versioning is pnpm-native (pnpm >=11.13 — https://pnpm.io/versioning).
Config lives in `pnpm-workspace.yaml` under `versioning:` (fixed groups,
lanes, ignore). This directory holds the changesets-format intent files
`pnpm change` writes, plus the consumption ledger (`ledger.yaml`).

- `pnpm change` — record a change intent
- `pnpm change status` — preview pending intents
- `pnpm version -r` — consume intents, bump versions, update dependents
- `pnpm publish -r` — publish (see root `publish-dev` for verdaccio)
