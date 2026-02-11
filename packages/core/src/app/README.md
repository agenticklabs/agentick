# App & Session

The app layer manages session lifecycle, execution, and the spawn primitive.

## Overview

```
createApp(Component, options) → App
  ├── app.session(id?) → Session
  ├── app.run(input) → SessionExecutionHandle (ephemeral)
  └── app.sessions → SessionRegistry
```

**App**: Factory for sessions. Holds shared configuration (model, tools, callbacks, middleware).

**Session**: Long-lived conversation context. Manages state, timeline, and executions.

**Execution**: A single send/render cycle. One or more ticks (model calls).

## Session

### Creating Sessions

```typescript
const app = createApp(MyAgent, { model });

// Auto-generated ID
const session = await app.session();

// Specific ID (get-or-create)
const session = await app.session("user-123");
```

### Session Methods (All Procedures)

| Method   | Returns                  | Description                                  |
| -------- | ------------------------ | -------------------------------------------- |
| `send`   | `SessionExecutionHandle` | Queue messages + run execution               |
| `render` | `SessionExecutionHandle` | Set props + run execution (no message queue) |
| `queue`  | `void`                   | Queue messages without triggering execution  |
| `spawn`  | `SessionExecutionHandle` | Create and run an ephemeral child session    |

All are Procedures — they support `.use(middleware)`, `.withContext()`, `.withTimeout()`, etc.

```typescript
// Direct execution
const handle = await session.send({ messages: [...] });

// Unwrap to final result
const result = await session.send({ messages: [...] }).result;

// With middleware
const result = await session.send.use(loggingMw)({ messages: [...] }).result;
```

### Session Properties

| Property         | Type                 | Description                           |
| ---------------- | -------------------- | ------------------------------------- |
| `id`             | `string`             | Session UUID                          |
| `status`         | `SessionStatus`      | `"idle"` / `"running"` / `"closed"`   |
| `parent`         | `Session \| null`    | Parent session (for spawned children) |
| `children`       | `readonly Session[]` | Active child sessions                 |
| `isAborted`      | `boolean`            | Whether current execution is aborted  |
| `queuedMessages` | `readonly Message[]` | Messages waiting to be sent           |

### Session Lifecycle

```typescript
session.interrupt(message?, reason?)  // Abort current execution, optionally queue a message
session.clearAbort()                  // Reset abort flag
await session.close()                 // Close session and all children (async)
session.snapshot()                    // Get current state as SessionSnapshot
session.inspect()                     // Detailed inspection (tick, tools, usage, etc.)
```

## Spawn

`session.spawn()` creates an ephemeral child session with a different agent/component. The child runs to completion and returns the same `SessionExecutionHandle` as `session.send()`.

### Three Input Forms

```typescript
// 1. Component function
await session.spawn(ChildAgent, { messages: [...] });

// 2. AgentConfig (Level 0 — no JSX)
await session.spawn({ system: "You are a summarizer.", model }, { messages: [...] });

// 3. JSX element (props merged with input.props)
await session.spawn(<Researcher query="quantum" />, { messages: [...] });
```

### From Tool Handlers

```typescript
const DelegateTool = createTool({
  name: "delegate",
  input: z.object({ task: z.string() }),
  handler: async (input, ctx) => {
    const handle = await ctx!.spawn(Specialist, {
      messages: [{ role: "user", content: [{ type: "text", text: input.task }] }],
    });
    const result = await handle.result;
    return [{ type: "text", text: result.response }];
  },
});
```

### Parallel Spawns

```typescript
const [a, b] = await Promise.all([
  session.spawn(AgentA, input).then((h) => h.result),
  session.spawn(AgentB, input).then((h) => h.result),
]);
```

### SpawnOptions

The optional third argument overrides inherited structural options:

```typescript
// Override model and maxTicks for a child
await session.spawn(
  SummaryAgent,
  { messages },
  {
    model: cheapModel,
    maxTicks: 3,
  },
);

// Override runner for a specific child
await session.spawn(
  CodeAgent,
  { messages },
  {
    runner: replRunner,
  },
);
```

| Field         | Type                   | Description                       |
| ------------- | ---------------------- | --------------------------------- |
| `model`       | `EngineModel`          | Override the parent's model       |
| `runner`      | `ExecutionRunner`      | Override the parent's runner      |
| `maxTicks`    | `number`               | Override the parent's max ticks   |

### Spawn Behavior

- **Self-similar**: Returns `SessionExecutionHandle` — identical to `session.send()`.
- **Isolation**: Child gets a fresh COM. Parent state does not leak.
- **Callback isolation**: Parent's lifecycle callbacks (onComplete, onTickStart, etc.) do NOT fire for child executions.
- **Runner inherited**: Child sessions inherit the parent's `ExecutionRunner`. A sandbox or REPL applies to all sub-agents. Use `SpawnOptions` to override.
- **Abort propagation**: Aborting parent execution → aborts all children.
- **Close propagation**: Closing parent session → closes all children.
- **Depth limit**: 10 levels max (throws `Error`).
- **Cleanup**: Children removed from `session.children` on completion.
- **Ephemeral**: Child sessions are NOT registered in the app's session registry.

## Lifecycle Callbacks

Defined on `AppOptions` (inherited by all sessions) or `SessionOptions` (per-session).

```typescript
interface LifecycleCallbacks {
  onEvent?: (event: StreamEvent) => void;
  onTickStart?: (tick: number, executionId: string) => void;
  onTickEnd?: (tick: number, usage?: UsageStats) => void;
  onComplete?: (result: SendResult) => void;
  onError?: (error: Error) => void;
}
```

Additional callbacks on `AppOptions`:

| Callback             | When it fires                               |
| -------------------- | ------------------------------------------- |
| `onBeforeSend`       | Before send executes (can modify input)     |
| `onAfterSend`        | After send completes                        |
| `onToolConfirmation` | Tool with `requiresConfirmation`            |
| `onSessionCreate`    | Session created                             |
| `onSessionClose`     | Session closed                              |
| `onBeforePersist`    | Before auto-save (can cancel or modify)     |
| `onAfterPersist`     | After auto-save                             |
| `onBeforeRestore`    | Before auto-restore (can cancel or migrate) |
| `onAfterRestore`     | After auto-restore                          |

**Important**: Spawned child sessions do NOT inherit lifecycle callbacks. This is intentional — the parent's onComplete handler should not fire when a child agent completes.

## Execution Runner

An `ExecutionRunner` controls how compiled context reaches the model and how tool calls execute. Set on `AppOptions.runner`.

```typescript
const runner: ExecutionRunner = {
  name: "repl",

  // Transform compiled input before model call (per tick)
  prepareModelInput(compiled, tools) {
    return { ...compiled, tools: [] }; // e.g., remove tool schemas
  },

  // Wrap individual tool execution (per tool call)
  async executeToolCall(call, tool, next) {
    if (call.name === "execute") return sandboxRun(call);
    return next(); // delegate to normal execution
  },

  // Lifecycle (once per session)
  onSessionInit(session) {
    /* set up sandbox */
  },
  onPersist(session, snapshot) {
    return { ...snapshot /* runner state */ };
  },
  onRestore(session, snapshot) {
    /* restore runner state */
  },
  onDestroy(session) {
    /* cleanup */
  },
};

const app = createApp(MyAgent, { model, runner });
```

All methods are optional. Without a runner, standard model→tool_use behavior applies.

Lifecycle hooks receive a `SessionRef` — a narrow interface exposing only `id`, `status`, `currentTick`, and `snapshot()`. This avoids coupling runners to the full `Session` type.

### Hook Timing

| Hook                | When                               | Frequency |
| ------------------- | ---------------------------------- | --------- |
| `onSessionInit`     | First send/render (infra creation) | Once      |
| `prepareModelInput` | Before each model call             | Per tick  |
| `executeToolCall`   | For each tool call                 | Per tool  |
| `onPersist`         | After execution (auto-persist)     | Per send  |
| `onRestore`         | Session restored from store        | Once      |
| `onDestroy`         | `session.close()`                  | Once      |

## Persistence

Sessions auto-persist after each execution and auto-restore on `app.session(id)`.

### Auto-Persist

After every execution completes, the session calls `snapshot()` and saves to the configured store. This is fire-and-forget — persist failures are logged but never block execution.

### Auto-Restore

When `app.session("user-123")` is called and the session isn't in memory:

1. Load snapshot from store
2. Call `onBeforeRestore` (can cancel or migrate)
3. Create session with snapshot data
4. Call `onAfterRestore`

**Layer 1 (default):** Timeline, comState, and dataCache from the snapshot are applied directly. Components read their persisted state via `useComState` and `useData`.

**Layer 2 (resolve):** When `AppOptions.resolve` is set, auto-apply is disabled. Resolve functions run with the snapshot as context. Results available via `useResolved(key)` in components.

### Session Registry

The `SessionRegistry` (in `agentick-instance.ts`) manages active sessions:

- **`maxActive`** — When exceeded, least-recently-used sessions are evicted from memory (saved to store first)
- **`idleTimeout`** — Sessions inactive for this duration are evicted. Tracked via `send()`, `render()`, `queue()`, and channel publish
- **Sweep timer** — Periodic check for idle sessions. Timer is `unref()`'d so it doesn't keep Node.js alive

### `maxTimelineEntries`

Safety net for unbounded memory growth. Trims the oldest entries from the session's timeline after each tick. This is NOT a context management strategy — use `<Timeline>` props (`limit`, `maxTokens`, `roles`) for context control.

### Timeline Ownership

The session owns `_timeline: COMTimelineEntry[]` — the append-only source of truth. Components access it via:

- **`<Timeline />`** — Renders timeline to model context with filtering/compaction
- **`useTimeline()`** — Direct read/write access (`entries`, `set()`, `update()`)
- **`useConversationHistory()`** — Read-only access to full timeline
- **`useTickState().timeline`** — Read-only access via tick state

## Files

| File                      | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `types.ts`                | All type definitions (Session, App, options, etc) |
| `session.ts`              | SessionImpl — the core implementation             |
| `session-store.ts`        | SessionStore interface for persistence            |
| `sqlite-session-store.ts` | SQLite-based session store                        |
