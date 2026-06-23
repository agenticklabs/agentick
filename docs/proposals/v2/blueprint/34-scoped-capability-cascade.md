# ADR 34 — Scoped capability cascade: one pattern for layered configuration

**Status:** Active · 2026-06-23
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins), ADR 31 (Harness hierarchy), ADR 32 (Extension shape spectrum)
**Touches:** `@agentick/spec-next/data/declarations.ts` (`ToolBinding`), `@agentick/spec-next/protocol/tool-executor.ts`, `@agentick/tool-executor-next/src/registry.ts`, `@agentick/tool-executor-next/src/with-scope.ts`, every extension that contributes capability at a layer (`withMCP`, future `withSkills`/`withMemory`/`withAuth`/...)
**Realized by:** Layered tools epic (#135 – #143), commit range `d161e902` → `7fb75ef2`

## TL;DR

The layered-tools work (#135 – #143) introduced a pattern — registry entries tagged with layer-binding, scope-bound lifecycle, lazy precedence resolution at consumption — that is **not specific to tools**. It is the framework's substrate for hierarchical capability injection.

This ADR names the pattern, sketches the generic primitive, and declares it the canonical model for any cross-cutting capability the framework eventually models: **tools (done), knobs, resources, prompts, skills, credentials, memory stores, telemetry exporters, capability filters, slash commands, routing rules**.

`installer.registerExtensionTool` is the **first thin wrapper** over the generic primitive. The next two domains that need this shape — likely skills and credentials — should be the trigger to **lift `ScopedRegistry<>` into spec** instead of re-rolling.

## The shape we accidentally formalized

Every layered cross-cutting capability in the framework wants the same five things. We didn't realize this until we built tools and noticed everything else has the same problem:

1. **Multiple sources contribute entries** to a shared store (gateway, app, session, execution, extension, reconciler, runtime).
2. **Each entry carries provenance** — a `binding` discriminator naming which layer contributed it.
3. **Consumers resolve lazily** at use-time (per-tick), not at insertion-time. Order of insertion is irrelevant to outcome.
4. **Conflicts resolve by precedence over bindings** — most-specific layer wins. Override semantics, not error semantics.
5. **Each scope owns its slice's lifetime** — scope closes → entries vanish. Atomic, scope-bound, exception-safe.

These five form a coherent pattern. We call it the **scoped capability cascade**.

It is a well-known shape in systems engineering:

| Domain | Same shape, different name |
|---|---|
| CSS | Selector specificity → cascade |
| Helm / Kubernetes values | Base → env → cluster → release |
| Spring profiles, OS env vars, lexical scope | Inner shadows outer |
| Effect `Layer`, React Context | Composable scoped provision |
| DI containers (Guice, Dagger) | Child container overrides parent |

What `compileForTick` does is structurally the CSS engine. What `withScope` does is structurally `Effect.scoped`. The vocabulary is new in agentick; the pattern is decades old.

## What ADR 27 and ADR 31 set up that this completes

ADR 27 said: every capability follows the same shape — built-ins are bundled, not privileged. ADR 31 said: the harness hierarchy is gateway → app → session, with substrate inheritance and per-scope overrides.

Those two together implied — but didn't formalize — that **capabilities themselves should layer along the harness hierarchy**. The tools work made the layering explicit. This ADR makes it general.

## The decision

The scoped capability cascade is **the canonical mechanism** for any cross-cutting capability the framework models. Two implications:

1. **Every new "layered X" follows the tools work as a reference impl.** No bespoke cascade plumbing per domain. The shape is settled.
2. **`installer.registerExtensionTool` is a wrapper.** When the generic primitive lifts, the tool-specific API stays — it just delegates to the generic underneath. Adopters writing extensions see one ergonomic call site per capability domain (`registerExtensionTool`, future `registerExtensionSkill`, etc.). The shared machinery is invisible.

## The generic primitive sketched

Two layers of generic — a base **`ScopedRegistry<Entry>`** with **`ResolutionStrategy<Entry>`** parameterizing the consumption step.

### `Binding` — shared discriminator (already in spec)

The discriminator is shared across all domains because it names *which scope owns the entry*, not what kind of entry it is. This already lives in `@agentick/spec-next/data/declarations.ts` as `ToolBinding`; lifting it to a more generic name (`ScopeBinding`?) when the next domain lands is a 30-second rename.

```ts
export type ScopeBinding =
  | { readonly scope: "runtime" }
  | { readonly scope: "gateway" }
  | { readonly scope: "app"; readonly appId: string }
  | { readonly scope: "session"; readonly sessionId: string }
  | { readonly scope: "execution"; readonly executionId: string }
  | {
      readonly scope: "extension";
      readonly extensionName: string;
      readonly level: "gateway" | "app" | "session";
    }
  | { readonly scope: "reconciler"; readonly mountId: string };
```

Precedence ladder (lowest → highest specificity):

```
runtime < gateway < {app, extension@app} < {session, extension@session} < execution < reconciler
```

This ladder is **architectural, not configurable**. Adopters who want different semantics use a different cascade.

### `Entry` — every domain's atom

```ts
export interface ScopedEntry {
  readonly binding: ScopeBinding;
  // Domain-specific payload via type parameter.
}
```

For tools: `Entry = ToolRegistration` (declaration + handlerRef + binding).
For skills: `Entry = SkillRegistration` (declaration + activation + payload + binding).
For credentials: `Entry = CredentialBinding` (name + value-getter + binding).
For memory: `Entry = MemoryStoreRegistration` (kind + store-handle + binding).

The `binding` field is the only structural requirement.

### `ResolutionStrategy<Entry, View>` — what consumption returns

Two flavors. Both share the cascade lifecycle skeleton; they differ only at the final fold.

**Selection** (most-specific wins per name):

```ts
interface SelectionStrategy<Entry, Filter> {
  readonly kind: "selection";
  /** Identity for collision detection. `compile` dedupes by this key. */
  readonly identity: (entry: Entry) => string;
  /** Optional filter applied BEFORE precedence resolution. */
  readonly matches?: (entry: Entry, filter: Filter) => boolean;
}
```

What `compileForTick` does for tools. Identity = `declaration.name`. Filter by `exposure`. One winner per identity.

**Composition** (all participate, in order):

```ts
interface CompositionStrategy<Entry> {
  readonly kind: "composition";
  /** Optional reorder/topology. Default: insertion order within binding,
   *  then precedence-low-to-high across bindings (runtime first,
   *  reconciler last) so inner scopes wrap outer scopes. */
  readonly order?: (entries: readonly Entry[]) => readonly Entry[];
}
```

What `app.use(middleware)` wants. All entries participate; order matters; precedence determines wrapping direction.

### `ScopedRegistry<Entry, View>` — the primitive

```ts
export interface ScopedRegistry<Entry extends ScopedEntry, View> {
  /** Insert one entry. Idempotent per (identity, binding-key). */
  add(entry: Entry): void;

  /** Bulk-remove by binding predicate. Used at scope close. */
  removeWhere(predicate: (binding: ScopeBinding) => boolean): void;

  /** Atomically replace the slice owned by one binding-key. */
  replaceSlice(bindingKey: string, entries: readonly Entry[]): void;

  /** Snapshot of every entry, no resolution. For diagnostics. */
  list(): readonly Entry[];

  /** The strategy-resolved view. The consumption surface. */
  compile(filter?: unknown): View;
}
```

### `withScope` — atomic lifecycle combinator

```ts
export async function withScope<Entry extends ScopedEntry, View, T>(
  registry: ScopedRegistry<Entry, View>,
  binding: ScopeBinding,
  entries: readonly Entry[],
  fn: () => Promise<T>,
): Promise<T>;
```

Register → run → `removeWhere(b => sameBindingKey(b, binding))` in `finally`. Cleanup runs on return, throw, or abort. The contract that makes scope-bound lifetimes safe.

### `bindingKey` — serialized identity (already in spec)

```ts
export function bindingKey(b: ScopeBinding): string;
// "runtime" | "gateway" | "app:<appId>" | "session:<sessionId>" | ...
```

The format is the documentation of identity-defining fields per variant. Already lives in `tool-executor-next/src/registry.ts`; lifts cleanly to spec when the second domain wants it.

## How tools map to the primitive (already realized)

`@agentick/tool-executor-next` is the reference implementation. Mapping:

| Generic | Tools instance |
|---|---|
| `Entry` | `ToolRegistration` |
| `View` | `readonly ToolDeclaration[]` |
| `Strategy` | Selection, `identity = decl.name`, filter by `ToolListFilter` |
| `ScopedRegistry.add` | `InMemoryToolRegistry.add` |
| `ScopedRegistry.removeWhere` | `InMemoryToolRegistry.removeWhere` |
| `ScopedRegistry.replaceSlice` | `replaceReconcilerSlice` (specialized to `scope:"reconciler"` for now) |
| `ScopedRegistry.compile` | `compileForTick(filter)` |
| `withScope` | `withScope(toolExecutor, binding, decls, fn)` |
| Protocol entry-point | `installer.registerExtensionTool` (thin wrapper) |

`installer.registerExtensionTool` is a one-line call into the registry's `add`. When `ScopedRegistry<>` lifts, it stays a one-line wrapper — adopters keep the ergonomic API; the machinery underneath becomes shared.

## How future capabilities map (sketches)

### Skills

```ts
type SkillEntry = { binding; declaration: SkillDeclaration; activation; payload };

const skillRegistry: ScopedRegistry<SkillEntry, readonly SkillDeclaration[]> = ...;

// Extension API (canonical wrapper):
installer.registerExtensionSkill({ declaration, activation, payload });
//   ↓
skillRegistry.add(toSkillEntry(input, { scope: "extension", level: "app", extensionName: "..." }));
```

Identity = `declaration.name`. Filter by activation context (the runtime decides which skills to surface this tick).

### Credentials (the high-leverage non-obvious one)

```ts
type CredentialEntry = { binding; name: string; getter: () => Promise<string> };

const credRegistry: ScopedRegistry<CredentialEntry, Map<string, string>> = ...;

// Adopter API:
session.credentials.set("OPENAI_API_KEY", { binding: sessionScope, getter });

// Consumer API at handler boundary:
const apiKey = await ctx.credentials.get("OPENAI_API_KEY");
```

Identity = `name`. Most-specific binding wins (session-scope token overrides app-scope token). **Scope close → tokens vanish atomically.** Closures-around-secrets are eliminated; the framework owns the lifecycle.

### Memory stores

```ts
type MemoryEntry = { binding; kind: "vector" | "kv" | "graph"; store: MemoryStore };

// Multiple memory stores layered: app-wide vector store + per-session conversation kv.
// Consumer picks by `kind`; precedence picks the most-specific store of that kind.
```

### Middleware (composition flavor)

```ts
type MiddlewareEntry<T> = { binding; mw: Middleware<T> };

// Strategy: composition. All participate. Order: inner scopes wrap outer scopes
// (reconciler wraps execution wraps session wraps app wraps gateway).
// app.use(mw) writes to this registry with { scope: "app", appId }.
// On session close: session-bound middleware is gone.
```

This is the bridge to `app.use` / `tool.use` / etc. Lift `ScopedRegistry` with `CompositionStrategy` and `app.use` becomes a one-liner into the registry instead of bespoke chain-building.

## The lift trigger

We do NOT lift `ScopedRegistry<>` into spec today. Premature abstraction is the bigger risk than re-rolling.

The trigger: **the third domain that needs this shape**.

- ✓ Tools (done, reference impl)
- ☐ +1 domain — point at the tools work, copy the pattern
- ☐ +2 domains — lift `ScopedRegistry<Entry, ResolutionStrategy>` into spec; rewrite tools as the first consumer

Likely +1: **skills** (near-term, structurally identical to tools, growing market momentum).
Likely +2: **credentials** (security stakes change the calculus; the framework wins big by owning scope-bound lifetimes here).

When +2 lands, the lift is one PR: extract `ScopedRegistry`, `withScope`, `bindingKey` into `@agentick/spec-next/data/scoped-registry.ts` (data) and `@agentick/runtime-next/src/scoped-registry.ts` (impl). Existing tools code switches its registry import; adopter call sites (`installer.registerExtensionTool`) stay exactly the same.

## Consequences

**Positive:**

- The next layered domain is a copy-paste-with-renames exercise. The reference impl in `tool-executor-next` is the template.
- Extensions writing into layered registries share machinery → consistent semantics for adopters across capability types.
- `withScope` is the universal escape-hatch for any "register at scope X, cleanup at scope end" need. Adopters writing custom flows reach for it instead of hand-rolling `try/finally`.
- Scope-bound lifecycle becomes a *contract* the framework enforces, not an *ergonomic suggestion* adopters might forget. This matters most for credentials (security), then memory (resource leaks), then everything else (correctness).
- Adopters reading the code see one canonical pattern across capability domains. The mental model is one shape, parameterized by domain.

**Negative / caveats:**

- The `ScopeBinding` discriminator hardcodes the harness hierarchy. A future deployment topology (e.g., a "tenant" scope between gateway and app) requires adding a variant and a precedence rank. Forward-compatible but visible churn.
- Composition vs selection variants increase the conceptual surface. Adopters need to know which flavor their capability is. Documented at the call site (`registerExtension*` factory makes the choice).
- Premature unification (lifting before the third domain) would over-fit on tool semantics. The selection vs composition split came out of thinking about future domains; we're not certain composition's `order` callback is the final shape until middleware actually uses it.

**Neutral:**

- ADR-only today. No code lifts. The next slice of any layered domain references this ADR as the design contract.
- The pattern is decades old in other systems engineering domains (CSS, Helm, Effect Layer). Naming it "scoped capability cascade" is local convention; adopters from those backgrounds recognize the shape on sight.

## Open questions

1. **OQ34.1 — Composition order convention.** When `withScope` adds entries during a child scope, do they wrap or are they wrapped by parent-scope entries? The current intuition is "inner wraps outer" (closer-to-the-call entries run first/last depending on direction), but middleware semantics vary by community. Resolution: defer to the middleware lift; whichever order the first composition-domain consumer wants becomes the default.

2. **OQ34.2 — Tenant scope.** Multi-tenant deployments (ADR 31 Tier 3) may want a `tenant` scope between gateway and app. Should the binding variant be added speculatively, or only when the cluster substrate lands? Resolution: **only when needed**. The binding ladder is part of the architecture; adding speculative scopes adds cognitive load to today's adopters.

3. **OQ34.3 — Cross-domain interactions.** A tool's handler may need to read from the credentials registry. Are these two registries independent, or does some shared "scoped store" coordinate? Resolution: independent registries per domain, coordinated via the harness substrate. Cross-domain reads happen at handler boundary via `ctx.<domain>.get(...)`. The cascade machinery doesn't enforce cross-domain semantics.

4. **OQ34.4 — Inheritance vs propagation.** Today, gateway tools are explicitly *propagated* into apps via `inheritedTools`. An alternative model: gateway tools live in a shared registry that every app reads. The propagation model is simpler (each registry is local); the shared-registry model is more memory-efficient but adds cross-instance coupling. Resolution: stick with propagation. Memory cost is negligible at realistic scales (tens of tools per layer); simplicity wins.

## See also

- ADR 26 (Harness as the single shape) — the harness pattern that every layer in the cascade implements.
- ADR 27 (Modular built-ins) — the principle "built-in is just bundled" which the cascade respects.
- ADR 31 (Harness hierarchy) — the gateway → app → session ladder the binding follows.
- ADR 32 (Extension shape spectrum) — extension installer surface; `registerExtensionTool` is one of N installer-write methods.
- `@agentick/tool-executor-next/src/registry.ts` — the reference implementation.
- `@agentick/tool-executor-next/src/with-scope.ts` — the lifecycle combinator.
