# Agentick — Agent Entry Doc

React, but the render target is model context instead of DOM. You build the context window with JSX; the framework compiles the component tree into what the model sees. Only what you render reaches the model.

**This repo is mid-rewrite.** The stable v1 line is under `packages/` (maintenance). The v2 rewrite is under `packages/` on the `feat/v2` branch and is where work happens. This doc is the v2 entry point. `CLAUDE.md` is the full guide; read it plus the ADRs before touching v2.

## Read first (v2)

1. `docs/proposals/v2/STATUS.md` — running progress log. **Update it when you finish work.**
2. `docs/proposals/v2/IMPLEMENTATION-PLAN.md` — the phased rollout plan.
3. `docs/proposals/v2/blueprint/` — architectural ADRs. Start with `00-overview.md`, then `26-harness-api-shape.md` ("everything is a harness") and `27-modular-built-ins.md` (foundational).

## v2 modularity model (non-negotiable)

- **Everything is a harness.** A harness owns substrate participation (bus/inbox/journal), a typed protocol, augmentation onto `HookBridges`, a `withX()` extension factory, and a conformance suite. Built-ins (timeline, knobs, state, gates, tool) and optionals (sandbox, mcp) follow the **identical** pattern.
- **Built-ins are bundled, not privileged.** They are private workspace packages the `agentick` metapackage bundles; optionals ship as separate installs. No code-level distinction — the asymmetry is packaging only. Never special-case "foundational" vs "optional."
- **`HookBridges` in `@agentick/spec` is an empty seed.** Every harness augments it via `declare module "@agentick/spec"`. Spec hardcodes no slots.
- **`@agentick/compiler-react` has NO harness deps.** It owns the JSX → IR pipeline and the bridge context (`BridgeProvider` / `useBridges`); the reference `InMemoryDataBridge` lives in `@agentick/compiler`. Snapshot/restore iterates `HookBridges` generically via `SnapshotCapable` feature detection — no hardcoded slot names. Any harness adds a `/react` subpath depending on compiler-react without a cycle.
- **Tests live where their deps live.** A "knobs + compiler" test belongs in `@agentick/knobs`, not compiler-react. Cross-harness tests live in `@agentick/session` or the metapackage.

### Per-harness package layout

```
@agentick/<harness>/src/
  harness.ts        — BaseHarness impl        augment.ts    — adds the HookBridges slot
  extension.ts      — withX() factory         conformance.ts — runXHarnessConformance
  react/            — optional React surface   testing/      — optional stubXHarness
  __tests__/  harness.spec.ts · conformance.spec.ts · integration-with-compiler.spec.tsx
```

## Package architecture (packages)

```
Foundation:  spec · runtime · pubsub · utils
Compiler:    compiler (base) → compiler-react (JSX harness)
Harnesses:   timeline · knobs · state · gates · tool · resources · elicitation ·
             tasks · prompts · skills · subscriptions · live · credentials
Executors:   tool-executor · model-executor · loop-executor
Model:       model · model-ai-sdk · model-anthropic · model-openai · model-google
Session/App: session · app
Client:      client-core → client · client-react · client-extensions
Wire:        transport(-http/-in-process/-unix-socket/-websocket) · gateway · cluster*
Optional:    sandbox* · mcp · connector · eval · formatters · store · telemetry-otlp
```

**Naming law:** `<role>` for a base/shared/abstract package; `<role>-<discriminator>` for a concrete impl (`compiler` base, `compiler-react` concrete). The role is implicit from the dependency graph — never use a `-base-` suffix.

## File locations (v2)

| What                     | Where                                               |
| ------------------------ | --------------------------------------------------- |
| Protocol seam (spec)     | `packages/spec/src/`                                |
| Foundation (bus/journal) | `packages/runtime/src/`                             |
| JSX compiler harness     | `packages/compiler-react/src/`                      |
| Compiler base + collect  | `packages/compiler/src/`                            |
| Built-in harnesses       | `packages/<harness>/src/`                           |
| Session / App            | `packages/session/src/`, `packages/app/src/`        |
| Gateway / transports     | `packages/gateway/src/`, `packages/transport*/src/` |
| Client                   | `packages/client*/src/`                             |
| Tests                    | `packages/*/src/**/*.spec.ts`                       |
| Examples                 | `example/v2-real/` (canonical), `example/v2*/`      |

v1 lives under `packages/*/src/` and is stable; don't migrate v1 code into v2 — v2 is a rewrite, not a port.

## Verification gates

- **Tests:** `npx vitest run packages` from the repo root. **Never** `pnpm --filter <pkg> test` — that path is a turbo no-op that reports a false green.
- **Typecheck:** `pnpm typecheck --force` (`--force` defeats stale cache; runs `tsc` including test files).
- **Format / lint:** `pnpm format` (**oxfmt**) and `pnpm lint` (**oxlint**) — not prettier, not jest. Pre-commit runs `format:check` + `lint`.
- **No top-level await:** `pnpm check:no-tla`.

Deleting or renaming any export → run `pnpm typecheck --force` workspace-wide before committing; package-local green proves nothing.

## Test doubles (Meszaros taxonomy)

`fake*` for minimal working impls (default), `stub*` for canned answers, `spy*` for call recorders, `mock*` for expectations. Never `test*`. Every layer ships its doubles under a `/testing` subpath, typed against spec interfaces so spec drift breaks them at compile time. Grep `src/` (and `@agentick/utils` + `/testing`) for an existing helper before writing one.

## Skills

Task-scoped skills in `skills/`: **`create-harness`** and **`create-extension`** (v2); `create-component`, `create-hook`, `create-tool`, `create-adapter` (v1). Invoke the matching skill before building the corresponding artifact.

## Coding standards

No backwards compatibility, no deprecations, no legacy paths — remove old code rather than shim it. One way to do things. Import from package index, not deep paths. Throw typed errors, don't return null. Single source of truth for every type. Check `@agentick/utils` before writing any utility.
