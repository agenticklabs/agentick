# ADR 56 — Tree-declared model per tick (the tool pattern, for models)

**Status:** PROPOSED 2026-07-06 (Fable, for Ryan)
**Depends on:** ADR 52 (the ONE LanguageModelExecutor + LanguageModelAdapter — #150, shipped),
ADR 27 (modular built-ins / bridge augmentation), ADR 55 (render-context; `activeModel` slot)
**Issue:** #169 — mechanism Ryan-ratified 2026-07-03 ("equal-class citizen; the tool pattern")

## TL;DR

The model the loop calls can be declared **in the tree, per tick**, taking precedence
over the send override and the session/app default. The mechanism is the **tool
pattern, verbatim**: the IR carries a *serializable* model selection (`{ modelRef,
parameters }` — the spec firewall holds); the *live* model value registers through a
render-scoped bridge slot (exactly like `ToolBridge` handler refs); the loop resolves
`modelRef → resolved model` per tick. Precedence: **tick-IR > send override > session/app**
(inner-scope-wins, matching every other layered seam).

Today the loop takes ONE `executor` + `target` for the whole execution
(construction-bound per send). `RenderedTree.config → parameters` already flows via
`buildParameters`; **the missing piece is per-tick model resolution** — this ADR.

## The firewall constraint drives the shape

A `LanguageModelAdapter` (model-next) is a **live object** — it cannot cross the spec
firewall into the reconciler/IR (JSON only). So, mirroring `ToolBridge` (`handlerRef`
in the IR ↔ live handler on the bridge):

- **IR** carries `RuntimeDeclarations.model?: { modelRef: string; parameters?: … }` — pure data.
- **Bridge** (`ModelBridge`) maps `modelRef → RegisteredModel` — the live side.
- **Loop** resolves the ref per tick and runs the resolved executor+target.

`RegisteredModel` is **spec-typed** so the loop and `reconciler-react` never import
model-next:

```ts
// spec — the resolved, run-ready model (both fields already spec types)
export interface RegisteredModel {
  readonly executor: ExecutorProtocol<unknown, unknown, LanguageModelExecutionResult>;
  readonly target: ExecutionTarget;
}
export interface ModelBridge {
  register(modelRef: string, model: RegisteredModel): Unsubscribe;
  unregister(modelRef: string): void;
  resolve(modelRef: string): RegisteredModel | undefined;
}
```

Post-ADR-52 there is ONE executor that consumes an adapter, so a "per-model executor"
is just that one executor constructed with that model's adapter. Whoever owns the
adapter constructs the `RegisteredModel` and registers it — the session for its
default, the (deferred) `<Model>` sugar for a tree-declared one. `reconciler-react`
stays adapter-agnostic; it only threads spec-typed `RegisteredModel`s.

## Design (the core — this ADR)

### spec
- `ModelBridge` + `RegisteredModel` in `hook-bridges.ts`; seed `HookBridges.models?: ModelBridge` (optional foundational slot, exactly like `tools?: ToolBridge`).
- `RuntimeDeclarations.model?: ModelDeclaration` where `ModelDeclaration = { modelRef: string; parameters?: Readonly<Record<string, unknown>> }`. Single (one model per tick); nearest-scope / last-wins if a tree nests several.

### reconciler-react (generic — adapter-agnostic)
- A render-time registration hook `useModelRegistration(modelRef, resolved: RegisteredModel)`: registers on `bridges.models` (via the bridge context, like `useToolBridge`) and contributes `declarations.model = { modelRef }` to the IR for this render. Unregisters on unmount.
- The reconciler collects `declarations.model` into `RenderedTree` alongside `declarations.tools`.
- **No adapter knowledge here** — the resolved `{executor,target}` is handed in spec-typed.

### loop-executor
- Per tick, after render: read `renderResult.tree.declarations.model`. If present,
  `bridges`… no — the loop already holds `input.reconciler`; the resolution needs the
  `ModelBridge`. Thread a `resolveModel?: (ref: string) => RegisteredModel | undefined`
  onto `RunExecutionInput` (session supplies it, closing over the mount's `ModelBridge`)
  — symmetric with `resolveRenderContext`. Resolve `decl.modelRef → RegisteredModel`;
  run **that** `executor`+`target` (merging `decl.parameters` over `target`) for the tick.
- **Fallback:** no IR model → `input.executor` / `input.target` (today's behavior, untouched). This is the precedence: tick-IR wins, else send/session.

### session
- Build the `ModelBridge` (a small in-memory registry, reference impl in `reconciler-next` alongside `InMemoryDataBridge`) into the mount bridges; supply `resolveModel` to the loop closing over it. No default registration needed — the fallback covers the un-declared case.

### Tests
- `reconciler-react` integration: `useModelRegistration` with a **fake** `RegisteredModel` (Meszaros `fakeExecutor` + a target) → a real loop run resolves the ref and runs the fake executor for the tick, not `input.executor`. Precedence test: IR model beats the send/session executor; no IR model → fallback.

## Deferred (explicit follow-up slices — filed off #169)

1. **Adapter-aware `<Model model={adapter}>` sugar.** The adopter face — takes a
   model-next `LanguageModelAdapter`, derives `{executor,target}`, calls
   `useModelRegistration`. Needs a home that deps BOTH `reconciler-react` + `model-next`;
   none exists today. → new **`model-react-next`** binding package (per the
   framework-bindings convention), or fold into the **#161** metapackage. **A package
   decision — deferred out of the core.** Until it lands, the mechanism is exercised via
   the generic hook + `models:`-style registration.
2. **Force-render / dynamic `activeModel`.** Making the render-context `activeModel`
   (ADR 55) reflect the *IR-declared* model requires render → resolve → re-render to
   convergence (the model isn't known until after the render that declares it). The
   per-tick *execution* model (this ADR) has NO chicken-and-egg — it's resolved
   post-render, before the call. Dynamic render-context activeModel is a distinct,
   additive slice on the stabilization loop. → follow-up; the ADR 55
   `TODO(trail-per-tick-model)` markers point here.

## Rejected
- **Adapter value in the IR.** Live object across the JSON firewall — impossible; the
  whole reason for the ref+bridge split.
- **`ModelBridge` registers a raw adapter (`unknown`).** Then the loop must construct an
  executor (it can't — no model-next) and spec can't type it. Register the spec-typed
  `RegisteredModel` (executor already wraps the adapter). One owner constructs it where
  adapters live.
- **Per-provider `<GoogleModel>`/`<OpenAIModel>` components.** Adapters are first-class
  values now (ADR 52); one `<Model model={adapter}>` replaces the family. (v2 has none
  yet — nothing to delete; the sugar lands fresh in slice 1.)

## Scope
Core (spec bridge+IR, reconciler-react generic registration, loop per-tick resolution +
precedence, session wiring, tests) = this ADR, delegable with fakes. Adapter sugar +
force-render = the two deferred slices above.
