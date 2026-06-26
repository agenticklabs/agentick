# ADR 39 — JSX template walker: one IR, two evaluation contexts

**Status:** Proposed · 2026-06-26
**Builds on:** ADR 22 (StateBridge + Formatters), ADR 27 (Modular built-ins),
ADR 26 (Harness as the single shape)
**Touches:** new `@agentick/jsx-walker-next` + `@agentick/jsx-template-next`
packages; refactor of `@agentick/reconciler-react-next`; consumed by
`PromptDeclaration` (#121), `Resource` runtime (#123), tool descriptions,
and the future MCP server harness (#171).

## TL;DR

**JSX is the universal authoring format for any piece of model-context
content** — prompts, resources, tool descriptions, system-prompt
boilerplate, error messages — and there are two ways to evaluate it:

- **Live** — full reactive walker (reconciler-react-next, hooks +
  scheduler + commit pipeline).
- **Snapshot** — pure static walker (jsx-template-next, compile-until-
  stable, no reactivity).

Both walkers consume the **same dispatch table** and produce the **same
`RenderedTree` IR**. They differ only in how they handle the **effect
channel** an intrinsic can emit. This collapses an asymmetric two-walker
problem into a single dispatch table with two evaluation modes.

`render(Template, props)` is **always `Promise<string>` (or
`Promise<ContentBlock[]>`)** — compile-until-stable means `useData` can
suspend at any depth, so the contract is async at every call site.

## Motivation

Today the only path from JSX to model context is through
`reconciler-react-next`'s reactive mount lifecycle: `mount → renderOnce →
commit → renderToString`. That pipeline is right for live agent UIs but
wrong for at least four other use cases that the v2 roadmap already
needs:

1. **PromptDeclaration** (#121) — adopters author MCP prompts in JSX.
   The MCP server harness (#171) calls `prompts/get` and serializes to
   markdown over the wire. No reactivity required; no mount lifecycle
   wanted.
2. **Resource runtime** (#123) — `<Resource uri="..." />` files
   exported as JSX. Re-rendered on each MCP `resources/read` for fresh
   data (via `useData`). Same shape as prompts.
3. **Tool descriptions** — `createTool({ description: <Paragraph>...</Paragraph> })`
   compiled to markdown once at registration. Lets adopters embed
   `<Code>`, `<List>`, structured examples in tool docs without
   handcrafting markdown strings.
4. **Framework-shipped templates** — system-prompt boilerplate, tool-
   execution error formatting, DevTools tool-description rendering. The
   framework eats its own dogfood; adopters override by passing a
   different template.

A standalone CLI (`agentick render path/to/template.tsx`) and snapshot-
testable templates fall out of the same primitive for free.

## Context

`reconciler-react-next` already separates a `RenderedTree` IR (lives in
`@agentick/spec-next`) from the formatter pass. The seam exists: the
serializer (`RenderedTree → string`) is pure; the walker (`JSX →
RenderedTree`) is the part entangled with react-reconciler's commit
pipeline.

The static walker we want has none of that entanglement. It's a pure
recursive function over React elements:

- string / number → text node
- Fragment → recurse children
- function component → call it with props, recurse on result
- host element → look up in dispatch table, emit `{ ir, effects }`
- thrown Promise (compile-until-stable) → await + retry

The reactive walker has the same skeleton but runs inside react-
reconciler's commit pipeline, where hooks (`useState`/`useEffect`/
`useSignal`) are valid and the scheduler coordinates re-renders.

## Decisions

### D1 — Uniform IR, effect channel is the context-dependent part

Every intrinsic in the dispatch table emits the **same shape**:

```ts
interface IntrinsicResult {
  readonly ir?: IrNode | IrNode[];          // content — uniform across walkers
  readonly effects?: readonly Effect[];     // side effects — context-dependent
}

type IntrinsicHandler = (
  props: unknown,
  children: ReactNode,
  visit: (n: ReactNode) => IrNode[],        // recursion handle into the walker
) => IntrinsicResult;
```

Both walkers run the same dispatch table. They differ ONLY in what they
do with `effects`:

- **Static walker** — any non-empty `effects` → throw with a precise
  error naming the intrinsic and why it can't appear in a snapshot.
- **Reactive walker** — `effects` → dispatch through `HookBridges`
  (existing tool-register / knob-bind / channel-subscribe / etc.).

This collapses the previously-imagined `PURE_INTRINSICS` vs
`REACTIVE_ONLY_INTRINSICS` partition. Adding a new intrinsic is **one
entry** in the table; whether it works in static is determined by
whether it emits effects.

### D2 — Templates are React function components, no wrapper required

A template is a **default export of a function component** that uses
only walker-portable APIs:

```tsx
// prompts/explain-code.tsx
export default function ExplainCode({ language }: { language: string }) {
  const examples = useData(`examples:${language}`, () => fetchExamples(language));
  return (
    <>
      <H1>Code Explanation — {language}</H1>
      {examples.map((e) => <Code key={e.id} language={language}>{e.body}</Code>)}
    </>
  );
}

// caller
import ExplainCode from "./prompts/explain-code.js";
const md = await render(ExplainCode, { language: "TypeScript" });
```

No `defineTemplate(...)` ceremony. The framework concept is "a template
is a function component that emits no effects." Composition is React
composition.

A `TemplateComponent<P>` type alias is provided for documentation +
optional type-level enforcement (lint rules can refuse to import
`useState` into a `TemplateComponent`), but the framework doesn't
require it at runtime — duck-typing wins for adopter ergonomics.

### D3 — `render()` is always async

```ts
function render<P>(template: TemplateComponent<P>, props: P, opts?: RenderOptions): Promise<string>;
function renderToBlocks<P>(template: TemplateComponent<P>, props: P, opts?: RenderOptions): Promise<readonly ContentBlock[]>;
```

`useData` (and any other suspend-via-throw primitive) can fire at any
depth, so the compile-until-stable loop is async at every call site.
Adopters who need a hard "no data fetching" contract use `renderSync()`
which throws if any walker-portable hook suspends; useful for the few
cases where the caller wants to assert determinism up front.

### D4 — Walker-portable vs reactive-only APIs

| API                                            | Static walker          | Reactive walker     |
| ---------------------------------------------- | ---------------------- | ------------------- |
| `useData(key, fetcher)` — suspend via throw    | ✓ (await + retry loop) | ✓ (existing)        |
| `useResource`, similar suspend-via-throw       | ✓                      | ✓                   |
| `useState`, `useEffect`, `useSignal`, channels | **throw**              | ✓                   |
| Control flow (`.map()`, conditionals, etc.)    | ✓                      | ✓                   |
| `<Section>`, `<Message>`, semantic content     | ✓                      | ✓                   |
| `<Tool>` (emits register effect)               | **throw**              | ✓ (register effect) |
| `<Knobs>`, `<MCP>`, reactive scopes            | **throw**              | ✓                   |

The trick: `useData` doesn't have to be a true React hook. The thrown-
Promise blocking pattern is just `throw` + `await` + `catch` — no
React-dispatcher dependency. Implementing it as a plain function called
inside a function component means both walkers honor it. True hooks
(useState et al.) need React's dispatcher and stay reactive-only.

### D5 — Reconciler-agnostic IR

`RenderedTree` already lives in `@agentick/spec-next`. The dispatch
table operates on a normalized AST — it doesn't care that React
elements are the input shape. Future reconcilers (Angular, Solid,
custom AST) provide their own AST-walking layer that emits into the
same dispatch table and produces the same IR.

This is the move that makes Agentick **truly** reconciler-pluggable
instead of reconciler-pluggable-in-theory-React-pinned-in-practice. The
IR is the lingua franca; the dispatch table is the contract.

### D6 — Reactive apps can mount static templates as leaves

A live reactive app can include a static template as a child component.
The reactive walker hits its function component, calls it with no
React-specific context, recurses on its output. Works because templates
only use walker-portable APIs.

The asymmetry is intentional: **static→reactive is fine** (a snapshot is
a snapshot); **reactive→static throws** (a hook is a hook).

### D7 — Cache invalidation lives at the data source

Each `render()` call re-evaluates `useData`. If the fetcher returns
cached data, the render is fast; if the cache busts, fresh data lands on
the next render. The template is stateless about freshness — that's the
data source's job. Simple model.

For "render whenever I want a fresh snapshot": just call `render()`
again. For "subscribe to updates": that's what the reactive walker is
for; use it instead.

## Package layout

```
@agentick/jsx-walker-next/          — new (shared dispatch table + walker core)
  src/
    dispatch-table.ts               — INTRINSICS: Record<tag, IntrinsicHandler>
    walk.ts                         — pure recursion, mode-agnostic
    use-data.ts                     — walker-portable thrown-Promise primitive
    effects.ts                      — Effect types (ToolRegister, KnobBind, ...)
    intrinsics/                     — per-tag handlers (section, message, h1, ...)

@agentick/jsx-template-next/        — new (static evaluation context)
  src/
    render.ts                       — async render + compile-until-stable loop
    render-sync.ts                  — throws if any hook suspends
    template-component.ts           — TemplateComponent<P> type alias

@agentick/reconciler-react-next/    — refactored
  src/
    harness/                        — unchanged externally
    host/host-config.ts             — delegates to jsx-walker-next dispatch table
```

Reconciler-react-next still owns the reactive scaffold (hooks, scheduler,
commit pipeline, bridges). Its host-config no longer carries intrinsic
semantics — those move to `@agentick/jsx-walker-next/intrinsics/`. The
reactive walker calls into the shared table during commit; static
walker calls into the same table during recursion.

## Rollout

**Phase 1 — Build static walker (parallel, no touch on reconciler-react-next).**
Carve `@agentick/jsx-walker-next` with the dispatch table + pure
recursive walker. Build `@agentick/jsx-template-next` with `render()` /
`renderToBlocks()` / `renderSync()`. Ship snapshot testing helpers.
Verified by its own suite. **~3 days. Zero risk to existing tests.**

**Phase 2 — Adopt downstream.** Wire jsx-template-next into:

1. Tool description compilation (createTool's `description` accepts
   `ReactNode`; renders to markdown at registration).
2. PromptDeclaration runtime (#121) — `<Prompt>` is a template.
3. Resource runtime (#123) — `<Resource>` is a template.
4. MCP server harness (#171) — `prompts/get` and `resources/read`
   dispatch to template renders.

**~3 days, can be parallel-ized across the four sites.**

**Phase 3 — Differential gate + refactor reconciler-react-next.**
Feed `@agentick/jsx-template-next` every static JSX input from the
existing 1925-test reconciler-react-next corpus. Assert identical
`RenderedTree` output. Once parity is proven, refactor reconciler-react-
next's host-config to delegate intrinsic handling to the shared
dispatch table. Delete duplicated logic. **~3–5 days. Differential
gate IS the safety net — if the full suite stays green after the
delegation refactor, we're safe.**

Phase 3 is optional from a correctness standpoint; jsx-template-next
and reconciler-react-next can coexist with independent walkers
indefinitely. Phase 3 collapses the duplication.

## Concerns

- **Async render contract.** Adopters must remember to await. Document
  loudly; provide `renderSync()` for callers who want a hard "no
  suspending" guarantee.
- **Determinism boundary.** If a `useData` fetcher is non-deterministic
  (clock, random, network), so is the template. Snapshot tests need
  stable fixtures. Worth a "Determinism" docs section.
- **Type-level enforcement.** `TemplateComponent<P>` is duck-typed at
  runtime — users CAN call `useState` inside a template and the walker
  catches it. A lint rule (or branded type) gives compile-time feedback
  for the common error. Ship both; types for early feedback, walker
  throws for safety.
- **Walker-portable hooks are NOT React hooks.** They're plain functions
  using the thrown-Promise pattern. They don't go through React's
  dispatcher. Documented as such — adopters won't try to call them
  outside a function component because they won't have a walker
  invoking them.
- **Cache invalidation.** Each `render()` re-evaluates `useData`. If
  the fetcher caches internally, renders are fast; if not, they refetch
  every time. Adopter chooses the caching policy at the fetcher level,
  not at the framework.

## Open questions

- **`useData` lives in `jsx-walker-next` or `spec-next`?** Lean
  walker-next — it's the implementation, not the protocol. spec-next
  doesn't need to know.
- **What's the right way to expose intrinsic handlers for adopter-
  defined tags?** A registration API on `jsx-walker-next` (`registerIntrinsic("my-tag", handler)`)
  would let extensions add JSX vocabulary. Defer until a concrete use
  case demands it.
- **CLI scope.** `agentick render` is implied future work. Don't ship
  it in this ADR's phases; let it land separately once the primitive
  has bake time.
- **Streaming output.** `render()` returns a final string. Future
  consideration: `renderStream()` that yields IR fragments as they
  stabilize. Not needed for prompts/resources; might matter for very
  large rendered templates. Defer.

## Why this is foundational

Without this ADR, Agentick is "a JSX-shaped reactive agent framework."
With it, Agentick becomes "a framework where JSX is the universal
authoring format for any piece of model-context content, and the
runtime decides whether to evaluate it live or as a snapshot." That
framing reshapes the value proposition — every existing tool/prompt/
resource/error/system-prompt site becomes a template, every adopter
gets snapshot testing for free, and the reconciler-pluggability
promise becomes real.

Prompts and resources land as natural consequences. Tool descriptions
upgrade from strings to structured content. The framework can dogfood
its own templates. The MCP server harness's prompt and resource
endpoints become two-line implementations.
