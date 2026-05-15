# Runtime

## Status: Living Draft

Last updated: 2026-05-08

`@agentick-core/runtime` is the library runtime for agentick v2. It consumes
[`CompiledStructure`](./compiled-spec.md), runs executions and tick loops,
owns session lifecycle, and exposes integration surfaces through harness
boundaries.

This document intentionally treats distributed topology as optional. Cluster and
gateway concerns are first-class add-ons that wrap the same harnesses:

- [`cluster.md`](./cluster.md) - optional distributed deployment wrapper
- [`gateway.md`](./gateway.md) - optional transport and ingress wrapper

The core runtime remains an in-process library.

## What Changed from Earlier Drafts

Previous drafts treated "distributed by default" as the baseline architecture.
That overloaded the runtime with topology concerns.

The v2 direction is now explicit:

1. Runtime is a library first.
2. Harness boundaries are the load-bearing abstraction.
3. Clustering composes on top through those boundaries.

This keeps the core easier to reason about while preserving deep integration
points for advanced deployments.

## Design Principles

1. **Library-first baseline.** `createApp()` and sessions work without cluster,
   gateway, or external stream infrastructure.
2. **Harness-first integration.** Meaningful layers expose commands, events,
   interceptors, and typed outcomes.
3. **Spec firewall.** Everything crossing compiler/executor boundaries is
   JSON-shaped spec data, not Effect internals.
4. **Real React, hidden runtime substrate.** React remains the authoring model;
   runtime mechanics stay beneath the boundary.
5. **Deterministic execution semantics.** One session command at a time,
   explicit cancellation, explicit lifecycle transitions.
6. **Progressive operations.** Durability, clustering, and transport are opt-in
   layers, not architectural forks.
7. **Typed failures.** Error channels are typed at every harness boundary.
8. **Observability by attachment.** Events and telemetry are structural but
   optional for consumers.

## Runtime Scope

The runtime package owns:

- Session and app lifecycle orchestration
- Loop executor invocation
- React runtime harness invocation
- Executor harness invocation
- Tool dispatch orchestration
- Context propagation and middleware orchestration
- Persistence integration points
- Event and interceptor coordination

The runtime package does **not** own:

- React reconciler internals (compiler concern)
- Provider HTTP/SDK internals (executor concern)
- Transport protocols (gateway concern)
- Cluster routing and sharding mechanics (cluster concern)

## Harness Topology

The runtime composes harnesses rather than hard-coding topology:

```
App harness
  └─ Session harness (one per session)
       └─ Loop executor
            ├─ React runtime harness
            └─ Executor harness
                 └─ Tool Executor harness
```

The runtime directly implements app/session harnesses, owns the loop executor,
and consumes React runtime/executor/tool executor harnesses through protocols.

## App Harness

### Commands in

- `createSession`
- `runOnce`
- `getSession`
- `listSessions`
- `closeApp`

### Events out

- app lifecycle events
- session-created / session-closed
- optional cross-session tagged events

### Interceptors

- `session-create`
- `session-close`
- `app-close`

### Outcomes and failures

- `AppError` taxonomy for app-level failures
- app error events for observability
- command-level typed failure responses

## Session Harness

### Commands in

- `send`
- `dispatch`
- `render`
- `append`
- `spawn`
- `abort`
- `pause`
- `resume`
- `inject`
- `recover`
- `hibernate`
- `restore`
- `close`

### Events out

- tick lifecycle events
- timeline mutation events
- execution/tool/model events
- session lifecycle events

### Interceptors

- `send`
- `dispatch`
- `render`
- `spawn`
- `hibernate`
- `restore`
- `close`

### Outcomes and failures

- typed session and tick errors
- corresponding error events
- recovery commands for external orchestration

## Tick Loop (Session Internal)

The session command loop delegates one execution at a time to the loop executor.
`send` is the primary entry point.

```
1) Compile session React tree via React runtime harness
2) Produce CompiledStructure IR snapshot
3) Resolve execution target
4) Execute IR via executor harness (projection -> execution -> normalization)
5) Dispatch tool calls through tool executor harness when needed
6) Apply normalized executor result and tool results to runtime session state
7) Decide continue/stop for multi-tick execution
```

Each step is explicit and typed. Each boundary is harness-shaped. See
[`loop-executor.md`](./loop-executor.md) for the extracted loop boundary.

## Compiled Context Consumption

The runtime treats `CompiledStructure` as an IR snapshot with two top-level
concerns:

- `context`: ordered model-input entries for the next executor call.
- `declarations`: runtime-facing registrations for tools, resources, outputs,
  and MCP contributions.

Runtime owns session state mutation. When normalized executor output or tool
results arrive, runtime updates timeline/state first, then asks the React
runtime for the next snapshot. The React runtime does not ingest provider output
as an execution side effect.

The React runtime can also be used without the loop executor for render-only
workflows such as MCP resources, prompt previews, and documentation generation.

## Runtime and Effect

Effect remains the runtime substrate, but it is not the public architecture.
The public architecture is harness contracts.

Effect powers:

- scoped resource cleanup (`Scope`)
- request/session context propagation (`FiberRef`)
- structured cancellation
- stream and pub/sub primitives
- typed error channels

These details should not leak across the spec boundary or the primary user
surface.

## Persistence and Lifecycle

Persistence is integrated through runtime boundaries, not through ad-hoc
callbacks.

### Core runtime semantics

- Session state has explicit lifecycle transitions.
- Hibernation and restore are runtime policies.
- Snapshot payloads are runtime + compiler protocol collaboration.

### Storage strategy

The runtime supports composable persistence layers:

- session record storage
- timeline storage
- blob/content storage
- optional caches

No single backend is hard-coded by architecture.

## Observability

Observability flows through harness events and telemetry attachment.

### Runtime guarantees

- events are emitted from structural operations, not ad-hoc logging sites
- events carry enough context for correlation
- observability subscribers are optional

### Runtime non-goals

- no requirement for distributed buses in core runtime
- no mandatory global event routing layer

Those concerns are handled by optional wrappers (`cluster.md`, `gateway.md`).

## Unified Event/Interceptor Engine

Runtime should expose one underlying integration engine for:

- event observation (non-blocking subscribers)
- interceptors (blocking coordination at integration points)
- middleware composition (global/app/session layering)

All three match against the same `EventEnvelope` envelope and `EventQuery`
selector model (defined in `harness-principle.md` and `spec-package.md`).

### Phase semantics in runtime

Runtime command boundaries should emit:

- `requested` (always)
- `before` (for interceptable commands)
- `delta` (optional, repeatable)
- `terminal` with a typed outcome

This keeps lifecycle/execution symmetry explicit and discoverable.

## Middleware and Interceptor Coordination

Interceptors and middleware are first-class runtime concerns. The runtime owns
invocation semantics for interceptors at command boundaries and execution
boundaries.

Required semantics to keep stable across implementations:

- deterministic handler ordering
- explicit timeout/cancellation policy
- explicit response merge rules (`proceed`, `defer`, `veto`, `replace`)
- typed interceptor errors mapped into runtime outcomes and failures

See [`harness-principle.md`](./harness-principle.md) for cross-harness policy.

## Testing Model

Harness boundaries are the primary test seams.

You should be able to:

- mock React runtime harness and test session behavior
- mock executor harness and test tick orchestration
- mock tool executor harness and test error/retry flows
- run full integration tests with real harness implementations

The runtime test strategy should not require cluster topology to validate core
semantics.

## Relationship to Optional Topologies

Core runtime is deployable as:

- in-process runtime library (default)
- runtime + gateway in one process
- runtime wrapped by cluster sharding layer

These are topology choices over the same harness contracts.

## Open Questions

1. **Interceptor semantics codification.** Where should normative
   merge/ordering rules
   live: this doc or harness-principle appendix?
2. **Execution queue policy.** Which commands are mutually exclusive and which
   can interleave (if any)?
3. **Hibernation defaults.** What default policy balances memory and latency
   without topology assumptions?
4. **Snapshot granularity.** Which runtime state must be persisted vs derived?
5. **Event envelope.** Minimal required metadata for causality and replay?
6. **Context layering.** Exact boundary between session context and
   execution/request context?

## Decision Log

- **Runtime is library-first.** (2026-05-08) Reason: keep core simple and
  composable; topology should wrap the runtime, not define it.
- **Harness boundaries define integrations.** (2026-05-08) Reason: one
  consistent extension model across compiler/runtime/executor/tool layers.
- **Distributed topology is optional wrapper architecture.** (2026-05-08)
  Reason: preserve cluster capability without forcing cluster complexity into
  every runtime mental model.
- **Spec remains the runtime boundary firewall.** (2026-05-08) Reason: stable
  wire contracts and interchangeable harness implementations.
- **Core runtime tests should not require cluster topology.** (2026-05-08)
  Reason: architecture correctness must be testable in-process.
