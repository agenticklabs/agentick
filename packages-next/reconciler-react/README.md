# @agentick/reconciler-react-next

Reference implementation of the `ReconcilerProtocol` from `@agentick/spec-next`.
Drives JSX agent definitions through `react-reconciler` (React 19) and
produces a `RenderedTree` IR ready for the executor harness.

## Architecture

Three sharply separated layers:

```
Layer A — Reconciliation
  react-reconciler ──host config──► HostInstance tree (mutable, transient)

Layer B — Collection
  HostInstance tree ──contributors──► RenderedTree (JSON, immutable)

Layer C — Harness
  BaseHarness subclass wraps renderTree as a typed command with the
  full phase contract, lifecycle handlers, middleware, inbox, events.
```

The host tree never crosses the harness boundary; only `RenderedTree`,
`ReconcilerSnapshot`, and `RenderToStringPayload` do — all JSON-shaped.

## React feature semantics

| Feature                                   | Behavior                                                    |
| ----------------------------------------- | ----------------------------------------------------------- |
| Reconciler, hooks, refs, effects, context | full support (real React)                                   |
| `useData` (custom)                        | blocks render via thrown Promise; loop awaits & re-renders  |
| `<Suspense>` fallbacks                    | warning diagnostic; opt-in hard-fail via `strictNoSuspense` |
| `<ErrorBoundary>`                         | supported (per-section resilience)                          |
| `useTransition` / `useDeferredValue`      | allowed, no effect (sync render mode)                       |
| React Server Components                   | not supported                                               |

See `docs/proposals/v2/blueprint/21-reconciler-implementation.md` for
the full design.

## State hooks: `useKnob` vs `useSessionState`

Two different reactive state bridges, each with a hook:

| Hook                            | Bridge        | Visibility             | Purpose                                                                                                                                                                                        |
| ------------------------------- | ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useKnob(id, initial)`          | `KnobBridge`  | **Model-visible**      | Surface in `knobs.list()` to the model; settable via the executor's `set_knob` tool. Use for agent configuration the model can tweak.                                                          |
| `useSessionState(key, initial)` | `StateBridge` | **Framework-internal** | Component state that survives across mounts / hibernate-resume but is NOT visible to the model. Use for prose state machines, scratch counters, derived state, anything the LLM shouldn't see. |

Both persist through the session's snapshot/restore round-trip.

### Migration from v1's `useComState`

If you came from v1's `useComState(key, initial)`:

```diff
- import { useComState } from "agentick";
+ import { useSessionState } from "@agentick/reconciler-react-next";

- const status = useComState("status", "pending");
- status.set("active");
- console.log(status());
+ const [status, setStatus] = useSessionState("status", "pending");
+ setStatus("active");
+ console.log(status);
```

Semantic is identical — same per-session storage, same persistence
through snapshots. The signal-style call API (`status()` / `status.set()`)
is replaced with React's `[value, setter]` tuple. The COM bag is gone;
the session owns a `StateBridge` instead. See
[ADR 22 §D1](../../docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md).

## Static-template rendering: `compileTemplate` + `renderTemplate`

Two one-shot entry points for "I have a JSX tree, give me the IR /
string" without spinning up a session, harness, journal, or
operation lifecycle. The capability uses the SAME reconciler
infrastructure as `createApp` — same compile-until-stable loop,
same `collect` walker, same `useData` semantics — but skips the
reactive harness scaffolding adopters of `createApp` get.

```ts
import { compileTemplate, renderTemplate } from "@agentick/reconciler-react-next";
import { xmlFormatter } from "@agentick/formatters-next";

// Returns RenderedTree IR + diagnostics + iteration count
const { tree } = await compileTemplate(<MyTemplate />);

// Returns formatted string + diagnostics + iteration count (markdown by default)
const { output } = await renderTemplate(<MyTemplate />);

// Pick a different formatter for the string pass
const { output: xml } = await renderTemplate(<MyTemplate />, { formatter: xmlFormatter });
```

`compileTemplate` halts at "stable IR": `useData` suspends resolve,
the walker collects, you get a wire-shape `RenderedTree`.
`renderTemplate` adds the formatter pass on top via
`formatTree` from `@agentick/formatters-next` — see that package's
README for how per-formatter framing rules (`frameSection` /
`frameMessage` / `blocksToText`) are owned by the formatter, not
hardcoded in the renderer.

### When to reach for `renderTemplate` vs `createApp`

| Use case | Reach for |
|----------|-----------|
| **Authoring a prompt** | `renderTemplate` — render JSX to a string, hand to a model |
| **MCP server prompt / resource body** | `renderTemplate` — server returns formatted text |
| **Tool description with rich semantic content** | `renderTemplate` — `<Section>` / `<H1>` / `<Code>` etc. in your description, render once |
| **Skill content** (`@agentick/skills-next`) | `renderTemplate` — JSX-authored skill bodies become wire strings |
| **Snapshot tests for JSX templates** | `compileTemplate` — assert against a stable `RenderedTree` |
| **Docs generator / static site that embeds prompts** | `renderTemplate` — JSX in, markdown out |
| **Agentic loop, tool dispatch, hibernate/resume, channels, reactive `<Tool>`** | `createApp` — full reconciler harness |

### What the template variants do NOT provide

These functions ship with the minimum bridges needed for the
walker to run — a real `InMemoryDataBridge` for `useData`, plus
trivial stubs for `loop` and `session`. They deliberately omit:

- **Reactive bridges** (knobs, state, timeline, tools, mcp, sandbox).
  Hooks that depend on them throw at render. If your template needs
  `useKnob` / `useSessionState` / `useToolBridge` / etc., it's not a
  static template — use `createApp`.
- **Session lifecycle** (snapshot/restore, hibernation, ticks).
- **Journal / inbox / operation wrap**. Each call is a one-shot.
- **Loop control** (`continueAfterTick` / `stopAfterTick` are no-ops).

`<Tool>` created via `createTool({ use, handler })` won't register
its handler in template mode (no real ToolBridge), but the
underlying `<tool>` declaration intrinsic STILL appears on
`tree.declarations.tools` for inspection. Static templates that
declare tools (`<tool name="x" inputSchema={...} handlerRef="y" />`)
work fine — handler resolution is the executor's concern at
dispatch time, not the renderer's.

### `useData` works the same way

`useData(key, fetcher)` suspends via thrown Promise; the walker's
compile-until-stable loop awaits pending fetches and re-renders
until everything resolves. Same `InMemoryDataBridge` semantics —
per-call cache (each `compileTemplate` / `renderTemplate` call is
fresh; no leakage across invocations), same dedup by key, same
rejection-cached-as-failure behavior.

`maxIterations` (default 10) caps the render-until-stable loop;
`awaitTimeoutMs` (no default) bounds the per-iteration wait for
suspended fetches. Both surface as `diagnostics` entries when
triggered.

## Status

Phase 3 of the v2 implementation plan — `docs/proposals/v2/STATUS.md`.
