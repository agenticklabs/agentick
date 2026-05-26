# example-v2-real

End-to-end Agentick v2 example with a **real model** (OpenAI via the AI SDK adapter).

## What this demonstrates

- **Ergonomic API surface** — Vercel-grade target: ~6 setup lines plus a JSX agent.
- **JSX-defined agent** — `<System>` system prompt, `createTool` for inline-handler tools, `useKnob` for model-visible reactive state.
- **`createApp` + `aisdk` + `openai`** — the canonical 3-package wire-up.
- **`app.send(string)`** — the simplest send: a string prompt, a string response (plus tick + usage telemetry).

## Run

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY in .env

pnpm --filter example-v2-real dev
```

## What you'll see

The agent answers `"What's 47 * 23, and tell me a fun fact about that number?"`. The model calls the inline `calculator` tool, then composes a final reply.

```
→ User: What's 47 * 23, and tell me a fun fact about that number?

← Assistant: 47 × 23 = 1081. Fun fact: 1081 is a prime number.

[2 tick(s), 187 tokens, stop=end]
```

(Token counts + exact wording vary by model and run.)

## The whole agent in one file

```tsx
// src/agent.tsx
import { z } from "zod";
import { System, createTool } from "@agentick/reconciler-react";
import { Knobs, useKnob } from "@agentick/knobs/react";

const Calculator = createTool({
  name: "calculator",
  description: "Evaluate a JS arithmetic expression",
  input: z.object({ expression: z.string() }),
  handler: async ({ expression }) => {
    const result = new Function(`"use strict"; return (${expression})`)();
    return [{ type: "text", text: `${expression} = ${result}` }];
  },
});

export function Agent() {
  const [verbose] = useKnob<boolean>("verbose", false, {
    description: "Detailed step-by-step explanations.",
    valueType: "boolean",
  });
  return (
    <>
      <System>
        You are a concise assistant with a calculator tool.
        {verbose ? " Explain step by step." : " Be terse."}
      </System>
      <Calculator.Tool />
      <Knobs />
    </>
  );
}
```

## The whole runner

```ts
// src/index.ts
import "dotenv/config";
import React from "react";
import { createApp } from "@agentick/app";
import { aisdk } from "@agentick/executor-ai-sdk";
import { openai } from "@ai-sdk/openai";
import { Agent } from "./agent.js";

const app = await createApp(React.createElement(Agent), {
  executor: aisdk({ model: openai("gpt-4o-mini") }),
});

const result = await app.send("What's 47 * 23?");
console.log(result.response);
await app.close();
```

## Switching providers

The AI SDK adapter accepts any `ai` package `LanguageModel`. Replace the import + key:

```ts
import { anthropic } from "@ai-sdk/anthropic";
// ...
aisdk({ model: anthropic("claude-3-5-sonnet-latest") })
```

Add the corresponding env var (`ANTHROPIC_API_KEY`) to `.env`.

## Notes

- The `calculator` tool uses `new Function()` for demo simplicity — **do not do this in production**. Wire a real expression parser or sandbox.
- `useKnob` adds a `verbose` knob to the agent. The model can flip it via the `set_knob` tool (auto-emitted by `<Knobs />`). When flipped, the next render's system prompt changes; the model sees the new prompt on the next tick.
- The `Knobs />` component auto-renders the knob group + the `set_knob` tool. Adopters who want full control over presentation use `<Knobs render={...}>`.
