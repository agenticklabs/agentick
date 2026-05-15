# @agentick/reconciler-react

Reference implementation of the `ReconcilerProtocol` from `@agentick/spec`.
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

| Feature                     | Behavior                                                   |
| --------------------------- | ---------------------------------------------------------- |
| Reconciler, hooks, refs, effects, context | full support (real React)                    |
| `useData` (custom)          | blocks render via thrown Promise; loop awaits & re-renders |
| `<Suspense>` fallbacks      | warning diagnostic; opt-in hard-fail via `strictNoSuspense` |
| `<ErrorBoundary>`           | supported (per-section resilience)                          |
| `useTransition` / `useDeferredValue` | allowed, no effect (sync render mode)              |
| React Server Components     | not supported                                              |

See `docs/proposals/v2/blueprint/21-reconciler-implementation.md` for
the full design.

## Status

Phase 3 of the v2 implementation plan — `docs/proposals/v2/STATUS.md`.
