# Tentickle - Claude Code Guidelines

## Philosophy

**No backwards compatibility, no deprecations, no legacy code paths.**

We maintain a clean, single code path for all functionality. When refactoring:

- Remove old code entirely rather than deprecating
- Don't add compatibility shims or migration helpers
- Don't keep unused exports "for backwards compat"
- One way to do things, done well

## Package Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Applications                                │
│        (example/express, user apps, CLI tools)                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                          Framework Layer                                 │
│   @tentickle/core     @tentickle/gateway     @tentickle/client          │
│   @tentickle/express  @tentickle/devtools                               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                         Adapter Layer                                    │
│   @tentickle/openai   @tentickle/google   @tentickle/ai-sdk             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                        Foundation Layer                                  │
│              @tentickle/kernel          @tentickle/shared               │
│              (Node.js only)             (Platform-independent)          │
└─────────────────────────────────────────────────────────────────────────┘
```

### @tentickle/kernel (Node.js Foundation)

The kernel is the foundational package for all server-side Tentickle packages. It provides low-level execution primitives that other packages build upon.

**Core Exports:**

| Module                 | Purpose                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `procedure.ts`         | Async function wrappers with middleware, context binding, schema validation, telemetry |
| `context.ts`           | Request-scoped state via AsyncLocalStorage (ALS), user context, metadata propagation   |
| `schema.ts`            | Schema detection, conversion (to JSON Schema), validation (Zod 3/4, Standard Schema)   |
| `logger.ts`            | Structured logging with configurable levels, context-aware                             |
| `telemetry.ts`         | Execution spans, timing, distributed tracing                                           |
| `otel-provider.ts`     | OpenTelemetry integration                                                              |
| `execution-tracker.ts` | Execution graph, call chains, boundary detection                                       |
| `metrics-helpers.ts`   | Metrics collection and aggregation                                                     |
| `procedure-graph.ts`   | Procedure dependency graph, visualization                                              |
| `channel.ts`           | Async generators for streaming with backpressure                                       |
| `event-buffer.ts`      | Typed event buffering and replay                                                       |
| `stream.ts`            | Stream utilities                                                                       |

**Key Patterns:**

```typescript
import { createProcedure, Context } from "@tentickle/kernel";

// Procedures wrap functions with middleware, context, telemetry
const myProcedure = createProcedure(
  { name: "my-operation", schema: z.object({ id: z.string() }) },
  async (params) => {
    const ctx = Context.get(); // Access ALS context
    return { result: params.id };
  }
);

// Context provides request-scoped state
Context.run({ user: { id: "123" }, metadata: { traceId: "abc" } }, async () => {
  const ctx = Context.get();
  console.log(ctx.user?.id); // "123"
});
```

### @tentickle/shared (Platform-Independent Types)

Shared types that work in both Node.js and browser environments. No runtime dependencies on Node.js APIs.

**Core Exports:**

| Module         | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `blocks.ts`    | ContentBlock types (text, image, tool_use, tool_result, etc.) |
| `messages.ts`  | Message types (user, assistant, system, tool_result)          |
| `tools.ts`     | ToolDefinition, ToolCall, ToolResult, ToolExecutionType       |
| `errors.ts`    | TentickleError hierarchy with codes, serialization            |
| `streaming.ts` | Stream event types                                            |
| `protocol.ts`  | Wire protocol types for client/server communication           |
| `input.ts`     | Input normalization (ContentInput, MessageInput)              |
| `identity.ts`  | ID generation utilities                                       |
| `devtools.ts`  | DevTools protocol types                                       |

**Error Handling:**

```typescript
import { ValidationError, AbortError, isAbortError } from "@tentickle/shared";

throw new ValidationError("email", "string", "Invalid email format");

try {
  await operation();
} catch (error) {
  if (isAbortError(error)) {
    // Handle cancellation
  }
}
```

## Schema Validation

The workspace uses **Zod 4.x** with full support for Zod 3 and Standard Schema.

### Kernel Schema Utilities (`@tentickle/kernel`)

The kernel provides comprehensive schema utilities in `schema.ts`:

```typescript
import {
  // Detection
  detectSchemaType,  // Returns: "zod3" | "zod4" | "standard-schema" | "json-schema" | "unknown"
  isZod3Schema,
  isZod4Schema,
  isStandardSchema,

  // Conversion
  toJSONSchema,      // Convert any schema to JSON Schema format

  // Validation
  validateSchema,    // Returns { success, data } or { success: false, issues }
  parseSchema,       // Throws on failure (used by procedure)
} from "@tentickle/kernel";
```

### Procedure Schema Support

Procedures accept any schema type - Zod 3, Zod 4, or Standard Schema:

```typescript
const myProcedure = createProcedure(
  {
    name: "my-operation",
    schema: z.object({ id: z.string() }),  // Zod 4
    // schema: zodV3Schema,                // Zod 3 also works
    // schema: arkTypeSchema,              // Standard Schema also works
  },
  async (params) => params
);
```

### Gateway Type Inference

Gateway exports `ZodLikeSchema` for TypeScript type inference in method handlers:

```typescript
// Type inference - compile time only
export interface ZodLikeSchema<T = unknown> {
  parse(data: unknown): T;
  _output: T;
}

// Used to infer params type from schema
method({
  schema: z.object({ id: z.string() }),
  handler: async (params) => {
    params.id;  // TypeScript knows this is string
  },
});
```

### Architecture

```
kernel/schema.ts          Core implementation (detection, conversion, validation)
    ↓
core/utils/schema.ts      Re-exports from kernel
    ↓
gateway/types.ts          ZodLikeSchema for type inference (TypeScript only)
```

## Gateway Architecture

The gateway provides:

- **Custom methods** via `method()` factory with schema validation, roles, guards
- **Dual transport**: WebSocket (for CLI) + HTTP/SSE (for browsers)
- **Session management**: Automatic session lifecycle
- **Auth**: Token, JWT, or custom validation with `hydrateUser` hook

```typescript
import { createGateway, method } from "@tentickle/gateway";

const gateway = createGateway({
  agents: { assistant: myApp },
  defaultAgent: "assistant",
  methods: {
    tasks: {
      list: async (params) => todoService.list(params.sessionId),
      create: method({
        schema: z.object({ title: z.string() }),
        roles: ["user"],
        handler: async (params) => todoService.create(params.title),
      }),
    },
  },
});
```

## Client Architecture

The client provides:

- **SSE transport** for browser connections
- **invoke()** for custom method calls (JSON response)
- **send()** for chat messages (streaming SSE)
- **session()** accessor for session-scoped operations

```typescript
import { createClient } from "@tentickle/client";

const client = createClient({ baseUrl: "http://localhost:3000/api" });
const session = client.session("my-session");

// Invoke custom methods
const { todos } = await session.invoke("tasks:list");

// Chat with streaming
for await (const event of session.send("Hello!")) {
  console.log(event);
}
```

## Development Practices

### Testing

```bash
pnpm test                    # Run all tests
pnpm vitest run             # Run once
pnpm --filter @tentickle/gateway test  # Run specific package
```

### Building

```bash
pnpm build                   # Build all packages
pnpm --filter @tentickle/gateway build  # Build specific package
```

### Type Checking

```bash
pnpm typecheck              # Check all packages
pnpm --filter example-express typecheck  # Check example
```

## Code Style

- **One code path**: No feature flags, no backwards compat shims
- **Clean imports**: Import from package index, not deep paths
- **Type inference**: Let TypeScript infer when obvious
- **Explicit over implicit**: Name things clearly
- **No dead code**: Remove unused exports, functions, types
- **Errors over nulls**: Throw typed errors, don't return null for failures

## Common Patterns

### Adding a new custom method to Gateway

```typescript
methods: {
  namespace: {
    methodName: method({
      schema: z.object({ /* params */ }),
      roles: ["required-role"],  // Optional
      guard: (ctx) => ctx.user?.canDoThing,  // Optional
      handler: async (params) => {
        const ctx = Context.get();
        return { result: "value" };
      },
    }),
  },
}
```

### Creating a new procedure

```typescript
import { createProcedure } from "@tentickle/kernel";

export const myProcedure = createProcedure(
  {
    name: "my-procedure",
    executionBoundary: "auto",
    schema: z.object({ input: z.string() }),
  },
  async (params) => {
    return { output: params.input.toUpperCase() };
  }
);
```

### Using ALS Context

```typescript
import { Context } from "@tentickle/kernel";

// In a request handler or procedure
const ctx = Context.get();
const userId = ctx.user?.id;
const traceId = ctx.metadata?.traceId;

// Emit events for devtools/observability
Context.emit("custom:event", { data: "value" });
```

## File Locations

| What                   | Where                             |
| ---------------------- | --------------------------------- |
| Kernel types           | `packages/kernel/src/*.ts`        |
| Shared types           | `packages/shared/src/*.ts`        |
| Gateway implementation | `packages/gateway/src/gateway.ts` |
| Client implementation  | `packages/client/src/client.ts`   |
| Express example        | `example/express/src/`            |
| Test files             | `packages/*/src/**/*.spec.ts`     |
