---
name: build-and-check
description: Build, typecheck, and test the agentick monorepo. Use when asked to verify changes, run checks, or ensure nothing is broken.
---

# Build & Check

> **v2 gate mechanics (use these on `feat/v2`).**
>
> - **Tests:** `npx vitest run packages-next` from the repo root. **Never** `pnpm --filter <pkg> test` — it is a turbo no-op that reports a false green.
> - **Typecheck:** `pnpm typecheck --force` — `--force` bypasses stale turbo cache and runs `tsc` including test files.
> - **Format / lint:** `pnpm format` (oxfmt) and `pnpm lint` (oxlint) — not prettier, not jest.
> - **No top-level await:** `pnpm check:no-tla`.
> - After deleting or renaming any export, run `pnpm typecheck --force` workspace-wide before committing — package-local green proves nothing.
>
> The commands below target the v1 `packages/` tree.

## Quick Verification

After making changes, run the appropriate checks:

```bash
# Typecheck everything (fast, catches most issues)
pnpm typecheck

# Typecheck a specific package
pnpm --filter @agentick/core typecheck
pnpm --filter @agentick/kernel typecheck

# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @agentick/core test
pnpm --filter @agentick/gateway test

# Run a single test file
pnpm vitest run packages/core/src/hooks/__tests__/knob.spec.ts

# Full build (slower, for publishing verification)
pnpm build
```

## When to Run What

| Change                    | Command                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Modified a type/interface | `pnpm typecheck` (ALL packages — structural typing)                                 |
| Modified a single package | `pnpm --filter @agentick/PACKAGE typecheck && pnpm --filter @agentick/PACKAGE test` |
| Modified kernel or shared | `pnpm typecheck && pnpm test` (foundation packages affect everything)               |
| Added a new export        | `pnpm typecheck`                                                                    |
| Before committing         | `pnpm typecheck && pnpm test`                                                       |
| Before publishing         | `pnpm build && pnpm typecheck && pnpm test`                                         |

## Important: Interface Changes

When modifying a TypeScript interface, always run full `pnpm typecheck` — not just the package you edited. Structural typing means anonymous object literals in other packages may implement your interface without explicitly referencing it.

Grep for the **property name** across all `.ts` files, not just the interface name:

```bash
# If you renamed or deleted a property called "eventBuffer":
grep -r "eventBuffer" packages/ --include="*.ts"
```

## Common Issues

**pnpm install fails with CodeArtifact error**: Your `~/.npmrc` may have a stale registry. Workaround:

```bash
NPM_CONFIG_REGISTRY=https://registry.npmjs.org pnpm install
```

**Type error in a package you didn't touch**: Likely a structural typing issue. Check if your interface change affects object literals elsewhere.

**Test timeout**: Default vitest timeout is 5s. For async agent tests, ensure `cleanup()` is called in `afterEach`.
