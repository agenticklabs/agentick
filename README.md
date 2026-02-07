# tentickle

**React for AI agents.**

A React reconciler where the render target is a language model. No prompt templates, no YAML chains, no Jinja. You build the context window with JSX — the same components, hooks, and composition you already know — and the framework compiles it into what the model sees.

You're not configuring a chatbot. You're building the application through which the model sees and experiences the world.

[![npm version](https://img.shields.io/npm/v/pi-messenger?style=for-the-badge)](https://www.npmjs.com/package/pi-messenger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

```tsx
import { createApp, System, Timeline, Message, Section,
         createTool, useContinuation } from "@tentickle/core";
import { openai } from "@tentickle/openai";
import { z } from "zod";

// Tools are components — they render state into model context
const Search = createTool({
  name: "search",
  description: "Search the knowledge base",
  input: z.object({ query: z.string() }),
  handler: async ({ query }, com) => {
    const results = await knowledgeBase.search(query);
    const sources = com.getState("sources") ?? [];
    com.setState("sources", [...sources, ...results.map((r) => r.title)]);
    return [{ type: "text", text: JSON.stringify(results) }];
  },
  // render() injects live state into the context window every tick
  render: (tickState, com) => {
    const sources = com.getState("sources");
    return sources?.length ? (
      <Section id="sources" audience="model">
        Sources found so far: {sources.join(", ")}
      </Section>
    ) : null;
  },
});

// Agents are functions that return JSX
function ResearchAgent({ topic }: { topic: string }) {
  // The model auto-continues when it makes tool calls.
  // Hooks add your own stop conditions.
  useContinuation((result) => {
    if (result.tick >= 20) result.stop("too-many-ticks");
  });

  return (
    <>
      <System>
        You are a research agent. Search thoroughly, then write a summary.
      </System>

      {/* You control exactly how conversation history renders */}
      <Timeline>
        {(history, pending) => <>
          {history.map((entry, i) =>
            i < history.length - 4
              ? <CompactMessage key={i} entry={entry} />
              : <Message key={i} {...entry.message} />
          )}
          {pending.map((msg, i) => <Message key={`p-${i}`} {...msg.message} />)}
        </>}
      </Timeline>

      <Search />
    </>
  );
}

const model = openai({ model: "gpt-4o" });
const app = createApp(ResearchAgent, { model });
const result = await app.run({
  props: { topic: "quantum computing" },
  messages: [{ role: "user", content: [{ type: "text", text: "What's new in quantum computing?" }] }],
});

console.log(result.response);
```

## Why Tentickle

Every other AI framework gives you a pipeline. A chain. A graph. You slot your prompt into a template, bolt on some tools, and hope the model figures it out.

Tentickle gives you a **programming language for AI applications.** The context window is your canvas. Components compose into it. Tools render their state back into it. Hooks run arbitrary code between ticks — verify output, summarize history, gate continuation. The model's entire world is JSX that you control, down to how individual content blocks render.

There are no prompt templates because JSX _is_ the template language. There are no special abstractions between you and what the model sees — you build it, the framework compiles it, the model reads it. When the model calls a tool, your component re-renders. When you want older messages compressed, you write a component. When you need to verify output before continuing, you write a hook.

This is application development, not chatbot configuration.

## The Context Is Yours

The core insight: **only what you render gets sent to the model.** `<Timeline>` isn't a magic black box — it accepts a render function with `(history, pending)`, and you decide exactly how every message appears in the context window. Skip a message? The model never sees it. Rewrite it? That's what the model reads.

### Default — Just Works

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

`<Timeline />` with no children renders conversation history with sensible defaults.

### Custom Rendering — Control What the Model Sees

The render function receives `history` (completed entries) and `pending` (messages queued this tick). Only what you return from this function enters the model's context:

```tsx
<Timeline>
  {(history, pending) => <>
    {history.map((entry, i) => {
      const msg = entry.message;
      const isOld = i < history.length - 6;

      // Old user messages — drop images, keep text summaries
      if (isOld && msg.role === "user") {
        const textOnly = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(" ");
        return <Message key={i} role="user">[Earlier: {textOnly.slice(0, 100)}...]</Message>;
      }

      // Old assistant messages — collapse
      if (isOld && msg.role === "assistant") {
        return <Message key={i} role="assistant">[Previous response]</Message>;
      }

      // Recent messages — full fidelity
      return <Message key={i} {...msg} />;
    })}
    {pending.map((msg, i) => <Message key={`p-${i}`} {...msg.message} />)}
  </>}
</Timeline>
```

Images from 20 messages ago eating your context window? Render them as `[Image: beach sunset]`. Tool results from early in the conversation? Collapse them. Recent messages? Full detail. You write the function, you decide.

### Composability — It's React

That render logic getting complex? Extract it into a component. It's React — components compose:

```tsx
// A reusable component for rendering older messages compactly
function CompactMessage({ entry }: { entry: COMTimelineEntry }) {
  const msg = entry.message;

  // Walk content blocks — handle each type differently
  const summary = msg.content.map((block) => {
    switch (block.type) {
      case "text":    return block.text.slice(0, 80);
      case "image":   return `[Image: ${block.source?.description ?? "image"}]`;
      case "tool_use": return `[Called ${block.name}]`;
      case "tool_result": return `[Result from ${block.name}]`;
      default:        return "";
    }
  }).filter(Boolean).join(" | ");

  return <Message role={msg.role}>{summary}</Message>;
}

// Use it in your Timeline
function Agent() {
  return (
    <>
      <System>You are helpful.</System>
      <Timeline>
        {(history, pending) => <>
          {history.map((entry, i) =>
            i < history.length - 4
              ? <CompactMessage key={i} entry={entry} />
              : <Message key={i} {...entry.message} />
          )}
          {pending.map((msg, i) => <Message key={`p-${i}`} {...msg.message} />)}
        </>}
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

### Sections — Structured Context for the Model

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

## Hooks Control Everything

Hooks are where the real power lives. They're real React hooks — `useState`, `useEffect`, `useMemo` — plus lifecycle hooks that fire at each phase of execution.

### `useContinuation` — Add Stop Conditions

The agent loop auto-continues when the model makes tool calls. `useContinuation` lets you add your own stop conditions:

```tsx
// Stop after a done marker
useContinuation((result) => !result.text?.includes("<DONE>"));

// Stop after too many ticks or too many tokens
useContinuation((result) => {
  if (result.tick >= 10) { result.stop("max-ticks"); return false; }
  if (result.usage && result.usage.totalTokens > 100_000) {
    result.stop("token-budget"); return false;
  }
});
```

### `useOnTickEnd` — Run Code After Every Model Response

`useContinuation` is sugar for `useOnTickEnd`. Use the full version when you need to do real work between ticks:

```tsx
function VerifiedAgent() {
  useOnTickEnd(async (result) => {
    // Log every tick
    analytics.track("tick", { tokens: result.usage?.totalTokens });

    // When the model is done (no more tool calls), verify before accepting
    if (result.text && !result.toolCalls.length) {
      const quality = await verifyWithModel(result.text);
      if (!quality.acceptable) {
        result.continue("failed-verification"); // force another tick
      }
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

### Build Your Own Hooks

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
      <Section id="budget" audience="model">Tokens used: {spent}</Section>
      <Timeline />
    </>
  );
}
```

## Everything Is Dual-Use

`createTool` and `createAdapter` (used under the hood by `openai()`, `google()`, etc.) return objects that work both as JSX components and as direct function calls:

```tsx
const Search = createTool({ name: "search", ... });
const model = openai({ model: "gpt-4o" });

// As JSX — self-closing tags in the component tree
<model temperature={0.2} />
<Search />

// As direct calls — use programmatically
const handle = await model.generate(input);
const output = await Search.run({ query: "test" });
```

Context is maintained with AsyncLocalStorage, so tools and hooks can access session state from anywhere — no prop drilling required.

## More Examples

### One-Shot Run

```tsx
import { run, System, Timeline } from "@tentickle/core";
import { openai } from "@tentickle/openai";

const result = await run(
  <><System>You are helpful.</System><Timeline /></>,
  { model: openai({ model: "gpt-4o" }), messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }] },
);
console.log(result.response);
```

### Stateful Tool with Render

```tsx
const TodoTool = createTool({
  name: "manage_todos",
  description: "Add, complete, or list todos",
  input: z.object({
    action: z.enum(["add", "complete", "list"]),
    text: z.string().optional(),
    id: z.number().optional(),
  }),
  handler: async ({ action, text, id }) => {
    if (action === "add") todos.push({ id: todos.length, text, done: false });
    if (action === "complete") todos[id!].done = true;
    return [{ type: "text", text: "Done." }];
  },
  // render() injects live state into the model's context every tick
  render: () => (
    <Section id="todos" audience="model">
      Current todos: {JSON.stringify(todos)}
    </Section>
  ),
});
```

The model sees the current todo list _every time it thinks_ — not just in the tool response, but as persistent context. When it decides what to do next, the state is right there.

### Multi-Turn Session

```tsx
const app = createApp(Agent, { model: openai({ model: "gpt-4o" }) });
const session = await app.session("conv-1");

const msg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });

await session.send({ messages: [msg("Hi there!")] });
await session.send({ messages: [msg("Tell me a joke")] });

// Stream responses
for await (const event of session.send({ messages: [msg("Another one")] })) {
  if (event.type === "content_delta") process.stdout.write(event.delta);
}

session.close();
```

### Dynamic Model Selection

Models are JSX components — conditionally render them to switch models mid-session:

```tsx
const gpt = openai({ model: "gpt-4o" });
const gemini = google({ model: "gemini-2.5-pro" });

function AdaptiveAgent({ task }: { task: string }) {
  const needsCreativity = task.includes("creative");

  return (
    <>
      {needsCreativity ? <gemini temperature={0.9} /> : <gpt temperature={0.2} />}
      <System>Handle this task: {task}</System>
      <Timeline />
    </>
  );
}
```

## Packages

| Package                | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `@tentickle/core`      | Reconciler, components, hooks, tools, sessions               |
| `@tentickle/kernel`    | Execution kernel — procedures, context, middleware, channels |
| `@tentickle/shared`    | Platform-independent types and utilities                     |
| `@tentickle/openai`    | OpenAI adapter (GPT-4o, o1, etc.)                            |
| `@tentickle/google`    | Google AI adapter (Gemini)                                   |
| `@tentickle/ai-sdk`    | Vercel AI SDK adapter (any provider)                         |
| `@tentickle/gateway`   | Multi-app server with auth, routing, and channels            |
| `@tentickle/express`   | Express.js integration                                       |
| `@tentickle/nestjs`    | NestJS integration                                           |
| `@tentickle/client`    | TypeScript client for gateway connections                    |
| `@tentickle/react`     | React hooks for building UIs over sessions                   |
| `@tentickle/devtools`  | Fiber tree inspector, tick scrubber, token tracker           |
| `@tentickle/cli`       | CLI for running agents                                       |
| `@tentickle/server`    | Server utilities                                             |
| `@tentickle/socket.io` | Socket.IO transport                                          |

```
┌─────────────────────────────────────────────────────────────────┐
│                          Applications                           │
│       (express, nestjs, cli, user apps)                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                       Framework Layer                            │
│  @tentickle/core    @tentickle/gateway    @tentickle/client     │
│  @tentickle/express @tentickle/devtools                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                       Adapter Layer                              │
│  @tentickle/openai  @tentickle/google  @tentickle/ai-sdk        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                     Foundation Layer                              │
│           @tentickle/kernel         @tentickle/shared            │
│           (Node.js only)            (Platform-independent)       │
└─────────────────────────────────────────────────────────────────┘
```

## Adapters

Three built-in, same interface. Or build your own — implement `prepareInput`, `mapChunk`, `execute`, and `executeStream`. See [`packages/adapters/README.md`](packages/adapters/README.md).

```tsx
import { openai } from "@tentickle/openai";
import { google } from "@tentickle/google";
import { aiSdk } from "@tentickle/ai-sdk";

const gpt = openai({ model: "gpt-4o" });
const gemini = google({ model: "gemini-2.5-pro" });
const sdk = aiSdk({ model: yourAiSdkModel });
```

## DevTools

```tsx
const app = createApp(Agent, { model, devTools: true });
```

Fiber tree inspector, tick-by-tick scrubber, token usage tracking, real-time execution timeline. Record full sessions for replay with `session({ recording: 'full' })`.

## Gateway

Deploy multiple apps behind a single server with auth, routing, and channel adapters:

```tsx
import { createGateway } from "@tentickle/gateway";

const gateway = createGateway({
  apps: { support: supportApp, sales: salesApp },
  defaultApp: "support",
  auth: { type: "token", token: process.env.API_TOKEN! },
});
```

## Quick Start

```bash
npm install @tentickle/core @tentickle/openai zod
```

**TypeScript config** — add to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

## License

MIT
