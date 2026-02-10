# @agentick/core

Core engine for Agentick. Provides the React-like reconciler, JSX components, and hooks for building LLM applications.

## Installation

```bash
pnpm add @agentick/core
```

## Quick Start

```tsx
import { createApp, System, Timeline, Message, createTool } from "@agentick/core";
import { createOpenAIModel } from "@agentick/openai";
import { z } from "zod";

// Create a tool
const Calculator = createTool({
  name: "calculator",
  description: "Performs math calculations",
  input: z.object({ expression: z.string() }),
  handler: async ({ expression }) => {
    const result = eval(expression);
    return [{ type: "text", text: String(result) }];
  },
});

// Define your app
function MyApp() {
  return (
    <>
      <System>You are a helpful assistant with access to a calculator.</System>
      <Timeline />
      <Calculator />
    </>
  );
}

// Create and run
const app = createApp(MyApp, { model: createOpenAIModel() });
const session = await app.session();
await session.send({
  messages: [{ role: "user", content: [{ type: "text", text: "What is 2 + 2?" }] }],
}).result;
```

## Level 0: `createAgent` (No JSX Required)

For simple agents that don't need custom rendering or hooks:

```tsx
import { createAgent, knob } from "@agentick/core";
import { createOpenAIModel } from "@agentick/openai";

const agent = createAgent({
  system: "You are a helpful researcher.",
  model: createOpenAIModel(),
  tools: [SearchTool, Calculator],
  knobs: {
    mode: knob("broad", { description: "Search mode", options: ["broad", "deep"] }),
  },
});

const handle = await agent.run({
  messages: [{ role: "user", content: [{ type: "text", text: "Research quantum computing" }] }],
});
for await (const chunk of handle) {
  console.log(chunk);
}
const result = await handle.result;

// or create an agent session

const session = await agent.session();
await session.send({
  messages: [{ role: "user", content: [{ type: "text", text: "Research quantum computing" }] }],
}).result;
```

`createAgent` wraps the `<Agent>` component and `createApp` — same capabilities, no JSX. For conditional tools, custom hooks, or composition, use `<Agent>` directly (Level 1+):

```tsx
import { Agent, createApp } from "@agentick/core";

function MyAgent() {
  const [verbose] = useKnob("verbose", false, { description: "Verbose mode" });
  return <Agent system="You are helpful." tools={[SearchTool]} />;
}

const app = createApp(MyAgent);
```

## JSX Components

### `<System>`

Define system instructions:

```tsx
<System>You are a helpful assistant.</System>
```

### `<Timeline>`

Render conversation history. This is the core component that represents the conversation:

```tsx
// Basic — renders all history + pending messages
<Timeline />

// With filtering
<Timeline roles={['user', 'assistant']} limit={10} />

// With token budget compaction
<Timeline maxTokens={4000} strategy="sliding-window" headroom={500} />

// With render prop (receives history, pending, budget info)
<Timeline maxTokens={8000}>
  {(entries, pending, budget) => {
    if (budget?.isCompacted) console.log(`Evicted ${budget.evictedCount} entries`);
    return entries.map(entry => <Message key={entry.id} entry={entry} />);
  }}
</Timeline>

// With custom rendering via Provider
<Timeline.Provider>
  <Timeline.Messages renderEntry={(entry) => <CustomMessage entry={entry} />} />
</Timeline.Provider>
```

#### Token Budget Compaction

When `maxTokens` is set, Timeline automatically compacts entries that exceed the token budget. Entries carry token estimates from the compiler's annotation pass (or fall back to a char/4 heuristic).

| Prop            | Type                 | Default            | Description                                |
| --------------- | -------------------- | ------------------ | ------------------------------------------ |
| `maxTokens`     | `number`             | —                  | Token budget. Enables compaction when set. |
| `strategy`      | `CompactionStrategy` | `"sliding-window"` | Compaction strategy                        |
| `headroom`      | `number`             | `0`                | Reserve tokens for safety margin           |
| `preserveRoles` | `string[]`           | `["system"]`       | Roles that are never evicted               |
| `onEvict`       | `(entries) => void`  | —                  | Callback when entries are evicted          |
| `guidance`      | `string`             | —                  | Passed to custom strategy functions        |

**Built-in strategies:**

- **`"sliding-window"`** (default): Preserves entries with protected roles, then fills remaining budget with newest entries. Maintains original entry order.
- **`"truncate"`**: Keeps newest entries that fit. Simple FIFO eviction.
- **`"none"`**: No compaction. Entries pass through unchanged.
- **Custom function**: `(entries, budget, guidance?) => { kept, evicted }`

**Budget info** is available via render prop (3rd argument) or `useTimelineContext().budget`:

```typescript
interface TokenBudgetInfo {
  maxTokens: number; // configured budget
  effectiveBudget: number; // maxTokens - headroom
  currentTokens: number; // tokens in kept entries
  evictedCount: number; // entries dropped
  isCompacted: boolean; // whether compaction fired
}
```

### `<Message>`

Add messages to the conversation:

```tsx
<Message role="user">Hello!</Message>
<Message role="assistant">Hi there!</Message>

// With content blocks
<Message role="user">
  <Text>Check this image:</Text>
  <Image source={{ type: "url", url: "https://..." }} />
</Message>
```

### `<Section>`

Group content with semantic meaning:

```tsx
<Section id="context" title="Current Context">
  Today is {new Date().toDateString()}. User is logged in as {user.name}.
</Section>
```

### `<Model>`

Override the model for a subtree. Also accepts generation parameters and response format:

```tsx
<Model model={gpt4oMini}>
  {/* Children use gpt-4o-mini */}
</Model>

// With response format (structured output)
<Model model={gpt4o} responseFormat={{ type: "json" }} />

<Model
  model={gpt4o}
  responseFormat={{
    type: "json_schema",
    schema: { type: "object", properties: { name: { type: "string" } } },
    name: "person",
  }}
  temperature={0.2}
/>
```

#### ResponseFormat

Normalized across providers. Three modes:

| Type                                     | Description                      |
| ---------------------------------------- | -------------------------------- |
| `{ type: "text" }`                       | Free-form text (default)         |
| `{ type: "json" }`                       | Valid JSON output                |
| `{ type: "json_schema", schema, name? }` | JSON conforming to a JSON Schema |

For Zod schemas, call `zodToJsonSchema()` yourself — Agentick doesn't bundle Zod.

### `<Markdown>` / `<XML>`

Control output formatting:

```tsx
<Markdown>
  <Section id="rules">
    - Rule 1
    - Rule 2
  </Section>
</Markdown>

<XML>
  <Section id="data" title="User Data">
    {JSON.stringify(userData)}
  </Section>
</XML>
```

## Hooks

### State Hooks

```tsx
import { useState, useSignal, useComputed, useComState } from "@agentick/core";

function MyComponent() {
  // React-style state
  const [count, setCount] = useState(0);

  // Signal-based reactive state — Signal<T> is a callable + .set() + .value
  const counter = useSignal(0);
  const doubled = useComputed(() => counter() * 2, [counter]);

  counter(); // read: 0
  counter.set(5); // write
  counter.update((v) => v + 1); // update with function
  doubled(); // read: 12

  // COM state (persisted across ticks, shared between components)
  // Returns Signal<T>, NOT a tuple
  const notes = useComState<string[]>("notes", []);
  notes(); // read current value
  notes.set(["a", "b"]); // write new value
}
```

### Lifecycle Hooks

All lifecycle hooks follow the pattern: data first, COM (context) last.

```tsx
import {
  useOnMount,
  useOnUnmount,
  useOnTickStart,
  useOnTickEnd,
  useAfterCompile,
  useContinuation,
} from "@agentick/core";

function MyComponent() {
  // Called when component mounts
  useOnMount((ctx) => {
    console.log("Component mounted");
  });

  // Called when component unmounts
  useOnUnmount((ctx) => {
    console.log("Component unmounting");
  });

  // Called at the start of each tick (tick 2+ — see useOnMount for first tick)
  useOnTickStart((tickState) => {
    console.log(`Tick ${tickState.tick} starting...`);
  });

  // Called at the end of each tick (after model response)
  useOnTickEnd((result) => {
    console.log(`Tick ${result.tick} complete, tokens: ${result.usage?.totalTokens}`);
  });

  // Called after JSX compiles but before model call
  useAfterCompile((compiled) => {
    console.log(`Compiled ${compiled.tools.length} tools`);
  });

  // Control agent loop continuation (primary hook for agent behavior)
  useContinuation((result) => {
    // Return true to continue, false to stop
    if (result.text?.includes("<DONE>")) return false;
    if (result.tick >= 10) return false; // Safety limit
    return true;
  });

  // Access COM when needed (always the last parameter)
  useContinuation((result, ctx) => {
    ctx.setState("lastTick", result.tick);
    return !result.text?.includes("<DONE>");
  });
}
```

### Message Hooks

```tsx
import { useQueuedMessages, useOnMessage } from "@agentick/core";

function MyComponent() {
  // Access messages queued for this tick
  const queuedMessages = useQueuedMessages();

  // React to incoming messages
  useOnMessage((message, ctx, state) => {
    console.log("Received:", message);
  });
}
```

### Context Hooks

```tsx
import { useCom, useTickState, useContextInfo } from "@agentick/core";

function MyComponent() {
  // Access the Context Object Model
  const ctx = useCom();
  const history = ctx.timeline;

  // Access current tick state
  const tickState = useTickState();
  console.log(`Tick ${tickState.tick}`);

  // Access context utilization info (updated after each tick)
  const contextInfo = useContextInfo();
  if (contextInfo) {
    console.log(`Model: ${contextInfo.modelId}`);
    console.log(`Tokens: ${contextInfo.inputTokens} in / ${contextInfo.outputTokens} out`);
    console.log(`Utilization: ${contextInfo.utilization?.toFixed(1)}%`);
  }
}
```

### Knobs

Knobs are **form controls for models**. The same way HTML inputs bridge humans to application state, knobs bridge models to application state. The model sees primitive values (string, number, boolean), can change them via a `set_knob` tool, and the change takes effect on the next recompile.

`useKnob()` creates reactive state + renders it to model context + registers a tool — all in one line.

```tsx
import { useKnob, Knobs } from "@agentick/core";

function Agent() {
  // String with options → model sees [select] type
  const [mode] = useKnob("mode", "broad", {
    description: "Operating mode",
    options: ["broad", "deep"],
  });

  // Number with constraints → model sees [range] type
  const [temp] = useKnob("temp", 0.7, {
    description: "Temperature",
    group: "Model",
    min: 0,
    max: 2,
    step: 0.1,
  });

  // Boolean → model sees [toggle] type
  const [verbose] = useKnob("verbose", false, { description: "Verbose output" });

  // With resolver — model sets a primitive, you get a rich value
  const [model] = useKnob("model", "gpt-4", { description: "Model" }, (v) => openai(v));

  return (
    <>
      <Knobs />
      <Timeline />
    </>
  );
}
```

#### `<Knobs />` — Three Rendering Modes

The `set_knob` tool is always registered automatically. You control how knobs are rendered to the model's context:

```tsx
// 1. Default — renders a grouped knob section automatically
<Knobs />

// 2. Render prop — custom section formatting, receives KnobGroup[]
<Knobs>
  {(groups) => (
    <Section id="my-knobs" audience="model">
      {groups.flatMap(g => g.knobs).map(k => `${k.name}=${k.value}`).join("\n")}
    </Section>
  )}
</Knobs>

// 3. Provider — full custom rendering with React context
<Knobs.Provider>
  <Knobs.Controls />                          {/* Default section */}
  <Knobs.Controls renderKnob={(k) => ...} />  {/* Custom per-knob */}
  <Knobs.Controls renderGroup={(g) => ...} />  {/* Custom per-group */}
</Knobs.Provider>
```

The provider pattern also exposes `useKnobsContext()` for fully custom rendering:

```tsx
import { useKnobsContext } from "@agentick/core";

function MyKnobUI() {
  const { knobs, groups, get } = useKnobsContext();
  const temp = get("temp");
  return (
    <Section id="knobs" audience="model">
      Temperature is {temp?.value}. There are {knobs.length} knobs.
    </Section>
  );
}
```

#### Config-level Knobs

For `createAgent` / `<Agent>`, declare knobs as descriptors with `knob()`:

```tsx
import { knob, createAgent } from "@agentick/core";

const agent = createAgent({
  system: "You are a researcher.",
  knobs: {
    mode: knob("broad", { description: "Operating mode", options: ["broad", "deep"] }),
    temperature: knob(0.7, { description: "Temperature", min: 0, max: 2, step: 0.1 }),
  },
});
```

See `packages/core/src/hooks/README.md` for complete API reference including `KnobInfo`, `KnobGroup`, constraints, and validation.

## Context Utilization

The `useContextInfo` hook provides real-time information about model context usage:

```tsx
import { useContextInfo, type ContextInfo } from "@agentick/core";

function ContextAwareComponent() {
  const contextInfo = useContextInfo();

  if (!contextInfo) {
    return <Section id="status">Waiting for first response...</Section>;
  }

  // Access model info
  const { modelId, modelName, provider } = contextInfo;

  // Access token usage
  const { inputTokens, outputTokens, totalTokens } = contextInfo;

  // Access utilization percentage
  const { utilization, contextWindow } = contextInfo;

  // Access capabilities
  const { supportsVision, supportsToolUse, isReasoningModel } = contextInfo;

  // Access cumulative usage across ticks
  const { cumulativeUsage } = contextInfo;

  // Make decisions based on context usage
  if (utilization && utilization > 80) {
    return <System>Be concise - context is running low.</System>;
  }

  return null;
}
```

### ContextInfo Interface

```typescript
interface ContextInfo {
  // Model identification
  modelId: string; // "gpt-4o", "claude-3-5-sonnet", etc.
  modelName?: string; // Human-readable name
  provider?: string; // "openai", "anthropic", etc.

  // Context limits
  contextWindow?: number; // Total context window size
  maxOutputTokens?: number; // Max output tokens for model

  // Token usage (current tick)
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Utilization
  utilization?: number; // Percentage (0-100)

  // Model capabilities
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;

  // Execution info
  tick: number; // Current tick number

  // Cumulative usage across all ticks
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}
```

### Using ContextInfoProvider (Advanced)

For custom setups, you can create and provide your own context info store:

```tsx
import { createContextInfoStore, ContextInfoProvider } from "@agentick/core";

// Create a store
const contextInfoStore = createContextInfoStore();

// Provide to components
<ContextInfoProvider store={contextInfoStore}>
  <MyApp />
</ContextInfoProvider>;

// Update the store
contextInfoStore.update({
  modelId: "gpt-4o",
  inputTokens: 1500,
  outputTokens: 500,
  totalTokens: 2000,
  tick: 1,
});

// Read current value
const current = contextInfoStore.current;
```

## Tools

Create tools the model can call:

```tsx
import { createTool } from "@agentick/core";
import { z } from "zod";

const WeatherTool = createTool({
  name: "get_weather",
  description: "Get current weather for a location",
  input: z.object({
    location: z.string().describe("City name"),
    units: z.enum(["celsius", "fahrenheit"]).optional(),
  }),
  handler: async ({ location, units }, ctx) => {
    const weather = await fetchWeather(location, units);
    ctx?.setState("lastLocation", location);
    return [{ type: "text", text: JSON.stringify(weather) }];
  },
  // Optional: render state to model context (receives tickState, ctx)
  render: (tickState, ctx) => <Section id="weather-info">Last checked: {lastChecked}</Section>,
});

// Use in your app
function App() {
  return (
    <>
      <System>You can check the weather.</System>
      <Timeline />
      <WeatherTool />
    </>
  );
}
```

## App & Session

### Creating an App

```tsx
import { createApp } from "@agentick/core";

const app = createApp(MyApp, {
  model: myModel,
  devTools: true, // Enable DevTools
});
```

### Basic Options

```typescript
const app = createApp(MyApp, {
  model: createOpenAIModel(),  // Override model (optional if <Model> in JSX)
  maxTicks: 10,                // Max model calls per execution (default: 10)
  devTools: true,              // Enable DevTools emission
  tools: [ExternalTool],       // Additional tools (merged with JSX <Tool>s)
  mcpServers: { ... },         // MCP server configs
});
```

### Lifecycle Callbacks

Callbacks provide a cleaner alternative to event listeners:

```typescript
const app = createApp(MyApp, {
  model,

  // Execution lifecycle
  onTickStart: (tick, executionId) => console.log(`Tick ${tick}`),
  onTickEnd: (tick, usage) => console.log(`Used ${usage?.totalTokens} tokens`),
  onComplete: (result) => console.log(`Done: ${result.response}`),
  onError: (error) => console.error(error),

  // All events (fine-grained)
  onEvent: (event) => {
    /* handle any stream event */
  },

  // Send lifecycle
  onBeforeSend: (session, input) => {
    /* modify input */
  },
  onAfterSend: (session, result) => {
    /* post-processing */
  },

  // Tool confirmation
  onToolConfirmation: async (call, message) => {
    return await askUser(`Allow ${call.name}?`);
  },
});
```

### Session Management

```tsx
// Create a new session
const session = await app.session();

// Or get/create a specific session by ID
const session = await app.session("user-123");

// Send a message
const result = await session.send({
  messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
}).result;

// Check session state
const snapshot = session.snapshot();
console.log(snapshot.timeline);
console.log(snapshot.usage);
```

### Spawning Child Sessions

`session.spawn()` creates an ephemeral child session with a different agent/component. The child runs to completion and returns a `SessionExecutionHandle` — the same type as `session.send()`. This is the recursive primitive for multi-agent systems.

```tsx
// Spawn with a component function
const handle = await session.spawn(ChildAgent, {
  messages: [{ role: "user", content: [{ type: "text", text: "Analyze this data" }] }],
});
const result = await handle.result;

// Spawn with an AgentConfig (Level 0)
const handle = await session.spawn(
  { system: "You are a summarizer.", model: summaryModel },
  { messages: [{ role: "user", content: [{ type: "text", text: doc }] }] },
);

// Spawn with a JSX element (props from element + input.props are merged)
const handle = await session.spawn(<Researcher query="quantum computing" />, {
  messages: [{ role: "user", content: [{ type: "text", text: "Go" }] }],
});
```

**Parallel spawns** work with `Promise.all`:

```tsx
const [researchResult, factCheckResult] = await Promise.all([
  session.spawn(Researcher, { messages }).then((h) => h.result),
  session.spawn(FactChecker, { messages }).then((h) => h.result),
]);
```

**From tool handlers** via `ctx.spawn()`:

```tsx
const DelegateTool = createTool({
  name: "delegate",
  description: "Delegate to a specialist",
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

**Key behaviors:**

- **Isolation**: Child gets a fresh COM — no parent state leaks.
- **Lifecycle isolation**: Parent's lifecycle callbacks (onComplete, onTickStart, etc.) do NOT fire for child executions.
- **Abort propagation**: Aborting the parent execution aborts all children.
- **Close propagation**: Closing the parent session closes all children.
- **Depth limit**: Maximum 10 levels of nesting (throws if exceeded).
- **Cleanup**: Children are removed from `session.children` when they complete.

### Session Persistence

Sessions auto-persist after each execution and auto-restore when accessed via `app.session(id)`.

```typescript
const app = createApp(MyApp, {
  model,
  sessions: {
    store: "./data/sessions.db", // SQLite file (or ':memory:', or custom SessionStore)
    maxActive: 100, // Max concurrent in-memory sessions
    idleTimeout: 5 * 60 * 1000, // Evict from memory after 5 min idle
  },
});
```

**How it works:**

1. After each execution, session state is auto-saved to the store (fire-and-forget — persist failures don't block execution)
2. When `app.session("user-123")` is called and the session isn't in memory, it's auto-restored from the store
3. `useComState` and `useData` values are included in snapshots by default (set `{ persist: false }` to exclude)
4. `maxActive` and `idleTimeout` control memory — evicted sessions can be restored from store

#### Snapshot Contents

A `SessionSnapshot` captures:

| Field       | Type                        | Description                                            |
| ----------- | --------------------------- | ------------------------------------------------------ |
| `timeline`  | `COMTimelineEntry[] ∣ null` | Full conversation history                              |
| `comState`  | `Record<string, unknown>`   | All `useComState` values (with `persist !== false`)    |
| `dataCache` | `Record<string, ...>`       | All `useData` cached values (with `persist !== false`) |
| `tick`      | `number`                    | Tick count at snapshot time                            |
| `usage`     | `UsageStats`                | Accumulated token usage                                |

#### Lifecycle Hooks

```typescript
const app = createApp(MyApp, {
  model,
  sessions: { store: "./sessions.db" },

  // Before save — cancel or modify snapshot
  onBeforePersist: (session, snapshot) => {
    if (snapshot.tick < 2) return false; // Don't persist short sessions
  },

  // After save
  onAfterPersist: (sessionId, snapshot) => {
    console.log(`Saved session ${sessionId}`);
  },

  // Before restore — migrate old formats
  onBeforeRestore: (sessionId, snapshot) => {
    if (snapshot.version !== "1.0") return migrateSnapshot(snapshot);
  },

  // After restore
  onAfterRestore: (session, snapshot) => {
    console.log(`Restored session ${session.id} at tick ${snapshot.tick}`);
  },
});
```

#### Restore Layers

**Layer 1 (default):** Snapshot data is auto-applied. Timeline, comState, and dataCache are restored directly. Components see their previous state via `useComState` and `useData`.

**Layer 2 (resolve):** When `resolve` is configured, auto-apply is disabled. Resolve functions control reconstruction and receive the snapshot as context. Results are available via `useResolved(key)`.

```typescript
const app = createApp(MyApp, {
  model,
  sessions: { store: "./sessions.db" },

  // Layer 2: resolve controls reconstruction
  resolve: {
    greeting: (ctx) => `Welcome back! You were on tick ${ctx.snapshot?.tick}`,
    userData: async (ctx) => fetchUser(ctx.sessionId),
  },
});

// In components:
function MyAgent() {
  const greeting = useResolved<string>("greeting");
  const userData = useResolved<User>("userData");
  // ...
}
```

#### Context Management vs History

The session's `_timeline` is the append-only historical log — it grows with every message. The `<Timeline>` component controls what the model _sees_ (context) via its props:

```tsx
// Full history → model context (default)
<Timeline />

// Only recent messages in context
<Timeline limit={20} />

// Token-budgeted context
<Timeline maxTokens={8000} strategy="sliding-window" headroom={500} />

// Role filtering
<Timeline roles={['user', 'assistant']} />
```

The `useTimeline()` hook provides direct access for advanced patterns:

```tsx
function MyAgent() {
  const timeline = useTimeline();

  // Read current entries
  console.log(timeline.entries.length);

  // Replace timeline (e.g., after summarization)
  timeline.set([summaryEntry, ...recentEntries]);

  // Transform timeline
  timeline.update((entries) => entries.filter((e) => e.message.role !== "system"));
}
```

#### `maxTimelineEntries` — OOM Safety Net

For long-running sessions, `maxTimelineEntries` prevents unbounded memory growth by trimming the oldest entries after each tick. This is a safety net, not a context management strategy — use `<Timeline>` props for context control.

```typescript
const app = createApp(MyApp, {
  model,
  maxTimelineEntries: 500, // Keep at most 500 entries in memory
});
```

### Procedures & Middleware

Session methods `send`, `render`, `queue`, and `spawn` are all Procedures. This means they support middleware, context injection, and the chainable API:

```typescript
const session = await app.session();

// Direct call (await unwraps to SessionExecutionHandle)
const handle = await session.send({ messages: [...] });
const result = await session.send({ messages: [...] }).result; // SendResult

// Add middleware to a single call
const handle = await session.render.use(async (args, envelope, next) => {
  console.log("before render");
  const result = await next();
  console.log("after render");
  return result;
})({ query: "Hello" });

// .use() returns a new Procedure (immutable — original is unchanged)
const loggedRender = session.render.use(loggingMiddleware);
await loggedRender({ query: "test" }).result;
```

`ProcedurePromise` supports `.result` chaining — `await proc().result` resolves to the final `SendResult` regardless of whether the procedure is passthrough or handle-wrapped.

`app.run` is also a Procedure:

```typescript
const handle = await app.run({ messages: [...], props: { query: "Hello" } });
await handle.result;
```

### Middleware Inheritance

Apps inherit from the global `Agentick` instance by default:

```typescript
import { Agentick, createApp } from "@agentick/core";

// Register global middleware
Agentick.use("*", loggingMiddleware);
Agentick.use("tool:*", authMiddleware);

// App inherits global middleware (default)
const app = createApp(MyApp, { model });

// Isolated app (for testing)
const testApp = createApp(TestApp, {
  model,
  inheritDefaults: false,
});
```

### Standalone Run

For one-off executions without session management:

```tsx
import { run } from "@agentick/core";

const result = await run(<MyApp />, {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }],
  model: myModel,
});
```

### Choosing `run()` vs `createApp`

| Use case                          | API                                                            |
| --------------------------------- | -------------------------------------------------------------- |
| One-shot, quick prototype         | `run(<Agent />, { model, messages })`                          |
| Reusable app, persistent sessions | `createApp(Agent, { model })` + `app.run()` / `session.send()` |
| Middleware, lifecycle hooks       | `createApp` (supports `app.run.use(mw)`)                       |

`run()` accepts a JSX element (not a bare component function). Element props are defaults — `input.props` overrides them:

```tsx
// Element prop "query" is "default", but input.props overrides it to "override"
await run(<Agent query="default" />, { props: { query: "override" }, model, messages });
```

`createApp` takes a component function and returns a reusable app with session management, persistence, and middleware support.

## DevTools Integration

Enable DevTools for debugging:

```tsx
const app = createApp(MyApp, {
  devTools: true,
  // or with remote DevTools
  devTools: {
    enabled: true,
    remote: true,
    remoteUrl: "http://localhost:3001/api/devtools",
  },
});
```

For debugging the reconciler itself with React DevTools:

```tsx
import { enableReactDevTools } from "@agentick/core";

// Before creating sessions
enableReactDevTools(); // Connects to npx react-devtools on port 8097
```

## Local Transport

`createLocalTransport(app)` bridges an in-process `App` to the `ClientTransport` interface. This enables `@agentick/client` (and `@agentick/react` hooks) to work with a local app without any network layer.

```typescript
import { createApp } from "@agentick/core";
import { createLocalTransport } from "@agentick/core";
import { createClient } from "@agentick/client";

const app = createApp(MyAgent, { model });
const transport = createLocalTransport(app);
const client = createClient({ baseUrl: "local://", transport });
```

The transport is always "connected" — there's no network. `send()` delegates to `app.send()` and streams `SessionExecutionHandle` events as `TransportEventData`. Used by `@agentick/tui` for local agent mode.

See [`packages/shared/src/transport.ts`](../shared/src/transport.ts) for the `ClientTransport` interface.

## License

MIT
