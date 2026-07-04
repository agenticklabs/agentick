# ADR 44 — Data reconciler (functional, non-React agent root)

**Status:** Draft — 2026-06-29.
**Touches:** new package `@agentick/reconciler-data-next` (or
`-pure-next` — name TBD); composes onto existing
`@agentick/reconciler-next` (collect machinery, `defineReconciler`)
and `@agentick/formatters-next` (semantic-block rendering). Sibling
to `@agentick/reconciler-react-next` — adopter picks one at
`createApp({ reconciler })`. Names land under #243's
reconciler → compiler sweep when it happens.
**Driver:** Every v2 integration test that wants to exercise the App
extension pipeline currently has to pull in React + the React
reconciler as devDeps because that's the only fleshed-out
`defineReconciler` impl. The credentials-next slice (#281b.2)
deliberately dropped a full-app integration test specifically to
avoid this dep — a smell. More broadly: React-as-the-only-front-end
makes the framework's claim that "everything is a harness" leak — it
quietly requires a UI framework even for headless Node-only / edge /
Deno / Bun agents that have no UI. This ADR carves out a base
functional reconciler that satisfies the same `ReconcilerProtocol`
without React.

## TL;DR

Adopters pass a function as the agent root instead of a JSX element.
The function executes once per tick, receives a `ctx` carrying frozen
snapshots of live state (timeline, knobs, props, ...), and returns a
plain IR tree. Semantic content inside structural slots uses the same
factory-function form that React's JSX components emit under the
hood. Formatters render semantic content to provider-specific text.
No React, no hooks, no fiber tree, no concurrent rendering — just
`(ctx) → IRNode[]` per tick.

```ts
import {
  agent, system, user, tools, timeline,
  h1, h2, h3, paragraph, list, listItem, code,
} from "@agentick/reconciler-data-next";

export default agent(({ tick, knobs, props, timeline: tl }) => [
  system([
    h1("Role"),
    paragraph("You are a helpful assistant."),

    h1("Available tools"),
    list(availableTools.map(t => listItem(t.description))),
  ]),

  // Declarative timeline — harness owns compaction:
  timeline({ filter: e => e.role !== "system", compact: { maxTokens: 4000 } }),

  user([paragraph(props.userInput)]),

  tools([echo, search]),
]);
```

```ts
const app = await createApp(myAgent, {
  model: openai("gpt-5"),
  reconciler: dataReconciler(),
});
```

## The three-layer architecture (extracted from React mode, generalized)

The mental model that makes data-mode crisp is the same separation
React mode HAS but doesn't make explicit:

```
Layer A — Structural IR        (slots the model's input has)
            agent() system() user() assistant() tools() section() timeline() ...
                          ↓ owned by the reconciler
Layer B — Semantic content IR  (what text goes INTO each slot)
            h1() h2() paragraph() list() listItem() table() code() ...
                          ↓ owned by formatters-next
Layer C — Rendered bytes       (provider-specific text)
            "## Role\nYou are a helpful assistant.\n\n## Available tools..."
                          ↓ consumed by the model adapter
```

The agent function only ever produces Layer A + B. It never produces
text directly. Formatters do C. The data-reconciler is reconciler-
agnostic about C — it consumes whatever formatter the app harness has
configured.

React's JSX components (`<H1>`, `<Paragraph>`, `<Timeline>`) and the
data-reconciler's factory functions (`h1()`, `paragraph()`,
`timeline()`) emit the **same IR**. They're alternative syntaxes for
the same underlying data shape.

## The agent function

```ts
type AgentFn<P = unknown> = (ctx: AgentContext<P>) => readonly IRNode[];

export interface AgentContext<P> {
  readonly tick: number;
  readonly knobs: KnobsBag;
  readonly props: P;
  readonly timeline: TimelineSnapshot;
  readonly state: StateSnapshot;
  // Future: any harness that needs to surface live state for the
  // tick. Same rule applies — frozen snapshot at tick-start.
}

export function agent<P>(fn: AgentFn<P>): ReconcilerInput<P>;
```

`agent(...)` wraps the function in a `ReconcilerInput` the data-
reconciler knows how to consume. The data-reconciler's
`defineReconciler` impl is small — it captures snapshots at tick
boundary, invokes `fn(ctx)`, hands the resulting `IRNode[]` to the
compiler. Total reconciler body likely under 200 LOC; the bulk of
the package is factories + types.

### Purity guarantee

Given the same `ctx`, the same `agent(fn)` returns the same IR. The
framework captures live state into frozen snapshots BEFORE calling
the fn — adopter code never reaches into the harnesses directly.
This preserves:

- **Deterministic replay** — re-feed the journaled `ctx` through the
  same fn and get the same compiled output.
- **Snapshotability** — diff trees across ticks for debugging.
- **Cacheability** — if `(tick, knobs, props, timeline.head, state.head)`
  haven't changed, the compiled IR is identical; skip the LLM call.
- **Testability** — fake the ctx, no live harness required.

React preserves this within a single render pass — `useTimeline()`
returns the same value for the duration of one render. The
data-reconciler extends the guarantee across the entire tick.

## Live primitives — declarative + imperative both work

For any "I need to read live state to shape the IR" case, the
adopter has two equally-valid expressions:

```ts
// Declarative — harness owns the policy:
timeline({ compact: "auto", maxTokens: 4000 })

// Imperative — adopter transforms entries directly:
...ctx.timeline.entries({ filter: e => e.role !== "system" })
  .map(e => message(e.role, [paragraph(e.content)]))
```

Both produce the same IR. They differ in what the adopter gives up:

| Concern                       | Declarative                  | Imperative                              |
|-------------------------------|------------------------------|-----------------------------------------|
| Compaction policy             | Harness handles it           | Adopter compacts or accepts full include|
| Compose into messages         | Auto                         | Manual `map(e => message(...))`         |
| Reorder / interleave / wrap   | Limited                      | Full JS — `slice` / `flatMap` / etc.    |
| Annotate / branch on content  | No                           | Yes                                     |
| Journal debuggability         | Compactor decision logged    | Just the IR output                      |
| Per-entry token budget        | Harness-level                | Adopter implements                      |

The imperative form earns its keep on cases the declarative form
can't express:

```ts
// Summarize old turns separately + inline them as system context:
export default agent(({ timeline, props }) => {
  const recent = timeline.entries({ since: timeline.tail(5) });
  const older  = timeline.entries({ before: timeline.tail(5) });
  const summary = props.precomputedSummary;

  return [
    system([
      h1("Role"),
      paragraph("You are a helpful assistant."),
      h2("Conversation so far"),
      paragraph(summary),
    ]),
    ...recent.map(e =>
      message(e.role, [
        e.role === "assistant" ? h3(`Turn ${e.turn}`) : null,
        paragraph(e.content),
      ].filter(Boolean))
    ),
    tools([echo, search]),
  ];
});
```

That's pure JS — `map`, `filter`, `slice`, ternary — over a frozen
snapshot. No declarative policy knob would express this without
proliferating into N adopter-specific options nobody'll remember.

## The deconstructed-React mental model

For adopters coming from React, the translation table:

| React                                                        | Data-reconciler equivalent                            |
|--------------------------------------------------------------|-------------------------------------------------------|
| `function Agent()` body                                      | `agent((ctx) => ...)` body                            |
| `useTimeline()`                                              | `ctx.timeline` (frozen snapshot)                      |
| `useKnob("x")`                                               | `ctx.knobs.x`                                         |
| `useResolved(key)`                                           | `ctx.props.resolved[key]` (resolved by adopter)       |
| `<H1>Role</H1>`                                              | `h1("Role")`                                          |
| `{entries.map(e => <Message ...>...</Message>)}`             | `...entries.map(e => message(...))`                   |
| `useEffect(...)`                                             | **No equivalent** — side effects via framework lifecycle, never adopter code |
| `useState(...)`                                              | **No equivalent** — state lives in adopter modules / closures, or in `bridges.state` if persistent |
| `<Suspense fallback={...}>`                                  | **No equivalent** — adopter resolves async upfront, passes via `props` |

What React HAS that data mode drops: per-component state, effects,
suspense, concurrent rendering. What data mode KEEPS that React
fights: pure-function inputs/outputs, snapshotability, deterministic
replay, no hidden re-render triggers.

For agent-context-compilation specifically, the things data mode
drops are mostly things you don't want in the agent's render path
anyway. State-in-the-component is the wrong place for agent state —
it belongs in `bridges.state` or `bridges.timeline`. Effects-during-
render are how React produces hard-to-debug agents. Suspense is
over-engineered for "resolve some async data before this tick".

## What "reconciler" even means in data mode

In React mode, the reconciler does real work — walking the fiber
tree, managing per-component state, diffing across ticks, scheduling
re-renders. There's genuine *reconciliation*.

In data mode, the function returns a complete IR every tick. There's
nothing to reconcile — it's just `(ctx) => fn(ctx)` per tick, handing
the result straight to the compiler. The "reconciler" is barely a
thing; only the compiler runs.

This is why #243's reconciler → compiler rename matters. In data
mode the reconciler disappears entirely; the compiler remains. The
seam between front-end-syntax and IR-compilation is the load-bearing
boundary, and it's already there architecturally — the rename makes
it visible.

## Surface inventory (initial draft)

### `agent(fn)`
Wraps an adopter function in a `ReconcilerInput` for the data-
reconciler. Single export from the package root.

### Structural factories (Layer A)
| Factory       | Produces                                             |
|---------------|------------------------------------------------------|
| `system(...)` | system-role message                                  |
| `user(...)`   | user-role message                                    |
| `assistant(...)` | assistant-role message                            |
| `message(role, ...)` | arbitrary-role message                        |
| `section(opts, ...)` | named region (id, audience, persistence)      |
| `tools([...])` | tool declarations available to the model            |
| `timeline(opts)` | declarative timeline expansion                    |
| `event(opts, ...)` | persisted event                                  |
| `ephemeral(opts, ...)` | non-persisted current-state context          |
| `grounding(opts, ...)` | semantic grounding wrapper                   |

### Semantic factories (Layer B)
Mirror the existing `packages/core/src/jsx/components/semantic.tsx`
set, just as plain functions instead of JSX components:

| Factory                          | React equivalent                  |
|----------------------------------|-----------------------------------|
| `h1(text)` / `h2(text)` / `h3(text)` | `<H1>` / `<H2>` / `<H3>`     |
| `header(level, text)`            | `<Header level={n}>`              |
| `paragraph(text)`                | `<Paragraph>`                     |
| `list(items, opts?)`             | `<List>`                          |
| `listItem(text, opts?)`          | `<ListItem>`                      |
| `table(opts)`                    | `<Table>`                         |
| `code(text, opts)`               | `<Code>`                          |
| `json(data)`                     | `<Json>`                          |
| `text(s)`                        | `<Text>`                          |

### Content-block factories (multimodal)
| Factory                  | React equivalent           |
|--------------------------|----------------------------|
| `image(source)`          | `<Image>`                  |
| `audio(source)`          | `<Audio>`                  |
| `video(source)`          | `<Video>`                  |
| `document(source)`       | `<Document>`               |

### Live-primitive nodes (declarative reads)
| Factory                  | What it expands to                            |
|--------------------------|-----------------------------------------------|
| `timeline(opts)`         | Messages from `bridges.timeline`              |
| `knobs(descriptors)`     | The standard knob section + `set_knob` tool   |
| `mcpTools(opts)`         | Tool decls discovered from a `bridges.mcp` server |
| `skill(name)`            | Skill content from `bridges.skills`           |
| `prompt(name, args)`     | Prompt template render from `bridges.prompts` |

## Implementation sketch

```ts
// In @agentick/reconciler-data-next:
import { defineReconciler, type ReconcilerProtocol } from "@agentick/reconciler-next";

export function dataReconciler(): ReconcilerProtocol {
  return defineReconciler({
    name: "data-reconciler",
    mount: async (input, host) => {
      // input is an `agent(fn)` wrapper; nothing to "mount" really —
      // just remember the fn for tick-time invocation.
      const { fn } = input;
      return { fn };
    },
    reconcile: async (mounted, ctx) => {
      // Capture frozen snapshots from the host's bridges.
      const snapshots = {
        tick: ctx.tick,
        knobs: ctx.host.bridges.knobs.snapshot(),
        props: ctx.props,
        timeline: ctx.host.bridges.timeline.snapshot(),
        state: ctx.host.bridges.state.snapshot(),
      };
      // Invoke the agent fn, get IR back.
      const ir = mounted.fn(snapshots);
      // Hand IR to the existing collect machinery.
      return collect(ir, ctx.host);
    },
    unmount: async () => {},
  });
}
```

Live-primitive nodes like `timeline({...})` are recognized during
`collect()` and expanded by walking back into the relevant bridge
with the captured snapshot. The Contributors registry from
`reconciler-next` is the natural extension point — one Contributor
per live-primitive node type.

## Trade-offs vs React-reconciler

| Concern                           | Data-reconciler                            | React-reconciler                              |
|-----------------------------------|--------------------------------------------|-----------------------------------------------|
| Bundle weight                     | ~few hundred LOC + tests                  | react + react-reconciler + ours               |
| Runtime cost per tick             | One fn call + tree walk                    | Fiber tree reconcile + commit phase           |
| State management                  | Adopter-owned (modules, closures, bridges.state) | useState / useReducer / context           |
| Async data                        | Resolve upfront, pass via props            | Suspense (or external state libs)             |
| Devtools                          | Standard JS debugger; IR tree inspectable  | React DevTools (mature)                       |
| Snapshot / replay determinism     | Native                                     | Possible but hooks fight it                   |
| Test ergonomics                   | Fake ctx, no harness needed                | Need to mount + render + observe              |
| JSX-as-syntax                     | No (function calls)                        | Yes                                           |
| Concurrent rendering              | No                                         | Yes (if you want it)                          |
| Adopter ramp-up                   | Plain JS function — minutes                | React knowledge required                      |
| Compose sub-agents                | Plain function composition                 | React component composition                   |

For agent context-compilation, the React-side wins are mostly
features adopters DON'T want in the render path (state, effects,
suspense). The data-side wins are properties they DO want
(determinism, snapshots, testability, no peer-dep on a UI framework).

## Naming

Working title: `@agentick/reconciler-data-next` paralleling
`@agentick/reconciler-react-next`. Other candidates:

- `@agentick/reconciler-pure-next` — emphasizes purity
- `@agentick/reconciler-fn-next` — emphasizes functional shape
- `@agentick/agent-fn-next` — drops "reconciler" entirely (post-#243)

After #243 ships the reconciler → compiler rename, the package
becomes `@agentick/compiler-data-next` (or whichever suffix wins).
The package-level rename is mechanical; no API churn.

## Where this fits in the v2.0 plan

Not in scope for v2.0 itself. The React reconciler is the canonical
JSX surface and stays as such. The data reconciler is a sibling
that:

1. Unblocks v2 internal tests that don't want to pull react devDeps
   to exercise the App extension pipeline (the credentials-next
   integration-test smell that surfaced this design).
2. Unblocks Node-only / edge-runtime / Deno / Bun agents.
3. Serves as the **reference impl** for `reconciler-next`'s
   contract — independent of React, so contract regressions surface
   without React noise.
4. Gives future framework bindings (Solid, Vue, Svelte) a clear
   template — bind reactive primitives at Layer A/B, compile to
   the same IR.

Ship order, if approved:

1. **Slice 1** — package scaffold + `agent(fn)` + structural factories (`system`, `user`, `assistant`, `tools`, `section`, `message`) + minimal `dataReconciler()` impl that handles the no-live-primitives case + conformance against `reconciler-next`'s protocol.
2. **Slice 2** — semantic factories (`h1`, `paragraph`, `list`, `code`, etc.) mirroring the existing React semantic-components set. Validates Layer B / formatter integration.
3. **Slice 3** — live-primitive Contributors: `timeline()` first (highest-value), then `knobs()`, `mcpTools()`, `skill()`, `prompt()`.
4. **Slice 4** — port one or two existing internal tests off `createApp from /react` to `createApp` + `dataReconciler()` to prove parity.
5. **Slice 5** — extract the React semantic components to share their IR factories with data-mode (currently the React JSX components own the IR shape directly; we want a shared `ir-factories.ts` both sides import).

## Open questions

- **Ctx surface — what's included by default?** Timeline + knobs +
  state + props is the minimum. Should `bridges.*` be on `ctx`
  directly (every harness's snapshot interface), or behind
  `ctx.bridges.*` to mirror React's `bridges` slot? Lean toward
  `ctx.bridges` for symmetry.

- **Closure-captured state — pure or impure?** A pattern like
  `let lastSeen = 0; agent((ctx) => { lastSeen = ctx.tick; ... })`
  technically violates purity (the closure holds state across ticks).
  Forbid via lint? Allow? Lean toward "allow with a doc warning" —
  the framework can't actually prevent closures, and many legit
  patterns (memoization, computed-once values) need them. The
  determinism guarantee only requires that GIVEN THE SAME CTX, the
  output is deterministic — closure-cached values that derive from
  ctx are fine; closure-mutated state that drifts is not.

- **Per-tick imports / dynamic factories** — should adopters be able
  to import semantic factories lazily based on knobs (e.g., "only
  load the table renderer if a knob enables it")? Probably yes —
  factories are tree-shakable; lazy import works at the JS level.
  No framework concern.

- **TypeScript inference** — `agent<P>(fn)` should infer `P` from
  the fn's parameter shape, or take it as a generic explicitly.
  Pattern to copy: `createApp<P>` already handles this; mirror.

- **Async agent functions** — `(ctx) => Promise<IRNode[]>` valid?
  Probably yes — adopters might want to await some side-pipeline
  before assembling IR (rare, but no reason to forbid). The
  framework awaits the result either way. Note in the ADR but allow.

- **JSX shape on top of factory functions** — could we ship a JSX
  pragma that desugars to data factories (i.e., zero-runtime JSX
  without React)? Tempting but probably premature. Adopters who
  want JSX use the React reconciler. Adopters who want fn-call
  syntax use this one. Don't blur the line.
