# Getting Started

## Install

```bash
npm install agentick @agentick/openai
```

Or with the scoped packages directly:

```bash
npm install @agentick/core @agentick/openai
```

## Your first agent

```tsx
import { createApp, run } from "agentick";
import { OpenAIModel } from "@agentick/openai";

const app = createApp(() => (
  <>
    <OpenAIModel model="gpt-4o" />
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
));

const result = await app.run({
  messages: [{ role: "user", content: "Hello!" }],
}).result;

console.log(result.response);
```

The model is a component in the tree — `<OpenAIModel model="gpt-4o" />`. It declares which model this app uses, and because it's in the component tree, it's dynamic. You can swap models conditionally, pass different configs based on state, or even switch providers mid-conversation.

## Add a tool

```tsx
import { createApp, createTool } from "agentick";
import { OpenAIModel } from "@agentick/openai";
import { z } from "zod";

const Calculator = createTool({
  name: "calculate",
  description: "Evaluate a math expression",
  input: z.object({ expression: z.string() }),
  handler: ({ expression }) => {
    return String(eval(expression));
  },
});

const app = createApp(() => (
  <>
    <OpenAIModel model="gpt-4o" />
    <System>You are a helpful assistant with a calculator.</System>
    <Calculator />
    <Timeline />
  </>
));

const result = await app.run({
  messages: [{ role: "user", content: "What is 42 * 17?" }],
}).result;
```

When the model calls `calculate`, agentick executes the handler, adds the result to the timeline, and runs another tick. Multi-turn tool use is automatic.

## One-shot with `run`

For quick one-off calls without creating an app first:

```tsx
import { run } from "agentick";
import { OpenAIModel } from "@agentick/openai";

function MyAgent() {
  return (
    <>
      <OpenAIModel model="gpt-4o" />
      <System>You are a helpful assistant.</System>
      <Timeline />
    </>
  );
}

const result = await run(<MyAgent />, {
  messages: [{ role: "user", content: "Hello!" }],
}).result;
```

`run` creates a temporary app and session, sends the message, and returns the result. The model is still declared in the component tree.

## Use createAgent for less boilerplate

```tsx
import { createAgent } from "agentick";
import { openai } from "@agentick/openai";

const agent = createAgent({
  model: openai({ model: "gpt-4o" }),
  system: "You are a helpful assistant.",
  tools: [Calculator],
});

const result = await agent.run({
  messages: [{ role: "user", content: "What is 42 * 17?" }],
}).result;
```

`createAgent` wraps `createApp` with an `<Agent>` component that handles system prompts, tools, timeline, and knobs. Same thing under the hood — less typing. The `openai()` factory (lowercase) returns a `ModelClass` that `<Agent>` wraps in a `<Model>` component internally.

## Sessions for multi-turn

For ongoing conversations, use sessions:

```tsx
const session = await app.session({ id: "user-123" });

// First turn
await session.send({
  messages: [{ role: "user", content: "Remember: my name is Ryan." }],
});

// Second turn — the model remembers
const result = await session.send({
  messages: [{ role: "user", content: "What's my name?" }],
}).result;
```

Sessions manage conversation history, component state, and identity across turns.

## Dynamic models

Because the model is a component, you can make it dynamic:

```tsx
const app = createApp(() => {
  const [provider] = useKnob("provider", "openai", {
    options: ["openai", "google"],
    description: "Which model provider to use",
  });

  return (
    <>
      {provider === "openai" ? (
        <OpenAIModel model="gpt-4o" />
      ) : (
        <GoogleModel model="gemini-2.0-flash" />
      )}
      <System>You are a helpful assistant.</System>
      <Knobs />
      <Timeline />
    </>
  );
});
```

The model can switch mid-conversation. Standard conditional rendering.

## Next steps

- [Components & JSX](/docs/components) — how the fiber tree works
- [Hooks](/docs/hooks) — lifecycle, state, reactive patterns
- [Tools](/docs/tools) — stateful tools, render functions
- [Knobs](/docs/knobs) — model-settable reactive state
