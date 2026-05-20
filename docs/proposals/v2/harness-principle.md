# The Harness Principle

## Status: Living Draft

Last updated: 2026-05-08

This doc is the architectural spine of v2. Everything else in this
folder — `compiled-spec.md`, `spec-package.md`, `compiler-harness.md`,
`renderer-harness.md`, `loop-executor.md`, `runtime.md`, `executor.md`,
`cluster.md`, `gateway.md` — references this. Read this first.

## What it is

**Every meaningful layer of the system is a harness.** A harness is a
self-contained component with a well-defined integration boundary shaped by four
protocol surfaces:

1. **Commands in** — imperative, typed requests to do work
2. **Events out** — observable facts emitted by work
3. **Interceptors around commands** — participatory coordination that can
   proceed/defer/veto/replace
4. **Typed outcomes** — command/interceptor results, including typed failures

External code (other layers, integrations, tests, observers) attaches
at this boundary. The harness's internals are private; its boundary
is the contract.

## Topology stance

Harness principle is independent of deployment topology.

- Core runtime is library-first and in-process by default
- Clustered deployment is an optional wrapper over the same harnesses
- Gateway/transport ingress is an optional wrapper over the same harnesses

This keeps semantics stable while allowing deployment sophistication to scale
without architectural forks.

## Why a uniform pattern

Without a uniform pattern, every layer invents its own integration
shape. v1's pain came from this: lifecycle callbacks looked one way, event
emission another, tool dispatch a third, channel subscription a
fourth. Contributors had to learn each layer's idiosyncrasies.
Integrations were ad-hoc.

With a uniform pattern: learn the four surfaces once, apply at every
layer. New layers cost less. Integrations cost less. Testing is
uniform. Observability is uniform.

This is the same discipline behind:

- Unix philosophy (small tools, pipes between them)
- Hexagonal architecture (ports and adapters)
- Erlang/OTP behaviors (gen_server, gen_event, gen_statem — uniform
  shapes)
- Effect's service-and-Layer pattern

We're naming it explicitly so it becomes load-bearing.

## The four protocol surfaces

### Commands in

Imperative API exposed by the harness. Typed inputs, typed outputs, typed
outcomes. The harness can refuse with a typed failure; the caller decides what
to do.

In Effect: typed `Effect<Result, Error, Service>` exposed via `Context.Tag`.
Each command is a service method.

Used for:

- Driving the harness from outside (sending messages, dispatching operations,
  controlling state)
- Recovery (telling the harness how to recover from an observed outcome)
- Integration glue (a higher layer driving a lower layer)

### Events out

Broadcast notifications of things that happened. Past tense. Multiple
subscribers, no coordination, no response expected.

In Effect: `PubSub<Event>` + `Stream<Event>` consumers. Backpressure
built in. Subscribers tied to `Scope` for clean lifecycle.

Used for:

- Observability (logs, metrics, dashboards, audit)
- Reactive integrations (UI updates, event-driven workflows)
- Replay and debugging
- Cross-layer composition (one layer's events feed another's commands)

Cost when no subscribers: zero. Pub/sub doesn't pay for what no one listens to.

### Interceptors

Bidirectional coordination around command execution. Before or around an
operation, the harness asks matching interceptors what to do. Interceptors can:

- **Proceed** — let the operation continue
- **Defer** — request a delay; harness retries later
- **Veto** — halt the operation with a reason
- **Replace** — substitute a result without running the operation

Lifecycle callbacks are interceptors registered against lifecycle commands.
Middleware is ordered interceptor composition. They are not separate primitives.

Used for:

- Coordinating with external state (flush before hibernate, sync
  before close)
- Vetoing operations during critical regions (don't hibernate while
  payment processing)
- Modifying behavior (transform inputs/outputs at boundaries)
- Resource cleanup with awaitable semantics

This is what events alone can't do. Events fire-and-forget; interceptors
participate.

### Typed outcomes

Commands and interceptors terminate with typed outcomes:

- `succeeded`
- `failed`
- `canceled`
- `vetoed`
- `replaced`
- `deferred`

Failures still use Effect's typed `E` channel internally, but the protocol
should not collapse every terminal condition into "error." A veto is not a
provider failure. Cancellation is not a validation error. Deferred work is not a
crash.

Outcome events are emitted for observability. Recovery remains a command.

### Outcome payload rule

Protocol-defined non-success outcomes (`vetoed`, `replaced`, `deferred`) are
successful harness executions with non-success domain outcomes. They should not
use Effect's failure channel unless the harness itself failed.

Effect failure is reserved for actual failures: provider errors, validation
errors, network errors, invariant violations, and cancellation-as-failure.

When a command has a result payload, the terminal outcome envelope should carry
the payload only for outcomes where a payload is meaningful. For executor runs,
that means `ExecutorTerminal { outcome: "succeeded" | "replaced" }` carries an
`ExecutionResult`; `failed`, `canceled`, and `vetoed` do not.

## One underlying integration system

Events and interceptors should share one underlying matcher/envelope system with
two interaction modes:

1. **Observe mode** (non-blocking): subscribers consume the event stream.
2. **Intercept mode** (blocking/participatory): handlers can
   proceed/defer/veto/replace at integration points.

Both modes match against the same event envelope and query model. This
prevents three parallel abstractions ("event listeners", "middleware",
"lifecycle callbacks") from drifting apart.

### Canonical event envelope

"Harness" is architecture vocabulary, not public type vocabulary. The shared
wire shape should use protocol-oriented names:

- `ProtocolEvent` — the event union emitted by Agentick protocol surfaces.
- `EventEnvelope` — the common envelope shared by protocol event variants.

```ts
interface EventEnvelope {
  id: string; // unique event id
  opId: string; // operation correlation id
  surface: "app" | "session" | "compiler" | "executor" | "tool";
  name: string; // hierarchical semantic name
  phase: "requested" | "before" | "delta" | "terminal";
  outcome?: "succeeded" | "failed" | "canceled" | "vetoed" | "replaced" | "deferred";
  timestamp: number;
  scope: {
    appId?: string;
    sessionId?: string;
    executionId?: string;
    tickId?: string;
  };
  payload?: unknown; // phase-specific structured payload
  tags?: string[];
  error?: { name: string; message: string; data?: unknown };
}

type ProtocolEvent = EventEnvelope & {
  payload?: unknown;
};
```

### Canonical query model

```ts
interface EventQuery {
  surface?: EventEnvelope["surface"] | EventEnvelope["surface"][];
  name?: NameQuery;
  phase?: EventEnvelope["phase"] | EventEnvelope["phase"][];
  outcome?: EventEnvelope["outcome"] | EventEnvelope["outcome"][];
  tagsAny?: string[];
  scope?: Partial<EventEnvelope["scope"]>;
}

type NameQuery =
  | { exact: string }
  | { prefix: string }
  | { segments: string[] }
  | { wildcard: string };
```

Observers and interceptors both use `EventQuery`.

### Naming model (semantic and hierarchical)

Use broad-to-specific naming so filters are composable and readable:

`<harness>:<domain>:<action>`

Examples:

- `session:lifecycle:hibernate`
- `session:execution:tick`
- `executor:provider:request`
- `tool:dispatch:invoke`

Phase is separate (`requested|before|delta|terminal`) and may be rendered in
logs with outcomes:

- `session:lifecycle:hibernate:before`
- `session:lifecycle:hibernate:terminal:succeeded`

This keeps lifecycle symmetry explicit while preserving query ergonomics.

### Symmetry contract

For every command:

- `requested`: exactly once
- `before`: zero or one, depending on whether the command is interceptable
- `delta`: zero or more, only after `requested` and before `terminal`
- `terminal`: exactly once

`terminal` MUST include an `outcome`. `delta` is optional and only used where
incremental insight is meaningful.

### Handler scopes and ordering

Handlers can be registered at:

- global/runtime scope
- app scope
- session scope

Recommended order:

- **before phase**: global -> app -> session
- **terminal phase**: session -> app -> global

This preserves intuitive middleware stacking (outer wraps inner).

## Harnesses all the way down (almost)

The pattern is fractal. Each layer of the system is a harness. They
compose by hooking one's outputs to another's inputs:

```
App harness
  └─ Session harness          (one per session)
       └─ Loop executor       (per execution)
            ├─ React runtime  (living React tree + compiler)
            │    └─ Renderer  (semantic content -> rendered content)
            └─ Executor       (per model/provider run)
                 └─ Tool executor (per tool call)
```

Each layer:

- Emits its own events
- Exposes its own commands
- Provides its own interceptor boundaries
- Has its own typed outcomes and failure channel

The session delegates execution mechanics to the loop executor. The loop
executor calls into the React runtime for snapshots, into the executor for
model/provider runs, and into the tool executor for Agentick-managed tool calls.
Each layer consumes the layer below through a typed harness boundary.

### Per-layer specifics

Each harness gets its own doc, but the shapes-per-layer:

**React runtime harness** — manages the React tree as a living application

- Commands: mount, rerender, compileContext, renderToString, renderResource,
  unmount, snapshot, restore
- Events: mounted, suspended, errored, recompiled,
  async-component-resolved, rendered
- Interceptors: mount, rerender, compileContext, renderToString,
  renderResource, unmount,
  snapshot, restore
- Errors: CompileError, RendererError, AsyncComponentError

**Renderer harness** — renders semantic content into concrete content/text

- Commands: render, renderToText, renderResource, inspectCapabilities
- Events: render-started, render-delta, rendered, render-failed
- Interceptors: render, renderToText, renderResource
- Errors: UnsupportedContentError, UnsupportedRendererError, RenderError

**Loop executor** — runs one execution/tick loop

- Commands: runExecution, abort
- Events: execution, tick, compile, executor, tool-dispatch, ingest,
  continuation events
- Interceptors: execution, tick, compile, executor, tool-dispatch, ingest,
  continuation
- Errors: ExecutionError, TickError, LoopCanceledError

**Executor harness** — manages model + tool execution

- Commands: execute(spec, model), abort
- Events: stream chunks, completion, errors, model-request,
  model-response
- Interceptors: projection, provider-execute, provider-stream
- Errors: ProviderError, ProjectionError, NetworkError

**Tool Executor harness** — sub-layer of executor

- Commands: dispatch(name, input, ctx), abort
- Events: tool-called, tool-result, tool-error
- Interceptors: dispatch, confirmation-required, tool-error
- Errors: ToolNotFound, ValidationError, HandlerError

**Session harness** — message-driven session layer

- Commands: send, dispatch, render, append, spawn, abort, pause,
  resume, inject, recover, hibernate, restore, close
- Events: tick events, timeline events, lifecycle events (the
  ~43-event taxonomy)
- Interceptors: send, dispatch, render, spawn, hibernate, restore, close
- Errors: SessionError, TickError

**App harness** — manages sessions + cross-cutting

- Commands: createSession, runOnce, getSession, listSessions,
  closeApp
- Events: app-level lifecycle, cross-session events (sessionId-tagged)
- Interceptors: session-create, session-close, app-close
- Errors: AppError, AuthError

### Where it stops

We don't harness everything. Sensible stopping points:

- **React's reconciler internals** — we wrap it as the compiler
  harness; reconciler internals stay private
- **Provider SDK clients** — wrapped as executor implementations; the
  SDK surface is what it is
- **Effect runtime primitives** — foundational; harnessing them adds
  nothing
- **Tool handler bodies** — user code; once invoked through the tool
  executor harness, the body is just a function
- **Internal helpers** — anything below "meaningful integration
  boundary" is bureaucracy

The principle: **harness the layers that have meaningful integration
points and composition boundaries.** Below that, stop.

## What this enables

**Symmetry.** Learn the four protocol surfaces once. Apply at every layer.
Contributors don't relearn per-layer idioms.

**Pluggability is uniform.** Custom executor? Implement the executor
harness. Custom React runtime? Implement the React runtime harness. Custom
renderer? Implement the renderer harness. Custom tool executor? Same. The
harness shape is the contract.

**Observability composes.** Subscribe to events at any harness level.
Each emits its own scope. Want only model chunks? Subscribe to
executor. Want only timeline writes? Subscribe to session. Want
everything? Subscribe to app.

**Testability uniformly.** Mock any harness; test the layer above.
Same mocking pattern at every level. No layer-specific test
infrastructure.

**Integration points are explicit.** "Where do I plug in
observability?" — at any harness boundary. "Where do I plug in
clustering?" — wrap the session harness. "Where do I plug in a custom
model?" — wrap the executor harness. The answer is always "at the
relevant harness."

**Library-first works naturally.** Each harness is library-shaped — a
service with typed methods. Cluster wrapping is just a Layer that
substitutes the harness's implementation. No core changes required.

## Implications for other docs

The harness principle reshapes the doc set:

- **`compiled-spec.md`** — the wire format (data flowing through
  harnesses).
- **`spec-package.md`** — types + protocol. The protocol section
  defines harness-shaped service interfaces.
- **`compiler-harness.md`** — describes the **React runtime harness** and its
  relationship to the **renderer harness**. Compilation is one command;
  renderer/resource output is also first-class.
- **`renderer-harness.md`** — describes the **renderer harness** for semantic
  content to rendered content/text.
- **`loop-executor.md`** — describes the execution loop harness that calls
  React runtime, executor, and tool executor.
- **`runtime.md`** — describes core **app/session harnesses** in the
  library-first runtime.
- **`executor.md`** — describes the **executor harness** + sub
  **tool executor harness**.
- **`cluster.md`** — optional distributed wrapper around harnesses,
  especially app/session.
- **`gateway.md`** — optional ingress/transport wrapper that maps
  client protocols onto harness commands/events.
- **`harness-principle.md`** (this doc) — the spine. Referenced by
  all others.

Each harness doc follows the same template:

1. What this harness manages
2. Commands in (API surface)
3. Events out (taxonomy)
4. Interceptors (boundaries + responses)
5. Outcomes and failures (typed taxonomy)
6. Composition (how this harness consumes/feeds others)
7. Examples
8. Open questions / decisions

## Open Questions

1. **Interceptor registry shape.** Single registry per harness, or one per
   command namespace? Performance and ordering implications.

2. **Interceptor response merging.** Current lean:
   - first `veto` wins (short-circuit)
   - `replace` short-circuits
   - multiple `defer` responses merge via earliest retry policy
     Needs final normative spec text.

3. **Interceptor timeout.** What if a handler hangs? Default
   timeout? Cancellation policy?

4. **Cross-harness event propagation.** Lower harness emits events;
   higher harness wraps and re-emits with context (sessionId, tickId,
   etc.). What's the convention for tagging?

5. **Where do harness boundaries cross process / node boundaries?**
   In-process composition is direct. Cross-node (clustering) wraps
   harnesses. Worth explicit treatment.

6. **Test harness ergonomics.** A `TestHarness<H>` helper that mocks a
   harness uniformly across layers? Worth designing.

7. **Query language shape.** Is `EventQuery` enough, or do we need a richer
   matcher DSL (prefix/wildcard/path-segment operators) for large systems?

8. **Symmetry exceptions.** Which operations are explicitly exempt from
   `requested/before/delta/terminal` (if any), and how are exemptions
   documented?

## Decision Log

- **Harness pattern is fractal — applied at every meaningful layer.**
  (Conversation 2026-05-08) Reason: uniform integration vocabulary;
  symmetric pluggability; learn-once apply-everywhere.

- **Four protocol surfaces: commands, events, interceptors, outcomes.**
  (Conversation 2026-05-08) Reason: minimum-but-complete primitive set.
  Commands for control; events for observation; interceptors for
  coordination; outcomes for completion/failure semantics.

- **Effect Services + Layers + PubSub are the implementation
  vocabulary.** (Conversation 2026-05-08) Reason: matches Effect's
  natural idioms; composable; testable via Layer substitution; one
  vocabulary across all harnesses.

- **Interceptors support proceed / defer / veto / replace responses.**
  (Conversation 2026-05-08) Reason: events alone can't coordinate state
  transitions. Interceptors need request-response semantics with multiple
  verdict types to handle real coordination cases (in-flight work, critical
  regions, transformations).

- **Events and interceptors share one matcher/envelope substrate with two
  modes (observe + intercept).** (Conversation 2026-05-08) Reason: avoids
  parallel integration abstractions that drift and makes global/app/session
  integration behavior uniform.

- **Event naming is hierarchical and semantic.** (Conversation
  2026-05-08) Reason: broad-to-specific names (`harness:domain:action`)
  enable composable filtering and readable taxonomy growth.

- **Phase semantics are symmetrical by default (`requested`, `before`,
  `delta`, `terminal`).** (Conversation 2026-05-08) Reason: explicit lifecycle
  contracts reduce ambiguity and make causality/replay reasoning simpler.

- **Terminal outcomes are broader than errors.** (Conversation 2026-05-08)
  Reason: success, failure, cancellation, veto, replacement, and deferral have
  different semantics. Collapsing all non-success outcomes into errors hides
  useful protocol information.

- **Harnesses stop at meaningful integration boundaries; we don't
  harness internal helpers, library internals, or user code bodies.**
  (Conversation 2026-05-08) Reason: harness has cost (boundary
  ceremony, types, docs). Pay it where it pays back; not below.
