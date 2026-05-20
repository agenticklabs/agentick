# 10 — Events, Lifecycle Handlers, Middleware, and Inbox

**Status:** Synthesized · refined 2026-05-08 (five-surface harness model)
`[SOURCE: harness-principle.md (refined), runtime.md, all per-harness docs]`

This doc consolidates the four integration-time surfaces of the harness
model:

- **Events** (⑤) — pure observation. Multi-subscriber. Cannot affect
  execution.
- **Lifecycle handlers** (③) — `.onX(fn)` typed registrations. Direct fn
  refs. Participate in execution.
- **Middleware** (④) — `.use(mw)` around-style registrations. Direct fn
  refs. Wrap whole operations.
- **Inbox** (②) — addressable inbound messages. Wire-safe. Local or
  cross-process.

(The fifth surface — ① Commands — is direct method calls and is
covered per-harness in docs 03–09.)

`[V1-REPLACED]` of v1's three parallel mechanisms (`EventEmitter`,
`LifecycleCallbacks`, `ExecutionRunner` hooks). Five surfaces now;
each unambiguous.

## When to use which (the canonical rule)

```
Need to invoke an operation, in-process, with typed input/output?
  → ① Command (direct method call) — see per-harness docs

Need to invoke an operation from anywhere (local or remote)?
  → ② Inbox message

Need to participate at a specific lifecycle moment, in-process?
  → ③ Lifecycle handler (.onX)

Need to wrap an operation with around-style behavior, in-process?
  → ④ Middleware (.use)

Need to observe what's happening (no need to affect)?
  → ⑤ Event subscriber
```

**Don't use events to drive execution.** Events observe; participation is
through ③ or ④. Cross-process control is through ②.

## ⑤ Events — pure observation

### EventEnvelope

```ts
interface EventEnvelope {
  id: string;
  opId?: string; // present on operation lifecycle events
  surface: EventSurface;
  name: string; // hierarchical: <surface>:<domain>:<action>
  phase: EventPhase; // requested | before | delta | terminal
  outcome?: CommandOutcome; // present on phase: "terminal"
  timestamp: number;
  scope: EventScope;
  payload?: unknown;
  tags?: string[];
  error?: { name: string; message: string; data?: unknown };
}

type EventSurface =
  | "app"
  | "session"
  | "loop"
  | "reconciler"
  | "formatter"
  | "executor"
  | "tool"
  | "cluster"
  | "gateway";

type EventPhase = "requested" | "before" | "delta" | "terminal";

interface EventScope {
  appId?: string;
  sessionId?: string;
  executionId?: string;
  tickId?: string;
  parentSessionId?: string;
  spawnPath?: string[];
  tenantId?: string;
  nodeId?: string;
  gatewayId?: string;
}
```

### EventQuery

The single matcher used by all event subscribers:

```ts
interface EventQuery {
  surface?: EventSurface | EventSurface[];
  name?: NameQuery;
  phase?: EventPhase | EventPhase[];
  outcome?: CommandOutcome | CommandOutcome[];
  tagsAny?: string[];
  scope?: Partial<EventScope>;
}

type NameQuery =
  | { exact: string }
  | { prefix: string }
  | { segments: string[] }
  | { wildcard: string };
```

### Subscribing

```ts
session.events.subscribe({ name: { prefix: "tool:dispatch" } }, (envelope) => audit.log(envelope));

app.events.subscribe(
  { name: { exact: "loop:tick:terminal" }, outcome: ["failed", "vetoed"] },
  (envelope) => alerts.fire(envelope),
);
```

Subscribers cannot affect execution. They observe and react.
Multi-subscriber by default. Cost when no subscribers: zero (lazy
fan-out).

### Hierarchical naming

```
<surface>:<domain>:<action>

session:lifecycle:hibernate
session:execution:tick
loop:tick:terminal
reconciler:render:context
formatter:format:terminal
executor:provider:request
tool:dispatch:invoke
```

Phase appended in display contexts:

```
session:lifecycle:hibernate:before
session:lifecycle:hibernate:terminal:succeeded
```

### The phase contract for operation events

```
requested ──► before? ──► delta* ──► terminal
```

| Phase       | Required?    | Notes                                                |
| ----------- | ------------ | ---------------------------------------------------- |
| `requested` | exactly once | argument bound                                       |
| `before`    | zero or one  | for interceptable ops; handlers/middleware fire here |
| `delta`     | zero or more | optional incremental progress                        |
| `terminal`  | exactly once | MUST include `outcome`                               |

A subscriber that ignores all `delta` events MUST be able to reconstruct
the correct outcome from `terminal` alone — the **terminal correctness
invariant**.

### Cross-surface event re-emission

When a session receives an event from an inner harness (loop, react,
etc.), the session may re-emit on its own bus with `scope.sessionId`
populated. Convention `[PROPOSAL]`:

- Original event keeps its `surface` and `name`.
- Wrapper adds its own `scope.*` fields.
- A `tags: ["wrapped-by:session"]` entry may be added.

## ③ Lifecycle handlers — typed `.onX(fn)`

### Per-harness registration

Each harness exposes typed `.onX(fn)` methods for its lifecycle moments.
The handler is a **direct function reference** (not an envelope).

```ts
// Loop executor
loop.onTickEnd(async (tickResult) => { ... });
loop.onExecutionStart(async (input) => { ... });

// Session
session.onHibernateBefore(async () => { ... });
session.onSpawn(async (childInfo) => { ... });

// reconciler harness
react.onAsyncResolved((info) => { ... });
react.onCompileForcedStable((diagnostics) => { ... });
```

### Handler signature

```ts
type LifecycleHandler<TPayload, TVerdict = void> = (
  payload: TPayload,
) => Effect<TVerdict, never, never> | Promise<TVerdict> | TVerdict;
```

Handlers may return:

- `void` — observe only; doesn't affect execution.
- A **`HandlerVerdict`** at `before`-phase boundaries to influence
  execution (`proceed | defer | veto | replace`).
- A typed payload (e.g., `TickEndDecision` from a `tickEnd` handler).
- May throw to trigger `failed` outcome.

### Scope and ordering

Handlers register at one of three scopes:

```
global / runtime ────► app ────► session
        outermost     middle    innermost
```

Multi-handler ordering at the same lifecycle moment:

| Phase                | Order                                          |
| -------------------- | ---------------------------------------------- |
| `before`             | global → app → session (outer wraps inner)     |
| `after` / `terminal` | session → app → global (inner completes first) |

Within a scope, handlers run in registration order. Each receives the
(possibly mutated) payload from the previous.

### When to use lifecycle handlers

- Cross-harness wiring inside an integration site (session wires
  loop.onTickEnd to its own forwarding).
- Per-tick / per-operation hooks where one direct fn ref is sufficient.
- App-level policies registered at construction (rate limit, auth).
- Runtime instrumentation that needs to PARTICIPATE in flow (not just
  observe).

### Ordering of handler verdict merge

Veto > Replace > Defer > Proceed. First veto wins; first replace wins;
deferreds merge by earliest retry. Same as the operation-level merge
rules in `19-foundation.md`.

## ④ Middleware — around-style `.use(mw)`

### Registration

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
  aroundTick: async (tickInput, next) => {
    const allowed = await rateLimit.check();
    if (!allowed) throw new RateLimitError();
    return next(tickInput);
  },
});
```

### Composition order

Outer-wraps-inner in registration order:

```
session.use(mw1);  // outer
session.use(mw2);  // middle
session.use(mw3);  // inner

// runtime invokes per send:
// mw1.before → mw2.before → mw3.before → operation body →
// mw3.after  → mw2.after  → mw1.after
```

### When to use middleware over lifecycle handlers

- Cross-cutting concerns that need to wrap the whole operation:
  timing, rate limit, transformation.
- When you need both `before` and `after` access in one function.
- When you need to short-circuit (skip `next()` to replace).
- When you need to transform input/output between handlers.

Lifecycle handlers fire at one moment; middleware wraps the whole
operation. Different shapes, different uses.

## ② Inbox — addressable inbound messages

### MessageEnvelope

```ts
interface MessageEnvelope {
  addressedTo: string; // `{surface}:{scopeId}`
  type: string; // discriminator within harness's accepted messages
  from?: string; // sender address for response/ack
  messageId: string; // idempotency key (caller-supplied; defaults to ULID)
  parentOpId?: string; // causality
  correlationId?: string;
  payload?: unknown; // typed by message type
  timestamp: number;
}
```

### Tell vs ask

```ts
// Tell: fire-and-forget with ack
await inbox.send("loop:execution-abc-123", {
  addressedTo: "loop:execution-abc-123",
  type: "halt",
  payload: { reason: "user-requested" },
  messageId: ULID(),
  timestamp: Date.now(),
});

// Ask: send + await typed response (RPC-shaped; has timeout)
const decision = await inbox.ask<HaltAck>(
  "loop:execution-abc-123",
  { ..., type: "halt", ... },
  { timeoutMs: 5000 },
);
```

### Local vs cluster dispatch

In Tier 0/1 (single-process), messages dispatch via an in-process
registry. In Tier 2 (cluster), unknown-locally addresses route via
`@effect/cluster`.

**Same handler signature; same wire shape; substrate-swappable Layer.**

### When to use the inbox

- External entities (gateway, supervisor, scheduled jobs) that don't
  hold a typed reference to the harness.
- Cross-process control (cluster mode).
- Decoupled command surfaces where the caller and callee may live in
  different processes.
- Idempotent retry-safe semantics needed (gateway retries with same
  messageId).

### When NOT to use the inbox

- In-process callers that have a direct typed reference. Use ① command
  method calls instead — faster, type-safer, no JSON constraint.

### Per-harness inbox messages

| Harness       | Common inbox messages                                             |
| ------------- | ----------------------------------------------------------------- |
| App           | `create-session`, `close-app`                                     |
| Session       | `send`, `dispatch`, `abort`, `pause`, `hibernate`, `inject-input` |
| Loop executor | `halt`, `pause`                                                   |
| React         | `recompile`, `unmount`                                            |
| Renderer      | (typically commands only)                                         |
| Executor      | `abort`                                                           |
| Tool executor | `abort`, `confirmation-response`                                  |

See per-harness docs (03–09) for canonical message types.

## Per-surface event catalog

### `surface: "app"`

| v2 name                           | Phase    | Payload                |
| --------------------------------- | -------- | ---------------------- |
| `app:lifecycle:created:terminal`  | terminal | `{ appId }`            |
| `app:lifecycle:closed:terminal`   | terminal | `{ appId }`            |
| `app:session:created:terminal`    | terminal | `{ sessionId }`        |
| `app:session:closed:terminal`     | terminal | `{ sessionId }`        |
| `app:session:hibernated:terminal` | terminal | `{ sessionId }`        |
| `app:session:restored:terminal`   | terminal | `{ sessionId }`        |
| `app:cross-session:event`         | n/a      | inner event re-emitted |

### `surface: "session"`

| v2 name                                     | v1 mapping                 | Phase     | Payload                        |
| ------------------------------------------- | -------------------------- | --------- | ------------------------------ |
| `session:lifecycle:mount:*`                 | —                          | all       | mount info                     |
| `session:lifecycle:hibernate:*`             | —                          | all       | (none)                         |
| `session:lifecycle:restore:*`               | —                          | all       | snapshot ref                   |
| `session:lifecycle:close:*`                 | —                          | all       | reason                         |
| `session:execution:requested`               | `execution_start`          | requested | execution + send               |
| `session:execution:terminal`                | `execution_end`, `result`  | terminal  | `SendResult`                   |
| `session:tick:*`                            | `tick_start`, `tick_end`   | all       | tick info                      |
| `session:timeline:appended:terminal`        | —                          | terminal  | TimelineEntry                  |
| `session:timeline:entry-committed:terminal` | `entry_committed`          | terminal  | entry + index                  |
| `session:apply:executor-result:*`           | —                          | all       | `LanguageModelExecutionResult` |
| `session:apply:tool-results:*`              | —                          | all       | `ToolResult[]`                 |
| `session:apply:entry:*`                     | —                          | all       | TimelineEntry                  |
| `session:channel:published:terminal`        | —                          | terminal  | channel event                  |
| `session:knob:set:terminal`                 | —                          | terminal  | from / to                      |
| `session:subscription:registered:terminal`  | —                          | terminal  | intent                         |
| `session:subscription:routed:terminal`      | —                          | terminal  | intent + payload               |
| `session:spawn:*`                           | `spawn_start`, `spawn_end` | all       | spawn info                     |
| `session:fork:*`                            | `fork_start`, `fork_end`   | all       | fork info                      |
| `session:context:terminal`                  | `context_update`           | terminal  | utilization                    |
| `session:error`                             | `engine_error`             | n/a       | error                          |

### `surface: "loop"`

| v2 name                 | Phase          | Payload                          |
| ----------------------- | -------------- | -------------------------------- |
| `loop:execution:*`      | all            | `ExecutionRunResult`             |
| `loop:tick:*`           | all            | tick info                        |
| `loop:compile:*`        | all            | (forwarded from react)           |
| `loop:executor:*`       | all            | (forwarded from executor)        |
| `loop:tool-dispatch:*`  | all            | per-call                         |
| `loop:execution:halted` | n/a (discrete) | reason from `halt` inbox message |

### `surface: "reconciler"`

| v2 name                         | Phase          | Payload                  |
| ------------------------------- | -------------- | ------------------------ |
| `reconciler:mount:*`            | all            | mountId                  |
| `reconciler:rerender:*`         | all            | trigger                  |
| `reconciler:render:*`           | all            | iter count, RenderedTree |
| `reconciler:render-to-string:*` | all            | FormattedContent         |
| `reconciler:render-resource:*`  | all            | FormattedContent         |
| `reconciler:notify-tick-end:*`  | all            | TickEndDecision          |
| `reconciler:async:resolved`     | n/a (discrete) | componentId              |
| `reconciler:suspended`          | n/a (discrete) | componentId              |
| `reconciler:runtime-error`      | n/a (discrete) | cause                    |
| `reconciler:unmount:*`          | all            | —                        |
| `reconciler:snapshot:*`         | all            | snapshot                 |
| `reconciler:restore:*`          | all            | mountId                  |

### `surface: "formatter"`

| v2 name                                   | Phase    | Payload                    |
| ----------------------------------------- | -------- | -------------------------- |
| `formatter:format:*`                      | all      | FormatInput / FormatResult |
| `formatter:format-to-text:*`              | all      | FormatInput / FormatResult |
| `formatter:format-resource:*`             | all      | FormatInput / FormatResult |
| `formatter:capabilities:inspect:terminal` | terminal | `FormatterCapabilities`    |

### `surface: "executor"`

| v2 name                       | Phase    | Payload           |
| ----------------------------- | -------- | ----------------- |
| `executor:request:*`          | all      | overall lifecycle |
| `executor:project:terminal`   | terminal | TargetInput       |
| `executor:provider:request`   | n/a      | provider input    |
| `executor:provider:response`  | n/a      | provider raw      |
| `executor:delta`              | delta    | ExecutorDelta     |
| `executor:normalize:terminal` | terminal | ExecutionResult   |
| `executor:tool-call:detected` | n/a      | ToolCall          |

### `surface: "tool"`

| v2 name                       | v1 mapping                         | Phase     | Payload                    |
| ----------------------------- | ---------------------------------- | --------- | -------------------------- |
| `tool:dispatch:*`             | `tool_result_start`, `tool_result` | all       | DispatchInput / ToolResult |
| `tool:validation:terminal`    | —                                  | terminal  | issues / valid             |
| `tool:confirmation:requested` | `tool_confirmation_required`       | requested | request                    |
| `tool:confirmation:resolved`  | `tool_confirmation_result`         | terminal  | response                   |
| `tool:handler:*`              | —                                  | n/a       | handler lifecycle          |

### `surface: "cluster"` (optional wrapper)

```
cluster:routing:requested  cluster:routing:terminal
cluster:activation:terminal
cluster:deactivation:terminal
cluster:migration:requested  cluster:migration:terminal
cluster:node:joined          cluster:node:left
```

### `surface: "gateway"` (optional wrapper)

```
gateway:transport:connected     gateway:transport:disconnected
gateway:auth:terminal           (with outcome)
gateway:rate-limit:applied
gateway:proxy:requested         gateway:proxy:terminal
```

## Sequence numbering

Per-session monotonic sequence on every event published to the session
bus. `[V1-INHERITED]`. Enables durable streams, replay, gap detection,
deduplication.

In cluster mode, an additional cluster-wide event ID may be added by the
cluster wrapper for cross-session ordering.

## DevTools event split

```
Public session.events()              DevTools.events()
─────────────────────────            ──────────────────
lifecycle, execution, tick           compiler:compile (with rawCompiled),
timeline appended/committed          executor:project (with TargetInput),
channel + knob mutations             executor:provider (raw provider),
spawn / fork                         executor:normalize (with raw),
context updates                      compiler:snapshot
errors                               (recording-mode-specific events)
```

DevTools events are intentionally split to a separate bus:

- Different cadence (much more verbose).
- Different fidelity (raw provider responses, fiber tree snapshots).
- Different consumer (one DevTools UI per app, not many subscribers).

`[V1-REPLACED]` of v1's interleaving DevTools events into the public
stream. Both buses use the same envelope shape.

## Channels (named persistent streams)

Channels are a separate primitive — named per-session streams, not the
event bus. But they share the envelope shape:

```ts
interface ChannelEvent<T = unknown> extends EventEnvelope {
  surface: "session";
  name: `session:channel:${string}`;
  payload: T;
}

interface ChannelHandle<T = unknown> {
  publish(event: T): void;
  subscribe(query: ChannelSubscribeQuery, handler: (e: ChannelEvent<T>) => void): Unsubscribe;
  read(query: ChannelReadQuery): ChannelEvent<T>[];
}
```

Per-channel retention is configurable. Default `[PROPOSAL]`: 256 entries
or 30 minutes, whichever first.

## Backpressure

```
Per-subscriber bounded buffer (default: 256).
Slow subscriber: bounded buffer fills → that subscriber's stream
  back-pressures via Effect's pull-based Stream model.
If buffer overflows: subscriber's stream errors with BufferOverflowError;
  publisher continues; other subscribers unaffected.
Zero subscribers: events are not published (lazy fan-out — cost free).
```

## Telemetry integration

OTel spans wrap operation lifecycle. Span attributes carry sessionId,
executionId, tickId. Effect's FiberRef-based span context propagates
parent/child correctly across forks. See `19-foundation.md` for the
projection.

## Observability headlessness

A session with zero subscribers, zero telemetry exporter, zero
DevTools attachment runs identically to one with 50:

- PubSubs do not publish if no subscribers.
- Telemetry spans collapse to no-ops if no exporter.
- DevTools-bus events are not constructed if no DevTools attached.
- Inbox routing is no-op if no addressable handlers (always: at least
  the harness itself).

This is structural in Effect, not a config flag.

## Decisions captured

- Five surfaces: commands (①), inbox (②), lifecycle handlers (③),
  middleware (④), events (⑤). Each unambiguous.
- Events do NOT drive execution; they observe.
- Lifecycle handlers + middleware are direct fn refs, in-process only.
- Inbox is the cross-process addressable command channel.
- Hierarchical event names (`<surface>:<domain>:<action>`).
- Phase contract is mandatory for operations.
- Outcome vocabulary: succeeded/failed/canceled/vetoed/replaced/deferred.
- Cross-scope handler ordering: outer-in for `before`, inner-out for
  `terminal`.
- Verdict merge: veto > replace > defer > proceed.
- DevTools events on a separate bus; same envelope shape.
- Headless = zero cost.

## Open questions

- Cross-surface re-emission convention (lean: tags + same name).
- Default channel retention (lean: 256 entries or 30 min).
- Backpressure exact policy (lean: lazy fan-out + per-subscriber bounded).
- Cluster-wide event id format.
- Middleware exposure: should every harness expose `.use(mw)`, or only
  ones that benefit from around-style? Lean: only where genuinely useful
  (loop, session, app); add others as need arises.
