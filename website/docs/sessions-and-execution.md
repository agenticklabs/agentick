# Sessions & Execution

## Execution Model

Agentick has three levels of granularity:

```
Session
├── Execution 1 (user: "Hello")
│   └── Tick 1 → model response
├── Execution 2 (user: "Use the calculator")
│   ├── Tick 1 → tool_use (calculator)
│   └── Tick 2 → final response
└── Execution 3 ...
```

**Session**: Long-lived conversation context. Holds state, timeline history, component tree. Has an identity (ID + metadata). Persists across multiple user interactions.

**Execution**: One user message → model response cycle. Created by `session.send()` or `session.render()`. Can span multiple ticks if the model uses tools.

**Tick**: One model API call. The reconciler compiles the component tree, sends it to the model, and processes the response. If the response includes tool calls, a new tick begins after the tools execute.

## Creating Sessions

```tsx
const app = createApp(() => (
  <>
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
));

// Create a session with an ID
const session = await app.session({ id: "user-123" });

// Send a message
const handle = await session.send({
  messages: [{ role: "user", content: "Hello!" }],
});

// Get the result
const result = await handle.result;
console.log(result.response); // Model's text response
```

## Session as Procedure

`session.send()`, `session.render()`, and `session.queue()` are all **Procedures**. This means they return `ProcedurePromise` values that support `.result` chaining:

```tsx
// Get the execution handle (status, abort, streaming)
const handle = await session.send({ messages: [...] });

// Or go straight to the result
const result = await session.send({ messages: [...] }).result;
```

## Stateless Execution

For one-off calls without session management, use `run()`:

```tsx
import { run } from "agentick";
import { OpenAIModel } from "@agentick/openai";

function MyAgent() {
  return (
    <>
      <OpenAIModel model="gpt-4o" />
      <System>You are a helpful assistant.</System>
      <Timeline />
    </>
  );
}

const result = await run(<MyAgent />, {
  messages: [{ role: "user", content: "Hello!" }],
}).result;
```

`run()` is also a Procedure. `await run(app, opts)` returns an execution handle; `await run(app, opts).result` returns the `SendResult` directly.

## Tick Lifecycle

Each tick follows this sequence:

1. **Tick start** — `useOnTickStart` callbacks fire (tick 2+)
2. **Compile** — reconciler diffs the component tree, compiler produces model input
3. **After compile** — `useAfterCompile` callbacks fire
4. **Model call** — adapter sends the compiled context to the model
5. **Process response** — tool calls executed, timeline updated
6. **Tick end** — `useOnTickEnd` callbacks fire
7. **Continuation check** — framework checks tool calls + queued messages, then `useContinuation` callbacks can override

If the model responds with tool calls, steps 1–7 repeat for the next tick.

After the tick loop exits (or on abort/error):

8. **Execution end** — `useOnExecutionEnd` callbacks fire (before snapshot persistence)

## Spawn

`session.spawn()` creates an ephemeral child session with a different agent. The child runs to completion and returns the same `SessionExecutionHandle` as `session.send()`.

```tsx
// Spawn with a component function
const handle = await session.spawn(SummaryAgent, {
  messages: [{ role: "user", content: "Summarize this document." }],
});
const result = await handle.result;

// Spawn with JSX
await session.spawn(<Researcher query="quantum" />, { messages });

// Parallel spawns
const [a, b] = await Promise.all([
  session.spawn(AgentA, input).then((h) => h.result),
  session.spawn(AgentB, input).then((h) => h.result),
]);
```

### From Tool Handlers

```tsx
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

### SpawnOptions

The optional third argument overrides inherited options:

```tsx
await session.spawn(
  SummaryAgent,
  { messages },
  {
    model: cheapModel, // Override the parent's model
    maxTicks: 3, // Limit child ticks
    runner: replRunner, // Override the parent's runner
  },
);
```

### Spawn Behavior

- **Self-similar**: Returns `SessionExecutionHandle` — identical to `session.send()`
- **Isolation**: Child gets a fresh component tree. Parent state does not leak
- **Runner inherited**: Child sessions inherit the parent's `ExecutionRunner` (override via `SpawnOptions`)
- **Abort propagation**: Aborting parent → aborts all children
- **Close propagation**: Closing parent → closes all children
- **Depth limit**: 10 levels max
- **Ephemeral**: Child sessions are NOT registered in the app's session registry

## Execution Runner

An `ExecutionRunner` controls how compiled context reaches the model and how tool calls execute. Set on `AppOptions.runner`.

```tsx
const runner: ExecutionRunner = {
  name: "repl",

  // Transform compiled structure before model call (per tick)
  transformCompiled(compiled, tools) {
    return { ...compiled, tools: [] };
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
  onDestroy(session) {
    /* cleanup */
  },
};

const app = createApp(MyAgent, { model, runner });
```

All methods are optional. Without a runner, standard model→tool_use behavior applies.

### Hook Timing

| Hook                | When                               | Frequency |
| ------------------- | ---------------------------------- | --------- |
| `onSessionInit`     | First send/render (infra creation) | Once      |
| `transformCompiled` | Before each model call             | Per tick  |
| `executeToolCall`   | For each tool call                 | Per tool  |
| `onPersist`         | After execution (auto-persist)     | Per send  |
| `onRestore`         | Session restored from store        | Once      |
| `onDestroy`         | `session.close()`                  | Once      |

Runners are inherited by spawned children. Use `SpawnOptions.runner` to override for a specific child.

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

### Session Registry

The `SessionRegistry` manages active sessions in memory:

- **`maxActive`** — When exceeded, least-recently-used sessions are evicted (saved to store first)
- **`idleTimeout`** — Sessions inactive for this duration are evicted
