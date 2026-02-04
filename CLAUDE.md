# Tentickle - Claude Code Guidelines

## Philosophy

**No backwards compatibility, no deprecations, no legacy code paths.**

We maintain a clean, single code path for all functionality. When refactoring:

- Remove old code entirely rather than deprecating
- Don't add compatibility shims or migration helpers
- Don't keep unused exports "for backwards compat"
- One way to do things, done well

### Primitives vs Patterns

The framework provides **building blocks**, not opinions. Users compose these into application-specific patterns.

**Core primitives (what framework provides):**

| Primitive     | Purpose                                                               |
| ------------- | --------------------------------------------------------------------- |
| `<Timeline>`  | Renders conversation history. Special because it IS the conversation. |
| `<Tool>`      | Defines a function the model can call                                 |
| `<Section>`   | Renders content to model context                                      |
| `<Message>`   | Adds a message to the timeline                                        |
| Signals/hooks | Reactive state management                                             |
| Channels      | Real-time sync between session and UI                                 |

**Patterns (what users build from primitives):**

Todo lists, artifacts, memory systems, etc. are NOT framework primitives. They are **state that exists parallel to the timeline**. The timeline contains _actions_ (tool calls) that manipulate this state, but the state itself lives outside the conversation history.

```
┌─────────────────────────────────────────────────────────────┐
│                        Session                               │
│                                                             │
│   Timeline (IS the conversation)    Parallel State          │
│   ┌─────────────────────────┐      ┌───────────────────┐   │
│   │ user: "Add a task"      │      │ todos: [...]      │   │
│   │ tool_use: todo_list     │ ───▶ │ artifacts: [...]  │   │
│   │ tool_result: "Created"  │      │ memory: [...]     │   │
│   │ assistant: "Done!"      │      │ (user-defined)    │   │
│   └─────────────────────────┘      └───────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Stateful Tool Pattern

The recommended way to build managed collections (todos, artifacts, etc.) is the **stateful tool pattern**. See `example/express/src/tools/todo-list.tool.tsx` for a complete example.

A stateful tool combines:

```typescript
export const MyStatefulTool = createTool({
  name: "my_tool",
  description: "...",
  input: schema,

  // 1. Handler: Mutates state, broadcasts changes
  handler: async (input) => {
    const result = MyService.doAction(input);

    // Broadcast to UI via channel
    const ctx = Context.tryGet();
    ctx?.channels?.publish(ctx, "my-channel", {
      type: "state_changed",
      payload: result
    });

    return [{ type: "text", text: "Done" }];
  },

  // 2. Render: Shows current state to model each tick
  render: () => {
    const state = MyService.getState();
    return (
      <Section id="my-state" audience="model">
        Current state: {JSON.stringify(state)}
      </Section>
    );
  },
});
```

This pattern gives you:

- **Model sees state** via `render()` on each tick
- **Model can act** via `handler()` tool calls
- **UI stays in sync** via channel broadcasts
- **Actions in timeline** but state lives separately

### Provider Pattern (for composability)

For more complex patterns, use the Provider pattern (see `<Timeline.Provider>`):

```tsx
// Provider manages state + context
<MyThing.Provider service={myService}>
  {/* Customizable rendering */}
  <MyThing.List>
    {(items) => items.map(item => <CustomItem {...item} />)}
  </MyThing.List>

  {/* Tools can be bundled or custom */}
  <MyThing.Tools />
</MyThing.Provider>
```

This allows:

- Default rendering with customization via render props
- Separation of state management from presentation
- Service injection for persistence

### Plugins

Common patterns can be packaged as plugins (separate packages, not in core):

```typescript
import { Artifacts } from "@tentickle/plugin-artifacts";

<Artifacts.Provider service={myArtifactService}>
  <Artifacts.List />
  <Artifacts.Tools />
</Artifacts.Provider>
```

Plugins compose framework primitives into reusable patterns. They should:

- Accept service/persistence configuration
- Follow the Provider pattern for composability
- Have sensible defaults but allow customization

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

## Model Adapters

Adapters transform between Tentickle's format and provider-specific APIs. Understanding the streaming architecture is critical for writing correct adapters.

### Streaming Architecture

```
┌─────────────────┐    executeStream    ┌─────────────────┐
│  Provider SDK   │ ──────────────────▶ │  Raw Chunks     │
│  (OpenAI, etc)  │                     │  (provider fmt) │
└─────────────────┘                     └────────┬────────┘
                                                 │
                                        mapChunk │ (adapter)
                                                 ▼
                                        ┌─────────────────┐
                                        │  AdapterDelta   │
                                        │  (normalized)   │
                                        └────────┬────────┘
                                                 │
                                     processChunk│ (model.ts)
                                                 ▼
                                        ┌─────────────────┐
                                        │  StreamEvent    │
                                        │  (framework)    │
                                        └────────┬────────┘
                                                 │
                                          yield  │ (to session)
                                                 ▼
                                        ┌─────────────────┐
                                        │  Session/UI     │
                                        └─────────────────┘
```

### Key Types

**AdapterDelta** - What adapters emit (simplified):

```typescript
type AdapterDelta =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "message_start"; model?: string }
  | { type: "message_end"; stopReason: StopReason; usage?: UsageStats }
  | { type: "usage"; usage: Partial<UsageStats> }  // Standalone usage update
  | { type: "error"; error: Error | string }
```

**StreamEvent** - What consumers receive (richer):

```typescript
type StreamEvent =
  | ContentDeltaEvent    // { type: "content_delta", delta: string, ... }
  | MessageEndEvent      // { type: "message_end", stopReason, usage, ... }
  | UsageEvent           // { type: "usage", usage: { inputTokens, ... } }
  | MessageEvent         // { type: "message", message: Message, raw, ... }
  // ... and more
```

### Creating an Adapter with `createAdapter`

```typescript
import { createAdapter, StopReason } from "@tentickle/core/model";

const model = createAdapter<ProviderInput, ProviderOutput, ProviderChunk>({
  metadata: {
    id: "my-provider",
    provider: "my-provider",
    capabilities: [{ stream: true, toolCalls: true }],
  },

  prepareInput: (input: ModelInput) => {
    // Transform Tentickle format → provider format
    return { model: "...", messages: [...], tools: [...] };
  },

  mapChunk: (chunk: ProviderChunk): AdapterDelta | null => {
    // Transform provider chunk → AdapterDelta
    // Return null to ignore chunks
  },

  execute: async (input) => provider.generate(input),
  executeStream: async function* (input) { yield* provider.stream(input) },

  // Optional: Reconstruct full response from streaming chunks
  reconstructRaw: (accumulated) => ({
    id: "...",
    choices: [{ message: { content: accumulated.text }, ... }],
    usage: accumulated.usage,
  }),
});
```

### Critical: Provider-Specific Streaming Quirks

Different providers send data differently. **Always check provider behavior!**

**OpenAI** sends streaming data in this order:

1. Text delta chunks with `choices[0].delta.content`
2. A chunk with `finish_reason: "stop"` (NO usage yet)
3. A SEPARATE final chunk with just `usage` data (no choices)

**Correct handling:**

```typescript
mapChunk: (chunk: ChatCompletionChunk): AdapterDelta | null => {
  // Usage-only chunks (no choices) - emit "usage" NOT "message_end"
  if (!chunk.choices || chunk.choices.length === 0) {
    if (chunk.usage) {
      return { type: "usage", usage: { ... } };  // ✅ Correct
      // NOT: return { type: "message_end", ... }; // ❌ Wrong - causes duplicate
    }
    return null;
  }

  // finish_reason chunk → message_end (without usage)
  if (choice.finish_reason) {
    return { type: "message_end", stopReason: ..., usage: undefined };
  }

  // Content chunks
  if (delta.content) {
    return { type: "text", delta: delta.content };
  }
}
```

**Why this matters:**

- `message_end` triggers accumulator reset in model.ts
- Two `message_end` events = second one has empty content
- `usage` event updates usage without resetting accumulators

### Tool Call Streaming Patterns

Providers handle tool calls differently. The StreamAccumulator supports both patterns:

**Pattern 1: Complete Tool Calls** (Google, some providers)

```typescript
// Provider sends complete tool call in one chunk
mapChunk: (chunk) => {
  if (chunk.functionCall) {
    return {
      type: "tool_call",  // Complete in one event
      id: chunk.functionCall.id || chunk.functionCall.name,
      name: chunk.functionCall.name,
      input: chunk.functionCall.args,
    };
  }
}
```

**Pattern 2: Streamed Tool Calls** (OpenAI, AI SDK)

```typescript
// Provider streams tool calls in parts
mapChunk: (chunk) => {
  if (chunk.toolCallStart) {
    return { type: "tool_call_start", id: chunk.id, name: chunk.name };
  }
  if (chunk.toolCallDelta) {
    return { type: "tool_call_delta", id: chunk.id, delta: chunk.jsonChunk };
  }
  if (chunk.toolCallEnd) {
    return { type: "tool_call_end", id: chunk.id, input: undefined }; // Accumulator parses JSON
  }
}
```

**Critical: OpenAI ID-by-Index Tracking**

OpenAI only sends tool call `id` on the first chunk. Subsequent chunks only have `index`:

```typescript
// OpenAI adapter needs stateful tracking
let toolCallIdByIndex = new Map<number, string>();

mapChunk: (chunk) => {
  if (chunk.tool_calls) {
    for (const tc of chunk.tool_calls) {
      // Track ID by index (only sent on first chunk)
      if (tc.id) toolCallIdByIndex.set(tc.index, tc.id);
      const id = toolCallIdByIndex.get(tc.index) || "";

      if (tc.function?.name) {
        return { type: "tool_call_start", id, name: tc.function.name };
      }
      if (tc.function?.arguments) {
        return { type: "tool_call_delta", id, delta: tc.function.arguments };
      }
    }
  }
},

executeStream: async function* (params) {
  toolCallIdByIndex = new Map(); // Reset per stream!
  // ...
}
```

**No Explicit `tool_call_end`?**

Some providers (native OpenAI) don't send explicit end events for tool calls - they just send `message_end` with `finish_reason: "tool_calls"`. The StreamAccumulator handles this automatically by finalizing any in-progress tool calls when `message_end` is received.

### The `reconstructRaw` Option

For streaming responses, `ModelOutput.raw` should contain a fully-formed provider response (as if non-streaming). Implement `reconstructRaw`:

```typescript
reconstructRaw: (accumulated) => {
  // Build what a non-streaming response would look like
  return {
    id: accumulated.chunks[0]?.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    model: accumulated.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: accumulated.text || null,
        tool_calls: accumulated.toolCalls.length > 0 ? [...] : undefined,
      },
      finish_reason: mapStopReason(accumulated.stopReason),
    }],
    usage: {
      prompt_tokens: accumulated.usage.inputTokens,
      completion_tokens: accumulated.usage.outputTokens,
      total_tokens: accumulated.usage.totalTokens,
    },
  };
}
```

### Message Event Timing

The final `message` event (containing the complete response) is yielded at **stream end**, not immediately after `message_end`. This ensures:

- All content is accumulated (text, tools, reasoning)
- All usage data is captured (may arrive in separate chunks)
- `reconstructRaw` has all chunks available

### Adapter Files

| Adapter | Location                                  | Notes                          |
| ------- | ----------------------------------------- | ------------------------------ |
| OpenAI  | `packages/adapters/openai/src/openai.ts`  | Native OpenAI SDK              |
| Google  | `packages/adapters/google/src/google.ts`  | Google Generative AI           |
| AI SDK  | `packages/adapters/ai-sdk/src/adapter.ts` | Vercel AI SDK (multi-provider) |

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
