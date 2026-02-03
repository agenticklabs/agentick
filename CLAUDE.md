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

## Core Package Architecture

### React-like Reconciler

Tentickle uses a React-inspired reconciler for composing LLM prompts. The core abstracts are:

- **Fiber Tree**: Virtual DOM-like structure representing the component hierarchy
- **Reconciler**: Manages component lifecycle, diffs changes, schedules updates
- **Compiler**: Transforms the fiber tree into model-ready format (messages, tools, system prompt)

```
┌─────────────────────────────────────────────────────────────────┐
│                      User JSX Components                         │
│   <App> → <System> → <Message> → <Tool> → primitives            │
└───────────────────────────┬─────────────────────────────────────┘
                            │ render
┌───────────────────────────▼─────────────────────────────────────┐
│                        Fiber Tree                                │
│   Root fiber → child fibers → hooks state → props               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ compile
┌───────────────────────────▼─────────────────────────────────────┐
│                    CompiledStructure                             │
│   { system, timelineEntries, tools, ephemeral, sections }       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ transform
┌───────────────────────────▼─────────────────────────────────────┐
│                      Provider Input                              │
│   Provider-specific format (Anthropic, OpenAI, etc.)            │
└─────────────────────────────────────────────────────────────────┘
```

### Key Files in @tentickle/core

| File                         | Purpose                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `reconciler/reconciler.ts`   | Fiber reconciliation, component lifecycle                |
| `reconciler/fiber.ts`        | Fiber node types and creation                            |
| `compiler/fiber-compiler.ts` | Transforms fiber tree to CompiledStructure               |
| `compiler/collector.ts`      | Collects content from fiber tree                         |
| `app/session.ts`             | Session management, tick execution, DevTools integration |
| `hooks/*.ts`                 | React-like hooks (useState, useEffect, useSignal, etc.)  |
| `jsx/components/*.tsx`       | Built-in JSX components                                  |

### JSX Components

Built-in components for prompt composition:

```typescript
// System prompt
<System>You are a helpful assistant.</System>

// Messages
<Message role="user">Hello!</Message>
<Message role="assistant">Hi there!</Message>

// Tools
<Tool
  name="calculator"
  description="Performs math"
  schema={z.object({ expression: z.string() })}
  handler={async ({ expression }) => eval(expression)}
/>

// Primitives
<text>Raw text content</text>
<section id="context">Grouped content</section>
```

### Hook System

React-like hooks for state and effects:

```typescript
// State
const [count, setCount] = useState(0);
const [state, dispatch] = useReducer(reducer, initialState);

// Signals (reactive state)
const signal = useSignal(initialValue);
const computed = useComputed(() => signal.value * 2);

// Effects
useEffect(() => {
  // Side effect on mount/update
  return () => { /* cleanup */ };
}, [deps]);

// Message handling
const messages = useQueuedMessages();
useOnMessage((msg) => { /* handle */ });

// Context
const value = useContext(MyContext);
```

### Session & Execution Model

**Session**: Long-lived conversation context with state persistence.

**Execution**: Single run of the component tree (one user message → model response cycle).

**Tick**: One model API call within an execution. Multi-tick executions happen with tool use.

```
Session
├── Execution 1 (user: "Hello")
│   └── Tick 1 → model response
├── Execution 2 (user: "Use calculator")
│   ├── Tick 1 → tool_use (calculator)
│   └── Tick 2 → final response
└── Execution 3 ...
```

### CompiledStructure

The intermediate representation after compiling the fiber tree:

```typescript
interface CompiledStructure {
  system: CompiledTimelineEntry[];      // System-level entries
  timelineEntries: CompiledTimelineEntry[]; // Message history
  tools: CompiledTool[];                // Available tools
  ephemeral: CompiledEphemeral[];       // Temporary content
  sections: Map<string, CompiledSection>; // Named sections
}
```

## DevTools Architecture

### Enabling DevTools

```typescript
import { createSession } from "@tentickle/core";

const session = createSession(MyApp, {
  devTools: true,  // Enable DevTools
  // or with config:
  devTools: {
    enabled: true,
    remote: true,
    remoteUrl: "http://localhost:3001/api/devtools",
  },
});
```

### DevTools Event Flow

```
┌─────────────┐    emit     ┌──────────────────┐    SSE     ┌─────────────┐
│   Session   │ ─────────▶  │ devToolsEmitter  │ ─────────▶ │ DevTools UI │
│   (core)    │             │    (shared)      │            │  (browser)  │
└─────────────┘             └──────────────────┘            └─────────────┘
```

### Key Event Types

| Event                       | Purpose                        |
| --------------------------- | ------------------------------ |
| `execution_start`           | New execution began            |
| `execution_end`             | Execution completed            |
| `tick_start` / `tick_end`   | Model API call lifecycle       |
| `compiled`                  | JSX compiled to messages/tools |
| `model_request`             | Request sent to provider       |
| `provider_response`         | Raw provider response          |
| `model_response`            | Transformed response           |
| `tool_call` / `tool_result` | Tool execution                 |
| `fiber_snapshot`            | Fiber tree state at tick end   |
| `content_delta`             | Streaming text chunk           |

### DevTools UI Structure

The DevTools UI (`packages/devtools/ui/`) has:

**Sidebar** (left):

- Executions list
- Sessions list (grouped executions)

**Content Tabs** (center):

- **Execution**: Overview stats (status, tokens, duration, model)
- **Context**: Per-tick context view controlled by tick scrubber
  - Compiled context (system, messages, tools)
  - Provider input (what model sees)
  - Provider response (raw)
  - Model output (transformed)
  - Tool calls
- **Fiber Tree**: Component hierarchy with hooks inspection
- **Tools**: All tool calls across ticks

**Global Tabs** (separated):

- **Network**: Gateway connections, sessions, requests

**Inspector** (right, fiber tab only):

- Selected node props
- Hook states
- Token estimates

**Tick Navigator** (top):

- Scrubber to select which tick's data to view

### DevTools Files

| File                                                   | Purpose                            |
| ------------------------------------------------------ | ---------------------------------- |
| `packages/shared/src/devtools.ts`                      | Event types, emitter singleton     |
| `packages/devtools/ui/src/App.tsx`                     | Main UI layout and state           |
| `packages/devtools/ui/src/hooks/useDevToolsEvents.ts`  | Event processing, state management |
| `packages/devtools/ui/src/components/ContentPanel.tsx` | Tab content views                  |
| `packages/devtools/ui/src/components/Tree/`            | Fiber tree visualization           |
| `packages/devtools/ui/src/components/Inspector/`       | Node inspection panel              |
| `packages/devtools/ui/src/components/NetworkPanel.tsx` | Network monitoring                 |

### Token Estimation

DevTools shows approximate token counts using `packages/core/src/utils/token-estimate.ts`:

```typescript
import { computeTokenSummary, formatTokenCount } from "@tentickle/core";

const summary = computeTokenSummary(compiled);
// { system: 150, messages: 500, tools: 200, ephemeral: 0, total: 850, byComponent: Map }

formatTokenCount(1500); // "1.5k"
```

### React DevTools Integration

For debugging the reconciler itself, connect to standalone React DevTools:

```typescript
import { enableReactDevTools } from "@tentickle/core";

// Before creating sessions
enableReactDevTools(); // Connects to npx react-devtools on port 8097
```

## Provider Adapters

Adapters transform between Tentickle's format and provider-specific APIs:

```typescript
import { createAnthropicAdapter } from "@tentickle/openai"; // or @tentickle/google

const adapter = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Used internally by session
const session = createSession(MyApp, {
  adapter,
  model: "claude-3-5-sonnet-20241022",
});
```

## Common Debugging

### Component shows as `<Unknown>` in DevTools

Add `displayName` to function components:

```typescript
function MyComponent() { ... }
MyComponent.displayName = "MyComponent";
```

### System tokens showing as 0

Ensure sections are being compiled. Check that `<System>` or `<section>` components are in the tree.

### Fiber tree not updating

The fiber tree snapshots are taken at tick end. Check `tick_end` events are being emitted.

### DevTools not receiving events

1. Verify `devTools: true` in session config
2. Check SSE connection in Network tab
3. Look for `[DevTools]` log messages in console
