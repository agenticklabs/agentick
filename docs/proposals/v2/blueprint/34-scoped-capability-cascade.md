# ADR 34 — Scoped capability cascade: one pattern for layered configuration

**Status:** Active · 2026-06-23 (revised 2026-06-23 with Pattern A clarification)
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins), ADR 31 (Harness hierarchy), ADR 32 (Extension shape spectrum)
**Touches:** `@agentick/spec-next/data/declarations.ts` (`ToolBinding`), `@agentick/spec-next/protocol/tool-executor.ts`, `@agentick/tool-executor-next/src/registry.ts`, `@agentick/tool-executor-next/src/with-scope.ts`, `@agentick/shared/utils/merge-layered.ts`, every extension that contributes capability at a layer (`withMCP`, future `withSkills`/`withMemory`/`withAuth`/...)
**Realized by:** Layered tools epic (#135 – #143), commit range `d161e902` → `7fb75ef2`; mergeLayered primitive (#144)

## TL;DR

The layered-tools work (#135 – #143) introduced a pattern — registry entries tagged with layer-binding, scope-bound lifecycle, lazy precedence resolution at consumption — that is **not specific to tools**. It is the framework's substrate for hierarchical capability injection.

This ADR names the pattern, sketches the generic primitive, and declares it the canonical model for any cross-cutting capability the framework eventually models: **tools (done), knobs, resources, prompts, skills, credentials, memory stores, telemetry exporters, capability filters, slash commands, routing rules**.

`installer.registerExtensionTool` is the **first thin wrapper** over the generic primitive. The next two domains that need this shape — likely skills and credentials — should be the trigger to **lift `ScopedRegistry<>` into spec** instead of re-rolling.

## Three patterns, three primitives

What we built for tools is one of three sibling cascade patterns in the framework. All three share vocabulary (precedence direction, "most-specific wins", scope-bound provenance) but diverge in machinery. Naming all three explicitly so future cascade work picks the right shape.

| Pattern                    | What it cascades                                                                   | Primitive                                                                     | State                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **A. Declarative cascade** | Adopter-written config values (`maxTicks`, `executor`, `metadata`, project config) | **`mergeLayered<T>(...layers)`** in `@agentick/shared/utils/merge-layered.ts` | Landed                                                                                |
| **A′. Substrate cascade**  | One slot per kind, factory-aware (bus/inbox/journal)                               | `HarnessShell` slot resolver in `BaseHarness`                                 | Landed (ADR 31)                                                                       |
| **B. Emitted cascade**     | Dynamic multi-entry sources (tools, skills, prompts, resources, ...)               | **`ScopedRegistry<Entry, Strategy>`** + `withScope` + `replaceSlice`          | Reference impl exists (`@agentick/tool-executor-next`); lifts when third domain lands |

### Pattern A — Declarative cascade (`mergeLayered`)

**When:** adopter writes a config value into options at some layer. Each layer's options carry zero-or-one value per field. Resolution merges all layers with most-specific winning.

**Primitive:** `mergeLayered<T>(...layers: Layer<T>[]): T`. Deep-merge with cascade semantics — `undefined` doesn't override, plain objects deep-merge, arrays / primitives / opaque instances replace by default. Symbol-wrapped strategies (`append` / `prepend` / `replace` / `omit`) opt into per-field semantics at the call site.

```ts
const config = mergeLayered<SessionConfig>(
  FRAMEWORK_DEFAULTS,
  gateway?.config, // gateway layer
  app.config, // app layer
  session.config, // session layer
  sendInput.config, // per-call layer
);
```

**Two consumers in mind, by intent:**

1. **Agentick-internal cascade** — at construction boundaries between harness layers. New harness layer = one new arg. New config field = one new type addition. No per-field resolver code.

2. **Convenience-wrapper authors** (the v2 equivalent of v1's `agent({ ... })` package) — merging framework defaults + env config + project config + adopter call-site into one blob, then translating to agentick's primitives. Agentick is intentionally low-level; the "config file" ergonomics most adopters expect live in the wrapper layer above. `mergeLayered` serves both layers identically.

**Symbol strategies** are the lever that makes per-field semantics expressible at the call site:

```ts
mergeLayered(
  { extensions: [existingExt] },
  { extensions: append([newExt]) }, // → [existingExt, newExt]
);
mergeLayered(
  { a: { x: 1, y: 2 } },
  { a: replace({ y: 9 }) }, // → { a: { y: 9 } }  (opts out of deep merge)
);
```

Adopters writing convenience wrappers — "my framework's default `extensions: [...]` should be appended to by adopter input, not replaced" — express this as data, not custom merger code.

**What `mergeLayered` is NOT:** an inline `??` chain. Early drafts of this ADR described Pattern A as `local ?? parent ?? grandparent ?? default`, which works for **scalars and opaque instances** but fails for **objects** (`{a:1} ?? {b:2}` returns the first object, dropping `b:2` entirely). Existing call sites in `sendBody`/`createSessionBody` use inline `??` chains today; those are correct for the specific fields they cascade (`executor`, `maxTicks`, `streaming` — all scalars). When a new layered field requires object-deep-merge semantics, those call sites should adopt `mergeLayered` rather than expanding the inline chain.

**Migration policy:** the primitive sits in `@agentick/shared` ready for use. Existing inline `??` chains are NOT migrated speculatively — they work and they're correct. The first new layered field that needs object merge (or the first new layer added between gateway and per-call) is the forcing function for migration.

### Pattern A′ — Substrate cascade (already done)

ADR 31 settled this. The harness hierarchy (gateway → app → session) inherits or wraps parent substrate (bus/inbox/journal) via a factory-or-instance slot resolver. Same precedence direction as A and B; specialized to cardinality-1 per (kind, scope) with first-class composition support (factories let a child wrap rather than replace).

No work here. The pattern exists; future harness types inherit it for free.

### Pattern B — Emitted cascade (this ADR's main subject)

**When:** some process emits N entries at a layer dynamically — the reconciler renders and emits tool declarations; MCP discovers and emits tool registrations; the adopter declares tools statically; the per-send call adds more. Multiple sources contribute concurrently per scope.

Resolution can't be a lookup chain because there's no single slot per layer — each layer carries an arbitrary set. You need a registry, provenance tags, a compile step that resolves precedence at consumption time, and scope-bound lifecycle.

This is what the tools work built. The rest of the ADR sketches its generic shape.

### The distinguishing test

Picking which pattern applies to a new concern:

> **"Does the reconciler (or any per-tick dynamic emitter) need to participate in this cascade?"**
>
> - **Yes** → Pattern B (`ScopedRegistry`). Tools, sections, skills, resources, prompts, per-tick model selection.
> - **No, just adopter-written config** → Pattern A (`mergeLayered`). maxTicks, streaming, executor default, metadata, policy.override.
> - **One slot per kind, child-may-wrap-parent** → Pattern A′ (substrate). bus/inbox/journal.

## The shape we accidentally formalized

Every layered cross-cutting capability in the framework wants the same five things. We didn't realize this until we built tools and noticed everything else has the same problem:

1. **Multiple sources contribute entries** to a shared store (gateway, app, session, execution, extension, reconciler, runtime).
2. **Each entry carries provenance** — a `binding` discriminator naming which layer contributed it.
3. **Consumers resolve lazily** at use-time (per-tick), not at insertion-time. Order of insertion is irrelevant to outcome.
4. **Conflicts resolve by precedence over bindings** — most-specific layer wins. Override semantics, not error semantics.
5. **Each scope owns its slice's lifetime** — scope closes → entries vanish. Atomic, scope-bound, exception-safe.

These five form a coherent pattern. We call it the **scoped capability cascade**.

It is a well-known shape in systems engineering:

| Domain                                      | Same shape, different name       |
| ------------------------------------------- | -------------------------------- |
| CSS                                         | Selector specificity → cascade   |
| Helm / Kubernetes values                    | Base → env → cluster → release   |
| Spring profiles, OS env vars, lexical scope | Inner shadows outer              |
| Effect `Layer`, React Context               | Composable scoped provision      |
| DI containers (Guice, Dagger)               | Child container overrides parent |

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

The discriminator is shared across all domains because it names _which scope owns the entry_, not what kind of entry it is. This already lives in `@agentick/spec-next/data/declarations.ts` as `ToolBinding`; lifting it to a more generic name (`ScopeBinding`?) when the next domain lands is a 30-second rename.

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

| Generic                       | Tools instance                                                         |
| ----------------------------- | ---------------------------------------------------------------------- |
| `Entry`                       | `ToolRegistration`                                                     |
| `View`                        | `readonly ToolDeclaration[]`                                           |
| `Strategy`                    | Selection, `identity = decl.name`, filter by `ToolListFilter`          |
| `ScopedRegistry.add`          | `InMemoryToolRegistry.add`                                             |
| `ScopedRegistry.removeWhere`  | `InMemoryToolRegistry.removeWhere`                                     |
| `ScopedRegistry.replaceSlice` | `replaceReconcilerSlice` (specialized to `scope:"reconciler"` for now) |
| `ScopedRegistry.compile`      | `compileForTick(filter)`                                               |
| `withScope`                   | `withScope(toolExecutor, binding, decls, fn)`                          |
| Protocol entry-point          | `installer.registerExtensionTool` (thin wrapper)                       |

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
- Scope-bound lifecycle becomes a _contract_ the framework enforces, not an _ergonomic suggestion_ adopters might forget. This matters most for credentials (security), then memory (resource leaks), then everything else (correctness).
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

4. **OQ34.4 — Inheritance vs propagation.** Today, gateway tools are explicitly _propagated_ into apps via `inheritedTools`. An alternative model: gateway tools live in a shared registry that every app reads. The propagation model is simpler (each registry is local); the shared-registry model is more memory-efficient but adds cross-instance coupling. Resolution: stick with propagation. Memory cost is negligible at realistic scales (tens of tools per layer); simplicity wins.

## See also

- ADR 26 (Harness as the single shape) — the harness pattern that every layer in the cascade implements.
- ADR 27 (Modular built-ins) — the principle "built-in is just bundled" which the cascade respects.
- ADR 31 (Harness hierarchy) — the gateway → app → session ladder the binding follows.
- ADR 32 (Extension shape spectrum) — extension installer surface; `registerExtensionTool` is one of N installer-write methods.
- `@agentick/tool-executor-next/src/registry.ts` — the reference implementation.
- `@agentick/tool-executor-next/src/with-scope.ts` — the lifecycle combinator.
