# 08 — Session Harness

**Status:** Synthesized with placeholders
`[SOURCE: runtime.md, harness-principle.md, loop-executor.md]`

The session harness owns identity, timeline, knobs, channels, mounted
React tree, and persistence integration. It is **the user-facing
abstraction** that most application code interacts with: `session.send(...)`,
`session.dispatch(...)`, `session.append(...)`, etc.

In v2, the session harness is **library-first** — by default a plain
in-process object; cluster mode wraps it as a sharded entity (see
`11-cluster.md`) without changing the user-facing API.

```
                ┌──────────────────────────────────────────┐
                │              Session harness             │
                │                                          │
   commands ──► │  send · dispatch · render · append       │ ──► events
                │  spawn · abort · pause · resume · inject │
                │  recover · hibernate · restore · close   │
                │                                          │
   interceptors◄┤  state: timeline · knobs · channels      │ ──► outcomes
                │         mountId · subscription intents   │
                └────────────┬─────────────────────────────┘
                             │
                             ▼
                     ┌────────────────┐
                     │ Loop executor  │  per execution
                     └────────────────┘
```

`[V1-REPLACED]` of the monolithic v1 `SessionImpl`
(`packages/core/src/app/session.ts` ~3700 lines). The session class
shrinks dramatically because:

- Tick mechanics extracted → loop executor harness.
- Compilation extracted → reconciler harness.
- Tool execution extracted → tool executor harness.
- Provider mechanics extracted → executor harness.
- Lifecycle callbacks → interceptors (no more `LifecycleCallbacks`).
- COM mutation API gone (1268 LOC).

What remains is identity, state, channel routing, persistence, and the
public command surface.

## What this harness manages

**Identity:**
- `id`, `parentSessionId`, immutable `metadata`.

**Mounted React tree:**
- One mounted instance per active session (the reconciler harness's `mountId`).
- The tree stays mounted across multiple executions for a session.

**State:**
- `timeline: TimelineEntry[]` — full chronology, persisted incrementally.
- `knobs: Map<name, KnobState>` — model-visible reactive values.
- `channels: Map<name, ChannelState>` — named streams.
- `subscriptionIntents: SubscriptionIntent[]` — declarative intents from
  long-lived primitives.
- `useResolved` data cache.

**Lifecycle:**
- `idle | running | paused | hibernating | hibernated | restoring | closed`.

**Persistence:**
- Snapshot policies: snapshot on tick end, on hibernate, on explicit
  `checkpoint()`, etc.

It does NOT manage:

- Tick orchestration (loop executor).
- React tree internals (reconciler harness).
- Tool dispatch internals (tool executor).
- Provider mechanics (executor).
- Cross-session routing (cluster wrapper).

## Commands in

```ts
interface SessionHarnessProtocol<P = unknown> {
  send(input: SendInput<P>):
    Effect<SessionExecutionHandle, SessionError, SessionEnv>;

  dispatch(input: DispatchHostInput):
    Effect<ContentBlock[], DispatchError, SessionEnv>;

  render(input: FormatInput<P>):
    Effect<SessionExecutionHandle, SessionError, SessionEnv>;

  append(input: AppendInput):
    Effect<SessionExecutionHandle | void, SessionError, SessionEnv>;

  spawn(input: SpawnInput<P>):
    Effect<SessionExecutionHandle, SessionError, SessionEnv>;

  abort(reason?: string): Effect<void, never, SessionEnv>;

  pause(): Effect<void, SessionError, SessionEnv>;
  resume(): Effect<SessionExecutionHandle, SessionError, SessionEnv>;

  inject(message: Message): Effect<void, SessionError, SessionEnv>;
  recover(strategy: RecoveryStrategy): Effect<void, SessionError, SessionEnv>;

  hibernate(): Effect<void, SessionError, SessionEnv>;
  restore(snapshot: SessionSnapshot):
    Effect<void, SessionError, SessionEnv>;

  close(): Effect<void, never, SessionEnv>;

  // State application — used by loop executor, host door, subscription handlers
  applyExecutorResult(input: ApplyExecutorResultInput):
    Effect<ApplyResult, StateApplyError, SessionEnv>;
  applyToolResults(input: ApplyToolResultsInput):
    Effect<ApplyResult, StateApplyError, SessionEnv>;
  appendEntry(input: AppendEntryInput):
    Effect<ApplyResult, StateApplyError, SessionEnv>;

  // Tick-end forwarding (called from session's loop.onTickEnd handler)
  notifyLifecycle(input: NotifyTickEndInput):
    Effect<TickEndDecision, SessionError, SessionEnv>;

  // Observation (synchronous reads against in-memory state)
  timeline(query?: TimelineQuery): TimelineEntry[];
  events(query?: EventQuery): Stream<ProtocolEvent>;
  channel(name: string): ChannelHandle;
  knob(name: string): KnobHandle;
  snapshot(): SessionSnapshot;
}
```

### `send` — the primary entry point

Run the agent with messages and/or props. Returns
`SessionExecutionHandle` (`AsyncIterable<ProtocolEvent>` + `.result:
Promise<SendResult>`). Multiple `send` calls during a running execution
queue messages and return the same handle.

`[V1-INHERITED]` from `Session.send`. Implementation now delegates to
loop executor; session itself doesn't own the tick loop anymore.

### `dispatch` — host door for tools

```ts
interface DispatchHostInput {
  name: string;
  input: Record<string, unknown>;
  context?: Record<string, unknown>;
}
```

Calls into the tool executor harness with `via: "dispatch"`. Returns the
flattened `ContentBlock[]` content for ergonomics (host code rarely
needs the full `ToolResult` envelope).

`[V1-INHERITED]` of `session.dispatch(name, input)`.

### `render` — re-execute current props

Triggers an execution without new messages. Used when host changes props
and wants the agent to react.

### `append` — direct timeline write

```ts
interface AppendInput {
  entry: TimelineEntry;
  trigger?: boolean;             // run a tick after appending
}
```

`[V1-INHERITED]` of `session.append(...)` — the "ambient context" primitive.
Bypasses the next-tick queue entirely. Emits `entry_committed` (in v2,
`session:timeline:appended:terminal`).

### `spawn` — child session

```ts
interface SpawnInput<P> {
  component: ComponentFunction | JSX.Element;
  send?: SendInput<P>;
  options?: SpawnOptions;
}

interface SpawnOptions {
  model?: ExecutionTarget;
  maxTicks?: number;
  inheritKnobs?: boolean;
  // [PROPOSAL] explicit override for any config dimension
}
```

Creates a child session with its own ID. Parent abort propagates to
child by default.

`[V1-INHERITED, REFINED]` — v1 spawn was an ephemeral child
(NOT registered in App's session registry). v2 keeps that as the default
but the cluster wrapper may promote spawn to a registered child entity.
See `11-cluster.md`.

### `abort` — interrupt current execution

Cancels the in-flight execution if any; queued messages may be preserved.

### `pause` / `resume`

Pause halts execution at the next tick boundary; resume continues from
where it stopped. Distinct from `abort` (which terminates).

`[GAP]` — pause/resume is in the source proposals' command list but the
semantics are not described. **Blueprint position `[PROPOSAL]`:**

| State | `pause` | `resume` |
| --- | --- | --- |
| `idle` | no-op | error |
| `running` | mark; complete current tick; transition to `paused` | error |
| `paused` | error | re-enter loop with same execution context |

Sign-off needed.

### `inject` — push a message into the running execution

Unlike `queue`, which delivers on the next tick, `inject` makes the
message visible to `useOnEntry`/`useOnEvent` hooks immediately within the
current tick (if the React tree has subscribed).

`[GAP]` — `inject` is listed but not described. Above is `[PROPOSAL]`.
Sign-off needed.

### `recover` — strategy-driven recovery

```ts
type RecoveryStrategy =
  | { kind: "rewind"; toTick: number }
  | { kind: "skip"; offendingEventId: string }
  | { kind: "retry-tick" }
  | { kind: "abandon" };
```

`[GAP]` — listed but not described. Above is `[PROPOSAL]`. Sign-off
needed.

### `hibernate` / `restore`

Hibernate releases in-memory resources (unmounts React tree, cancels
active subscriptions on the supervisor side). Persists a
`SessionSnapshot`. Restore re-mounts the tree from snapshot, re-registers
intents.

`[V1-REPLACED]` of v1's lifecycle callbacks (`onPersist`, `onRestore`)
which run as interceptors on the `hibernate` and `restore` commands.

### `close`

Terminate the session. Final close: unmounts React tree, drops state.
The session ID is then unreachable; subsequent `send` is an error.

## Events out

All on `surface: "session"`. The full session-level event taxonomy:

```
Lifecycle:
  session:lifecycle:create:terminal
  session:lifecycle:mount:terminal
  session:lifecycle:hibernate:requested  …:before  …:terminal
  session:lifecycle:restore:requested    …:before  …:terminal
  session:lifecycle:close:requested      …:terminal
  session:lifecycle:pause                session:lifecycle:resume

Execution wrappers (delegated to loop executor; re-emitted):
  session:execution:requested  …:before  …:delta  …:terminal
  session:execution:tick:terminal  (from loop:tick:terminal, re-tagged)

Timeline:
  session:timeline:appended:terminal     (with TimelineEntry payload)
  session:timeline:entry-committed:terminal (after ingest)

Channels:
  session:channel:published:terminal
  session:channel:subscribed:terminal
  session:channel:unsubscribed:terminal

Knobs:
  session:knob:registered:terminal
  session:knob:set:terminal              (with from / to values)

Subscriptions:
  session:subscription:registered:terminal
  session:subscription:routed:terminal
  session:subscription:handler-unbound:terminal

Spawn:
  session:spawn:requested  …:terminal
  session:spawn:completed:terminal (when child closes)

Errors:
  session:error
```

The session harness also acts as a **fan-up point**: events from inner
harnesses (loop, react, executor, tool) are published to the session's
PubSub with a `scope.sessionId` tag added. Subscribers to
`session.events()` see one ordered stream covering everything the session
did.

## Interceptors

```
send       — wraps the whole execution
dispatch   — host-door dispatch (separate from tool:dispatch)
render
append
spawn
hibernate
restore
close
```

Use cases:

| Interceptor | Use case |
| --- | --- |
| `send` veto | Refuse send during pause |
| `send` defer | Queue if knob limit exceeded |
| `dispatch` replace | Host-side tool sandboxing |
| `hibernate` defer | Critical-region in flight; retry after cleanup |
| `hibernate` veto | Ongoing payment processing must not hibernate |
| `close` proceed-with-cleanup | Persist final snapshot, flush channels |

`[V1-REPLACED]` of v1's `LifecycleCallbacks` (`onTickStart`, `onTickEnd`,
`onComplete`, `onError`) — they become observers on the corresponding
event names; or interceptors when they need to change behavior.

## Outcomes and failures

```ts
type SessionError =
  | TickError                        // proxied from loop executor
  | DispatchError                    // proxied from tool executor
  | TimelineError
  | KnobError
  | ChannelError
  | HibernationError
  | RestoreError
  | SessionClosedError;

interface TimelineError {
  _tag: "TimelineError";
  reason: string;
}

interface KnobError {
  _tag: "KnobError";
  knob: string;
  reason: string;
}

interface ChannelError {
  _tag: "ChannelError";
  channel: string;
  reason: string;
}

interface HibernationError {
  _tag: "HibernationError";
  reason: string;
  cause?: unknown;
}

interface RestoreError {
  _tag: "RestoreError";
  reason: string;
  cause?: unknown;
}

interface SessionClosedError {
  _tag: "SessionClosedError";
  attemptedCommand: string;
}
```

## Lifecycle states

```
                 send / dispatch / render
   ┌─────────────────────┐
   │       idle          │ ◄─────────┐
   └─────────┬───────────┘           │
             │ send                  │ tick complete
             ▼                       │
   ┌─────────────────────┐           │
   │     running         │ ──────────┘
   └─────────┬───────────┘
             │ pause       hibernate
             ▼               │
   ┌─────────────────────┐   │   ┌─────────────────────┐
   │      paused         │   └──►│   hibernating       │
   └─────────┬───────────┘       └─────────┬───────────┘
             │ resume                      │ flushed
             │                             ▼
             │                   ┌─────────────────────┐
             │                   │   hibernated        │
             │                   └─────────┬───────────┘
             │                             │ message arrival
             │                             │ or restore
             │                             ▼
             │                   ┌─────────────────────┐
             │                   │   restoring         │
             │                   └─────────┬───────────┘
             │                             │
             ▼                             ▼
                  back to running / idle

   close, from any state: ──► closed (terminal)
```

`[V1-INHERITED, EXTENDED]` — v1 has `idle | running | closed`. v2 adds
`paused | hibernating | hibernated | restoring`.

## State the session owns

```ts
interface SessionState {
  // Identity
  id: string;
  parentSessionId: string | null;
  metadata: Readonly<Record<string, unknown>>;

  // Lifecycle
  status: SessionStatus;
  currentTick: number;

  // Mounted React tree
  mountId?: string;                              // empty when idle/hibernated

  // Timeline (persisted incrementally — see 14-state-tiers.md)
  timeline: TimelineEntry[];

  // Knobs (model-visible reactive values)
  knobs: Map<string, KnobState>;

  // Channels (named streams)
  channels: Map<string, ChannelState>;

  // Long-lived primitive intents (subscriptions, crons, webhooks, listeners)
  subscriptionIntents: SubscriptionIntent[];

  // Resolve cache (Layer 1: persisted)
  resolveCache: Record<string, ResolvedValue>;

  // Usage / accumulated stats
  usage: UsageStats;

  // Lock for serialized command execution
  // (Effect Semaphore in implementation)
}
```

`KnobState`, `ChannelState`, `SubscriptionIntent`, `ResolvedValue`
shapes `[PLACEHOLDER]` — synthesized from v1 hook contracts:

```ts
interface KnobState {
  declaration: KnobDeclaration;
  value: unknown;
  history?: Array<{ timestamp: number; value: unknown; setBy: "model" | "host" }>;
}

interface ChannelState {
  retention: { count?: number; ms?: number };
  events: ChannelEvent[];
  lastSequence: number;
}

interface SubscriptionIntent {
  id: string;
  source: string;                           // e.g., "webhook:/orders"
  handlerId: string;
  config: Record<string, unknown>;          // source-specific
  registeredAt: number;
}

interface ResolvedValue {
  key: string;
  value: unknown;
  resolvedAt: number;
  ttlMs?: number;
}
```

Sign-off needed.

## Cross-harness wiring (integration site)

The session harness is the integration site for the session's
loop ↔ react ↔ executor ↔ tool wiring. At construction time, the session
installs lifecycle handlers to bridge the harnesses.

### Loop ↔ React tick-end wiring

```ts
class SessionHarness extends BaseHarness<"session"> {
  constructor(deps: SessionDeps) {
    super(...);

    // Wire loop's tick-end to react's notifyLifecycle via session.notifyLifecycle
    this.unsubTickEnd = this.loop.onTickEnd(async (tickResult) => {
      return this.notifyLifecycle({
        tickResult,
        defaultShouldContinue: this.defaultFromStopReason(tickResult),
      });
    });

    // Loop's executor terminal → session.applyExecutorResult
    this.unsubExecutorTerminal = this.loop.onExecutorTerminal(async (result) => {
      await this.applyExecutorResult({
        result,
        executionId: this.currentExecutionId,
        tickId: this.currentTickId,
      });
    });

    // Loop's tool dispatches → session.applyToolResults
    this.unsubToolResults = this.loop.onToolResults(async (results) => {
      await this.applyToolResults({
        results,
        executionId: this.currentExecutionId,
        tickId: this.currentTickId,
      });
    });
  }

  /** Forward tick result to reconciler harness; return tree's decision. */
  notifyLifecycle(input: NotifyTickEndInput):
    Effect<TickEndDecision, SessionError, SessionEnv>
  {
    return this.runOperation(/* op */, async ({ tickResult, defaultShouldContinue }) => {
      return this.react.notifyLifecycle({
        mountId: this.mountId,
        tickResult,
        defaultShouldContinue,
        tick: this.currentTick,
        executionId: this.currentExecutionId,
      });
    });
  }
}
```

The session is the **only** place that knows about both the loop and the
reconciler harness. Each harness on its own is independent.

### What this enables

- **Swap harness implementations:** replace the reconciler harness with a Vue
  harness — no loop or session code changes; rewire the session's
  `loop.onTickEnd` handler to call `vue.notifyLifecycle`.
- **Test the loop in isolation:** mock the `.onTickEnd` registration
  point; assert the correct tick result was passed to the (mocked)
  session.
- **Test the session in isolation:** call `notifyLifecycle` directly; mock
  the reconciler harness.

## Inbox messages

The session harness accepts inbound messages at address
`session:{sessionId}`:

| Message type | Payload | Effect |
| --- | --- | --- |
| `send` | `SendInput` | Triggers an execution. Idempotent on `messageId`. |
| `dispatch` | `{ name, input }` | Host-door tool dispatch. |
| `abort` | `{ reason: string }` | Aborts in-flight execution. |
| `pause` | `{}` | Pauses session at next tick boundary. |
| `resume` | `{}` | Resumes from pause. |
| `inject-input` | `Message` | Pushes a message into the running execution. |
| `hibernate` | `{}` | Initiates hibernate (subject to interceptors). |
| `recover` | `RecoveryStrategy` | Triggers recovery procedure. |
| `close` | `{}` | Terminates session. |

These mirror the command surface but are reachable by external callers
who don't hold a typed reference. In Tier 0/1 they dispatch via local
inbox; in Tier 2 they route through the cluster.

## Lifecycle handlers exposed

```ts
session.onMount(handler: (mountInfo) => void | Promise<void>)
session.onHibernateBefore(handler: () => Promise<HandlerVerdict | void>)
session.onHibernate(handler: (info) => void | Promise<void>)
session.onRestoreBefore(handler: (snapshot) => Promise<HandlerVerdict | void>)
session.onRestore(handler: (mountInfo) => void | Promise<void>)
session.onSpawn(handler: (childInfo) => void | Promise<void>)
session.onClose(handler: () => Promise<void>)
session.onError(handler: (err: SessionError) => void)
```

`onHibernateBefore` is critical-region territory — handlers can return
`{ kind: "veto", reason }` or `{ kind: "defer", retryAfter: ms }` to
prevent hibernation during in-flight work (e.g., payment processing).

## Middleware exposure

```ts
session.use({
  aroundSend: (input, next) => { ... },        // wrap every execution
  aroundDispatch: (input, next) => { ... },    // wrap every host-door dispatch
  aroundHibernate: (input, next) => { ... },   // wrap hibernate
});
```

## Long-lived primitives at runtime

When the reconciler harness emits `RuntimeDeclarations` containing subscription
intents, the session:

1. Diffs against the previous compile's intent set.
2. For each new intent: registers with the runtime supervisor (which owns
   external connections in cluster deployments, or in-process listeners
   in single-node deployments).
3. For each removed intent: deregisters.
4. For each event arriving on a registered intent: invokes the React
   harness's `invokeHandler(handlerId, payload)` — which routes to the
   resolved handler in the freshly-mounted tree.

If the session is hibernated when an event arrives, the supervisor calls
`session.restore()` first, then routes the event.

## Persistence integration

The session participates in persistence through:

```
Tick boundary
   │
   ├── stateApplicator writes timeline entry → emit
   │   session:timeline:entry-committed:terminal
   │
   ├── persistence.appendEntry(sessionId, entry)
   │   (incremental; one row per entry)
   │
   ├── On tick:terminal:succeeded:
   │   persistence.saveSession(record)
   │   (small structured row; no full timeline dump)
   │
   ▼

Hibernation
   │
   ├── interceptors run; if veto/defer, halt
   │
   ├── flush in-flight async work (see 03-reconciler-harness.md)
   │
   ├── react.snapshot(mountId) → ReconcilerSnapshot (small)
   │
   ├── persistence.saveSession({ ...sessionRecord, compilerSnapshot })
   │
   ├── react.unmount(mountId)
   │
   ▼   status = hibernated

Restore
   │
   ├── persistence.loadSession(sessionId) → record
   │
   ├── react.restore({ rootElement, snapshot, hookBridges })
   │   → mountId
   │
   ├── re-register subscription intents with supervisor
   │
   ▼   status = idle (or running, if there's a pending message)
```

Persistence backends are pluggable Layers (`14-state-tiers.md`).

## Concurrent commands

Sessions process commands serially. Multiple `send` calls during a running
execution don't race — they queue messages onto the active execution and
return the same `SessionExecutionHandle`.

For commands that conflict (e.g., `hibernate` while `running`):

```
hibernate during running:
  default → defer until execution completes
  interceptor on `send` may veto if hibernate is pending

abort during running:
  immediate cancellation; current tick aborts via signal

close during running:
  abort first, then close
```

`[V1-INHERITED]` of session's serial execution model. Implementation uses
an Effect Semaphore.

## SessionSnapshot shape

```ts
interface SessionSnapshot {
  version: string;                        // [V1-INHERITED]
  sessionId: string;
  parentSessionId: string | null;
  metadata: Record<string, unknown>;

  status: SessionStatus;
  currentTick: number;
  usage: UsageStats;

  // Persisted state (small)
  knobs: Record<string, KnobState>;
  subscriptionIntents: SubscriptionIntent[];
  resolveCache: Record<string, ResolvedValue>;

  // Compiler-private state captured at snapshot time
  compilerSnapshot?: ReconcilerSnapshot;

  // Channel pointer state — actual events live in timeline storage
  channelPointers: Record<string, { lastSequence: number; retention: ChannelRetention }>;

  // Timeline is NOT in the snapshot record — loaded on hydration
  // (windowed). See 14-state-tiers.md.

  timestamp: number;
}
```

Differs from v1's `SessionSnapshot` (which embedded `timeline` directly).
`[V1-REPLACED]` to support incremental persistence.

## SessionExecutionHandle

```ts
interface SessionExecutionHandle {
  readonly sessionId: string;
  readonly executionId: string;
  readonly currentTick: number;

  // AsyncIterable<ProtocolEvent>
  [Symbol.asyncIterator](): AsyncIterator<ProtocolEvent>;

  // Promise<SendResult>
  readonly result: Promise<SendResult>;

  // Mid-execution interaction
  queueMessage(message: Message): void;
  submitToolResult(toolUseId: string, response: ToolConfirmationResponse): void;
  abort(reason?: string): void;
}

interface SendResult {                    // [V1-INHERITED]
  response: string;
  outputs: Record<string, unknown>;
  usage: UsageStats;
  stopReason?: string;
  raw: RenderedTree;                 // [V1-REPLACED] of COMInput
}
```

## Library-first vs cluster-wrapped

The session harness is the same protocol in both modes:

```
Library mode:
  app.session(id) → SessionImpl object  (in-memory state)
  session.send(...) → in-process loop executor

Cluster mode:
  app.session(id) → SessionRef (typed cluster entity reference)
  session.send(...) → typed message dispatched to entity
                    → entity processes serially in its fiber
                    → response routes back across nodes
```

User code is identical. See `11-cluster.md` for the wrapper details.

## Two doors preserved

```
Capability             Model door            Host door
─────────              ──────────            ─────────
Append timeline        <Message>, <Event>    session.append(entry)
Run shell              <Bash> tool           session.shell(cmd)*
Invoke tool            tool_use              session.dispatch(name, input)
Run skill              implicit "skill" tool session.skill(name, opts)
```

`*` `session.shell(cmd)` `[V1-INHERITED]` is sugar over
`session.dispatch("shell", { command: cmd })`. The shell tool must be
registered (typically via `<Sandbox>` ancestor providing the shell tool).

`[GAP]` — what happens to `session.shell(cmd)` when no `<Sandbox>` is
mounted? Blueprint position `[PROPOSAL]`: `ToolNotFoundError` from the
tool executor; sugar method maps the error to a clear message. Sign-off
needed.

## SessionToolsProxy `[V1-INHERITED]`

```ts
session.tools.<name>(input)
```

Typed proxy over `dispatch`, generated from registered tool declarations.
Same behavior as `session.dispatch(name, input)` with TypeScript-level
typing.

## Decisions captured

- Library-first by default; cluster wraps the same harness shape.
- One mounted React tree per active session.
- Tick orchestration delegated to loop executor.
- Timeline persisted incrementally; snapshot record is small.
- Compiler-private snapshot captured at hibernate; restore re-mounts.
- Lifecycle callbacks become interceptors on the corresponding commands.
- Subscription intents live in session state; supervisor materializes
  external connections.

## Open questions

- `pause` / `resume` semantics (placeholder; sign-off).
- `inject` semantics (placeholder; sign-off).
- `recover` strategy taxonomy (placeholder; sign-off).
- `KnobState`, `ChannelState`, `SubscriptionIntent` shapes (placeholders).
- `session.shell` no-sandbox behavior (lean: error).
- Spawn promotion in cluster mode (deferred to `11-cluster.md`).
