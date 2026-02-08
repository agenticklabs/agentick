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
7. **Continuation check** — `useContinuation` decides if another tick runs

If the model responds with tool calls, steps 1–7 repeat for the next tick.
