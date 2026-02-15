---
layout: home
hero:
  name: agentick
  text: The component framework for AI.
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
  - icon: 🔌
    title: Connectors
    details: Bridge agents to Telegram, iMessage, or any platform. Content filtering, delivery timing, rate limiting, and tool confirmations — adapters just handle I/O.
  - icon: 🏗️
    title: Session Architecture
    details: Sessions manage identity, persistence, spawn/fork. The reconciler is an implementation detail. Scale from one agent to thousands.
---

<div class="content-section">

## You already know this

If you've used React, you've already learned 80% of agentick. The remaining 20% is AI-specific primitives — tools, timeline, model context — built on the same component model.

<div class="code-compare">
<div class="code-block">

### React — renders UI for humans

```tsx
function TodoApp() {
  const [todos, setTodos] = useState<string[]>([]);
  const [input, setInput] = useState("");

  return (
    <div>
      <h1>Todo List</h1>
      <input value={input} onChange={(e) => setInput(e.target.value)} />
      <button
        onClick={() => {
          setTodos((t) => [...t, input]);
          setInput("");
        }}
      >
        Add
      </button>
      <ul>
        {todos.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
```

</div>
<div class="code-block">

### Agentick — renders context for models

```tsx
function TodoAgent() {
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

Same `useState`, same JSX, same component model. The React app renders a `<div>` for a browser. The agent renders `<System>`, `<Tool>`, and `<Section>` for an LLM's context window. When state changes, the reconciler diffs and recompiles — just like a DOM update.

## Quick Start

```bash
npm install agentick @agentick/openai
```

```tsx
import { createAgent } from "agentick";
import { openai } from "@agentick/openai";

const agent = createAgent({
  model: openai({ model: "gpt-4o" }),
  system: "You are a helpful assistant.",
  tools: [SearchTool, CalculatorTool],
});

const result = await agent.run({
  messages: [{ role: "user", content: "Hello!" }],
});
```

Five lines to a working agent. No JSX required. Want more control? Keep reading.

<div class="cta-buttons">
  <a href="/docs/getting-started" class="cta-button primary">Read the Docs</a>
  <a href="https://github.com/agenticklabs/agentick" class="cta-button secondary">View on GitHub</a>
</div>

## Going Deeper

<div class="code-example">

### Full JSX Control

When you need composition, hooks, and full control over the context tree:

```tsx
import { createApp, useKnob } from "agentick";
import { OpenAIModel } from "@agentick/openai";

const app = createApp(() => {
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

`createAgent` and full JSX are the same thing underneath — `createAgent` just wraps `<Agent>` in a `createApp` call. Start simple, eject when you need to.

</div>

<div class="code-example">

### Tools That Render Context

Tools aren't just functions the model calls. They're components in the fiber tree with their own render output:

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

The `render` function lives in the fiber tree. `<List task>` and `<ListItem checked>` are semantic primitives — the compiler renders them as markdown checkboxes, structured content, whatever the model needs. When tool state changes, the reconciler diffs and recompiles. No string templates.

</div>

<div class="code-example">

### Knobs: Agent Self-Modification

One hook creates reactive state, renders it to model context, and registers a tool — the model can adjust its own behavior mid-conversation:

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

The model sees the knobs as form controls in its context and gets a `set_knob` tool to change them. The agent decides mid-conversation that it needs more search depth? It sets the knob, the state updates, the context recompiles, next tick sees the new value.

</div>

<div class="code-example">

### Multi-Turn Agent Loops

Hooks control the tick loop — how many times the model runs, what happens between turns, and when to stop:

```tsx
function DeepResearchAgent() {
  const [sources, setSources] = useState<Source[]>([]);

  // Keep running until we have enough sources
  useContinuation((result) => sources.length < 5);

  // Log after each model turn
  useOnTickEnd((result, ctx) => {
    console.log(`Tick ${ctx.tick}: ${sources.length} sources`);
  });

  return (
    <>
      <System>
        Find and analyze sources. Use the search tool repeatedly until you have at least 5 quality
        sources.
      </System>
      <SearchTool onResult={(s) => setSources((prev) => [...prev, s])} />
      <Section title="Sources Found">
        <List>
          {sources.map((s) => (
            <ListItem key={s.url}>{s.title}</ListItem>
          ))}
        </List>
      </Section>
      <Timeline />
    </>
  );
}
```

`useContinuation` controls whether the agent keeps running. `result.shouldContinue` shows the framework's default; return nothing to defer, or override with a boolean or `{ stop/continue: true, reason? }`. Same lifecycle model as React effects — `useOnMount`, `useOnTickStart`, `useOnTickEnd`, `useAfterCompile`.

</div>

<div class="code-example">

### Deploy It

Serve agents over HTTP with sessions, auth, and real-time streaming:

```tsx
import { createGateway } from "@agentick/gateway";

const gateway = createGateway({
  port: 3000,
  apps: {
    assistant: createApp(() => <AssistantAgent />),
    research: createApp(() => <DeepResearchAgent />),
  },
  defaultApp: "assistant",
  auth: {
    type: "token",
    token: process.env.API_TOKEN,
  },
});

await gateway.start();
```

Gateway manages sessions, handles SSE streaming to clients, and supports custom RPC methods. Use `@agentick/client` to connect from browsers, or `@agentick/express` and `@agentick/nestjs` to embed into existing apps.

</div>

## Get Started

<div class="get-started-grid">
<div class="get-started-install">

```bash
npm install agentick @agentick/openai
```

</div>
<div class="get-started-actions">
  <a href="/docs/getting-started" class="cta-button primary">Read the Docs</a>
  <a href="https://github.com/agenticklabs/agentick" class="cta-button secondary">View on GitHub</a>
</div>
</div>

</div>

<style>
.content-section {
  max-width: 1152px;
  margin: 0 auto;
  padding: 2rem 0;
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

.get-started-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: center;
}

.get-started-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

@media (max-width: 768px) {
  .get-started-grid {
    grid-template-columns: 1fr;
  }

  .get-started-actions {
    grid-template-columns: 1fr;
  }
}

.cta-buttons {
  display: flex;
  gap: 1rem;
  margin-top: 1.5rem;
}

.cta-button {
  display: inline-block;
  padding: 0.75rem 2rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 1rem;
  text-decoration: none;
  transition: opacity 0.2s;
}

.cta-button:hover {
  opacity: 0.85;
}

.cta-button.primary {
  background: var(--vp-c-brand-1);
  color: white;
}

.cta-button.secondary {
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-1);
}
</style>
