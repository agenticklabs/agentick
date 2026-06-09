# 19 — Foundation: The Substrate Below the Harnesses

**Status:** New — needs review · synthesized from the durability discussion

This doc describes the substrate every harness sits on. It is the part
of v2 that makes the system **durable, resumable, and observable by
construction**, regardless of whether you've configured persistence,
clustering, or telemetry exporters.

> Reading order: this doc should be read **after `01-harness-principle.md`**
> (so you know what a harness is) but **before any per-harness doc**
> (since each harness inherits from the substrate described here).

## What this is

The system is, conceptually, **one stream of typed envelopes** carried
through a single pipeline. Operations, channel events, discrete
notifications, inbound messages — all share related envelope shapes.
Four substrate components handle different sinks/sources:

- **`OperationJournal`** — durable record (recovery, audit, idempotency).
- **`EventBus`** — live observation (telemetry, devtools, dashboards).
- **`MessageInbox`** — addressable inbound messages (cross-process command
  channel; the actor's mailbox).
- **OTel exporter** — projection of the bus into spans/metrics/logs.

They are not separate systems; the journal and bus share the same write
path, OTel is a projection, and the inbox is the actor's symmetric
counterpart to the bus. Every harness inherits a base class that exposes
all of these uniformly.

Durability, observability, and addressability are not features added
per harness; they are properties of the substrate every harness shares.

## The mental model in one diagram

```
                      ┌──────────────────────────────────────┐
                      │      A Harness (addressable actor)   │
                      │                                      │
                      │    Five integration surfaces         │
                      │    (see 01-harness-principle.md)     │
                      └─────────┬─────────────┬──────────────┘
                                │             │
                                │             │ event envelopes
                          messages in         │ flow out
                                │             │
                                ▼             ▼
       ┌─────────────────────────────────────────────────────┐
       │     ProtocolEvent envelopes  +  Message envelopes   │
       │             (canonical record types)                │
       └────┬───────────────┬───────────────┬─────────┬──────┘
            │               │               │         │
            ▼               ▼               ▼         ▼
   OperationJournal    EventBus        OTel exporter  MessageInbox
   ─────────────────   ──────────      ──────────     ─────────────
   durable record      live observers  spans, metrics  addressable
   replay, audit       channels        logs            inbound dispatch
   crash recovery      devtools        dashboards      local + remote
   idempotency
        │                  │                │              │
        ▼                  ▼                ▼              ▼
   Memory ring /        Effect          Datadog /       Local registry /
   Postgres / Redis /   PubSub          Tempo /         Cluster RPC
   Cluster journal      Stream          Honeycomb       (@effect/cluster)
```

Three categories of envelope on the **outbound** side:

| Category                | Created by                            | Phase contract? | Idempotent?            | Use                                  |
| ----------------------- | ------------------------------------- | --------------- | ---------------------- | ------------------------------------ |
| **Operation** lifecycle | `BaseHarness.runOperation`            | yes             | yes                    | Commands with typed outcomes         |
| **Discrete** event      | `BaseHarness.emit` (or `bus.publish`) | no              | no                     | Notifications, infrastructure events |
| **Channel** event       | `channel.publish(...)`                | no              | no (retention applies) | User-defined named streams           |

One category on the **inbound** side:

| Category    | Created by                    | Wire-safe?     | Routing                       | Use                                               |
| ----------- | ----------------------------- | -------------- | ----------------------------- | ------------------------------------------------- |
| **Message** | external sender to an address | **yes** (JSON) | local dispatch or cluster RPC | Addressable inbound commands; the actor's mailbox |

## The Operation envelope

```ts
interface Operation<I, R, E> {
  /** Stable identity. Caller-supplied (gateway boundary) or system-generated. */
  opId: string;

  /** Causality — operation that initiated this one. */
  parentOpId?: string;

  /** Request bundle id, when many operations belong to one user request. */
  correlationId?: string;

  /** Surface emitting this operation. */
  surface: EventSurface;

  /** Hierarchical name: <surface>:<domain>:<action> */
  name: string;

  /** Scope context (sessionId, executionId, tickId, tenantId, nodeId, ...). */
  scope: EventScope;

  /** The typed input. */
  input: I;

  /** Phantoms for return type inference. */
  __r?: R;
  __e?: E;
}

type TerminalEvent<R = unknown, E = unknown> =
  | { phase: "terminal"; outcome: "succeeded"; result: R }
  | { phase: "terminal"; outcome: "failed"; error: E }
  | { phase: "terminal"; outcome: "canceled"; reason?: string }
  | { phase: "terminal"; outcome: "vetoed"; reason?: string }
  | { phase: "terminal"; outcome: "replaced"; result: R; reason?: string }
  | { phase: "terminal"; outcome: "deferred"; retryAfter?: number };
```

Operations are journaled as a sequence of `ProtocolEvent` envelopes:

```
opId X:
  envelope { phase: "requested" }   ← always
  envelope { phase: "before" }      ← if interceptable
  envelope { phase: "delta" } * N   ← optional, streaming
  envelope { phase: "terminal", outcome: ... }   ← always exactly one
```

The terminal envelope is what `journal.lookupTerminal(opId)` returns on
idempotent replay.

## The Discrete event envelope

```ts
interface DiscreteEvent {
  /** Unique envelope id; not an opId. */
  id: string;

  /** Optional causality link to a parent operation. */
  parentOpId?: string;

  surface: EventSurface;
  name: string;
  scope: EventScope;
  payload?: unknown;
  tags?: string[];
  timestamp: number;
}
```

Discrete events have **no phase**, **no outcome**, **no opId**. They are
notifications: "a thing happened." Examples:

```
reconciler:async:resolved             ← React tree state change
reconciler:suspended
cluster:node:joined              ← cluster framework lifecycle
cluster:node:left
gateway:transport:connected      ← network lifecycle
gateway:transport:disconnected
session:timeline:entry-committed ← finer-grained "an entry landed" notice
                                   (the parent op was a loop:ingest)
```

The rule:

> **If something has a caller awaiting a typed outcome, it's an Operation.
> If it's just a notification, it's a Discrete event.**

## The Channel event envelope

```ts
interface ChannelEvent<T = unknown> extends DiscreteEvent {
  surface: "session";
  name: `session:channel:${string}`;
  payload: T;

  /** Per-session monotonic offset within this channel. */
  channelSequence: number;
}
```

Channel events are **discrete events with a name pattern and retention
policy**. They are first-class because user code subscribes to them with
offset semantics (read from beginning, latest, or specific offset). But
they are not a separate primitive — they're a slice of the journal with a
named retention configuration.

```
session.channel("orders")
  ─► subscribes to journal: name pattern `session:channel:orders`
  ─► reads with offset semantics (channelSequence)
  ─► retention: configurable (256 entries / 30 min default)
```

## The OperationJournal contract

```ts
interface OperationJournal {
  /** Append an envelope. Idempotent on (opId, phase) for operations. */
  append(event: ProtocolEvent): Effect<void, JournalError, never>;

  /** Read events matching a query, from a given offset. */
  read(
    query: EventQuery,
    from: { offset: number } | "latest" | "beginning",
  ): Stream<ProtocolEvent, JournalError, never>;

  /** Subscribe to ongoing events matching a query. */
  tail(query: EventQuery): Stream<ProtocolEvent, never, never>;

  /** Idempotency lookup. Returns Some(terminal) if opId already terminated. */
  lookupTerminal(opId: string): Effect<Option<TerminalEvent>, JournalError, never>;

  /** Query operations that started but never reached terminal. Used at boot. */
  findOrphaned(query: {
    surface?: EventSurface;
    olderThan?: number;
  }): Effect<readonly OrphanedOperation[], JournalError, never>;
}

type JournalError =
  | { _tag: "WriteFailed"; cause: unknown }
  | { _tag: "ReadFailed"; cause: unknown }
  | { _tag: "OffsetOutOfRange"; requested: number; oldest: number };
```

Three properties matter:

1. **Append-only.** New envelopes are added; old ones are never mutated.
2. **Indexed by `EventQuery`.** Same query model as observers (one
   matcher across journal/bus).
3. **Idempotent terminal lookup.** Given an `opId`, can the journal
   answer "did this already terminate?" If yes, replay returns the cached
   terminal instead of re-executing.

### Implementations as Effect Layers

```ts
OperationJournal.memory({ maxEntries?: number }): Layer<OperationJournal>
OperationJournal.sqlite({ path: string }): Layer<OperationJournal>
OperationJournal.postgres({ url: string }): Layer<OperationJournal>
OperationJournal.redisStreams({ url: string }): Layer<OperationJournal>
OperationJournal.cluster(/* @effect/cluster wiring */): Layer<OperationJournal>
```

Same protocol; different substrate. **The harness code never knows which
one is wired in.**

## The PubSub bus

```ts
interface EventBus {
  publish(event: ProtocolEvent): Effect<void, never, never>;
  subscribe(query: EventQuery): Stream<ProtocolEvent, never, Scope>;
}
```

The bus is `PubSub<ProtocolEvent>` from Effect, scoped per-harness or
per-session as appropriate. Subscribers are `Stream<ProtocolEvent>` with
backpressure built in (Effect's PubSub is bounded by configurable
overflow strategy: `dropping`, `sliding`, `suspend`, or `unbounded`).

**The bus and the journal share the write path but are not the same
sink.** A single `BaseHarness.publish(event)` operation may write to:

```
publish(event)
   ├─► bus.publish(event)        ← live subscribers see it immediately
   ├─► journal.append(event)     ← durable record (if policy says so)
   └─► OTel exporter             ← bus subscriber; sees everything
```

**Whether a given event hits the journal depends on the journaling
policy** (next section). Some events go to bus only. This is what makes
high-cadence streaming affordable in production.

**Lazy fan-out**: if no subscriber matches an event's query, the
publish is a cheap no-op. Headless cost = zero.

## The MessageInbox

The inbox is the **inbound** counterpart to the event bus. Where the bus
is for observation (what happened), the inbox is for control (what
should happen). It's the actor's mailbox.

```ts
interface MessageInbox {
  /** Register typed message handlers for a given harness address. */
  register<T extends MessageEnvelope>(
    address: string,
    handler: MessageHandler<T>,
  ): Effect<Unsubscribe, InboxError, never>;

  /** Send a message to a harness by address. Local OR remote routing. */
  send<T extends MessageEnvelope>(
    address: string,
    message: T,
  ): Effect<MessageAck, InboxError, never>;

  /** Ask: send and await a typed response. */
  ask<T extends MessageEnvelope, R>(
    address: string,
    message: T,
    options?: { timeoutMs?: number },
  ): Effect<R, InboxError | MessageHandlerError, never>;
}

interface MessageEnvelope {
  /** Recipient address — `{surface}:{scopeId}`. */
  addressedTo: string;
  /** Discriminator within the recipient's accepted message set. */
  type: string;
  /** Optional sender address for response/ack. */
  from?: string;
  /** Idempotency key (caller-supplied; defaults to system ULID). */
  messageId: string;
  /** Causality. */
  parentOpId?: string;
  correlationId?: string;
  /** Typed payload by message type. */
  payload?: unknown;
  /** ISO timestamp at send. */
  timestamp: number;
}

type MessageHandler<T extends MessageEnvelope> = (
  msg: T,
) => Effect<unknown, MessageHandlerError, never>;

type InboxError =
  | { _tag: "AddressNotFound"; address: string }
  | { _tag: "RoutingFailed"; cause: unknown }
  | { _tag: "InboxClosed" };

type MessageHandlerError = { _tag: "HandlerError"; cause: unknown };
```

### Local vs cluster dispatch

```ts
MessageInbox.local(): Layer<MessageInbox>           // in-process registry
MessageInbox.cluster(/* @effect/cluster wiring */): Layer<MessageInbox>
```

The local implementation is a `Map<address, MessageHandler>`. `send`
looks up the address and dispatches synchronously (well, on the next
microtask — it's an Effect). Cluster mode replaces this with cluster-aware
routing where unknown-locally addresses go to the cluster framework.

Same protocol; same handler signatures. **Harness code never knows which
backend is wired in.**

### Tell vs ask semantics

Two send shapes:

```ts
// Tell: fire-and-forget
await inbox.send("loop:abc-123", {
  addressedTo: "loop:abc-123",
  type: "halt",
  payload: { reason: "user-requested" },
  messageId: ULID(),
  timestamp: Date.now(),
});

// Ask: send + await response
const decision = await inbox.ask<HaltMessage, HaltAck>(
  "loop:abc-123",
  { ... type: "halt", ... },
  { timeoutMs: 5000 },
);
```

Tell is the fast path (no response needed; e.g., halt, pause, inject).
Ask is for query-shaped messages (get-state, request-decision); has a
timeout because remote handlers might be unreachable.

Most inbox messages are tell. Use ask sparingly — it's RPC-shaped and
inherits RPC's failure modes.

### Idempotency on messages

`messageId` is the idempotency key. If the same `messageId` arrives
twice (e.g., gateway retried due to network blip), the handler runs
once; subsequent dispatches return the cached response (for ask) or
ack-only (for tell).

The inbox tracks in-flight + recent message ids in compiler-private
state. Eviction policy: 10-minute TTL or LRU bound. (Rate of unique
messageIds at a single harness is bounded; this is cheap.)

### Address allocation

Each harness allocates its address at construction:

```ts
class LoopExecutorHarness extends BaseHarness<"loop"> {
  constructor(executionId: string, ...) {
    super(...);
    this.address = `loop:${executionId}`;
    this.unsubInbox = this.inbox.register(this.address, this.handleMessage);
  }
}
```

Addresses are `{surface}:{scopeId}` by convention. Per-session entities
get session-scoped addresses (`session:user-42`). Per-execution entities
get execution-scoped addresses (`loop:exec-abc-123`). Singleton entities
(supervisor) get bare-surface addresses (`supervisor:main`).

## Backpressure and the write-path policy

The system will run a lot of background work (executions, ticks, tool
dispatches, channel publishes, subscriptions firing). Without explicit
write-path discipline, observability and durability writes become
contention points: a slow Postgres journal blocks every harness command;
a dropped Redis stream silently loses operation lifecycle. We need
explicit policy.

### What Effect gives us

Effect's primitives line up well here:

| Need                                 | Effect primitive                                        |
| ------------------------------------ | ------------------------------------------------------- |
| Decouple producer from slow consumer | `Queue` or `PubSub` with bounded buffer                 |
| Drop policy on overflow              | `BackingQueue.dropping` / `sliding` / `suspend`         |
| Async write fork                     | `Effect.fork` returns a fiber; producer doesn't wait    |
| Bounded subscriber buffer            | `Stream.buffer({ capacity, strategy })`                 |
| Throttle / batch                     | `Stream.groupedWithin`, `Stream.throttle`               |
| Backpressure on streams              | `Stream`'s pull-based model is backpressured by default |

This means **journal writes can be async, with a bounded queue between
the harness and the durable backend**:

```
Harness                      Bounded Queue              Journal worker
─────────                    ─────────────              ──────────────
runOperation
  ── enqueue envelope ──►
                              (in-memory, fast)
                                                        take from queue
                                                        ── append to backend ──►
                                                                          (Postgres / Redis)

If queue is full:
  - "suspend"   : producer waits     (preserves durability, costs latency)
  - "sliding"   : drop oldest        (preserves recent events, lossy)
  - "dropping"  : drop newest        (preserves throughput, lossy)
```

The producer (the harness's command code path) does **not** block on
the durable backend. It pays only the in-memory queue enqueue cost.

### Per-phase journaling policy

Not every envelope needs to be durable. The journal is the **recovery +
audit** layer; the bus is the **live observability** stream. They diverge
on high-cadence events.

```ts
interface JournalingPolicy {
  /** Phases that always go to journal (and bus). Cannot be dropped. */
  alwaysJournal: ReadonlyArray<EventPhase>;

  /** Phases that go to bus only. Subscribers see live; not durable. */
  busOnly: ReadonlyArray<EventPhase>;

  /** Per-event-name overrides (by exact name or prefix). */
  override?: Record<string, "always" | "bus-only" | "drop">;

  /** Backpressure strategy when the journal write queue is full. */
  overflow: "suspend" | "sliding" | "dropping";

  /** Bounded queue capacity. */
  queueCapacity: number;
}

const DEFAULT_POLICY: JournalingPolicy = {
  alwaysJournal: ["requested", "terminal"], // recovery + audit spine
  busOnly: ["before", "delta"], // observability noise
  overflow: "sliding", // favor harness throughput
  queueCapacity: 4096,
};
```

What this means in practice:

- **Every operation has `requested` + `terminal` in the journal.** That's
  enough for crash recovery (find ops with no terminal) and for audit
  ("when was this dispatched, when did it finish, what was the
  outcome?").
- **`before` phase events** (interceptor decisions) go to the bus.
  Subscribers can observe; they're not durable. Acceptable because the
  outcome is encoded in `terminal` regardless.
- **`delta` events** go to the bus. Subscribers render progressively;
  they're not durable. If you ignore deltas and read terminal, you get
  the right answer.
- **Channels default to `alwaysJournal`** because they are application
  domain events — losing them silently is wrong.
- **Critical channels** (audit logs, payment events) override to
  `overflow: "suspend"` so the publisher waits rather than drops.

### Per-surface tunability

`JournalingPolicy` is configured per-surface (per-harness) and can be
overridden per-event-name. Defaults handle 90% of cases; ops can dial
the knobs in production.

```ts
createApp(<Agent />, {
  journaling: {
    "executor": { busOnly: ["before", "delta"] },          // default
    "tool":     { alwaysJournal: ["requested", "before", "terminal"] },  // tighter audit
    "reconciler":  { alwaysJournal: ["terminal"], busOnly: ["requested", "before", "delta"] },
                  // many compile cycles per session; only persist terminal
  },
});
```

### Concrete shapes

`BaseHarness` consults the policy on every event:

```ts
protected emit(envelope: ProtocolEvent): Effect<void> {
  return Effect.gen(this, function* () {
    const policy = this.policyFor(envelope);

    // Bus is always notified (lazy fan-out makes this free with no subs)
    yield* this.bus.publish(envelope);

    // Journal is conditional
    if (policy === "always") {
      yield* this.journalQueue.offer(envelope);   // bounded queue, may drop
    }
    // "bus-only" and "drop" do nothing further
  });
}
```

A worker fiber drains the queue:

```ts
const journalWorker = Effect.forever(
  Effect.gen(function* () {
    const batch = yield* this.journalQueue.takeBetween(1, 64);
    yield* this.journal.appendBatch(batch);
    // appendBatch is a single transaction in durable backends
  }),
).pipe(Effect.forkScoped);
```

### Acknowledgment

We are not designing this perfectly up front. The decisions above (which
phases are durable by default, what the default queue size is, how
overflow behaves) will move as we observe real workloads. **What
matters is that the architecture has the right knobs in the right
places.** Backpressure isn't an afterthought added later; it's a
property of the journal write path from day one.

## OpenTelemetry as a projection

OTel is a _consumer_ of the envelope stream, not a parallel system.

```
                   ProtocolEvent envelopes
                            │
                            ▼
                   OTel exporter (subscriber)
                            │
                            ├─► Spans
                            │   - requested → Effect.withSpan starts
                            │   - delta → span event
                            │   - terminal → span ends with status from outcome
                            │
                            ├─► Metrics
                            │   - counters from outcome counts
                            │   - histograms from terminal − requested duration
                            │   - gauges from lifecycle events (active sessions, ...)
                            │
                            └─► Logs
                                - structured log line per terminal event
                                - level derived from outcome
                                  (succeeded → INFO, failed → ERROR, ...)
```

In Effect terms, BaseHarness wraps each operation in `Effect.withSpan`:

```ts
protected runOperation<I, R, E>(op: Operation<I, R, E>, body): Effect<R, E, Scope> {
  return body(op.input).pipe(
    Effect.withSpan(op.name, {
      attributes: {
        opId: op.opId,
        parentOpId: op.parentOpId,
        surface: op.surface,
        ...op.scope,
      },
    }),
    Effect.tapBoth({
      onFailure: (e) => this.appendTerminal(op, { outcome: "failed", error: e }),
      onSuccess: (r) => this.appendTerminal(op, { outcome: "succeeded", result: r }),
    }),
  );
}
```

Effect's `FiberRef`-based span context propagates parent/child across
forks, so **`parentOpId` and OTel parent spanId align automatically.**
Same tree, two views.

Wiring an OTel exporter is one Layer:

```ts
import { NodeSdk } from "@effect/opentelemetry";

const TelemetryLayer = NodeSdk.layer(() => ({
  resource: { serviceName: "my-agent" },
  spanProcessor: new BatchSpanProcessor(otlpExporter),
}));

createApp(<Agent />, { telemetry: TelemetryLayer });
```

Zero observability code in the harnesses.

## `BaseHarness` — the inheritance point

`BaseHarness` exposes the five surfaces from
`01-harness-principle.md` and gives every concrete harness:

- ① **Commands** via `runOperation` (the heavy path with phase contract,
  idempotency, journaling, span wrapping).
- ② **Inbox** via the `MessageInbox` (typed inbound message dispatch,
  local or cluster).
- ③ **Lifecycle handlers** registry (typed `.onX(fn)` registration).
- ④ **Middleware** chain (`.use(mw)` registration).
- ⑤ **Events** via `emit` (light path) and `emitDelta` (in-flight progress).

```ts
abstract class BaseHarness<Surface extends EventSurface> {
  protected readonly address: string; // {surface}:{scopeId}

  // ⑤ Lifecycle handler registries (typed per concrete harness)
  protected readonly handlers = new HandlerRegistry();

  // ④ Middleware chain
  protected readonly middleware = new MiddlewareChain();

  constructor(
    protected readonly surface: Surface,
    protected readonly scopeId: string,
    protected readonly journal: OperationJournal,
    protected readonly bus: EventBus,
    protected readonly inbox: MessageInbox,
    protected readonly policy: JournalingPolicy = DEFAULT_POLICY,
  ) {
    this.address = `${surface}:${scopeId}`;

    // Register inbox at the address; concrete harness overrides handleMessage
    this.inbox.register(this.address, this.handleMessage.bind(this));
  }

  // ──────── ① Commands (heavy path) ────────

  /**
   * Wraps a command body in operation lifecycle:
   * idempotency check → requested → middleware before → handlers before →
   * body → handlers after → middleware after → terminal.
   */
  protected runOperation<I, R, E>(
    op: Operation<I, R, E>,
    body: (input: I) => Effect<R, E, Scope>,
  ): Effect<R, E, Scope> {
    return Effect.gen(this, function* () {
      // 1. Idempotency check
      const cached = yield* this.journal.lookupTerminal(op.opId);
      if (Option.isSome(cached)) return yield* this.replayTerminal(cached.value);

      // 2. Append `requested`
      yield* this.appendPhase(op, "requested");

      // 3. Compose middleware chain (outer → inner)
      const composed = this.middleware.compose(op.name, body);

      // 4. Run `before` lifecycle handlers (in order; can throw to veto)
      yield* this.appendPhase(op, "before");
      const beforeOutcome = yield* this.handlers.runBefore(op);
      switch (beforeOutcome.kind) {
        case "veto":
          return yield* this.appendTerminalAndFail(op, "vetoed", beforeOutcome);
        case "replace":
          return yield* this.appendTerminalAndReturn(op, "replaced", beforeOutcome.result);
        case "defer":
          return yield* this.appendTerminalAndDefer(op, beforeOutcome);
        case "proceed":
          break;
      }

      // 5. Execute composed (middleware-wrapped) body in child Scope with span
      const result = yield* Effect.scoped(composed(op.input)).pipe(
        Effect.withSpan(op.name, { attributes: this.spanAttributes(op) }),
        Effect.tapBoth({
          onFailure: (e) => this.appendTerminal(op, "failed", { error: e }),
          onSuccess: (r) =>
            Effect.gen(this, function* () {
              // 6. Run `after` lifecycle handlers (post-success only)
              yield* this.handlers.runAfter(op, r);
              yield* this.appendTerminal(op, "succeeded", { result: r });
            }),
        }),
      );
      return result;
    });
  }

  // ──────── ⑤ Events (light path) ────────

  /** Emit a discrete event. No phase contract, no idempotency. */
  protected emit(envelope: Omit<DiscreteEvent, "id" | "timestamp" | "surface">): Effect<void> {
    return this.publishEnvelope({
      ...envelope,
      surface: this.surface,
      id: ULID.generate(),
      timestamp: Date.now(),
    } as ProtocolEvent);
  }

  /** Streaming progress within an active operation. */
  protected emitDelta(op: Operation<unknown, unknown, unknown>, delta: unknown): Effect<void> {
    return this.appendPhase(op, "delta", { payload: delta });
  }

  // ──────── ② Inbox (concrete harness override) ────────

  /**
   * Concrete harnesses override this with a typed switch on message.type.
   * Default: throw NoHandlerForMessageType.
   */
  protected abstract handleMessage(
    msg: MessageEnvelope,
  ): Effect<unknown, MessageHandlerError, never>;

  // ──────── Internal: write-path policy ────────

  /** Publishes an envelope to bus + (conditionally) journal per policy. */
  private publishEnvelope(envelope: ProtocolEvent): Effect<void> {
    return Effect.gen(this, function* () {
      yield* this.bus.publish(envelope); // always (lazy fan-out)
      if (this.shouldJournal(envelope)) {
        yield* this.journalQueue.offer(envelope); // bounded, may drop
      }
    });
  }

  // Implementation helpers omitted: appendPhase, replayTerminal, spanAttributes,
  // shouldJournal, journalQueue, etc.
}
```

### How a concrete harness uses each surface

```ts
class LoopExecutorHarness extends BaseHarness<"loop"> {
  // ① Commands
  runExecution(input: RunExecutionInput): Effect<ExecutionRunResult, LoopError, LoopEnv> {
    const op: Operation<RunExecutionInput, ExecutionRunResult, LoopError> = {
      opId: input.executionId,
      surface: "loop",
      name: "loop:execution:run",
      scope: { sessionId: input.sessionId, executionId: input.executionId },
      input,
    };
    return this.runOperation(op, (input) => this.runExecutionBody(input));
  }

  // ③ Lifecycle handler registration (typed)
  onTickEnd(handler: TickEndHandler): Unsubscribe {
    return this.handlers.register("tickEnd", handler);
  }

  // ② Inbox handlers (typed switch)
  protected handleMessage(msg: MessageEnvelope): Effect<unknown, MessageHandlerError, never> {
    switch (msg.type) {
      case "halt":
        return this.handleHalt(msg.payload as HaltMessage);
      case "pause":
        return this.handlePause(msg.payload as PauseMessage);
      default:
        return Effect.fail({ _tag: "HandlerError", cause: new Error(`unknown: ${msg.type}`) });
    }
  }

  private handleHalt(payload: HaltMessage): Effect<void, MessageHandlerError, never> {
    return Effect.gen(this, function* () {
      this.signal.abort(payload.reason);
      yield* this.emit({ name: "loop:execution:halted", payload });
    });
  }

  // ⑤ Events: emit on bus directly, or via emitDelta during operations
  // (handled by runOperation lifecycle)

  // Internal: runs the actual tick loop, calling handlers at lifecycle points
  private async runExecutionBody(input): Effect<ExecutionRunResult, ...> {
    // ... per tick ...
    const tickResult = await this.runTick(...);

    // Fire ③ lifecycle handler (direct fn refs, in-process, fast)
    const decision = await this.handlers.fire("tickEnd", tickResult);

    // Continue or stop based on decision
    // ...
  }
}
```

The concrete harness writes the **body** of each command. Phase emission,
idempotency, journaling, span wrapping, lifecycle handler dispatch,
middleware composition, inbox routing — all handled by `BaseHarness`.

## Idempotency rules

The minimum set of rules. We add nuance only when a real case forces it.

```
Caller-supplied opId
  - Used at gateway/transport boundary where retry-safe semantics matter
  - Same opId → cached terminal returned on subsequent calls
  - Stored in journal; survives process restart with durable backend

System-generated opId (ULID)
  - Used internally between harnesses
  - Idempotent within a session/process
  - Cluster mode: cluster framework supplies globally-unique ids

Operations with side effects outside Agentick
  - Provider HTTP call, sandbox file write, etc.
  - We can't make a non-idempotent provider call idempotent at our layer
  - We CAN ensure WE don't double-issue: journal.lookupTerminal returns
    cached terminal so the side effect doesn't re-run on replay
```

**What we deliberately don't specify yet:**

- Conflict semantics for "same opId, different input" — current rule is
  "first call wins; subsequent calls return the cached terminal." If a
  real case demands conflict detection, we add it then.
- Special handling for results that carry non-data shapes (live streams,
  open handles). Current rule is "terminal results are JSON-serializable;
  if your result needs a live handle, return a reference instead." If
  this proves too restrictive, we revisit.

## Crash recovery

When a process boots with a durable journal:

```
1. Connect to OperationJournal.
2. journal.findOrphaned({ olderThan: thresholdMs }) → operations stuck
   in `requested` without `terminal`.
3. For each orphaned operation: append a synthetic
   terminal:failed { reason: "abandoned-on-restart" }.
4. Resume normal operation.
```

The default policy is **abandon**. If a specific harness has a real need
to retry or resume orphaned operations, it overrides this policy by
implementing its own recovery handler. We don't ship a `retry`/`resume`
taxonomy until we have a concrete case that needs it.

In-memory journal mode (Tier 0) has nothing to recover; `findOrphaned`
returns empty.

Crash recovery is not a feature of any specific harness — it's a property
of the substrate. Every harness's commands automatically participate.

## Conformance test contract

Every `OperationJournal` implementation (memory, sqlite, postgres,
redis, cluster) MUST pass the same conformance suite. Without this,
swapping Layers is aspirational — implementations will drift in
subtle ways.

### Where the conformance suite lives

The test suite that validates `OperationJournal`, `BaseHarness`, and
other foundation contracts is **kept private to the project — not
published to npm.** It lives in a private monorepo package:

```
packages/
  spec-conformance/
    package.json    { "private": true, ... }
    src/
      runJournalConformance.ts
      runHarnessConformance.ts
      ...
```

Rationale:

- The spec types themselves remain public (so consumers can implement
  against the contract).
- The conformance suite is **how we know our implementations are
  correct**. It's a competitive and engineering asset, not a public
  artifact.
- Third parties writing journal/harness implementations against
  `@agentick/spec-next` cannot run our tests; that's intentional. They
  conform by writing their own tests against the published types.
- Internal packages (`@agentick/runtime-next`,
  `@agentick/persistence-postgres`, etc.) depend on
  `@agentick/spec-conformance-next` as a `devDependency` to validate
  themselves.

A shared fixture, used internally:

```ts
import { runJournalConformance } from "@agentick/spec-conformance-next";

describe("MemoryJournal", () => {
  runJournalConformance(() => createMemoryJournal());
});

describe("PostgresJournal", () => {
  runJournalConformance(() => createPostgresJournal({ url: TEST_DB_URL }));
});
```

`runJournalConformance` exercises the protocol contract:

```
Append/read invariants:
  - append(e) makes e visible to read({}, "beginning")
  - read order matches append order within a single writer
  - tail() yields appended events to live subscribers
  - lookupTerminal returns Some(terminal) iff a terminal phase was
    appended for that opId
  - findOrphaned returns operations with requested but no terminal
  - Unknown query fields are ignored, not errors

Idempotency invariants:
  - appending the same (opId, phase) twice is a no-op
  - lookupTerminal is consistent across reads

Backpressure invariants:
  - Bounded queue overflow follows configured strategy
    (sliding/dropping/suspend) without losing always-journal events
  - busOnly events never appear in journal reads
  - alwaysJournal events appear in journal reads even under load

Recovery invariants:
  - findOrphaned does not return operations that have a terminal
  - findOrphaned does not return operations newer than its threshold

Concurrency invariants:
  - Concurrent appends from different writers do not lose events
  - Sequence/offset numbering is monotonic per (sessionId)
```

The conformance suite is property-based where it can be (using
`@effect/vitest` or fast-check) and example-based where it must be
(specific event ordering scenarios). This is **the test discipline that
keeps "the journal is Layer-swappable" honest** rather than a marketing
claim.

## Build order — what we build first

Strict dependency order:

```
[Layer 0] Conceptual contracts (no code)
  ─ Operation envelope shape
  ─ Discrete event shape
  ─ Idempotency rules
  ─ Phase contract
  ─ Outcome vocabulary

[Layer 1] Spec types (in @agentick/spec-next)
  ─ Operation<I, R, E> type
  ─ DiscreteEvent type
  ─ ChannelEvent<T> type
  ─ MessageEnvelope type, MessageHandler<T> signature
  ─ OperationJournal protocol interface
  ─ EventBus protocol interface
  ─ MessageInbox protocol interface
  ─ JournalingPolicy type
  ─ TerminalEvent payload table
  ─ JournalError, InboxError, MessageHandlerError taxonomies
  ─ EventQuery, ProtocolEvent (already there)
  ─ Shared conformance fixtures in private monorepo package:
      runJournalConformance(j)
      runInboxConformance(i)
      runHarnessConformance(h)

[Layer 2] In-memory substrates (in @agentick/runtime-next, internal)
  ─ MemoryJournal: ring buffer, no external deps
                   passes runJournalConformance
  ─ LocalInbox:    Map<address, handler> dispatch
                   passes runInboxConformance
  ─ LocalEventBus: Effect PubSub<ProtocolEvent>

[Layer 3] BaseHarness + write-path (in @agentick/runtime-next, internal)
  Five surfaces:
  ─ runOperation         (① heavy path, idempotent, journaled)
  ─ inbox.register       (② addressable inbound dispatch)
  ─ handlers registry    (③ typed .onX(fn) lifecycle)
  ─ middleware chain     (④ .use(mw) around-style)
  ─ emit / emitDelta     (⑤ event publishing, light path)

  Mechanics:
  ─ Bounded journal-write Queue + drain worker (backpressure)
  ─ JournalingPolicy lookup per envelope
  ─ Idempotency lookup at command entry
  ─ Phase emission per operation
  ─ Lifecycle handler ordering (registration order; veto/replace/defer)
  ─ Middleware composition (outer-wraps-inner)
  ─ Effect.withSpan wrapping
  ─ Default failure → terminal:failed mapping
  ─ Inbox idempotency (messageId TTL/LRU cache)

[Layer 4] One concrete harness end-to-end
  ─ Pick the simplest: tool executor
  ─ Implement dispatch via BaseHarness.runOperation
  ─ Implement an inbox handler for "abort"
  ─ Implement at least one .onX hook (e.g., .onDispatchError)
  ─ Verify with conformance suites + integration tests:
    events emit, handlers fire, middleware composes,
    inbox messages dispatch, idempotency works,
    spans appear, busOnly events skip the journal,
    backpressure overflow strategies behave per spec

[Layer 5] OTel projection
  ─ EventBus subscriber that converts envelopes to OTel signals
  ─ Layer factory: TelemetryLayer({ exporter, resource })

[Layer 6] Durable substrates
  ─ @agentick/persistence-sqlite implements OperationJournal
  ─ @agentick/persistence-postgres implements OperationJournal
  ─ Drop-in via Layer.succeed; no harness code changes

[Layer 7] Cluster substrates
  ─ @agentick/cluster wraps OperationJournal with @effect/cluster
  ─ @agentick/cluster wraps MessageInbox with cluster routing
  ─ Distributed; same protocol interfaces

[Layer 8] All other harnesses
  ─ Renderer, React, Loop executor, Session, App
  ─ Each is a BaseHarness extension; mostly mechanical
  ─ Each defines its inbox message types, .onX hooks, middleware
    boundaries, and event taxonomy
```

**The architecture isn't "real" until Layer 4 works.** Layers 1–3 are
contracts and infrastructure; Layer 4 is the first proof that the
pattern produces a working harness with all the substrate properties
(durability, idempotency, observability) for free.

## Effect primitives used

| Primitive                        | Used for                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| `Effect<R, E>`                   | Typed errors at every harness boundary                             |
| `Scope`                          | Structured cleanup; tick / execution / session scopes              |
| `Effect.scoped`                  | Automatic finalizer chaining                                       |
| `FiberRef`                       | Correlation across fork boundaries (opId, sessionId, span context) |
| `PubSub<ProtocolEvent>`          | The event bus                                                      |
| `Stream<ProtocolEvent>`          | Subscriber consumption with backpressure                           |
| `Queue`                          | Bounded journal-write queue with overflow strategies               |
| `Layer`                          | Swappable substrates (memory ↔ Postgres ↔ Redis ↔ cluster)         |
| `Semaphore`                      | Per-session command serialization                                  |
| `Ref` / `STM`                    | In-memory state with consistency                                   |
| `Effect.race` / `Effect.timeout` | Cancellation, deadlines; ask-message timeouts                      |
| `Effect.withSpan`                | OTel integration; FiberRef carries span context                    |
| `Effect.Metric`                  | Metrics declared once, exported via OTel                           |
| `@effect/cluster`                | Production cluster journal + inbox substrate (Layer 7)             |
| `@effect/workflow`               | Long-running operations with checkpoints (optional, Layer 7+)      |
| `@effect/opentelemetry`          | NodeSdk Layer for OTLP export                                      |

## Properties that fall out of the substrate

Once Layer 3 is in place, these are properties of the architecture, not
features of any individual harness:

| Property                                  | How it's enabled                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| **Crash recovery**                        | `journal.findOrphaned` at boot                                                |
| **At-least-once delivery**                | Caller retries with same opId; idempotency check                              |
| **Replay / audit**                        | Journal IS the audit log; query by opId/sessionId/timeRange                   |
| **Distributed migration**                 | Cluster mode: entity migrates with journal cursor + inbox re-registration     |
| **Resume across reconnect**               | Subscriber persists last-seen offset; reconnect → `journal.read(query, from)` |
| **Time travel debugging**                 | Read-only replay of journal up to chosen offset                               |
| **Cross-process control**                 | Inbox + addressable harness ids; same handler signature local + remote        |
| **Tracing**                               | `Effect.withSpan` in `runOperation`; FiberRef propagation                     |
| **Metrics**                               | OTel exporter subscribes to bus; counters / histograms / gauges derived       |
| **Structured logging**                    | Same: subscribe → log at level derived from outcome                           |
| **Headless = free**                       | Lazy fan-out: no subscribers → publish is a cheap no-op                       |
| **Library-first AND distributed-capable** | Direct fn-ref surfaces in-process; inbox + bus wire-safe for cross-process    |

## Open calls

Items raised by this design that still need decision. The "deferred"
items have been moved into "What we are deliberately not solving (yet)"
above; this list is what's actually outstanding for Layer 1–4.

1. **Default journaling policy across surfaces.** The doc proposes
   `alwaysJournal: ["requested", "terminal"]` and `busOnly: ["before",
"delta"]`. Sign-off needed; per-surface tuning exposed.
2. **Default queue capacity and overflow strategy.**
   **Lean:** `queueCapacity: 4096`, `overflow: "sliding"` for general
   surfaces; `"suspend"` for surfaces marked critical (audit, payment).
3. **Channel publish path: operation or discrete?**
   **Lean:** discrete by default; operation-mode opt-in per channel for
   delivery-guarantee semantics.
4. **`parentOpId` on root-level discrete events.**
   **Lean:** optional; `cluster:node:joined`, `gateway:transport:connected`
   are root-level by design.
5. **Typed event registry per surface for the discrete path.**
   **Lean:** yes; compile-time validated registry so typo'd event names
   don't silently no-op.
6. **Caller-supplied vs system-generated `opId` boundaries.**
   **Lean:** caller-supplied at gateway/transport ingress;
   system-generated (ULID) everywhere internal.
7. **Memory journal default size.**
   **Lean:** 4096 events per session; auto-shed when a durable journal
   Layer is attached.
8. **Two journals or one in cluster mode?** `@effect/cluster` already
   journals entity messages.
   **Lean:** collapse — our envelope IS the cluster's message shape.
   **Spike required** before committing.
9. **Span vs operation correspondence on replays.** A replay of a cached
   terminal short-circuits the body.
   **Lean:** emit a `replay` span event with duration zero; subscribers
   can filter or count separately.
10. **Conformance suite scope.** What does `runJournalConformance(j)`
    cover at minimum?
    **Lean:** the bullet list in "Conformance test contract" above; expand
    as we discover edge cases.

## Where this fits in the dependency story

```
@agentick/spec-next          ← Operation, DiscreteEvent, ChannelEvent,
                          OperationJournal, EventBus, TerminalEvent,
                          all envelope shapes
       ▲
       │
@agentick/runtime-next       ← MemoryJournal, BaseHarness, EventBus impl,
                          OTel projection wiring, idempotency table
       ▲
       │
       ├──── @agentick/persistence-{sqlite,postgres,redis}
       │     (drop-in OperationJournal Layers)
       │
       ├──── @agentick/cluster
       │     (cluster-backed OperationJournal Layer)
       │
       └──── concrete harnesses (in @agentick/runtime-next, @agentick/react)
             every one extends BaseHarness
```

## What we are deliberately not solving (yet)

The architecture has knobs in the right places for these concerns, but
the concerns themselves are not solved by Layer 1–4. They are real, they
will need answers before production deployment, and acknowledging them
here keeps us from pretending the foundation is complete when it isn't.

| Concern                                                                                         | Status                                                                                                                | When it must be answered                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Backpressure detail tuning** (per-phase policy defaults, queue capacity, overflow strategies) | Knobs exist; defaults are first guesses.                                                                              | Before durable backend ships (Layer 6)          |
| **Envelope schema evolution**                                                                   | Spec versioning exists; migration mechanism does not.                                                                 | Before first additive change to `EventEnvelope` |
| **Journal retention / GC**                                                                      | Append-only is fine until N grows large. No retention policy specified.                                               | Before durable backend ships (Layer 6)          |
| **Multi-writer correctness in cluster mode**                                                    | Single-writer-per-session via entity activation gets us most of the way; cross-session writes need explicit thinking. | Before cluster Layer ships (Layer 7)            |
| **Hot/cold tiering for production journals**                                                    | Not specified.                                                                                                        | Production deployment                           |
| **Compliance hard-delete** (GDPR / right-to-erasure)                                            | Not specified.                                                                                                        | Production deployment with regulated data       |
| **Cross-org federation**                                                                        | Out of scope for v2. Single-trust-domain stance.                                                                      | If/when v3 needs it                             |

**What we ARE solving in Layer 1–4:**

- Operation envelope shape and lifecycle.
- Discrete event and channel event shapes.
- Journal protocol (append, read, tail, lookupTerminal, findOrphaned).
- Bus protocol (publish, subscribe).
- BaseHarness with operation lifecycle, idempotency, interceptor
  composition, span wrapping, write-path policy.
- One concrete harness end-to-end (tool executor) proving the substrate.
- In-memory journal that satisfies the conformance contract.

**The principle:** get the foundations right so the under-thought
concerns can be solved incrementally without re-architecting. Don't
solve them prematurely; don't pretend they're solved.

## Why this matters

The most important property of v2 is that **durability is structural,
not bolted on**. If the substrate is right, every harness inherits these
properties without writing a line of durability code. If the substrate
is wrong, we'll discover that operations don't have stable identity,
events don't have causality, replay returns inconsistent results — and
those problems cannot be retrofitted.

This is why the foundation document exists, and why **building Layers
1–4 is the first thing we do, before any per-harness implementation
work**.

## Cross-references

- `01-harness-principle.md` — the four protocol surfaces; this doc says
  how they're durably implemented.
- `02-data-model.md` — `EventEnvelope`, `ProtocolEvent`, `EventQuery`.
- `10-events-and-interceptors.md` — the unified observe/intercept
  substrate; this doc adds the journal underneath.
- `13-package-graph.md` — package layout for the substrate.
- `14-state-tiers.md` — how journal entries become persisted state.
