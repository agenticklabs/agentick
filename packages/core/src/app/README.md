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
session.close()                       // Close session and all children
session.hibernate()                   // Snapshot + close (for persistence)
session.snapshot()                    // Get current state without closing
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
  session.spawn(AgentA, input).then(h => h.result),
  session.spawn(AgentB, input).then(h => h.result),
]);
```

### Spawn Behavior

- **Self-similar**: Returns `SessionExecutionHandle` — identical to `session.send()`.
- **Isolation**: Child gets a fresh COM. Parent state does not leak.
- **Callback isolation**: Parent's lifecycle callbacks (onComplete, onTickStart, etc.) do NOT fire for child executions.
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

| Callback             | When it fires                           |
| -------------------- | --------------------------------------- |
| `onBeforeSend`       | Before send executes (can modify input) |
| `onAfterSend`        | After send completes                    |
| `onToolConfirmation` | Tool with `requiresConfirmation`        |
| `onSessionCreate`    | Session created                         |
| `onSessionClose`     | Session closed                          |
| `onBeforeHibernate`  | Before hibernation (can cancel)         |
| `onAfterHibernate`   | After hibernation                       |
| `onBeforeHydrate`    | Before hydration (can cancel/migrate)   |
| `onAfterHydrate`     | After hydration                         |

**Important**: Spawned child sessions do NOT inherit lifecycle callbacks. This is intentional — the parent's onComplete handler should not fire when a child agent completes.

## Files

| File                      | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `types.ts`                | All type definitions (Session, App, options, etc) |
| `session.ts`              | SessionImpl — the core implementation             |
| `session-store.ts`        | SessionStore interface for persistence            |
| `sqlite-session-store.ts` | SQLite-based session store                        |
