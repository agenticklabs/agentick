---
layout: home
hero:
  name: agentick
  text: Build agents like you build apps.
  tagline: React, but the render target is model context instead of DOM. Build AI applications with the tools you already know.
  actions:
    - theme: brand
      text: Get Started
      link: /docs/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/agenticklabs/agentick
features:
  - icon: ⚛️
    title: It's React
    details: Same reconciler, same hooks, same JSX. The render target is model context instead of DOM. If you know React, you know this.
  - icon: 🧩
    title: JSX Context Definition
    details: Define what the model sees with JSX. <Section>, <Tool>, <Timeline>, <Message> — composable, declarative, reactive.
  - icon: 🔧
    title: Tools as Components
    details: createTool returns a component AND a callable. Stateful tools render context to the model. No more stringly-typed function registries.
  - icon: 🔄
    title: Reactive Hooks
    details: useOnMount, useOnTickEnd, useContinuation, useKnob — lifecycle hooks that make multi-turn agent behavior trivial to express.
  - icon: 🎛️
    title: Knobs
    details: Model-visible, model-settable reactive state. One hook gives you a form control the model can see and change. Agent self-modification in one line.
  - icon: 🏗️
    title: Session Architecture
    details: Sessions manage identity, persistence, spawn/fork. The reconciler is an implementation detail. Scale from one agent to thousands.
---

<div class="content-section">

## You already know this

If you've used React, you've already learned 80% of agentick. The remaining 20% is AI-specific primitives — tools, timeline, model context — built on the same component model.

<div class="code-compare">
<div class="code-block">

### React App

```tsx
function App() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}
```

</div>
<div class="code-block">

### Agentick Agent

```tsx
function Agent() {
  const [todos, setTodos] = useState<string[]>([]);

  return (
    <>
      <System>You are a todo manager.</System>
      <Tool
        name="add_todo"
        description="Add a todo item"
        input={z.object({ text: z.string() })}
        handler={({ text }) => {
          setTodos((t) => [...t, text]);
          return `Added: ${text}`;
        }}
      />
      <Section title="Current Todos">
        <List>
          {todos.map((t) => (
            <ListItem>{t}</ListItem>
          ))}
        </List>
      </Section>
      <Timeline />
    </>
  );
}
```

</div>
</div>

## The pitch

React renders UI for humans. Agentick renders context for models. Same reconciler, same component model, different target.

Your agent is a React app. Components define what the model sees — system prompts, tools, conversation history, state. The reconciler diffs, hooks manage lifecycle, JSX composes. When state changes, the model sees updated context on the next tick. Same way a DOM update works, but for an LLM's context window.

<div class="code-example">

### Use What You Need

```tsx
// npm install agentick @agentick/openai

// Config object — no JSX required
import { createAgent } from "agentick";
import { openai } from "@agentick/openai";

const agent = createAgent({
  model: openai({ model: "gpt-4o" }),
  system: "You are a helpful assistant.",
  tools: [SearchTool, CalculatorTool],
});

// Component — hooks, children, composition
import { createApp, Agent } from "agentick";

const agent = createApp(() => (
  <Agent
    model={openai({ model: "gpt-4o" })}
    system="You are a helpful assistant."
    tools={[SearchTool, CalculatorTool]}
  >
    <MyCustomKnobs />
  </Agent>
));

// Full JSX — complete control over the context tree
import { createApp, useKnob } from "agentick";
import { OpenAIModel } from "@agentick/openai";

const agent = createApp(() => {
  const [mode, setMode] = useKnob("mode", "helpful", {
    options: ["helpful", "concise", "creative"],
    description: "Response style",
  });

  return (
    <>
      <OpenAIModel model="gpt-4o" />
      <System>You are a {mode} assistant.</System>
      <SearchTool />
      <CalculatorTool />
      <Knobs />
      <Timeline />
    </>
  );
});
```

</div>

<div class="code-example">

### Tools That Render Context

```tsx
const TodoTool = createTool({
  name: "manage_todos",
  description: "Add, complete, or list todos",
  input: z.object({
    action: z.enum(["add", "complete", "list"]),
    text: z.string().optional(),
  }),
  handler: async ({ action, text }, ctx) => {
    if (action === "add") {
      todos.push({ text, done: false });
      ctx?.setState("lastAction", `Added: ${text}`);
    }
    // ...
    return { success: true };
  },
  render: () => (
    <Section id="todos" audience="model">
      <List title="Current Todos" task>
        {todos.map((t) => (
          <ListItem checked={t.done}>{t.text}</ListItem>
        ))}
      </List>
    </Section>
  ),
});
```

The `render` function is a component in the fiber tree. `<List task>` and `<ListItem checked>` are semantic primitives — the compiler renders them appropriately for the model (markdown checkboxes, structured content, etc.). When tool state changes, the reconciler diffs and recompiles. No string templates, no manual prompt assembly.

</div>

<div class="code-example">

### Knobs: Agent Self-Modification

```tsx
function ResearchAgent() {
  const [depth, setDepth] = useKnob("search_depth", 3, {
    min: 1,
    max: 10,
    description: "How many search results to analyze",
  });

  const [style] = useKnob("writing_style", "academic", {
    options: ["academic", "casual", "technical"],
    description: "Output writing style",
  });

  return (
    <>
      <System>
        You are a research assistant. Analyze the top {depth} results. Write in a {style} style.
      </System>
      <SearchTool maxResults={depth} />
      <Knobs />
      <Timeline />
    </>
  );
}
```

One `useKnob` call creates reactive state, renders it to model context as a form control, and registers a `set_knob` tool. The model can adjust its own behavior mid-conversation.

</div>

## Packages

### Core

| Package            | Description                                   |
| ------------------ | --------------------------------------------- |
| `agentick`         | Convenience re-export of @agentick/core       |
| `@agentick/core`   | Reconciler, hooks, JSX, compiler, app         |
| `@agentick/kernel` | Procedures, execution tracking, context (ALS) |
| `@agentick/shared` | Wire-safe types, blocks, messages, streaming  |

### Agent

| Package                | Description                    |
| ---------------------- | ------------------------------ |
| `@agentick/agent`      | High-level createAgent factory |
| `@agentick/guardrails` | Guard system                   |

### Adapters

| Package            | Description           |
| ------------------ | --------------------- |
| `@agentick/openai` | OpenAI adapter        |
| `@agentick/google` | Google Gemini adapter |
| `@agentick/ai-sdk` | Vercel AI SDK adapter |

### Server

| Package             | Description                       |
| ------------------- | --------------------------------- |
| `@agentick/gateway` | Multi-session management, methods |
| `@agentick/server`  | Transport server (SSE, WebSocket) |
| `@agentick/express` | Express.js integration            |
| `@agentick/nestjs`  | NestJS module                     |

### Client

| Package                        | Description                                |
| ------------------------------ | ------------------------------------------ |
| `@agentick/client`             | Browser/Node client for real-time sessions |
| `@agentick/react`              | React hooks & components for UI            |
| `@agentick/angular`            | Angular services & utilities               |
| `@agentick/cli`                | Terminal client for agents                 |
| `@agentick/client-multiplexer` | Multi-tab connection multiplexer           |

### DevTools

| Package              | Description                      |
| -------------------- | -------------------------------- |
| `@agentick/devtools` | Fiber inspector, timeline viewer |

## Install

```bash
npm install agentick @agentick/openai
```

</div>

<style>
.content-section {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

.content-section h2 {
  font-size: 1.8rem;
  margin-top: 3rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--vp-c-divider);
  padding-bottom: 0.5rem;
}

.content-section h3 {
  font-size: 1.3rem;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
  color: var(--vp-c-brand-1);
}

.code-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  margin: 1.5rem 0;
}

@media (max-width: 768px) {
  .code-compare {
    grid-template-columns: 1fr;
  }
}

.code-block {
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  padding: 1rem;
}

.code-block h3 {
  margin-top: 0;
  font-size: 1rem;
  opacity: 0.8;
}

.code-example {
  margin: 2rem 0;
  background: var(--vp-c-bg-soft);
  border-radius: 12px;
  padding: 1.5rem;
  border-left: 3px solid var(--vp-c-brand-1);
}

.code-example h3 {
  margin-top: 0;
}

.code-example p {
  margin-top: 1rem;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.6;
}
</style>
