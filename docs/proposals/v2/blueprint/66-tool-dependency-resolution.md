# ADR 66 — Tool dependency resolution: dispatch-resolved `ctx` extensions vs render-captured `use` deps

**Status:** ACCEPTED 2026-07-08 (Fable, for Ryan). **Builds on:** ADR 27 (empty-seed
module augmentation — `HookBridges`), ADR 43 (`ToolHandlerCtx` unification), ADR 51
(declared commands). **Unblocks:** dispatch-as-command + abort-as-command (tool-executor
adopts `command()`).

## The two dependency-injection modes a tool handler sees

A tool handler runs at **dispatch** time (when the tool is called), which is temporally
and contextually separate from **render** time (when the JSX tree is built). It needs two
categories of input, and they resolve very differently:

1. **The tool input** — the model's call arguments. JSON-serializable **by nature**. The
   caller (model / inbox / wire) supplies it: `{ name, input, scope }`.
2. **Execution dependencies** — services the handler needs but that aren't in its input:
   the sandbox, an MCP client, elicitation, tasks, resources, a tree-scoped provider value.

Category 2 has, historically, been served two ways:

- **`use` — render-time DI (capture).** `<Tool use={() => ({ sandbox: useSandbox() })}>`
  runs at render, captures tree values, stashes them on the registration
  (`reg.useDeps`), and injects them at dispatch as `deps.use`. Opaque
  (`Record<string, unknown>`), captured (stale relative to render cadence), and
  **non-serializable** (live closures/objects) — which is exactly why it made dispatch
  input look unserializable.
- **`ctx.*` — dispatch-time DI (resolve).** `ctx.elicit`, `ctx.tasks`, `ctx.resource`,
  `ctx.log`, `ctx.progress` — typed slots the executor populates **at dispatch** from the
  live session/app harnesses. Fresh, typed, no capture, serialization-boundary-clean.

## Principle

**Session-/app-scoped harnesses are dispatch-resolved via a typed, augmentable
`ToolHandlerCtx` seam. `use` is reserved for genuinely tree-positional context.**

- **Tree-positional context** — a value set by an _ancestor provider_ at a specific tree
  position, reachable only during render (`<Provider value={x}><Tool use={…}/>`). This is
  the irreducible core of `use`; it cannot be dispatch-resolved because it lives in the
  tree, not in any registry. Keep `use` for exactly this — and it is a minority.
- **Everything else** (sandbox, MCP refs, and the already-migrated elicit/tasks/resource/
  log/progress) belongs on `ctx`, resolved at dispatch. `use` is the escape hatch of last
  resort, never the default.

## The seam (mirrors `HookBridges`, ADR 27)

- **spec** declares an empty seed `interface ToolHandlerCtxExtensions {}`, and
  `ToolHandlerCtx extends ToolHandlerCtxExtensions`. Spec stays harness-agnostic — it
  hardcodes no optional harness.
- **each optional harness augments it** — e.g. sandbox:
  `declare module "@agentick/spec" { interface ToolHandlerCtxExtensions { readonly sandbox?: SandboxBridge } }`.
  Optional (`?`) because not every deployment mounts it. (Augmentation is _required_ here,
  not merely tidy: there is no spec-level sandbox protocol, so spec could not hardcode it
  even if it wanted to.)
- **the executor stays harness-agnostic** — it takes one generic construction option,
  `ctxExtensions?: Readonly<Record<string, unknown>>`, and spreads it onto every `ctx` it
  builds. It never imports sandbox. The _type_ of `ctx.sandbox` comes from the
  augmentation; the _value_ comes from the wiring layer.
- **the single construction site (AppHarness) fills the values** — it depends on the
  extension packages, resolves the live harness from the app/session bridges
  (`bridges.sandbox`), and passes `{ sandbox: … }` as `ctxExtensions` when present.

This is the same shape as `HookBridges` — a generic bundle, typed by augmentation, filled
by harnesses — but resolved at **dispatch** from the live bridge (a single source of
truth), not captured at render into an opaque bag. That distinction resolves every `use`
smell (opacity, staleness, serialization hole, render-coupling) for everything migrated to
`ctx`.

## Consequence: this is what makes dispatch a serializable declared command

Once execution dependencies are dispatch-injected via this seam rather than bundled into
the dispatch _input_, a dispatch's caller-supplied input is cleanly `{ name, input, scope }`
— serializable. That unblocks:

- **dispatch-as-command** — `tool:command:dispatch` becomes a real `this.command()`:
  journaled, provenance/principal-stamped (dispatch is _the_ model-originated action, the
  ADR-51 §5/§6 capability-policy subject), and inbox/wire-dispatchable (`session.dispatch`
  by name over the wire).
- **abort-as-command** — `AbortInput { toolCallId, reason? }` is already serializable;
  making it a declared command lets `BaseHarness` auto-route inbox abort to **both** the
  reference harness and every `defineX` callback variant, closing the callback-abort gap
  (was tracked as a `handleMessage`-not-wired symptom) at its root.

## Consequences / scope

- v2.0 ships the seam + `ctx.sandbox` as the first adopter; `use`-for-sandbox is retired
  (the `<Tool use={() => ({ sandbox: useSandbox() })}>` pattern becomes
  `ctx.sandbox!.exec(...)`).
- The seam generalizes to any optional harness (custom MCP refs, future ones) with zero
  spec churn.
- `use` remains for tree-positional context only.
- Migrating the currently-hardcoded universal slots (elicit/tasks/resource/log/progress)
  onto the same seed is an optional consistency follow-on, not required by this ADR.
- dispatch-as-command + abort-as-command are the natural next builds this seam unblocks;
  each gets its own slice.
