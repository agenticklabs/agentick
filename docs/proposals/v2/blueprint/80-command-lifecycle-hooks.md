# ADR 80 — Command lifecycle: intrinsic observe/transform hooks across all harnesses

**Status:** PROPOSED 2026-07-13 (Fable, for Ryan)
**Depends on:** ADR 26 (harness as the single shape), ADR 27 (modular built-ins / module augmentation), ADR 31 (self-similar harness hierarchy), ADR 45 (runtime context), ADR 51 (invocation model — `command()` + `runOperation`), ADR 76 (operation-middleware scoping + the `liftMiddleware` fiber fix)
**Fixes:** #17-adjacent (the `onBeforeModelGenerate` seam media reconciliation needs), the three-fragmented-lifecycle-vocabulary problem, the loop-coupled/observer-only `useOn*` surface, the session lifecycle vacuum
**Adjacent:** ADR 52 (executor/adapter split — where `model:generate` lives), ADR 55 (render-context), ADR 56 (tree-declared per-tick model — why a construction-time model wrapper is wrong), ADR 57 (the `LanguageModelInput` currency reshaped by `onBeforeModelGenerate`), ADR 74 (media normalization — one consumer of `onBeforeModelGenerate`)

## TL;DR

Every harness verb declared through `this.command("<who>:<what>", …)` should automatically expose a **lifecycle surface** with two faces:

- **Events** — `<who>-<what>-<phase>` (`model-generate-start`), out-of-band on the bus, fire-and-forget, wire-projectable, hierarchically subscribable. **Observe.**
- **Hooks** — `onBefore<Who><What>` / `onAfter<Who><What>` (`onBeforeModelGenerate`), in-band, awaited, ordered, transform-capable. **Participate.**

Both are a **total function of the command id**: `event = <who>-<what>-<phase>`, `hook = on + Before|After + PascalCase(<who>:<what>)`. You get the name right by naming the command right.

This is **not a new subsystem.** `command()` already routes through `runOperation`, which already emits phase envelopes (the events) and already composes operation middleware (the hooks). The work is (a) expose the surface ergonomically + typed via module augmentation, (b) route the verbs that still bypass `runOperation` (session `send`/`render`/`dispatch`), (c) fix ownership so each dispatcher fires standalone. Hooks **are** middleware entries — so they inherit ADR 76's `liftMiddleware` fiber-preservation fix verbatim, and `Hooks` is a **capability of `BaseHarness`, not a harness**.

## The problem — three lifecycle vocabularies, none complete

Audits across `reconciler`, `loop-executor`, `executor`, `model`, `tool-executor`, `session`, `app` found **three disjoint mechanisms** that all want to be the same thing, plus dead spec:

1. **`LifecycleStore` + `useOn*`** (`reconciler/src/lifecycle-store.ts`) — the React-facing family (`useOnTickStart`, `useOnToolStart`, …). **Observer-only by construction**: handlers are `(event) => void | Promise<void>`, return discarded (`lifecycle-store.ts:173`). **Loop-fed, not layer-owned**: `useOnToolStart` is dispatched by the loop, not the tool-executor, so it does not fire when a harness runs standalone.
2. **`runOperation` phase envelopes** (`runtime/src/substrate/base-harness.ts:814/823/877`) — `requested → before → terminal` per command. Observer bus events. Fire standalone. This is the *real* runtime lifecycle.
3. **Operation middleware** (`.use` / `.fx.use` / `app.use`, `base-harness.ts:607/631`) — the only **transform** primitive that exists. The tool-executor's `.fx.use` already rewrites tool input (`next(reshaped)`) and output — the proven seam.

Dead/partial: `ToolLifecycleEvent` (9 kinds, `spec/src/protocol/tool-executor.ts:374`) is **designed but never emitted**; `useOnError` has a binding but **no producer**; the reconciler emits **zero** compile events (`renderTreeBody` never touches `state.lifecycle`); the `project → call` model boundary has **no** before/after transform seam (nothing sits between `loop-executor/src/harness.ts:412` and `:416`); and session `send`/`render`/`dispatch` **bypass `runOperation` entirely** (`session/src/harness.ts:552`, TODO `:1002`), so the session has no phase envelopes, no hooks, no middleware of its own — a lifecycle vacuum.

The consequence: extending any harness's behavior around its verbs is inconsistent (three ways), incomplete (no compile/model transform, no session seam), and unsafe for standalone use (loop-coupled). A media reconciler, a redaction pass, an audit sink, a cache — each has to pick a different, partial mechanism.

## Decision

### 1. Lifecycle is intrinsic to `command()`

When any harness declares `command("<who>:<what>", spec)`, the base harness endows it with the lifecycle surface automatically. There is no privileged set of "core" lifecycle points — compile is `reconciler:render`, the model call is `model:generate`, tool dispatch is `tool:execute`, ingestion is `timeline:append`, a knob write is `knob:set`, an elicitation is `elicitation:request`. **Every verb, every harness, uniformly.** Ownership follows command ownership, which makes standalone-firing structural rather than hand-assigned.

### 2. Two surfaces: events (observe) + hooks (participate)

They are not two ways to do one thing — the split is coupling + timing + power, the same distinction as DOM events vs middleware, or a bus topic vs an interceptor:

| | Event | Hook |
|---|---|---|
| binding | subscribe to the bus | register a callback |
| timing | out-of-band, fire-and-forget | in-band, in the op's fiber, awaited |
| power | observe only | observe **and** transform / veto |
| reach | wire-projectable (telemetry, devtools, remote clients) | local only (policy/code — never crosses the wire) |
| realized by | `runOperation` phase envelopes | operation middleware entries |

A telemetry sink takes the event (decoupled, over the wire). A media reconciler takes the hook (in-band, reshapes the input). Observing via a void-returning hook is possible but reserved for when you need in-band ordering; pure watching subscribes to the event.

### 3. Naming — a total function of the command registry

- **Event:** `<who>-<what>-<phase>` (kebab), `phase ∈ {start, end}` (+ `error`). Matches the existing stream kinds (`tool-dispatch-start`, `tick-start`) and nests for subscription: `model-generate-*`, `model-*`.
- **Hook:** `on` + `Before|After` + `PascalCase(<who>:<what>)` (camel). Idiomatic JS (`onBeforeUnload` is `on[when][what]`).

The name is **derived, not chosen** — every command mints exactly four surfaces (two events, two hooks) mechanically, all greppable, zero per-hook judgment. The corollary is the discipline: **you get the hook name right by naming the command right.** This surfaces command-naming inconsistencies instead of hiding them — e.g. it forces `tool:dispatch → tool:execute` so the hook reads `onBeforeToolExecute` (a cleanup, `tool-executor/src/harness.ts:172`).

### 4. The hook contract

```ts
type BeforeHook<In, Ctx> = (input: In,  ctx: Ctx) => In  | void | Promise<In  | void>;
type AfterHook<Out, Ctx> = (output: Out, ctx: Ctx) => Out | void | Promise<Out | void>;
```

- **Before** receives the command's input, returns the (possibly reshaped) input that flows to the method.
- **After** receives the command's output, returns the (possibly reshaped) output.
- **Return the value → transform. Return `void` → passthrough/observe. Throw → veto/abort** (a typed error in the Effect channel — no verdict DSL needed).
- Async allowed. Multiple hooks compose as an **onion**: before-hooks outer→inner threading the input; after-hooks inner→outer threading the output.

`ctx` is the **RuntimeContext** (ADR 45): scope (`sessionId`/`executionId`/`tickId`), the resolved `target`/model (so `onBeforeModelGenerate` knows which provider it is reshaping for — ADR 56), `opId`, identity, `telemetryNamespace`, and the cascaded hooks context itself. This is the explicit-`ctx`-into-methods contract: everything a hook reads arrives on `ctx`; everything it returns threads forward.

### 5. Registration — declarative `hooks` object + imperative accessor

**Declarative** (the 90%): a single `hooks: {}` object accepted in any harness config.

```ts
createApp(<Agent />, {
  model: aisdk(openai("gpt-4o")),          // config stays config
  hooks: {                                  // one augmentable, cascading namespace
    onBeforeModelGenerate(input, ctx) { return reconcileMedia(input, ctx.target) },
    onAfterTimelineAppend(entry)      { audit(entry) },                 // observe (void)
    onBeforeToolExecute(input, ctx)   { if (blocked(input)) throw new VetoError() },
  },
});
```

`CommandHooks` is an **empty-seed interface** (the `HookBridges` pattern, ADR 27). Each harness package augments it with its **exposed** verbs, typed to their I/O:

```ts
declare module "@agentick/spec-next" {
  interface CommandHooks {
    onBeforeModelGenerate?:  BeforeHook<LanguageModelInput, RuntimeContext>;
    onAfterModelGenerate?:   AfterHook<LanguageModelExecutionResult, RuntimeContext>;
    onBeforeTimelineAppend?: BeforeHook<TimelineAppendInput, RuntimeContext>;
    onAfterTimelineAppend?:  AfterHook<TimelineEntry, RuntimeContext>;
    // …contributed per-package
  }
}
```

**Exposure gate.** Only commands declared `exposure: "public"` contribute keys (mirroring tool `audience` / wire `exposure`). So `onBeforeKnobSet` exists but an internal `knob:_reconcile` never surfaces — the gate is what keeps "every command is hookable" from becoming "every invariant is user-breakable."

**Imperative** (runtime dynamic): `harness.hooks` is an ordered accessor over the same registry.

```ts
const off = session.hooks.append("onBeforeToolExecute", fn); // run inner (later)
session.hooks.prepend("onBeforeModelGenerate", fn);          // run outer (earlier)
session.hooks.remove(handle); off();
session.hooks.fx.append("onBeforeModelGenerate", effectFn);  // Effect-native (§7)
```

Declarative is one-per-key-per-scope; imperative covers many/dynamic. **Rejected placements:** `model: { onBeforeGenerate }` (collides with the `model` config key *and* re-binds hooks to a construction-time model — the tree declares the model per tick, ADR 56, so a config-scoped model hook goes dark the instant the tree picks another); and hoisting `onBeforeModelGenerate` flat into options (turns the options object into a grab-bag).

### 6. Cascade & scope

Gateway ⊃ App ⊃ Session ⊃ Execution ⊃ command. A `hooks` object at any scope **cascades down** to all descendants and **composes as an onion** (not override): gateway-before outermost → app → session → execution → command; afters reverse. This is the *existing* operation-middleware inheritance (`ownAndInheritedMiddleware`, `base-harness.ts:631`, ADR 76) — hooks inherit it for free because hooks are middleware. Gateway is the new top tier (already the apps' construction parent), making it the home for deployment-wide policy: audit every `tool:execute`, redact every `model:generate`, across all apps.

Mechanically, the `hooks` object rides the **RuntimeContext** down the tree, and `command()` self-wires the match: declaring `command("<who>:<what>")` looks up `hooks.onBefore<Who><What>` / `onAfter<Who><What>` from the ambient context and installs them on that command. No per-harness filtering code — the wiring lives in `command()`.

### 7. Fiber-threading — hooks are middleware entries (hard invariant)

Because a declarative hook **desugars to a `.use` / `.fx.use` registration** on its command, hooks flow through the exact chain `liftMiddleware` governs and inherit ADR 76's fix verbatim: the continuation is `Runtime.runFork`'d on the **ambient** runtime (`Effect.runtime()`), not the default one, so RuntimeContext, span-nesting, the tier-4 `CallMiddlewareRef`, and interruption all survive the async boundary.

> **Invariant:** a `hooks` entry compiles *into* the command's existing middleware chain — never a bespoke "hook runner" side-path. A parallel invocation path bypasses `liftMiddleware` and reintroduces the fiber-severing bug ADR 76 killed. If we catch ourselves writing a dedicated hook-dispatch loop, we have broken this.

"Solved" means the *continuation* is fiber-preserved. A JS-form hook's own synchronous body between `await`s is inherently outside the Effect fiber — fine for reshape/observe (media included). The `.fx` form is for hooks whose *body* must be in-fiber (open a span wrapping the inner op, be interruptible mid-body) — exact `.use` vs `.fx.use` parity:

- `hooks: { onBeforeModelGenerate(input, ctx) {…} }` — JS form, continuation-preserved. The 90%.
- `session.hooks.fx.append("onBeforeModelGenerate", …)` — Effect-native, fully in-fiber.

### 8. `Hooks` is a capability of `BaseHarness`, not a harness

Tempting under "everything is a harness," but wrong, for reasons tied to what a harness *is* (snapshotable state + wire-projectable commands + inbox identity):

1. **Its "state" is functions, not data** — unserializable, so it can't round-trip through a store (ADR 49). A harness whose state can't persist isn't one.
2. **It must never cross the wire** — hooks run arbitrary code in the op's fiber; they're policy. The main reason to make something a harness (wire projection + remote commands) is exactly what you must deny it.
3. **Meta-regress** — a `Hooks` harness would itself have `command()`-intrinsic hooks (`onBeforeHooksAppend`?); you'd special-case it to stop the loop, and **needing to special-case a "harness" is the tell it isn't one.**

`Hooks` is the command-middleware registry every `BaseHarness` already owns, exposed as the cascaded declarative object (§5) + the `.hooks` accessor. A **facet, not a subject** — which keeps the mechanism intrinsic to `command()` instead of lifted back into a parallel subsystem.

## Worked examples

**`model:generate` — provider-aware media reconciliation** (the thread this ADR was born from). The seam is reconciler-agnostic (React, ADR-44 functional, or custom), executor-owned (fires for `executor.run()` standalone), fires with the per-tick resolved target, and is async:

```ts
hooks: {
  onBeforeModelGenerate(input /* LanguageModelInput */, ctx) {
    return reconcile(input, ctx.target); // pull-once+inline / passthrough-native / fileId→URI
  },
}
```

The hardest-looking requirement in the originating thread lands in the plainest possible hook: read `ctx.target`, await the resolver, return reshaped `LanguageModelInput`. JS form + the §7 continuation fix cover it — no `.fx`, no in-fiber body.

**`timeline:append` — ingestion.** There was never a separate "ingest layer"; ingestion of model output and tool results *is* the timeline's append verb. `onBeforeTimelineAppend` gates/reshapes what persists (dedup, redact, annotate); `onAfterTimelineAppend` observes the committed entry.

## Scope — slices (landable independently)

- **Slice 0 (prerequisite).** Route session `send`/`render`/`dispatch` through `runOperation` (the ADR-51 session-verb migration, TODO `session/src/harness.ts:1002`). Without it the session stays a lifecycle vacuum; this unblocks `onBefore/AfterSessionSend` and clean `timeline:append` ingest hooks.
- **Slice 1 (the mechanism).** The cascaded `hooks` RuntimeContext + `command()` self-wiring; the augmented `CommandHooks` empty-seed interface + per-command exposure gate; the `.hooks` imperative accessor (`append`/`prepend`/`remove`/`off` + `.fx`); derived `<who>-<what>-<phase>` event names; the §7 fiber invariant. Ship with **three exposed commands** — `model:generate`, `timeline:append`, `tool:execute` (with the `tool:dispatch → tool:execute` rename). Mergeable on its own.
- **Slice 2 (accretion).** Every other harness augments `CommandHooks` when ready (documented per-package checklist) — no big-bang. Wire or delete the dead spec: `ToolLifecycleEvent` (adopt its 9 kinds as the tool op's phase vocabulary, or remove) and `useOnError` (wire a producer or remove).

The React `useOn*` family is retained as **sugar over the same registry**: `useOnBeforeModelGenerate` registers into the command's middleware chain during render; a non-React reconciler registers into the same registry without React. The store's observer-only handlers become one consumer of the events, not a separate mechanism.

## Rejected

- **A dedicated `Hooks` harness** — §8.
- **A parallel hook-dispatch path** — §7; breaks fiber preservation.
- **Config-key-scoped hooks (`model: { onBeforeGenerate }`)** — §5; collides with config, binds to a static model.
- **One `[when]` vocabulary for both surfaces** — events say `start/end` (observe a timeline), hooks say `before/after` (a participant's position). Forcing symmetry erases the observe-vs-participate distinction the two surfaces exist to carry.
- **Making every command transform-hookable by default** — the exposure gate is deliberate; unrestricted transform hooks on internal verbs are an invariant-safety hole.

## Tests

- **Naming is a total function** — a command id yields exactly its four derived names; a renamed command renames its surfaces (regression gate for `tool:dispatch → tool:execute`).
- **Transform contract** — before reshapes input reaching the method; after reshapes output; `void` = passthrough; `throw` = veto (op aborts with the typed error); across N scopes composes onion-ordered.
- **Fiber preservation** — a JS-form `onBeforeModelGenerate` that awaits still sees the ambient RuntimeContext in its continuation, nests spans, and is interruptible (the ADR-76 characterization, re-run through a hook). Proof that hooks route through `liftMiddleware`, not a side-path.
- **Cascade** — a gateway-level `onBeforeToolExecute` fires for a tool executed in any app's session; app/session/execution scopes compose.
- **Standalone ownership** — `executor.run()` alone fires `model:generate` hooks + `model-generate-{start,end}`; `renderTree()` alone fires `reconciler:render` hooks; neither depends on the loop.
- **Exposure gate** — a non-public command contributes no `CommandHooks` key and rejects imperative registration.
- **Worked example** — `onBeforeModelGenerate` media reconciliation swaps an `s3`/`gcs`/`base64` source to a provider-consumable form before `buildParams`, keyed off `ctx.target.provider`.

@see ADR 76 (the middleware + fiber substrate this rides), ADR 27 (the augmentation pattern), ADR 57/74 (the `model:generate` currency + its media consumer), ADR 51 (the `command()`/`runOperation` invocation model + the session-verb migration this depends on).
