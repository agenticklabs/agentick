# @agentick/kernel

Low-level execution primitives for Agentick. Provides procedures, async context management, schema validation, logging, telemetry, and event streaming.

> **Note:** Most applications should use `@agentick/core` instead. This package is the foundation that core builds upon.

## Installation

```bash
pnpm add @agentick/kernel
```

## Core Primitives

### Procedures

Procedures wrap any async function, generator, or async iterable with middleware, execution tracking, and streaming:

```typescript
import { createProcedure } from "@agentick/kernel";
import { z } from "zod";

// Async function with schema validation
const fetchUser = createProcedure(
  {
    name: "fetchUser",
    schema: z.object({ id: z.string() }),
  },
  async ({ id }) => {
    return await db.users.find(id);
  },
);

// Execute
const user = await fetchUser({ id: "123" });

// With middleware
const withLogging = fetchUser.use(async (args, ctx, next) => {
  console.log("Fetching user:", args.id);
  const result = await next(args);
  console.log("Found:", result);
  return result;
});
```

#### Async Generators

Procedures wrapping generators get automatic context preservation, `stream:chunk` events, abort handling, and iterator cleanup:

```typescript
const tokenStream = createProcedure(
  { name: "tokens", handleFactory: false },
  async function* (prompt: string) {
    const response = await fetchSSE(prompt);
    for await (const chunk of response) {
      yield chunk.text;
    }
  },
);

const iter = await tokenStream("tell me a joke");
for await (const token of iter) {
  process.stdout.write(token);
}
```

Any function returning an `AsyncIterable` gets the same treatment — it doesn't have to be `async function*`.

#### ExecutionHandle

Procedures are callable directly. You can also use `.exec()`:

```typescript
// Direct call (preferred)
const handle = await fetchUser({ id: "123" });

// Or explicit .exec()
const handle = await fetchUser.exec({ id: "123" });

// Check status
console.log(handle.status); // "pending" | "running" | "completed" | "error"

// Abort if needed
handle.abort();

// Wait for result
const user = await handle.result;
```

#### Composition

```typescript
import { pipe, compose } from "@agentick/kernel";

// Chain procedures left-to-right
const pipeline = pipe(validate, transform, save);

// Or right-to-left (functional style)
const composed = compose(save, transform, validate);
```

### Context (AsyncLocalStorage)

Request-scoped state that flows through async operations automatically:

```typescript
import { Context } from "@agentick/kernel";

// Create and run within context
Context.run({ user: { id: "123" }, metadata: { traceId: "abc" } }, async () => {
  const ctx = Context.get();
  console.log(ctx.user?.id); // "123"

  // Context propagates through async calls
  await someAsyncOperation(); // Still has access to context
});

// Fork for parallel execution (safe isolation)
await Context.fork({ metadata: { branch: "A" } }, async () => {
  // Child context with overrides
});
```

#### Global Event Subscribers

```typescript
// Subscribe to all context events (useful for DevTools/telemetry)
const unsubscribe = Context.subscribeGlobal((event) => {
  console.log(event.type, event.payload);
});

// Emit events from anywhere
Context.emit("custom:event", { data: "value" });
```

### Schema Validation

Unified handling for Zod 3, Zod 4, and Standard Schema:

```typescript
import { detectSchemaType, toJSONSchema, validateSchema, parseSchema } from "@agentick/kernel";

// Detect schema type
const type = detectSchemaType(schema); // "zod3" | "zod4" | "standard-schema" | "json-schema"

// Convert to JSON Schema
const jsonSchema = toJSONSchema(myZodSchema);

// Validate (returns result object)
const result = validateSchema(schema, data);
if (result.success) {
  console.log(result.data);
} else {
  console.log(result.issues);
}

// Parse (throws on failure)
const data = parseSchema(schema, input);
```

### Logging

Structured logging with automatic context injection:

```typescript
import { Logger } from "@agentick/kernel";

// Configure globally
Logger.configure({
  level: "info",
  transport: "pretty", // or "json"
});

// Get context-aware logger
const log = Logger.get();
log.info("Processing request", { userId: "123" });

// Scoped logger
const dbLog = Logger.for("database");
dbLog.debug("Query executed", { query, duration });
```

### Telemetry

Spans and metrics for observability:

```typescript
import { Telemetry } from "@agentick/kernel";

// Start a trace
const trace = Telemetry.startTrace("handle-request");

// Create spans
const span = Telemetry.startSpan("fetch-user");
span.setAttribute("userId", "123");
try {
  // ... work
} catch (error) {
  span.recordError(error);
} finally {
  span.end();
}

// Metrics
const requestCounter = Telemetry.getCounter("requests_total");
requestCounter.add(1, { method: "POST" });

const latencyHistogram = Telemetry.getHistogram("request_duration_ms");
latencyHistogram.record(42, { endpoint: "/api/users" });
```

### Channels

Bidirectional communication for real-time updates:

```typescript
import { Channel } from "@agentick/kernel";

const channel = new Channel();

// Subscribe
channel.on("message", (payload) => {
  console.log("Received:", payload);
});

// Publish
channel.emit("message", { text: "Hello" });

// Request/response pattern
const response = await channel.request("getUser", { id: "123" }, 5000);

// Broadcast to all
channel.broadcast("notification", { message: "System update" });
```

### EventBuffer

Type-safe event streaming with replay:

```typescript
import { EventBuffer } from "@agentick/kernel";

type MyEvent =
  | { type: "start"; id: string }
  | { type: "progress"; percent: number }
  | { type: "complete"; result: unknown };

const buffer = new EventBuffer<MyEvent>();

// Subscribe with type narrowing
buffer.on("progress", (event) => {
  console.log(`${event.percent}% complete`);
});

// Late subscribers can replay
buffer.onReplay("start", (event) => {
  console.log("Started:", event.id);
});

// Async iteration
for await (const event of buffer) {
  console.log(event.type);
}

// Push events
buffer.push({ type: "start", id: "123" });
buffer.push({ type: "progress", percent: 50 });
buffer.push({ type: "complete", result: { success: true } });

// Close when done
buffer.close();
```

### Guards

Gate procedure execution with access control checks:

```typescript
import { createGuard, GuardError } from "@agentick/kernel";

// Simple predicate — deny throws GuardError
const adminOnly = createGuard(
  (envelope) => envelope.context.user?.roles?.includes("admin") ?? false,
);

// With config — custom reason and guard type
const roleGuard = createGuard(
  {
    name: "role-guard",
    guardType: "role",
    reason: (envelope) => `User ${envelope.context.user?.id} lacks required role`,
  },
  (envelope) => envelope.context.user?.roles?.includes("admin") ?? false,
);

// Throw GuardError directly for full control
const customGuard = createGuard({ name: "acl-guard" }, (envelope) => {
  if (!hasPermission(envelope.context.user)) {
    throw GuardError.role(["admin", "moderator"]);
  }
  return true;
});

// Apply to any procedure via .use()
const secured = fetchUser.use(adminOnly);
```

Guards are middleware — they compose with `.use()` like any other middleware but are purpose-built for allow/deny decisions.

#### GuardError

```typescript
import { GuardError, isGuardError } from "@agentick/kernel";

// Factories
GuardError.role(["admin"]); // "Requires one of roles [admin]"
GuardError.denied("Custom reason"); // Custom denial

// Type guard
if (isGuardError(error)) {
  error.code; // "GUARD_DENIED"
  error.guardType; // "role", "custom", etc.
  error.details; // { roles: [...], guard: "name", ... }
}
```

## Key Patterns

### Middleware Pipelines

```typescript
import { createPipeline } from "@agentick/kernel";

const authPipeline = createPipeline([
  async (args, ctx, next) => {
    if (!ctx.user) throw new Error("Unauthorized");
    return next(args);
  },
  async (args, ctx, next) => {
    ctx.metadata.startTime = Date.now();
    return next(args);
  },
]);

// Apply to any procedure
const securedFetch = fetchUser.use(authPipeline);
```

### Immutable Composition

All procedure methods return new instances:

```typescript
const base = createProcedure({ name: "base" }, handler);
const withTimeout = base.withTimeout(5000);
const withContext = withTimeout.withContext({ tenant: "acme" });

// Original unchanged
console.log(base === withTimeout); // false
```

## API Reference

### Procedures

| Export                              | Description                                |
| ----------------------------------- | ------------------------------------------ |
| `createProcedure(options, handler)` | Create a procedure (function or generator) |
| `generatorProcedure(options, fn)`   | Create a generator procedure with `this`   |
| `createHook(options, handler)`      | Create a hook procedure                    |
| `pipe(...procedures)`               | Chain left-to-right                        |
| `compose(...procedures)`            | Chain right-to-left                        |
| `createPipeline(middleware)`        | Bundle middleware                          |

### Guards

| Export                      | Description                 |
| --------------------------- | --------------------------- |
| `createGuard(fn)`           | Create guard from predicate |
| `createGuard(config, fn)`   | Create guard with config    |
| `GuardError`                | Access denied error class   |
| `GuardError.role(roles)`    | Role-based denial factory   |
| `GuardError.denied(reason)` | Custom denial factory       |
| `isGuardError(error)`       | Type guard for GuardError   |

### Context

| Export                               | Description                 |
| ------------------------------------ | --------------------------- |
| `Context.create(overrides?)`         | Create root context         |
| `Context.run(context, fn)`           | Run within context          |
| `Context.fork(overrides, fn)`        | Fork for parallel execution |
| `Context.get()` / `Context.tryGet()` | Access current context      |
| `Context.emit(type, payload)`        | Emit event                  |
| `Context.subscribeGlobal(handler)`   | Subscribe to all events     |

### Schema

| Export                          | Description                 |
| ------------------------------- | --------------------------- |
| `detectSchemaType(schema)`      | Identify schema type        |
| `toJSONSchema(schema)`          | Convert to JSON Schema      |
| `validateSchema(schema, value)` | Validate with result object |
| `parseSchema(schema, value)`    | Parse or throw              |

### Logging & Telemetry

| Export                         | Description              |
| ------------------------------ | ------------------------ |
| `Logger.configure(options)`    | Configure logging        |
| `Logger.get()`                 | Get context-aware logger |
| `Logger.for(name)`             | Get scoped logger        |
| `Telemetry.startSpan(name)`    | Create span              |
| `Telemetry.getCounter(name)`   | Create counter metric    |
| `Telemetry.getHistogram(name)` | Create histogram metric  |

### Streaming

| Export            | Description                           |
| ----------------- | ------------------------------------- |
| `Channel`         | Pub/sub with request/response         |
| `EventBuffer<T>`  | Type-safe event streaming with replay |
| `mapStream(s,fn)` | Transform items in an async stream    |
| `tapStream(s,fn)` | Side effects without modifying stream |
| `mergeStreams(s)` | Merge multiple streams (race)         |
| `isAsyncIterable` | Type guard for async iterables        |

## License

MIT
