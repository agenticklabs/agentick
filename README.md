# agentick

**The component framework for AI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-reconciler-blue?style=for-the-badge&logo=react&logoColor=white)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](https://github.com/agenticklabs/agentick/pulls)

A React reconciler where the render target is a language model. You build the context window with JSX — the same components, hooks, and composition you already know — and the framework compiles it into what the model sees.

```tsx
import { createApp, System, Timeline, createTool, useContinuation } from "@agentick/core";
import { openai } from "@agentick/openai";
import { z } from "zod";

const Search = createTool({
  name: "search",
  description: "Search the knowledge base",
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => {
    const results = await knowledgeBase.search(query);
    return [{ type: "text", text: JSON.stringify(results) }];
  },
});

function ResearchAgent() {
  useContinuation((result) => result.tick < 10);

  return (
    <>
      <System>Search thoroughly, then write a summary.</System>
      <Timeline />
      <Search />
    </>
  );
}

const app = createApp(ResearchAgent, { model: openai({ model: "gpt-4o" }) });
const result = await app.run({
  messages: [
    { role: "user", content: [{ type: "text", text: "What's new in quantum computing?" }] },
  ],
});
console.log(result.response);
```

## Quick Start

```bash
npm install agentick @agentick/openai zod
```

Add to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

## Why Agentick

Every other AI framework gives you a pipeline. A chain. A graph. You slot your prompt into a template, bolt on some tools, and hope the model figures it out.

Agentick gives you a **programming language for AI applications.** The context window is your canvas. Components compose into it. Tools render their state back into it. Hooks run arbitrary code between ticks — verify output, summarize history, gate continuation. The model's entire world is JSX that you control, down to how individual content blocks render.

There are no prompt templates because JSX _is_ the template language. There are no special abstractions between you and what the model sees — you build it, the framework compiles it, the model reads it. When the model calls a tool, your component re-renders. When you want older messages compressed, you write a component. When you need to verify output before continuing, you write a hook.

This is application development, not chatbot configuration.

## Built-in Components

Everything in the component tree compiles to what the model sees. Components are the building blocks — compose them to construct the context window.

### Structure

| Component             | Description                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Timeline>`          | Conversation history. Accepts a render function for full control, or renders with sensible defaults. Token budget compaction via `maxTokens`, `strategy`, `filter`, `limit`, `roles`.                                   |
| `<Timeline.Provider>` | Context provider exposing timeline entries to descendants via `useTimelineContext()`.                                                                                                                                   |
| `<Timeline.Messages>` | Renders messages from `Timeline.Provider` context. Optional `renderEntry` prop for custom rendering.                                                                                                                    |
| `<Section>`           | Structured context block injected every tick. `audience` controls visibility: `"model"`, `"user"`, or `"all"`.                                                                                                          |
| `<Tool>`              | Tool the model can call. Use inline (`<Tool name="..." handler={...} />`) or via `createTool()`. Supports `render()` for persistent state, `use()` for context injection, `audience: "user"` for model-hidden dispatch. |
| `<Model>`             | Model configuration. Pass `engine` prop, or use adapter-specific components like `<OpenAIModel>` or `<GoogleModel>`.                                                                                                    |

### Messages

| Component      | Description                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `<System>`     | System/instruction message.                                                                                                  |
| `<User>`       | User message.                                                                                                                |
| `<Assistant>`  | Assistant message.                                                                                                           |
| `<Message>`    | Generic message — takes `role` prop. The primitive underlying all role-specific components.                                  |
| `<ToolResult>` | Tool execution result. Requires `toolCallId`.                                                                                |
| `<Event>`      | Persisted application event. Use for structured logging that survives in the timeline.                                       |
| `<Ephemeral>`  | Non-persisted context. Visible during compilation but not saved to history. `position`: `"start"`, `"before-user"`, `"end"`. |
| `<Grounding>`  | Semantic wrapper for grounding context (ephemeral). `audience`: `"model"`, `"user"`, `"both"`.                               |

### Event Blocks

Use inside `<Event>` messages for structured event content:

| Component       | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `<UserAction>`  | User action block. Props: `action`, `actor?`, `target?`, `details?`.     |
| `<SystemEvent>` | System event block. Props: `event`, `source?`, `data?`.                  |
| `<StateChange>` | State change block. Props: `entity`, `field?`, `from`, `to`, `trigger?`. |

### Semantic Formatting

Compile to renderer-appropriate output (markdown, XML, etc.):

| Component              | Description                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `<H1>`, `<H2>`, `<H3>` | Heading levels 1–3.                                                                         |
| `<Header level={n}>`   | Generic heading (levels 1–6).                                                               |
| `<Paragraph>`          | Text paragraph block.                                                                       |
| `<List>`               | List container. `ordered` for numbered, `task` for checkboxes. `title` for a heading.       |
| `<ListItem>`           | List item. `checked` prop for task lists.                                                   |
| `<Table>`              | Table. `headers`/`rows` props for data, or `<Row>`/`<Column>` children for JSX composition. |
| `<Row>`                | Table row. `header` prop for header rows.                                                   |
| `<Column>`             | Table column. `align`: `"left"`, `"center"`, `"right"`.                                     |

### Content Blocks

Typed content for composing rich message content:

| Component    | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| `<Text>`     | Text content. Children or `text` prop. Supports inline formatting: `<b>`, `<em>`, `<code>`. |
| `<Image>`    | Image. `source: MediaSource` (URL or base64).                                               |
| `<Document>` | Document attachment. `source: MediaSource`, `title?`.                                       |
| `<Audio>`    | Audio content. `source: MediaSource`, `transcript?`.                                        |
| `<Video>`    | Video content. `source: MediaSource`, `transcript?`.                                        |
| `<Code>`     | Code block. `language` prop (typescript, python, etc.).                                     |
| `<Json>`     | JSON data block. `data` prop for objects, or `text`/children for raw JSON strings.          |

## The Context Is Yours

The core insight: **only what you render gets sent to the model.** `<Timeline>` isn't a magic black box — it accepts a render function, and you decide exactly how every message appears in the context window. Skip a message? The model never sees it. Rewrite it? That's what the model reads.

```tsx
<Timeline>
  {(history, pending) => (
    <>
      {history.map((entry, i) => {
        const msg = entry.message;
        const isOld = i < history.length - 6;

        if (isOld && msg.role === "user") {
          const textOnly = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(" ");
          return (
            <Message key={i} role="user">
              [Earlier: {textOnly.slice(0, 100)}...]
            </Message>
          );
        }

        if (isOld && msg.role === "assistant") {
          return (
            <Message key={i} role="assistant">
              [Previous response]
            </Message>
          );
        }

        return <Message key={i} {...msg} />;
      })}
      {pending.map((msg, i) => (
        <Message key={`p-${i}`} {...msg.message} />
      ))}
    </>
  )}
</Timeline>
```

Images from 20 messages ago eating your context window? Render them as `[Image: beach sunset]`. Tool results from early in the conversation? Collapse them. Recent messages? Full detail. You write the function, you decide.

### Default — Just Works

With no children, `<Timeline />` renders conversation history with sensible defaults:

```tsx
function SimpleAgent() {
  return (
    <>
      <System>You are helpful.</System>
      <Timeline />
    </>
  );
}
```

### Composability — It's React

That render logic getting complex? Extract it into a component:

```tsx
function CompactMessage({ entry }: { entry: COMTimelineEntry }) {
  const msg = entry.message;

  const summary = msg.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text.slice(0, 80);
        case "image":
          return `[Image: ${block.source?.description ?? "image"}]`;
        case "tool_use":
          return `[Called ${block.name}]`;
        case "tool_result":
          return `[Result from ${block.name}]`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(" | ");

  return <Message role={msg.role}>{summary}</Message>;
}

function Agent() {
  return (
    <>
      <System>You are helpful.</System>
      <Timeline>
        {(history, pending) => (
          <>
            {history.map((entry, i) =>
              i < history.length - 4 ? (
                <CompactMessage key={i} entry={entry} />
              ) : (
                <Message key={i} {...entry.message} />
              ),
            )}
            {pending.map((msg, i) => (
              <Message key={`p-${i}`} {...msg.message} />
            ))}
          </>
        )}
      </Timeline>
    </>
  );
}
```

Or go further — you don't even need `<Timeline>`. Render the entire conversation as a single user message:

```tsx
function NarrativeAgent() {
  return (
    <>
      <System>Continue the conversation.</System>
      <Timeline>
        {(history) => (
          <User>
            Here's what happened so far:{"\n"}
            {history.map((e) => `${e.message.role}: ${extractText(e)}`).join("\n")}
          </User>
        )}
      </Timeline>
    </>
  );
}
```

The framework doesn't care how you structure the context. Multiple messages, one message, XML, prose — anything that compiles to content blocks gets sent.

### Sections — Structured Context

```tsx
function AgentWithContext({ userId }: { userId: string }) {
  const profile = useData("profile", () => fetchProfile(userId), [userId]);

  return (
    <>
      <System>You are a support agent.</System>
      <Section id="user-context" audience="model">
        Customer: {profile?.name}, Plan: {profile?.plan}, Since: {profile?.joinDate}
      </Section>
      <Timeline />
      <TicketTool />
    </>
  );
}
```

`<Section>` injects structured context that the model sees every tick — live data, computed state, whatever you need. The `audience` prop controls visibility (`"model"`, `"user"`, or `"all"`).

### Knobs — The Model Controls Its Context

Like accordions in a UI. The model sees section headers and expands what it needs:

```tsx
function SupportAgent() {
  const [active] = useKnob("section", "none", {
    options: ["none", "api", "billing", "troubleshooting"],
    description: "Expand a documentation section",
    momentary: true, // auto-collapses after each execution
  });

  return (
    <>
      <System>You help users with our product. Expand a section when you need it.</System>

      <Section id="api" audience="model">
        {active === "api" ? apiDocs : "API Reference (expand to read)"}
      </Section>
      <Section id="billing" audience="model">
        {active === "billing" ? billingDocs : "Billing Guide (expand to read)"}
      </Section>
      <Section id="troubleshooting" audience="model">
        {active === "troubleshooting" ? troubleshootingDocs : "Troubleshooting (expand to read)"}
      </Section>

      <Knobs />
      <Timeline />
    </>
  );
}
```

The model sees collapsed headers → sets the knob → reads the content → answers. The `momentary` flag resets the knob after each execution, so sections collapse automatically. Only what the model needs consumes tokens.

## Hooks

Hooks are real React hooks — `useState`, `useEffect`, `useMemo` — plus lifecycle hooks that fire at each phase of the agent execution loop.

### All Hooks

#### Lifecycle

| Hook                  | Description                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `useOnMount(cb)`      | Run once when component first mounts.                                                                                               |
| `useOnUnmount(cb)`    | Run once when component unmounts.                                                                                                   |
| `useOnTickStart(cb)`  | Run at start of each tick (tick 2+). Receives `(tickState, ctx)`.                                                                   |
| `useOnTickEnd(cb)`    | Run at end of each tick. Receives `(result, ctx)`. Return `false` or call `result.stop()` to halt.                                  |
| `useAfterCompile(cb)` | Run after compilation completes. Receives `(compiled, ctx)`.                                                                        |
| `useContinuation(cb)` | Control whether execution continues. `result.shouldContinue` shows framework default. Return `boolean`, object, or `void` to defer. |

#### State & Signals

| Hook                         | Description                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `useSignal(initial)`         | Reactive signal. `.set()`, `.update()`, `.subscribe()`. Reads outside render, triggers reconciliation on write. |
| `useComputed(fn, deps)`      | Computed signal. Auto-updates when dependencies change.                                                         |
| `useComState(key, default?)` | Reactive COM state. Bidirectional sync with the context object model.                                           |

Standalone signal factories (no hook rules — use anywhere):

| Function          | Description                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `signal(initial)` | Create a signal.                                                                           |
| `computed(fn)`    | Create a computed signal.                                                                  |
| `effect(fn)`      | Run side effect with automatic dependency tracking. Returns `EffectRef` with `.dispose()`. |
| `batch(fn)`       | Batch signal updates — effects fire once after all updates.                                |
| `untracked(fn)`   | Read signals without tracking as dependencies.                                             |

#### Data

| Hook                           | Description                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `useData(key, fetcher, deps?)` | Async data fetch with resolve-then-render. Throws promise on first render, returns cached value on re-render. |
| `useInvalidateData()`          | Returns `(pattern: string \| RegExp) => void` to invalidate cached data.                                      |

#### Knobs (Model-Visible State)

Knobs are reactive values the model can see _and set_ via tool calls:

| API                         | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `knob(default, opts?)`      | Create a knob descriptor at config level.                                      |
| `useKnob(name, descriptor)` | Hook returning `[resolvedValue, setValue]`.                                    |
| `<Knobs />`                 | Component that renders all knobs as a `<Section>` + registers `set_knob` tool. |
| `<Knobs.Provider>`          | Context provider for custom knob rendering.                                    |
| `<Knobs.Controls>`          | Renders knob controls from `Knobs.Provider` context.                           |
| `isKnob(value)`             | Type guard for knob descriptors.                                               |

#### Context & Environment

| Hook                       | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| `useCom()`                 | Access the COM (context object model) — state, timeline, channels. |
| `useTickState()`           | Current tick state: `{tick, previous, queuedMessages}`.            |
| `useRuntimeStore()`        | Runtime data store (hooks, knobs, lifecycle callbacks).            |
| `useFormatter()`           | Access message formatter context.                                  |
| `useContextInfo()`         | Real-time context utilization: token counts, utilization %.        |
| `useTimelineContext()`     | Timeline context (requires `Timeline.Provider` ancestor).          |
| `useConversationHistory()` | Full conversation history from COM (no provider needed).           |

#### React (re-exported)

All standard React hooks work in agent components: `useState`, `useEffect`, `useReducer`, `useMemo`, `useCallback`, `useRef`.

### Stop Conditions

The agent loop auto-continues when the model makes tool calls or messages are queued. `useContinuation` adds your own stop conditions.

`result.shouldContinue` shows the framework's current decision (including overrides from prior callbacks in the chain). Return nothing to defer, or override with a boolean, object, or `result.stop()`/`result.continue()`:

```tsx
// Veto: stop even if framework would continue
useContinuation((result) => {
  if (result.tick >= 10) return { stop: true, reason: "max-ticks" };
  if (result.usage && result.usage.totalTokens > 100_000) return false;
});

// Defer: no return = accept framework decision
useContinuation((result) => {
  logger.info(`tick ${result.tick}, continuing: ${result.shouldContinue}`);
});
```

### Between-Tick Logic

`useContinuation` is sugar for `useOnTickEnd`. Use the full version when you need to do real work:

```tsx
function VerifiedAgent() {
  useOnTickEnd(async (result) => {
    if (result.text && !result.toolCalls.length) {
      const quality = await verifyWithModel(result.text);
      if (!quality.acceptable) result.continue("failed-verification");
    }
  });

  return (
    <>
      <System>Be accurate. Your responses will be verified.</System>
      <Timeline />
    </>
  );
}
```

### Custom Hooks

Custom hooks work exactly like React — they're just functions that call other hooks:

```tsx
// Reusable hook: stop after a token budget
function useTokenBudget(maxTokens: number) {
  const [spent, setSpent] = useState(0);

  useOnTickEnd((result) => {
    const total = spent + (result.usage?.totalTokens ?? 0);
    setSpent(total);
    if (total > maxTokens) result.stop("budget-exceeded");
  });

  return spent;
}

// Reusable hook: verify output before finishing
function useVerifiedOutput(verifier: (text: string) => Promise<boolean>) {
  useOnTickEnd(async (result) => {
    if (!result.text || result.toolCalls.length > 0) return;
    const ok = await verifier(result.text);
    if (!ok) result.continue("failed-verification");
  });
}

// Compose them — it's just functions
function CarefulAgent() {
  const spent = useTokenBudget(50_000);
  useVerifiedOutput(myVerifier);

  return (
    <>
      <System>You have a token budget. Be concise.</System>
      <Section id="budget" audience="model">
        Tokens used: {spent}
      </Section>
      <Timeline />
    </>
  );
}
```

## Tools Render State

Tools aren't just functions the model calls — they render their state back into the context window. The model sees the current state _every time it thinks_, not just in the tool response.

```tsx
const TodoTool = createTool({
  name: "manage_todos",
  description: "Add, complete, or list todos",
  input: z.object({
    action: z.enum(["add", "complete", "list"]),
    text: z.string().optional(),
    id: z.number().optional(),
  }),
  handler: async ({ action, text, id }, ctx) => {
    if (action === "add") todos.push({ id: todos.length, text, done: false });
    if (action === "complete") todos[id!].done = true;
    return [{ type: "text", text: "Done." }];
  },
  render: () => (
    <Section id="todos" audience="model">
      Current todos: {JSON.stringify(todos)}
    </Section>
  ),
});
```

Everything is dual-use — tools and models work as JSX components in the tree _and_ as direct function calls:

```tsx
// JSX — in the component tree
<Search />
<model temperature={0.2} />

// Direct calls — use programmatically
const output = await Search.run({ query: "test" });
const handle = await model.generate(input);
```

### Tool Types

Tools have execution types and intents that control routing and behavior:

| Execution Type | Description                              |
| -------------- | ---------------------------------------- |
| `SERVER`       | Executes on server (default).            |
| `CLIENT`       | Executes in browser.                     |
| `MCP`          | Routed to Model Context Protocol server. |
| `PROVIDER`     | Handled by model provider natively.      |

| Intent    | Description                |
| --------- | -------------------------- |
| `COMPUTE` | Returns data (default).    |
| `ACTION`  | Performs side effects.     |
| `RENDER`  | Produces UI/visualization. |

## Sessions

```tsx
const app = createApp(Agent, { model: openai({ model: "gpt-4o" }) });
const session = await app.session("conv-1");

const msg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

await session.send({ messages: [msg("Hi there!")] });
await session.send({ messages: [msg("Tell me a joke")] });

// Stream responses
for await (const event of session.send({ messages: [msg("Another one")] })) {
  if (event.type === "content_delta") process.stdout.write(event.delta);
}

await session.close();
```

Sessions are long-lived conversation contexts. Each `send()` creates an **execution** (one user message → model response cycle). Each model API call within an execution is a **tick**. Multi-tick executions happen automatically with tool use.

```
Session
├── Execution 1 (user: "Hello")
│   └── Tick 1 → model response
├── Execution 2 (user: "Use calculator")
│   ├── Tick 1 → tool_use (calculator)
│   └── Tick 2 → final response
└── Execution 3 ...
```

Session states: `idle` → `running` → `idle` (or `closed`).

### Dynamic Model Selection

Models are JSX components — conditionally render them:

```tsx
const gpt = openai({ model: "gpt-4o" });
const gemini = google({ model: "gemini-2.5-pro" });

function AdaptiveAgent({ task }: { task: string }) {
  return (
    <>
      {task.includes("creative") ? <gemini temperature={0.9} /> : <gpt temperature={0.2} />}
      <System>Handle this task: {task}</System>
      <Timeline />
    </>
  );
}
```

## Execution Runners

The context window is JSX. But what _consumes_ that context — and how tool calls _execute_ — is pluggable.

An `ExecutionRunner` is a swappable backend that sits between the compiled context and execution. It transforms what the model sees, intercepts how tools run, and manages its own lifecycle state. Your agent code doesn't change — the runner changes the execution model underneath it.

```tsx
import { type ExecutionRunner } from "@agentick/core";

const repl: ExecutionRunner = {
  name: "repl",

  // The model sees command descriptions instead of tool schemas
  transformCompiled(compiled, tools) {
    return { ...compiled, tools: [executeTool] };
  },

  // "execute" calls go to a sandbox; everything else runs normally
  async executeToolCall(call, tool, next) {
    if (call.name === "execute") return sandbox.run(call.input.code);
    return next();
  },

  onSessionInit(session) {
    sandbox.create(session.id);
  },
  onDestroy(session) {
    sandbox.destroy(session.id);
  },
};

const app = createApp(Agent, { model, runner: repl });
```

Same agent, same JSX, different execution model. Build once — run against standard tool_use in production, a sandboxed REPL for code execution, a human-approval gateway for sensitive operations.

All hooks are optional. Without a runner, standard model → tool_use behavior applies. Runners are inherited by spawned child sessions — override per-child via `SpawnOptions`:

```tsx
await session.spawn(CodeAgent, { messages }, { runner: replEnv });
```

## Testing

Agentick includes a full testing toolkit. Render agents, compile context, mock models, and assert on behavior — all without making real API calls.

### `renderAgent` — Full Execution

Render an agent in a test environment with a mock model:

```tsx
import { renderAgent, cleanup } from "@agentick/core/testing";
import { afterEach, test, expect } from "vitest";

afterEach(cleanup);

test("research agent searches then summarizes", async () => {
  const { send, model } = renderAgent(<ResearchAgent />);

  // Queue model responses
  model.addResponse({ text: "", toolCalls: [{ name: "search", input: { query: "quantum" } }] });
  model.addResponse({ text: "Here's a summary of quantum computing..." });

  const result = await send("What's new in quantum computing?");

  expect(result.response).toContain("summary");
  expect(model.calls).toHaveLength(2); // two ticks
});
```

### `compileAgent` — Inspect Context

Compile an agent without executing to inspect what the model would see:

```tsx
test("agent includes user context in system prompt", async () => {
  const { sections, tools } = compileAgent(<AgentWithContext userId="user-123" />);

  expect(sections).toContainEqual(expect.objectContaining({ id: "user-context" }));
  expect(tools.map((t) => t.name)).toContain("create_ticket");
});
```

### Test Adapter

Create a mock model adapter for fine-grained control over streaming:

```tsx
import { createTestAdapter } from "@agentick/core/testing";

const adapter = createTestAdapter();

// Simulate streaming chunks
adapter.stream([
  { type: "text", text: "Hello " },
  { type: "text", text: "world!" },
  { type: "finish", stopReason: "end_turn" },
]);
```

### Mocks & Helpers

| Utility                       | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `createMockApp()`             | Mock app for client/transport tests.                  |
| `createMockSession()`         | Mock session with send/close/abort.                   |
| `createMockExecutionHandle()` | Mock execution handle (async iterable + result).      |
| `createTestRunner()`          | Mock execution runner with call tracking.             |
| `createMockCom()`             | Mock COM for hook tests.                              |
| `createMockTickState()`       | Mock tick state.                                      |
| `createMockTickResult()`      | Mock tick result for `useOnTickEnd` tests.            |
| `makeTimelineEntry()`         | Create timeline entries for assertions.               |
| `act(fn)` / `actSync(fn)`     | Execute in act context.                               |
| `waitFor(fn)`                 | Poll until condition is met.                          |
| `flushMicrotasks()`           | Flush pending microtasks.                             |
| `createDeferred()`            | Create deferred promise with external resolve/reject. |

## Terminal UI

`@agentick/tui` provides an Ink-based terminal interface for chatting with agents — locally or over the network.

```bash
npm install @agentick/tui
```

### Local — In-Process

Connect directly to an app. No server needed:

```tsx
import { createTUI } from "@agentick/tui";
import { createApp, System, Timeline } from "@agentick/core";
import { openai } from "@agentick/openai";

function Agent() {
  return (
    <>
      <System>You are helpful.</System>
      <Timeline />
    </>
  );
}

const app = createApp(Agent, { model: openai({ model: "gpt-4o" }) });
const tui = createTUI({ app });
await tui.start();
```

### Remote — Over SSE

Connect to a running gateway or express server:

```tsx
const tui = createTUI({ url: "http://localhost:3000/api" });
await tui.start();
```

### CLI

```bash
# Run a local agent file
agentick-tui --app ./my-agent.tsx

# Connect to a remote server
agentick-tui --url http://localhost:3000/api

# Custom export name
agentick-tui --app ./agents.tsx --export SalesAgent

# Custom UI component
agentick-tui --app ./my-agent.tsx --ui ./dashboard.tsx
```

### Pluggable UI

The TUI ships with a default `Chat` component, but you can provide your own:

```tsx
import { createTUI, type TUIComponent } from "@agentick/tui";
import { useSession, useStreamingText } from "@agentick/react";

const Dashboard: TUIComponent = ({ sessionId }) => {
  const { send } = useSession({ sessionId });
  const { text, isStreaming } = useStreamingText({ sessionId });
  // ... your Ink components
};

const tui = createTUI({ app, ui: Dashboard });
```

All building-block components are exported for custom UIs: `MessageList`, `StreamingMessage`, `ToolCallIndicator`, `ToolConfirmationPrompt`, `InputBar`, `ErrorDisplay`.

## React Hooks for UIs

`@agentick/react` provides hooks for building browser or terminal UIs over agent sessions. These are pure React — no browser APIs — so they work in both React DOM and Ink.

```bash
npm install @agentick/react
```

| Hook                      | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `useClient()`             | Access the Agentick client from context.                       |
| `useConnection()`         | SSE connection state: `{state, isConnected, isConnecting}`.    |
| `useSession(opts?)`       | Session accessor: `{send, abort, close, subscribe, accessor}`. |
| `useEvents(opts?)`        | Subscribe to stream events. Returns `{event, clear()}`.        |
| `useStreamingText(opts?)` | Accumulated streaming text: `{text, isStreaming, clear()}`.    |
| `useContextInfo(opts?)`   | Context utilization info (token counts, %).                    |

Wrap your app in `<AgentickProvider client={client}>` to provide the client context.

## Packages

| Package               | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `@agentick/core`      | Reconciler, components, hooks, tools, sessions, testing utilities |
| `@agentick/kernel`    | Execution kernel — procedures, context, middleware, channels      |
| `@agentick/shared`    | Platform-independent types and utilities                          |
| `@agentick/openai`    | OpenAI adapter (GPT-4o, o1, etc.)                                 |
| `@agentick/google`    | Google AI adapter (Gemini)                                        |
| `@agentick/ai-sdk`    | Vercel AI SDK adapter (any provider)                              |
| `@agentick/gateway`   | Multi-app server with auth, routing, and channels                 |
| `@agentick/express`   | Express.js integration                                            |
| `@agentick/nestjs`    | NestJS integration                                                |
| `@agentick/client`    | TypeScript client for gateway connections                         |
| `@agentick/react`     | React hooks for building UIs over sessions                        |
| `@agentick/tui`       | Terminal UI — Ink-based chat interface for local or remote agents |
| `@agentick/devtools`  | Fiber tree inspector, tick scrubber, token tracker                |
| `@agentick/cli`       | CLI for running agents                                            |
| `@agentick/server`    | Server utilities                                                  |
| `@agentick/socket.io` | Socket.IO transport                                               |

## Adapters

Three built-in, same interface. Or build your own — implement `prepareInput`, `mapChunk`, `execute`, and `executeStream`. See [`packages/adapters/README.md`](packages/adapters/README.md).

```tsx
import { openai } from "@agentick/openai";
import { google } from "@agentick/google";
import { aiSdk } from "@agentick/ai-sdk";

const gpt = openai({ model: "gpt-4o" });
const gemini = google({ model: "gemini-2.5-pro" });
const sdk = aiSdk({ model: yourAiSdkModel });
```

Adapters return a `ModelClass` — callable _and_ a JSX component:

```tsx
// As JSX — configure model in the component tree
<gpt temperature={0.2} maxTokens={1000} />;

// As function — call programmatically
const handle = await gpt.generate(input);
```

## DevTools

### Agentick DevTools

```tsx
const app = createApp(Agent, { model, devTools: true });
```

Fiber tree inspector, tick-by-tick scrubber, token usage tracking, real-time execution timeline. Record full sessions for replay with `session({ recording: 'full' })`.

### React DevTools

Agentick is built on `react-reconciler` — the same foundation as React DOM and React Native. This means [React DevTools](https://github.com/facebook/react/tree/main/packages/react-devtools) works out of the box. You can inspect the component tree that compiles into the model's context window, live.

```sh
npm install --save-dev react-devtools-core
```

```tsx
import { enableReactDevTools } from "@agentick/core";

enableReactDevTools(); // connects to standalone DevTools on port 8097
```

```sh
# Terminal 1: start React DevTools
npx react-devtools

# Terminal 2: run your agent
node my-agent.js
```

You'll see the full component tree — `<System>`, `<Timeline>`, `<Section>`, your custom components, tools — in the same inspector you use for web and mobile apps. Inspect props, watch state changes between ticks, and see exactly what compiles into the context window.

## Gateway

Deploy multiple apps behind a single server with auth, routing, and channel adapters:

```tsx
import { createGateway } from "@agentick/gateway";

const gateway = createGateway({
  apps: { support: supportApp, sales: salesApp },
  defaultApp: "support",
  auth: { type: "token", token: process.env.API_TOKEN! },
});
```

## License

MIT
