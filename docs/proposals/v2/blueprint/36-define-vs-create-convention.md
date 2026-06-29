# ADR 36 — `defineX` vs `createX` naming convention

**Status:** Active · 2026-06-25
**Builds on:** ADR 31 (Harness hierarchy — `Factory<R, P>` primitive)
**Touches:** `@agentick/formatters-next` (rename `defineFormatter → createFormatter`), `@agentick/app-next` (drop `defineApp` alias), all future `define*` and `create*` exports across the framework.

## TL;DR

The framework has two functional categories of constructor exports. Their naming should encode the only meaningful mechanical difference between them: **does this thing need substrate from a parent harness to construct itself?**

- **`defineX(spec) → XFactory`** — for X that requires parent-harness substrate at construction time. Returns a `Factory<X, P> = (parent: P) => X | Promise<X> | Effect<X, never, never>`. The framework calls the factory with the parent harness when substrate is available.

- **`createX(args) → X | Promise<X>`** — for X that constructs directly from caller-supplied args. No parent harness required. Returns the materialized instance.

That's the entire rule. One mechanical question per call site (does it need parent substrate?), one verb per answer.

## What this fixes

Two minor inconsistencies in the current codebase:

1. `defineApp` is aliased to `createApp` in `packages-next/app/src/index.ts` "for naming preference." `createApp` doesn't need parent substrate (it IS the outermost layer); under the rule it's correctly named `create*`. The `define*` alias muddles the convention.

2. `defineFormatter` returns a `DefinedFormatter` directly (no factory wrapper). Formatters don't need parent harness substrate — they're pure render functions. Under the rule it should be `createFormatter`.

Nothing else is misnamed. The convention codifies what's already mostly true.

## Why "substrate-from-parent" is the right kicker

Earlier framings tried to encode the distinction as "stateful vs stateless" or "declarative vs imperative." Both are phantoms — they don't map to observable mechanics in the framework and produce ambiguous edge cases (is a formatter "stateful"? is a tool a "declaration"?).

The substrate-from-parent property IS observable in the type signature:

- If X is composed into the harness hierarchy and constructs itself by reading the parent's bus / inbox / journal — it can't be built until the parent exists. Hence `defineX(spec)` produces a deferred-construction factory `(parent) => X`.
- If X has everything it needs from the call's args, the constructor can run immediately. Hence `createX(args)` returns X directly.

The verb encodes the deferral, which encodes the dependency on parent substrate. Adopters reading code can predict the verb without learning rules.

## Audit (the existing surface)

| Name                                    | Returns                     | Needs parent substrate?   | Verb correct?                 |
| --------------------------------------- | --------------------------- | ------------------------- | ----------------------------- |
| `defineExecutor`                        | `ExecutorFactory`           | yes                       | ✅                            |
| `defineReconciler`                      | `ReconcilerFactory`         | yes                       | ✅                            |
| `defineSession`                         | `SessionHarnessFactory`     | yes                       | ✅                            |
| `defineLoop`                            | `LoopExecutorFactory`       | yes                       | ✅                            |
| `defineToolExecutor`                    | `ToolExecutorFactory`       | yes                       | ✅                            |
| `defineLanguageModelExecutor`           | `Factory<…>`                | yes                       | ✅                            |
| `defineCluster` (new)                   | `ClusterFactory`            | yes — wraps app substrate | ✅                            |
| `defineFormatter`                       | `DefinedFormatter` directly | no                        | ❌ — rename `createFormatter` |
| `createApp`                             | `Promise<AppHarness>`       | no (outermost)            | ✅                            |
| `app.createSession`                     | `Promise<Session>`          | n/a (method on parent)    | ✅                            |
| `createTool`                            | `CreatedTool`               | no                        | ✅                            |
| `createLocalPubSub`                     | `LocalPubSub`               | no                        | ✅                            |
| `createNotifier`, `createKeyedNotifier` | `Notifier`, `KeyedNotifier` | no                        | ✅                            |
| `defineApp` (alias)                     | `Promise<AppHarness>`       | n/a                       | ❌ — drop alias               |

## Adapter packages

The named factory exported by an adapter package (`openai(...)`, `redisTransport(...)`, `markdownFormatter(...)`) typically WRAPS the protocol-level `defineX` internally and closes over instance config. The adapter function's return type matches what `defineX` returns — a factory for protocol implementations needing parent substrate, a direct instance otherwise.

```typescript
// @agentick/executor-openai-next
export function openai(config: OpenAIConfig): ExecutorFactory {
  return defineExecutor({
    prepareInput: ...,   // closures over config
    execute: ...,
    // ...
  });
}

// @agentick/formatters-markdown-next
export function markdownFormatter(config: MarkdownConfig = {}): DefinedFormatter {
  return createFormatter({   // post-rename
    id: "markdown",
    format: "markdown",
    render: (blocks) => renderWithConfig(blocks, config),
  });
}
```

The adopter sees `openai(...)` and `markdownFormatter(...)` — they're named after the implementation, not the protocol verb. The verb appears inside the adapter package, where it documents the protocol-level role.

## Lazy config resolution (orthogonal)

Where a config value's evaluation deserves deferral until construction time (e.g., env vars resolved per replica), the field's type widens inline to `T | (() => T | Promise<T>)`. The framework awaits resolution at construction. No named `Resolvable<T>` type — the union is spelled at each call site that uses it. Async normalization is a one-line helper inside whichever package needs it.

This is independent of the define/create convention. Both `defineX` factories and `createX` constructors may accept lazy fields.

## Back-propagation

In order of cost:

1. **Drop `defineApp` re-export** in `packages-next/app/src/index.ts`. Remove the comment that explains the alias. One-line change. Search adopter-facing docs / READMEs for stray references.
2. **Rename `defineFormatter → createFormatter`** in `@agentick/formatters-next`. Update the function name, the return type's name (`DefinedFormatter` may stay — names of return types aren't covered by this convention), call sites across the workspace, and the spec entry.
3. **No other renames.** Every other `define*` and `create*` in the codebase is already correct under the rule.

## Conformance

No conformance-test changes implied. The convention is a naming rule, not a runtime contract. Adopters writing custom impls that ship as `defineMyX` must return a `Factory<MyX, P>`; that's enforceable via the existing type system (the caller of `defineMyX`'s output expects a factory shape) without a separate conformance suite.

## Out of scope

- Renaming `CreatedTool` / `DefinedFormatter` / similar return-type names. The convention covers FUNCTION names; type names follow their own readability decisions.
- Touching v1 code under `packages/`. V1 maintains its own conventions; this ADR is v2-only.
- The framework-internal helpers used by `defineX` factories (e.g., the substrate-wiring functions inside `AppHarness`). Convention is for exported public-surface functions only.
