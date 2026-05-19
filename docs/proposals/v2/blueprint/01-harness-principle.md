# 01 — The Harness Principle

**Status:** Synthesized · `[SOURCE: harness-principle.md]` (refined 2026-05-08)

The harness pattern is the architectural spine of v2. Every layer below
conforms to the same shape: an **addressable actor with five integration
surfaces**, the same phase contract for operations, and the same outcome
vocabulary.

This doc is the contract that every harness inherits from. After reading
it, read `19-foundation.md` for the substrate (operations, journal, bus,
inbox) before any per-harness doc.

## What a harness is

A **harness** is an addressable component — conceptually an actor — with
a stable identity, a typed mailbox, and five integration surfaces:

```
                  ┌──────────────────────────────────────────┐
                  │            A Harness                     │
                  │     (addressable actor, stable id)       │
                  │                                          │
   in-process     │   ┌────────────────────────────────┐     │
   imperative ──► │   │ ① Commands                     │     │
   callers        │   │   harness.foo(args)            │     │
                  │   │   direct method calls          │     │
                  │   └─────────────┬──────────────────┘     │
                  │                 │                        │
                  │                 ▼                        │
                  │   ┌────────────────────────────────┐     │
   ANY caller ──► │   │ ② Inbox                        │     │
   (local OR      │   │   typed message handlers       │     │
   remote, by     │   │   addressable, wire-safe       │     │
   address)       │   └────────────────────────────────┘     │
                  │                                          │
   in-process ──► │   ┌────────────────────────────────┐     │
   participants   │   │ ③ Lifecycle handlers           │     │
                  │   │   harness.onX(fn)              │     │
                  │   │   direct fn refs, in-process   │     │
                  │   ├────────────────────────────────┤     │
                  │   │ ④ Middleware                   │     │
                  │   │   harness.use(mw)              │     │
                  │   │   around-style, in-process     │     │
                  │   └────────────────────────────────┘     │
                  │                                          │
                  │   ┌────────────────────────────────┐     │
   ANY observer ◄─│   │ ⑤ Events                       │     │
   (local OR      │   │   bus.subscribe(query, fn)     │     │
   remote)        │   │   pure observation, fan-out    │     │
                  │   └────────────────────────────────┘     │
                  └──────────────────────────────────────────┘
```

External code attaches at one of these surfaces. Internals are private.
The harness boundary is the contract; the implementation behind it is
replaceable.

## The five surfaces at a glance

| # | Surface | Form | Wire-safe? | Affects exec? | Cross-process? |
| --- | --- | --- | --- | --- | --- |
| ① | Commands | direct method call | no (any types) | yes (it IS exec) | no |
| ② | Inbox | typed message via address | **yes** (JSON) | yes | **yes** |
| ③ | Lifecycle handlers | `.onX(fn)` direct fn ref | no | yes | no |
| ④ | Middleware | `.use(mw)` direct fn ref | no | yes | no |
| ⑤ | Events | observation stream | yes (JSON) | **no** | yes |

The crucial property: **the inbox is the cross-process command channel,
events are the cross-process observation channel, and direct fn-ref
surfaces (commands, handlers, middleware) are the in-process fast path.**

## Why a uniform pattern

v1 collapsed because every layer invented its own integration shape.
Lifecycle callbacks looked one way (`onTickStart`, `onComplete`), event
emission looked another (`EventEmitter` on session), tool dispatch a
third (`ExecutionRunner.executeToolCall`), channel subscription a fourth,
cross-cutting middleware a fifth. Contributors had to learn each layer's
idiosyncrasies; integrations were ad-hoc.

The harness principle replaces all of those with one shape:

| v1 mechanism | v2 surface |
| --- | --- |
| Lifecycle callbacks (`onTickStart`, etc.) | ③ Lifecycle handlers (`.onX(fn)`) |
| `app.use(middleware)` | ④ Middleware (`.use(mw)`) |
| `EventEmitter` listeners | ⑤ Events (`bus.subscribe`) |
| `ExecutionRunner.transformCompiled` | ④ Middleware on the relevant op |
| `ExecutionRunner.executeToolCall` | ④ Middleware on tool dispatch |
| Channel `subscribe()` | ⑤ Events (channels are named event subsets) |
| Direct method calls (`session.send`) | ① Commands |
| Cross-process control (new in v2) | ② Inbox |

Same shape across every harness. Learn five surfaces once; apply at every
layer.

## Each surface in detail

### ① Commands

Direct method calls. Imperative, typed.

```ts
session.send({ messages });           // returns SessionExecutionHandle
react.renderTree({ mountId });    // returns RenderedTree
loop.runExecution(input);             // returns ExecutionRunResult
```

- Inputs and outputs are typed (any TypeScript shape; not constrained to
  JSON).
- Implemented as methods on the harness instance (under the hood often
  delegating to `BaseHarness.runOperation`).
- Caller has a direct reference to the harness; this is in-process.
- The harness can refuse with a typed failure; the caller decides what
  to do.

**When:** in-process imperative calls where the caller has a reference.
The fast path. Most user code uses commands.

### ② Inbox

Typed message handlers reachable by **address** rather than by direct
reference.

```ts
// Sent from anywhere — local OR remote (cluster mode)
await messageBus.send("loop:execution-abc-123", {
  type: "halt",
  reason: "user-requested",
});
```

- Each harness has a stable address: `{surface}:{scopeId}`. Examples:
  `loop:execution-abc-123`, `session:user-42`, `compiler:mount-xyz`.
- Each accepted message has a typed shape with a discriminator (`type`).
- Messages are JSON-serializable by construction.
- Local callers AND remote callers reach the same handlers; the runtime
  routes (direct dispatch if local; cluster RPC if remote).
- Per-message handlers can have inbound semantics: ack, error,
  short-circuit. Most handlers just run and return.

**When:** any caller without a direct reference (cross-process, scheduled
external trigger, gateway-side relay, supervisor delegation).

The inbox is **the door to cross-process integration**. In Tier 0 (single
process) the inbox is still useful — local callers without a typed
reference can use it — but the load-bearing case is Tier 2 (cluster).

### ③ Lifecycle handlers

Typed registration points exposed per-harness via `.onX(fn)` methods.
Handlers are **direct function references**; they participate in
execution.

```ts
loop.onTickEnd(async (tickResult) => {
  return session.notifyLifecycle(tickResult);
});

react.onAsyncResolved((info) => {
  metrics.recordResolveLatency(info);
});

session.onHibernateBefore(async () => {
  if (paymentInFlight) throw new VetoError("payment in flight");
});
```

- Registered once at construction or runtime.
- Handler is a direct function (any TypeScript shape; not JSON-constrained).
- Can return values that affect execution (e.g., a tick-end handler
  returning `{ shouldContinue: false }`).
- Can throw to halt or veto.
- Multi-subscriber: multiple handlers per lifecycle moment; runs in
  registration order.

**When:** in-process bindings where one harness wires to another at
construction. The session's `loop.onTickEnd(...)` wiring is the canonical
example.

Lifecycle handlers are NOT events. They aren't filtered against a query;
they aren't envelope-shaped; they don't fan out to arbitrary observers.
They're explicit per-moment registrations.

### ④ Middleware

Around-style wrapping of operations, registered via `.use(mw)`.

```ts
session.use({
  aroundSend: async (input, next) => {
    const start = Date.now();
    const result = await next(input);
    metrics.histogram("send.duration", Date.now() - start);
    return result;
  },
});

loop.use({
  aroundTick: async (tick, next) => {
    if (await rateLimit.check()) return next(tick);
    return { skipped: true };
  },
});
```

- Around-style: middleware can run code before, after, both, or replace
  the operation.
- Direct function references; in-process only.
- Composable in registration order (outer wraps inner).
- Can short-circuit (skip `next()`) to replace.
- Can transform input/output.

**When:** cross-cutting concerns that need to wrap whole operations.
Telemetry timing, rate limiting, transformation pipelines, replay
fixtures.

### ⑤ Events

Broadcast notifications of things that happened. Past tense. Multiple
subscribers, no coordination, no response expected.

```ts
session.events.subscribe(
  { name: { prefix: "tool:dispatch" } },
  (envelope) => audit.log(envelope),
);

app.events.subscribe(
  { name: "loop:tick:terminal", outcome: "succeeded" },
  (envelope) => telemetry.record(envelope),
);
```

- Implemented as `PubSub<EventEnvelope>` under the hood.
- Wire-safe: envelopes are JSON-shaped.
- Cross-process: events fan out via the cluster bus when remote
  subscribers exist.
- Subscribers tied to `Scope` for clean lifecycle.
- **Cost when no subscribers: zero.** PubSub doesn't pay for what no one
  listens to (lazy fan-out).
- **Subscribers cannot affect execution.** They observe; they don't
  participate.

**When:** observability (logs, metrics, dashboards, audit), reactive
integrations (UI updates, devtools), replay/debugging, cross-layer
non-blocking composition.

## When to use which — the canonical rule

```
Need to invoke an operation, in-process, with typed input/output?
  → ① Command (direct method call)

Need to invoke an operation from anywhere (local or remote)?
  → ② Inbox message

Need to participate at a specific lifecycle moment, in-process?
  → ③ Lifecycle handler (.onX)

Need to wrap an operation with around-style behavior, in-process?
  → ④ Middleware (.use)

Need to observe what's happening (no need to affect)?
  → ⑤ Event subscriber
```

**Don't use events to drive execution.** That was the v1 anti-pattern
and the early-v2 over-application. Events observe; participation is
through ③ or ④. Cross-process control is through ②.

## The phase contract (for operations)

Operations — work driven through commands, inbox handlers, lifecycle
handlers, or middleware — emit a strict phase sequence:

```
requested ──► before? ──► delta* ──► terminal
```

| Phase | Required? | Meaning |
| --- | --- | --- |
| `requested` | exactly once | Operation arrived; argument bound. |
| `before` | zero or one | Only for interceptable operations; middleware/handlers run here. |
| `delta` | zero or more | Optional incremental progress. |
| `terminal` | exactly once | Operation completed with an outcome. MUST include `outcome`. |

This contract emits envelopes to the event bus (⑤) for observers. The
mechanics of running the operation use the in-process surfaces (① + ③ +
④); the event stream is the parallel observation channel.

A subscriber that ignores all delta events MUST be able to reconstruct
the correct outcome from the terminal alone — the **terminal correctness
invariant**.

## Outcome vocabulary

Operations terminate with one of:

| Outcome | Meaning |
| --- | --- |
| `succeeded` | Normal completion with result payload. |
| `failed` | Typed error in `E` channel. |
| `canceled` | Abort or cancellation signal triggered. |
| `vetoed` | Lifecycle handler / middleware halted before completion. |
| `replaced` | Lifecycle handler / middleware supplied a result without normal execution. |
| `deferred` | Lifecycle handler / middleware requested a delay. |

**Outcome payload rule:** non-success outcomes that are protocol-defined
(`vetoed`, `replaced`, `deferred`) are **successful harness executions
with non-success domain outcomes**. They MUST NOT use Effect's failure
channel unless the harness itself failed.

Effect's `E` channel is reserved for: provider errors, validation errors,
network errors, invariant violations, and cancellation-as-failure.

## Cross-process semantics

The architectural commitment to library-first AND distributed-capable
rests on this split:

```
Surface          Tier 0/1 (in-process)         Tier 2 (cluster)
─────────────────────────────────────────────────────────────────
① Commands       direct method call            local only — direct method call
                                                (cross-node use ② via address)

② Inbox          local dispatch, fast          local-or-remote routing
                                                via cluster framework (RPC)

③ Lifecycle      direct fn ref, fast           local only — same as Tier 0/1
   handlers                                     (cross-node concerns use ② or ⑤)

④ Middleware     direct fn ref, fast           local only — same as Tier 0/1

⑤ Events         in-memory PubSub              fan-out via cluster bus
                                                (Redis Streams / NATS JetStream)
```

This is the property that makes "library-first AND distributed-capable"
honest. We do NOT pay distributed-system overhead in library mode
(direct fn refs are 1-2us). We do NOT lock OUT distributed integration
(② and ⑤ are wire-safe by construction).

**Hard constraint:** lifecycle handlers and middleware are in-process by
design. If a feature needs cross-process participation in execution, it
must use ② (typed message to a harness's inbox) or ⑤ (observation only,
indirect coordination through events). We don't add cross-process direct
fn refs; that's RPC with all its failure modes, which we'd rather make
explicit at the inbox boundary.

## Handler / middleware ordering

When multiple handlers or middleware are registered, ordering matters.

**Lifecycle handlers** run in registration order. If multiple are
registered against the same lifecycle moment, the runtime invokes each
in order, awaiting each. Handlers can modify shared mutable state
(per-moment context object) to influence subsequent handlers and the
host harness.

**Middleware** composes outer-wraps-inner in registration order:

```
session.use(mw1);  // outer
session.use(mw2);  // middle
session.use(mw3);  // inner

// runtime invokes:
// mw1.before → mw2.before → mw3.before → operation body →
// mw3.after → mw2.after → mw1.after
```

**Cross-scope:** handlers/middleware can be registered at global
(runtime), app, or session scope. Outer-to-inner order on `before`
phases (global → app → session); inner-to-outer on `terminal` phases.

## Where the harness pattern stops

The pattern is fractal but not absolute. It explicitly does not extend
to:

- **React's reconciler internals** — wrapped by the reconciler harness;
  reconciler internals stay private.
- **Provider SDK clients** — wrapped as executor implementations.
- **Effect runtime primitives** — foundational.
- **Tool handler bodies** — user code; once invoked through the tool
  executor harness boundary, the body is just a function.
- **Internal helpers** — anything below "meaningful integration boundary"
  is bureaucracy.

**Harness the layers that have meaningful integration points and
composition boundaries.** Below that, stop.

## What this enables

| Property | Mechanism |
| --- | --- |
| **Symmetry** | Five surfaces, same shape, every layer. |
| **Pluggability** | Swap any harness implementation by substituting a Layer. |
| **Composable observability** | Subscribe at any harness; events compose by scope. |
| **Cross-process integration without overhead penalty** | Inbox is wire-safe; in-process couplings use direct fn refs. |
| **Uniform testability** | Mock any harness; same pattern at every level. |
| **Explicit integration points** | Where do I plug in X? At the relevant surface of the relevant harness. |
| **Library-first AND distributed-capable** | Hybrid surfaces by design. |

## Reference: per-layer harness shapes

Each harness gets its own doc. The shapes:

| Harness | Surface ID | Doc | Notable inbox messages |
| --- | --- | --- | --- |
| App | `app` | `09-app-harness.md` | `create-session`, `close-app` |
| Session | `session` | `08-session-harness.md` | `send`, `dispatch`, `abort`, `pause`, `hibernate`, `inject-input` |
| Loop executor | `loop` | `05-loop-executor.md` | `halt`, `pause` |
| React | `react` | `03-reconciler-harness.md` | `recompile`, `unmount` |
| ~~Renderer~~ | (no harness) | `04-formatters.md` | Formatters are pure functions, not a harness — see ADR 22 |
| Executor | `executor` | `06-executor-harness.md` | `abort` |
| Tool executor | `tool` | `07-tool-executor.md` | `abort`, `confirmation-response` |

Each per-harness doc follows a uniform template:

1. What the harness manages.
2. Commands (direct method API).
3. Inbox messages (addressable, wire-safe).
4. Lifecycle handlers (`.onX(fn)` registrations).
5. Middleware boundaries (`.use(mw)` opportunities).
6. Events out (taxonomy).
7. Outcomes and failures.
8. Composition (how this harness consumes/feeds others).
9. Examples.
10. Open questions.

## Decisions captured

- **Five surfaces, not four.** Commands, inbox, lifecycle handlers,
  middleware, events.
- **The harness is an addressable actor.** Stable address; typed inbox.
- **Events do NOT drive execution.** Pure observation. Multi-subscriber.
- **Lifecycle handlers and middleware are direct fn refs.** In-process
  only. Type-safe. Fast.
- **Inbox is the cross-process command channel.** Wire-safe. Routed by
  the runtime (local dispatch or cluster RPC).
- **Library-first AND distributed-capable falls out of the surface
  split.** No tax in library mode; no lock-out for cluster mode.
- **Effect Services + Layers + PubSub + cluster RPC are the implementation
  vocabulary.**
- **Phase contract on operations is uniform** (`requested → before →
  delta* → terminal`).
- **Outcome vocabulary spans success/failure/cancellation/veto/replace/
  defer.**
- **Cross-scope handler ordering: outer-in for `before`, inner-out for
  `terminal`.**
- **Harnesses stop at meaningful integration boundaries.**
