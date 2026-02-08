# Procedures

A **Procedure** wraps any async function with middleware, validation, execution tracking, and `ProcedurePromise` return values. Procedures are the core execution primitive — every model call, tool run, and session operation is a Procedure.

## Creating a Procedure

```tsx
import { createProcedure } from "@agentick/kernel";

const greet = createProcedure(async (name: string) => `Hello, ${name}!`);
```

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
