# Agentick - Claude Code Guidelines

## Philosophy

**No backwards compatibility, no deprecations, no legacy code paths.**

We are in a special window of opportunity to get the API right before users depend on it. Take advantage of this by making breaking changes freely when they improve the design.

When refactoring:

- Remove old code entirely rather than deprecating
- Don't add compatibility shims or migration helpers
- Don't keep unused exports "for backwards compat"
- One way to do things, done well

**Architecture over expediency.** Every architectural decision compounds. Take 20 minutes to think through the right abstraction boundary, the right package home, the right interface shape. A wrong architectural decision early means the project fails later. When in doubt, think about who else will need this, where the interface should live, and whether the dependency graph stays clean.

### Documentation

**Document features with README files at all levels of the codebase.**

- `packages/*/README.md` - Package overview and API
- `packages/*/src/*/README.md` - Submodule documentation
- Any directory with non-obvious patterns

README content: Purpose, Usage examples, API reference, Patterns.

### Primitives vs Patterns

The framework provides **building blocks**, not opinions.

| Primitive            | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `<Timeline>`         | Conversation history (IS the conversation — filter/compact/render)   |
| `<Tool>`             | Function the model can call                                          |
| `<Section>`          | Content rendered to model context                                    |
| `<Message>`          | Message added to timeline                                            |
| Signals/hooks        | Reactive state management                                            |
| Channels             | Real-time sync between session and UI                                |
| `knob()`             | Config-level knob descriptor (detected by `isKnob()`)                |
| `useKnob()`          | Model-visible, model-settable reactive state                         |
| `<Knobs />`          | Knob section + set_knob tool (default, render prop, or provider)     |
| `useTimeline()`      | Direct read/write access to session timeline                         |
| `useResolved()`      | Access resolve data on session restore (Layer 2)                     |
| `use()` on tools     | Bridge render-time context (React Context, hooks) into tool handlers |
| `<Sandbox>`          | Sandboxed execution (provider-backed, tree-scoped tools)             |
| ExecutionRunner      | Controls how compiled context reaches model and how tools execute    |

#### Semantic Components (`packages/core/src/jsx/components/semantic.tsx`)

Use these instead of raw markdown strings in JSX. They compile to renderer-appropriate output.

| Component                           | Purpose                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `<H1>`–`<H3>`, `<Header level={n}>` | Headings                                                       |
| `<Paragraph>`                       | Paragraph block                                                |
| `<List>`                            | List container (`ordered`, `task` props)                       |
| `<ListItem>`                        | List item (`checked` prop for task lists)                      |
| `<Table>`                           | Table (`headers`/`rows` props, or `<Row>`/`<Column>` children) |
| `<Row>`, `<Column>`                 | Table row and column                                           |

#### Content Block Components (`packages/core/src/jsx/components/content.tsx`)

Typed content blocks for composing rich message content:

| Component            | Purpose                              |
| -------------------- | ------------------------------------ |
| `<Text>`             | Text block (children or `text` prop) |
| `<Image>`            | Image (`source: MediaSource`)        |
| `<Code>`             | Code block (`language` prop)         |
| `<Json>`             | JSON data block (`data` prop)        |
| `<Document>`         | Document attachment                  |
| `<Audio>`, `<Video>` | Media blocks                         |

#### Message Role Components (`packages/core/src/jsx/components/messages.tsx`)

| Component     | Purpose                                |
| ------------- | -------------------------------------- |
| `<System>`    | System prompt message                  |
| `<User>`      | User message                           |
| `<Assistant>` | Assistant message                      |
| `<Event>`     | Persisted event entry                  |
| `<Ephemeral>` | Non-persisted context (current state)  |
| `<Grounding>` | Semantic wrapper for grounding context |

#### Model Components

| Component       | Import from        | Purpose                                     |
| --------------- | ------------------ | ------------------------------------------- |
| `<Model>`       | `agentick`         | Generic model config (takes `EngineModel`)  |
| `<OpenAIModel>` | `@agentick/openai` | OpenAI JSX component (takes `model` string) |
| `<GoogleModel>` | `@agentick/google` | Google JSX component (takes `model` string) |

**See `packages/core/src/jsx/ARCHITECTURE.md` for the complete JSX reference.**

Patterns (todos, artifacts, memory) are **state parallel to the timeline** - built by users from primitives.

### Stateful Tool Pattern

Recommended for managed collections (see `example/express/src/tools/todo-list.tool.tsx`):

```typescript
export const MyStatefulTool = createTool({
  name: "my_tool",
  description: "...",
  input: schema,
  handler: async (input, ctx) => {
    const result = MyService.doAction(input);
    ctx?.setState("lastResult", result);
    return [{ type: "text", text: "Done" }];
  },
  render: () => (
    <Section id="my-state" audience="model">
      <H2>Current State</H2>
      <Json data={MyService.getState()} />
    </Section>
  ),
});
```

### Context Injection Pattern

When tools need tree-scoped context (providers, React Context), use `use()`:

```typescript
const ShellTool = createTool({
  name: "shell",
  description: "Execute a command in the sandbox",
  input: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }), // render-time hook
  handler: async ({ command }, deps) => {
    const result = await deps!.sandbox.exec(command);
    return [{ type: "text", text: result.stdout }];
  },
});
```

`use()` runs at render time, captures values from the component tree, and passes them to the handler as `deps` (merged with `{ ctx }`). Direct `.run()` calls get `undefined` deps.

## Package Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Applications                               │
│        (example/express, user apps, CLI tools)                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                          Framework Layer                                │
│   @agentick/core     @agentick/gateway     @agentick/client          │
│   @agentick/express  @agentick/devtools    @agentick/sandbox         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                         Adapter Layer                                   │
│   @agentick/openai   @agentick/google   @agentick/ai-sdk             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                        Foundation Layer                                 │
│              @agentick/kernel          @agentick/shared               │
│              (Node.js only)             (Platform-independent)          │
└─────────────────────────────────────────────────────────────────────────┘
```

See individual package READMEs for detailed documentation.

## Core Concepts

### Session & Execution Model

**Session**: Long-lived conversation context with state persistence.
**Execution**: Single run (one user message → model response cycle).
**Tick**: One model API call. Multi-tick executions happen with tool use.

```
Session
├── Execution 1 (user: "Hello")
│   └── Tick 1 → model response
├── Execution 2 (user: "Use calculator")
│   ├── Tick 1 → tool_use (calculator)
│   └── Tick 2 → final response
└── Execution 3 ...
```

### Execution Runner

An `ExecutionRunner` controls how compiled context is consumed and how tool calls execute. It's an optional `AppOptions` field — when omitted, the default behavior applies (model calls tools via tool_use protocol).

```typescript
const runner: ExecutionRunner = {
  name: "repl",
  prepareModelInput(compiled, tools) { ... },  // Transform before model call
  executeToolCall(call, tool, next) { ... },    // Wrap tool execution
  onSessionInit(session) { ... },               // Once per session lifecycle
  onPersist(session, snapshot) { ... },         // Augment snapshot
  onRestore(session, snapshot) { ... },         // Restore runner state
  onDestroy(session) { ... },                   // Clean up resources
};

const app = createApp(MyAgent, { model, runner });
```

All methods are optional. The `prepareModelInput` hook runs per-tick, `executeToolCall` runs per tool call, and lifecycle hooks run at session boundaries. Lifecycle hooks receive `SessionRef` (narrow: `id`, `status`, `currentTick`, `snapshot()`) — not the full `Session`.

Runners are inherited by spawned children. Use `SpawnOptions` (3rd arg to `session.spawn()`) to override:

```typescript
await session.spawn(Agent, { messages }, { runner: replRunner, model: cheapModel });
```

### React-like Reconciler

Agentick uses a React-inspired reconciler:

- **Fiber Tree**: Virtual DOM-like component hierarchy
- **Reconciler**: Component lifecycle, diffs, scheduling
- **Compiler**: Transforms fiber tree → model-ready format

```
User JSX → Fiber Tree → CompiledStructure → Provider Input
```

## Development Practices

### Commands

```bash
pnpm test                                   # Run all tests
pnpm build                                  # Build all packages
pnpm typecheck                              # Check all types
pnpm --filter @agentick/core test          # Run specific package
```

### Code Style

- **One code path**: No feature flags, no backwards compat shims
- **Clean imports**: Import from package index, not deep paths
- **Type inference**: Let TypeScript infer when obvious
- **No dead code**: Remove unused exports, functions, types
- **Errors over nulls**: Throw typed errors, don't return null for failures
- **Single source of truth for types**: Never define the same interface in multiple files

### New Package Checklist

When adding a new `@agentick/*` package, update all of these:

1. **Package setup**: `packages/my-package/` with `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`
2. **Changeset linked list**: Add to `.changeset/config.json` → `linked[0]` array
3. **TypeDoc entry points**: Add to `website/typedoc.json` → `entryPoints` array
4. **Website package groups**: Add to `website/.vitepress/config.mts` → `PACKAGE_GROUPS` in the appropriate group
5. **README**: Create `packages/my-package/README.md` following the style of existing package READMEs (Purpose, Quick Start, API, Patterns)
6. **pnpm install**: Run `pnpm install` to register the workspace package

### Cross-Package Changes

When implementing a feature in one package, **don't treat code in other packages as static.** If modifying an underlying system (kernel, shared, core) would lead to a cleaner, more elegant solution — propose the change. Always confirm with the user before modifying interfaces or behavior in packages outside the one you're working in.

### Before Making Type Changes

1. Run `pnpm build` or `pnpm typecheck` first (not just tests)
2. Search for duplicate definitions: `grep -r "export.*interface MyType" packages/`
3. Choose one canonical source; have others re-export

## Common Patterns

### Adding a Gateway Method

```typescript
methods: {
  namespace: {
    methodName: method({
      schema: z.object({ /* params */ }),
      handler: async (params) => {
        const ctx = Context.get();
        return { result: "value" };
      },
    }),
  },
}
```

### Procedures & Middleware

A **Procedure** wraps any async function, generator, or async iterable with middleware, execution tracking, and streaming. Procedures are the core execution primitive — every model call, tool run, and engine operation is a Procedure.

```typescript
import { createProcedure } from "@agentick/kernel";

// Async function
const greet = createProcedure(async (name: string) => `Hello, ${name}!`);

// Async generator — streaming with automatic context preservation
const stream = createProcedure(
  { name: "tokens", handleFactory: false },
  async function* (prompt: string) {
    for (const token of ["Hello", " ", "World"]) {
      yield token;
    }
  },
);
```

**Calling a Procedure** returns a `ProcedurePromise<ExecutionHandle<T>>`:

```typescript
const handle = await greet("World"); // ExecutionHandle (status, abort, streaming)
const result = await greet("World").result; // "Hello, World!" (auto-unwraps .result)
```

The `.result` auto-unwrap is key: `await proc()` gives the handle, `await proc().result` gives the final value. This is how `await run(<Agent />, opts)` returns `SendResult` directly.

**Streaming with generators** — procedures that return async iterables get automatic context propagation, `stream:chunk` events, and cleanup:

```typescript
const iter = await stream("test");
for await (const token of iter) {
  process.stdout.write(token); // "Hello World"
}
```

**Stream utilities** — compose stream transformations on procedure output:

```typescript
import { mapStream, tapStream, mergeStreams } from "@agentick/kernel";

const doubled = mapStream(iter, (token) => token.repeat(2));
const logged = tapStream(iter, (token) => console.log(token));
const merged = mergeStreams([stream1, stream2]); // race, yield as they arrive
```

**Chainable API** — all return a new Procedure (immutable):

```typescript
proc.use(middleware); // Add middleware
proc.withContext({ user }); // Merge ALS context
proc.withTimeout(5000); // Abort after 5s
proc.withMetadata({ model }); // Add telemetry metadata
proc.pipe(nextProc); // Chain output → input
```

**Middleware** intercepts execution — transform args, modify results, or short-circuit:

```typescript
const timing: Middleware = async (args, envelope, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`${envelope.operationName}: ${Date.now() - start}ms`);
  return result;
};
```

**Layering** — kernel provides bare procedures, core adds engine middleware:

| Factory                 | Package                     | Behavior                                                 |
| ----------------------- | --------------------------- | -------------------------------------------------------- |
| `createProcedure`       | `@agentick/kernel`          | Bare procedure, no default middleware                    |
| `createEngineProcedure` | `@agentick/core` (internal) | `wrapProcedure([errorMiddleware])` — adds error handling |

`createEngineProcedure` is not exported from core's public API. It's used internally by adapters, tools, and MCP tools. Users register middleware via `Agentick.use()`, which is resolved at runtime from ALS context.

**Session Procedures** — `session.send`, `session.render`, `session.queue`, and `app.run` are all Procedures:

```typescript
const handle = await session.send({ messages: [...] });       // ProcedurePromise → SessionExecutionHandle
const result = await session.send({ messages: [...] }).result; // ProcedurePromise.result → SendResult
const handle = await session.render({ query: "Hello" });       // ProcedurePromise → SessionExecutionHandle
```

All four use passthrough mode (`handleFactory: false`) — the handler's return value flows through directly. `ProcedurePromise.result` chains to `SessionExecutionHandle.result`, giving `SendResult`.

### Using ALS Context

```typescript
import { Context } from "@agentick/kernel";

const ctx = Context.get();
const userId = ctx.user?.id;
Context.emit("custom:event", { data: "value" });
```

## File Locations

| What              | Where                           |
| ----------------- | ------------------------------- |
| Kernel primitives | `packages/kernel/src/`          |
| Shared types      | `packages/shared/src/`          |
| Core reconciler   | `packages/core/src/reconciler/` |
| Built-in JSX      | `packages/core/src/jsx/`        |
| Hooks             | `packages/core/src/hooks/`      |
| Gateway           | `packages/gateway/src/`         |
| Client            | `packages/client/src/`          |
| Sandbox           | `packages/sandbox/src/`         |
| Express example   | `example/express/src/`          |
| Tests             | `packages/*/src/**/*.spec.ts`   |

## Model Adapters

See `packages/adapters/README.md` for comprehensive adapter documentation.

Key points:

- Use `createAdapter()` which returns a `ModelClass` (callable + JSX component)
- Implement `prepareInput`, `mapChunk`, `execute`, `executeStream`
- Handle provider-specific streaming quirks (OpenAI sends usage separately)
- `mapChunk` returns `AdapterDelta` or `null` to ignore chunks

## Common Debugging

### Component shows as `<Unknown>` in DevTools

Add `displayName` to function components.

### System tokens showing as 0

Check that `<System>` or `<section>` components are in the tree.

### Fiber tree not updating

Snapshots taken at tick end. Check `tick_end` events are being emitted.

### DevTools not receiving events

1. Verify `devTools: true` in app config
2. Check SSE connection in Network tab
3. Look for `[DevTools]` log messages

### CSS: Flex children overflowing viewport

```css
.container {
  height: 100vh; /* Fixed height, not min-height */
  overflow: hidden;
}
.child {
  flex: 1;
  min-height: 0; /* Critical! Allows shrinking */
  overflow: auto;
}
```
