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

## Hooks Control the Loop

Hooks are real React hooks — `useState`, `useEffect`, `useMemo` — plus lifecycle hooks that fire at each phase of execution.

### Stop Conditions

The agent loop auto-continues when the model makes tool calls. `useContinuation` adds your own stop conditions:

```tsx
useContinuation((result) => !result.text?.includes("<DONE>"));

useContinuation((result) => {
  if (result.tick >= 10) {
    result.stop("max-ticks");
    return false;
  }
  if (result.usage && result.usage.totalTokens > 100_000) {
    result.stop("token-budget");
    return false;
  }
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

session.close();
```

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

## Packages

| Package               | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `@agentick/core`      | Reconciler, components, hooks, tools, sessions               |
| `@agentick/kernel`    | Execution kernel — procedures, context, middleware, channels |
| `@agentick/shared`    | Platform-independent types and utilities                     |
| `@agentick/openai`    | OpenAI adapter (GPT-4o, o1, etc.)                            |
| `@agentick/google`    | Google AI adapter (Gemini)                                   |
| `@agentick/ai-sdk`    | Vercel AI SDK adapter (any provider)                         |
| `@agentick/gateway`   | Multi-app server with auth, routing, and channels            |
| `@agentick/express`   | Express.js integration                                       |
| `@agentick/nestjs`    | NestJS integration                                           |
| `@agentick/client`    | TypeScript client for gateway connections                    |
| `@agentick/react`     | React hooks for building UIs over sessions                   |
| `@agentick/devtools`  | Fiber tree inspector, tick scrubber, token tracker           |
| `@agentick/cli`       | CLI for running agents                                       |
| `@agentick/server`    | Server utilities                                             |
| `@agentick/socket.io` | Socket.IO transport                                          |

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

## DevTools

```tsx
const app = createApp(Agent, { model, devTools: true });
```

Fiber tree inspector, tick-by-tick scrubber, token usage tracking, real-time execution timeline. Record full sessions for replay with `session({ recording: 'full' })`.

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
