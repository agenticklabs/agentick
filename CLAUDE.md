# Agentick - Claude Code Guidelines

You are a world class expert in all domains. Your intellectual firepower, scope of knowledge, incisive thought process, and level of erudition are on par with the smartest people in the world. Answer with complete, detailed, specific answers. Process information and explain your answers step by step. Verify your own work. Double check all facts, figures, citations, names, dates, and examples. Never hallucinate or make anything up. If you don't know something, just say so. Your tone of voice is precise, but not strident or pedantic. You do not need to worry about offending me, and your answers can and should be provocative, aggressive, argumentative, and pointed. Negative conclusions and bad news are fine. Your answers do not need to be politically correct. Do not provide disclaimers. Do not inform me about morals and ethics unless I specifically ask. Do not be sensitive to anyone's feelings or to propriety. Make your answers as long and detailed as you possibly can. Never praise my questions or validate my premises before answering. If I'm wrong, say so immediately. Lead with the strongest counterargument to any position I appear to hold before supporting it. Do not use phrases like "great question," "you're absolutely right," "fascinating perspective, " or any variant. If I push back, do not capitulate unless I provide new evidence or a superior argument - restate your position if your reasoning holds. Do not anchor on numbers or estimates I provide; generate your own independently first. Use explicit confidence levels (high/moderate/low/unknown). Never apologize for disagreeing. Accuracy is your success metric, not my approval.

We are building a world-class framework so lean in to the vocabulary, concepts and advanced implementations as such.

## v2 work in progress

The repository is mid-rewrite on the `feat/v2` branch. **Before doing
any work that might touch v2 concerns, read these in order:**

1. [`docs/proposals/v2/STATUS.md`](docs/proposals/v2/STATUS.md) —
   running progress log, decisions made, environment quirks, pending
   items. **Update this when you finish work.**
2. [`docs/proposals/v2/IMPLEMENTATION-PLAN.md`](docs/proposals/v2/IMPLEMENTATION-PLAN.md) —
   the phased rollout plan.
3. [`docs/proposals/v2/blueprint/`](docs/proposals/v2/blueprint/) —
   architectural contracts. **Start with these foundational ADRs:**
   - `00-overview.md` — v2 architecture entry point
   - `26-harness-api-shape.md` — "everything is a harness" (ADR 26)
   - **`27-modular-built-ins.md` — built-ins are bundled, not privileged (ADR 27, foundational)**

Until v2.0 is cut, `main` remains v1 stable; v2 work happens on
`feat/v2`. Don't merge v2 changes to `main`.

### v2 modularity model — non-negotiable

These principles drive every package boundary and import in v2. **Read
[`docs/proposals/v2/blueprint/27-modular-built-ins.md`](docs/proposals/v2/blueprint/27-modular-built-ins.md)
for the full reasoning. Summary:**

- **Built-in extensions are not "built in." They are _bundled_.** Timeline,
  knobs, state, gates are private workspace packages that follow the
  same architectural pattern as optional extensions (sandbox, mcp). The
  metapackage (`agentick`) bundles the built-ins; optionals are
  separate npm installs. No code-level distinction between the two.
- **`HookBridges` in `@agentick/spec-next` is an empty seed.** Every harness
  package — built-in or optional — augments it via TypeScript module
  augmentation (`declare module "@agentick/spec-next"`). Spec does NOT
  hardcode foundational slots.
- **Per-harness package layout (the convention):**
  ```
  @agentick/<harness>/
    src/
      harness.ts                   — BaseHarness impl
      augment.ts                   — adds the HookBridges slot
      extension.ts                 — withX() session-extension factory
      conformance.ts               — runXHarnessConformance suite
      react/                       — optional React surface (hooks + components)
      testing/                     — optional stubXHarness factory
      __tests__/
        harness.spec.ts                       — harness-only tests
        integration-with-compiler.spec.tsx    — uses real CompilerHarness
  ```
- **`@agentick/compiler-react-next` has NO dependency on any harness
  package.** It owns the JSX → IR pipeline and the bridge context
  (`BridgeProvider` / `useBridges`); the reference `InMemoryDataBridge`
  lives in `@agentick/compiler-next`. Snapshot/restore iterates `HookBridges`
  generically via `SnapshotCapable` feature detection — no hardcoded
  slot names. Any harness can add a `/react` subpath that depends on
  compiler-react WITHOUT creating a cycle.
- **Tests live where their dependencies live.** A "knobs work with the
  compiler" test belongs in `@agentick/knobs-next/__tests__/`, not in
  compiler-react. Compiler-react's tests test the compiler
  ITSELF, using protocol mocks where bridges are needed. Cross-harness
  integration tests live in `@agentick/session-next` (which depends on all
  the harnesses it integrates) or in the public metapackage.
- **Shipping ≠ architecture.** Built-ins ship as private workspace
  packages bundled into the `agentick` metapackage. Optional extensions
  ship as public packages installed separately. The pattern at the
  code level is identical between them.

**If you find yourself wanting to special-case foundational harnesses
vs optional extensions, stop. The pattern is intentionally uniform.**
The asymmetry between them is purely a packaging concern.

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

| Primitive                | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `<Timeline>`             | Conversation history (IS the conversation — filter/compact/render)   |
| `<Tool>`                 | Function the model can call                                          |
| `<Section>`              | Content rendered to model context                                    |
| `<Message>`              | Message added to timeline                                            |
| Signals/hooks            | Reactive state management                                            |
| Channels                 | Real-time sync between session and UI                                |
| `knob()`                 | Config-level knob descriptor (detected by `isKnob()`)                |
| `useKnob()`              | Model-visible, model-settable reactive state                         |
| `<Knobs />`              | Knob section + set_knob tool (default, render prop, or provider)     |
| `useTimeline()`          | Direct read/write access to session timeline                         |
| `useResolved()`          | Access resolve data on session restore (Layer 2)                     |
| `use()` on tools         | Bridge render-time context (React Context, hooks) into tool handlers |
| `<MCP>`                  | Connect to MCP servers (tools + progressive resource discovery)      |
| `<Sandbox>`              | Sandboxed execution (provider-backed, tree-scoped tools)             |
| ExecutionRunner          | Controls how compiled context reaches model and how tools execute    |
| `audience: "user"` tools | Visibility flag: tool hidden from model, only reachable via dispatch |
| `dispatch()`             | Invoke any tool by name/alias without model involvement (Procedure)  |

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

### Dependency Injection into Tool Handlers (ADR 66)

Tool handlers run at **dispatch** time, separate from render. Two ways to reach what they need:

**`ctx` — dispatch-resolved (the default).** Session/app-scoped harnesses are typed slots on the handler `ctx`, resolved fresh at dispatch from the live bridge: `ctx.elicit`, `ctx.tasks`, `ctx.resource`, `ctx.log`, `ctx.progress`, `ctx.sandbox`. Optional slots (sandbox, etc.) are contributed by their packages via module augmentation of `ToolHandlerCtxExtensions` — guard with `?`:

```typescript
const ShellTool = createTool({
  name: "shell",
  description: "Execute a command in the sandbox",
  input: z.object({ command: z.string() }),
  handler: async ({ command }, { ctx }) => {
    const sandbox = ctx.sandbox?.get("primary"); // dispatch-resolved from the live bridge
    if (!sandbox) return [{ type: "text", text: "no sandbox mounted" }];
    const result = await sandbox.exec(command);
    return [{ type: "text", text: result.stdout }];
  },
});
```

**`use()` — render-captured (the escape hatch).** For genuinely *tree-positional* context — a value set by an ancestor provider, reachable only during render (a custom React Context). `use()` runs at render, captures from the component tree, and passes the result to the handler as `deps` (merged with `{ ctx }`). Reserve it for tree-positional context; session/app harnesses belong on `ctx`. Direct `.run()` calls get `undefined` deps.

The workspace has two package trees: **`packages/`** is the v1 published line (stable, maintenance); **`packages-next/`** is the v2 rewrite on `feat/v2` (active). Most work targets v2.

### v2 — `packages-next/` (the `-next` packages)

```
Foundation:  spec-next · runtime-next · pubsub-next · utils-next
Compiler:    compiler-next (base) → compiler-react-next (JSX → IR harness)
Harnesses:   timeline · knobs · state · gates · tool · resources · elicitation ·
             tasks · prompts · skills · subscriptions · live · credentials
Executors:   tool-executor · model-executor · loop-executor
Model:       model · model-ai-sdk · model-anthropic · model-openai · model-google
Session/App: session-next · app-next
Client:      client-core → client · client-react · client-extensions
Wire:        transport(-http/-in-process/-unix-socket/-websocket) · gateway · cluster*
Optional:    sandbox* · mcp · connector · eval · formatters · store · telemetry-otlp
```

Every harness — built-in or optional — follows the per-harness layout in the v2 modularity model above. The `-next` naming law: `<role>-next` for a base, `<role>-<discriminator>-next` for a concrete impl.

### v1 — `packages/` (stable)

```
Applications (example/express, user apps)
    ↓
Framework: @agentick/core · gateway · client · express · devtools · sandbox
    ↓
Adapters: @agentick/openai · google · ai-sdk
    ↓
Foundation: @agentick/kernel (Node.js) · @agentick/shared (universal)
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
  transformCompiled(compiled, tools) { ... },   // Transform before model call
  executeToolCall(call, tool, next) { ... },    // Wrap tool execution
  onSessionInit(session) { ... },               // Once per session lifecycle
  onPersist(session, snapshot) { ... },         // Augment snapshot
  onRestore(session, snapshot) { ... },         // Restore runner state
  onDestroy(session) { ... },                   // Clean up resources
};

const app = createApp(MyAgent, { model, runner });
```

All methods are optional. The `transformCompiled` hook runs per-tick, `executeToolCall` runs per tool call, and lifecycle hooks run at session boundaries. Lifecycle hooks receive `SessionRef` (narrow: `id`, `status`, `currentTick`, `snapshot()`) — not the full `Session`.

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

### Check `@agentick/shared` Before Writing Utilities

Before writing ANY utility function, **always check `@agentick/shared` first**.
It is the canonical home for cross-framework utilities: `extractText`,
`isTextBlock`, block type guards, content helpers, wire types, etc.

- **Before creating**: grep `packages/shared/src/` for the function name
- **Shared code belongs there**: if a utility will be used across multiple
  packages (connector, client, core, adapters), put it in shared
- **Re-exports are fine**: packages can re-export from shared for convenience,
  but the implementation must live in shared — not be duplicated

## Common Patterns

> **v1-era.** This section describes v1 `packages/` APIs (gateway `method()`, kernel `createProcedure`, ALS `Context`). For v2, the equivalent is the harness model — see `docs/proposals/v2/blueprint/26-harness-api-shape.md` and the substrate/Operation primitives in `packages-next/runtime`.

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

**Session Procedures** — `session.send`, `session.render`, `session.queue`, `session.dispatch`, and `app.run` are all Procedures:

```typescript
const handle = await session.send({ messages: [...] });       // ProcedurePromise → SessionExecutionHandle
const result = await session.send({ messages: [...] }).result; // ProcedurePromise.result → SendResult
const handle = await session.render({ query: "Hello" });       // ProcedurePromise → SessionExecutionHandle
```

All use passthrough mode (`handleFactory: false`) — the handler's return value flows through directly. `ProcedurePromise.result` chains to `SessionExecutionHandle.result`, giving `SendResult`.

`dispatch` invokes any registered tool by name without the model — works on both regular and `audience: "user"` tools. It auto-mounts, validates input against the tool's Zod schema, resolves by name then alias, and returns `ContentBlock[]`:

```typescript
const result = await session.dispatch("add-dir", { path: "/tmp" });
```

### Using ALS Context

```typescript
import { Context } from "@agentick/kernel";

const ctx = Context.get();
const userId = ctx.user?.id;
Context.emit("custom:event", { data: "value" });
```

## File Locations

### v2 — `packages-next/`

| What                     | Where                               |
| ------------------------ | ----------------------------------- |
| Protocol seam (spec)     | `packages-next/spec/src/`           |
| Foundation (bus/journal) | `packages-next/runtime/src/`        |
| JSX compiler harness     | `packages-next/compiler-react/src/` |
| Compiler base + collect  | `packages-next/compiler/src/`       |
| Built-in harnesses       | `packages-next/<harness>/src/`      |
| Session / App            | `packages-next/session/src/`, `packages-next/app/src/` |
| Gateway / transports     | `packages-next/gateway/src/`, `packages-next/transport*/src/` |
| Client                   | `packages-next/client*/src/`        |
| Tests                    | `packages-next/*/src/**/*.spec.ts`  |
| Canonical example        | `example/v2-real/`                  |

### v1 — `packages/` (stable)

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

> **v1-era.** `createAdapter()` is the v1 adapter API. In v2, model access is a harness: the `@agentick/model-executor-next` base with concrete `@agentick/model-*-next` packages, plus the Vercel AI SDK path via `@agentick/model-ai-sdk-next`.

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
