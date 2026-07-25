# Local registry (verdaccio) — the `next`-lane dev loop

The canonical local registry is **nx-knowify's** — the registry lives
where the consumer lives; agentick publishes into it.

## Start (in nx-knowify)

```bash
# CodeArtifact is the uplink — export the token first:
export CODEARTIFACT_AUTH_TOKEN=...   # (see nx-knowify's own docs)
nx local-registry                     # verdaccio on :4873, persistent storage
```

The config (`nx-knowify/.verdaccio/config.yml`) allows `$all` publish on
every scope and proxies everything else through CodeArtifact (which
itself proxies public npm) — so v1 `@agentick/*@0.15.x` from npm and the
local `1.0.0-next.N` line resolve through one registry.

## Publish (in agentick)

```bash
# One-time, machine-local — the project .npmrc (gitignored) must carry:
#   @agentick:registry=http://localhost:4873/
# This OUT-RANKS any user-level ~/.npmrc scoped entry. Without it, a
# `@agentick:registry=https://registry.npmjs.org/` line in ~/.npmrc will
# silently hijack the publish target (scoped beats default; pnpm 11's
# native publish honors scope config over --registry and env overrides).

pnpm change            # record an intent (changesets format)
pnpm version -r        # consume -> X.Y.Z-next.N across the fixed group
pnpm publish-dev       # build packages/* + publish -r --tag next -> :4873
```

## Consume (nx-knowify or any consumer)

```bash
# consumer .npmrc:
@agentick:registry=http://localhost:4873/

pnpm add @agentick/session@next
# or: nx local-install (nx-knowify's target — installs with the local registry)
```

## Verify a publish like a consumer would

The workspace masks packaging defects (hoisted devDeps satisfy imports
that a real install cannot). After publishing, smoke-test from a CLEAN
directory: scoped `.npmrc` → `pnpm add @agentick/session@next` →
`node -e "require('@agentick/session')"`. `verify:publish` (build +
no-TLA + dep-graph gates) covers what it can in-repo; the isolated
install is the honest final check.
