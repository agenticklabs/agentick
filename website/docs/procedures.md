# Procedures

A **Procedure** wraps any async function, generator, or async iterable with middleware, execution tracking, and streaming. Procedures are the core execution primitive — every model call, tool run, and session operation is a Procedure.

## Creating a Procedure

### Async functions

```tsx
import { createProcedure } from "@agentick/kernel";

const greet = createProcedure(async (name: string) => `Hello, ${name}!`);
```

### Async generators

Procedures wrap generators with automatic context preservation, `stream:chunk` event emission, abort handling, and iterator cleanup.

```tsx
const tokenStream = createProcedure(
  { name: "tokens", handleFactory: false },
  async function* (prompt: string) {
    const response = await fetchSSE(prompt);
    for await (const chunk of response) {
      yield chunk.text;
    }
  },
);
```

Any function that returns an `AsyncIterable` gets the same treatment — it doesn't have to be `async function*`.

## Calling a Procedure

Procedures return `ProcedurePromise` — a special promise with `.result` chaining:

```tsx
// Get the execution handle (status, abort, streaming)
const handle = await greet("World");

// Or go straight to the result value
const result = await greet("World").result;
// → "Hello, World!"
```

The `.result` auto-unwrap is how `await run(<Agent />, opts)` returns `SendResult` directly.

## Streaming with Generators

Use `handleFactory: false` (pass-through mode) to get the raw async iterable back. This is the natural fit for generators:

```tsx
const iter = await tokenStream("tell me a joke");
for await (const token of iter) {
  process.stdout.write(token);
}
```

In default mode (with ExecutionHandle), `handle.result` resolves to the async iterable. The `stream:chunk` events fire as you consume it:

```tsx
const tracked = createProcedure({ name: "tracked-stream" }, async function* () {
  yield "chunk 1";
  yield "chunk 2";
});

const handle = await tracked();
// handle.result resolves to the async iterable — iterate to trigger chunks
for await (const chunk of await handle.result) {
  // Each iteration emits stream:chunk on handle.events
  process.stdout.write(chunk);
}
// handle.abort() cancels iteration between yields
```

### What you get for free

When a procedure wraps a generator or async iterable, the execution tracker automatically:

- **Preserves ALS context** across every `yield` — `Context.get()` works inside the generator
- **Emits `stream:chunk`** for each yielded value as it's consumed
- **Emits `procedure:end`** when iteration completes, `procedure:error` on failure
- **Checks abort signals** between yields — `handle.abort()` stops iteration cleanly
- **Cleans up the iterator** via `.return()` in the `finally` block

## Stream Utilities

Composable transformers for working with async iterables from procedures:

```tsx
import { mapStream, tapStream, mergeStreams } from "@agentick/kernel";

// Transform each chunk
const upper = mapStream(iter, (token) => token.toUpperCase());

// Side effects without modifying the stream
const logged = tapStream(iter, (token) => console.log("chunk:", token));

// Merge multiple streams — yields items as they arrive
const merged = mergeStreams([stream1, stream2]);

// Tagged merge — know which stream each item came from
const tagged = mergeStreams({ model: stream1, tools: stream2 });
for await (const item of tagged) {
  console.log(item.source, item.value); // "model" or "tools"
}
```

All utilities preserve execution context through iterations.

## Chainable API

All methods return a new Procedure (immutable):

```tsx
const enhanced = greet
  .use(loggingMiddleware)
  .withContext({ user: "ryan" })
  .withTimeout(5000)
  .withMetadata({ operation: "greeting" });
```

| Method                | Purpose                         |
| --------------------- | ------------------------------- |
| `.use(middleware)`    | Add middleware                  |
| `.withContext(ctx)`   | Merge AsyncLocalStorage context |
| `.withTimeout(ms)`    | Abort after timeout             |
| `.withMetadata(meta)` | Add telemetry metadata          |
| `.pipe(nextProc)`     | Chain output → input            |

## Middleware

Middleware intercepts execution — transform args, modify results, or short-circuit:

```tsx
import { Middleware } from "@agentick/kernel";

const timing: Middleware = async (args, envelope, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`${envelope.operationName}: ${Date.now() - start}ms`);
  return result;
};

const greet = createProcedure(async (name: string) => `Hello, ${name}!`).use(timing);
```

## Session Procedures

`session.send()`, `session.render()`, `session.queue()`, and `app.run()` are all Procedures:

```tsx
// ProcedurePromise → SessionExecutionHandle
const handle = await session.send({ messages: [...] });

// ProcedurePromise.result → SendResult
const result = await session.send({ messages: [...] }).result;
```

All use passthrough mode — the handler's return value flows through directly. `ProcedurePromise.result` chains to `SessionExecutionHandle.result`, giving `SendResult`.
