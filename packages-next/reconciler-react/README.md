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

## Status

Phase 3 of the v2 implementation plan — `docs/proposals/v2/STATUS.md`.
