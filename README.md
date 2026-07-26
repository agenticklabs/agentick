# agentick

**The component framework for AI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-reconciler-blue?style=for-the-badge&logo=react&logoColor=white)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)

A React reconciler whose render target is a **language model.** You build the
context window with JSX — the same components, hooks, and composition you already
know — and the framework compiles it into what the model sees. When the model
calls a tool, your component re-renders. When you want older messages compressed,
you write a component. The model's entire world is a tree you control.

```tsx
import { System, createTool } from "@agentick/compiler-react";
import { Knobs, useKnob } from "@agentick/knobs/react";
import { Timeline } from "@agentick/timeline/react";
import { z } from "zod";

const Calculator = createTool({
  name: "calculator",
  description: "Evaluate an arithmetic expression.",
  inputSchema: z.object({ expression: z.string() }),
  handler: async ({ expression }) => {
    const result = new Function(`"use strict"; return (${expression})`)();
    return [{ type: "text", text: `${expression} = ${result}` }];
  },
});

export function Agent() {
  const [verbose] = useKnob<boolean>("verbose", false, {
    description: "When true, explain each step.",
    valueType: "boolean",
  });

  return (
    <>
      <System>
        You are a concise assistant with a calculator. Use it for any arithmetic.
        {verbose ? " Explain your reasoning step by step." : " Be terse."}
      </System>
      <Calculator.Tool />
      <Knobs /> {/* renders the set_knob tool — the model can flip `verbose` itself */}
      <Timeline /> {/* THE conversation — it reaches the model only because you render it */}
    </>
  );
}
```

```tsx
import { createApp } from "@agentick/app/react";
import { aisdk } from "@agentick/model-ai-sdk";
import { openai } from "@ai-sdk/openai";

const app = await createApp(<Agent />, { model: aisdk(openai("gpt-4o-mini")) });
const session = await app.createSession();

const handle = await session.send({
  messages: [{ role: "user", content: "What's 47 * 23, and a fun fact about it?" }],
});
const { response, ticks, usage } = await handle.result;
console.log(response, `(${ticks} ticks, ${usage.totalTokens} tokens)`);
```

> **v2 is in active development on the `feat/v2` branch.** Everything below is the
> v2 surface — the `@agentick/*-next` packages. They are **private workspace
> packages, not yet on npm**; a single-install `agentick` metapackage that bundles
> them is on the way. Until then, run v2 from this repo — see **Quick start**.
> [`example/v2-real`](example/v2-real) is the canonical, runnable reference; its
> `src/` is the source of truth for every snippet here.

## Quick start

v2 isn't published yet, so the way to run it today is the example in this repo:

```bash
git clone https://github.com/agenticklabs/agentick && cd agentick
pnpm install

cp example/v2-real/.env.example example/v2-real/.env   # add your OPENAI_API_KEY
pnpm --filter example-v2-real dev
```

Building your own agent in the monorepo, you compose the `-next` packages
directly (the calculator above uses five): `@agentick/app`,
`@agentick/compiler-react`, `@agentick/knobs`, `@agentick/timeline`,
and a model adapter (`@agentick/model-ai-sdk` + an `@ai-sdk/*` provider).
Your `tsconfig.json` needs React JSX:

```json
{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react" } }
```

## The idea

Every other framework gives you a pipeline — a chain, a graph. You slot a prompt
into a template, bolt on tools, and hope the model figures it out.

Agentick gives you a **programming language for the context window.** The one rule
that follows from "JSX renders to a model" is:

> **Only what you render reaches the model.**

`<Timeline>` isn't a black box — render it and history reaches the model; don't,
and it doesn't. A tool renders its state back into the context every tick, so the
model sees the current state _every time it thinks_. A knob is a value the model
can read **and set** through a tool call — flip it, your agent re-renders, its
prompt changes. There are no prompt templates because JSX _is_ the template
language, and nothing sits between you and what the model reads: you build it, the
framework compiles it, the model reads it.

## Building blocks

Everything in the tree compiles to what the model sees. A curated set — each
package's README has the full surface.

**Messages & context** — `@agentick/compiler-react`

```tsx
import { System, User, Assistant, Section } from "@agentick/compiler-react";

<System>You are a support agent.</System>
<Section id="account" audience="model">
  Plan: {plan}, seat count: {seats}   {/* structured, live context, refreshed every tick */}
</Section>
```

`<Section audience="model" | "user" | "all">` injects structured context. Semantic
components (`<H1>`–`<H3>`, `<Paragraph>`, …) compile to renderer-appropriate output
(markdown, XML) so you never hand-format strings — see the
[`@agentick/compiler-react` README](packages/compiler-react/README.md)
for the full set.

**The timeline is yours to shape** — `@agentick/timeline/react`

`<Timeline />` with no children renders history with sensible defaults. Pass a
render function — `(entries, budget) => ReactNode` — and you decide exactly how each
message appears — compress old turns, drop images, collapse tool results:

```tsx
<Timeline>
  {(entries) =>
    entries.map((e, i) =>
      i < entries.length - 4 ? (
        <Message key={e.message.id ?? i} role={e.message.role}>
          [earlier turn]
        </Message>
      ) : (
        <Message key={e.message.id ?? i} {...e.message} />
      ),
    )
  }
</Timeline>
```

The render function also receives `budget` (a `TokenBudgetInfo | null`) so you can
compact against a live token ceiling.

**Tools** — `@agentick/tool` + `@agentick/compiler-react`

`createTool` bundles a Zod-validated schema with an inline handler that returns
content blocks. Mount it as `<MyTool.Tool />`. Tools can also `render()` state
back into context and be dispatched without the model — see
[`@agentick/tool`](packages/tool/README.md).

**Knobs** — model-visible, model-settable state — `@agentick/knobs/react`

```tsx
const [section] = useKnob("section", "none", {
  options: ["none", "api", "billing"],
  description: "Expand a docs section",
  momentary: true, // auto-collapses after each turn
});
```

The model sees collapsed headers, sets the knob, reads the expanded content,
answers — so only what it needs consumes tokens. `<Knobs />` renders the current
values plus the `set_knob` tool.

**Gates** — named exit conditions — `@agentick/gates`

```tsx
import { gate, useGate } from "@agentick/gates/react";

const verifyGate = gate({
  description: "Verify changes before finishing",
  activateWhen: (r) => r.toolCalls.some((t) => t.name === "write_file"),
});

function CodingAgent() {
  const verify = useGate("verify", verifyGate);
  return (
    <>
      <System>You are a coding agent.</System>
      <Timeline />
      {verify.element}
    </>
  );
}
```

A gate blocks the model from completing until it clears — latch gates the model
attests via `set_knob`; verified gates clear themselves when a code predicate
passes (so they can't be bypassed).

## Sessions, executions, ticks

A **session** is a long-lived conversation. Each `send()` is one **execution**
(user message → response). Each model API call within it is a **tick** —
multi-tick executions happen automatically with tool use.

```
Session
├── Execution 1  "hello"          → tick 1 → response
├── Execution 2  "use calculator" → tick 1 (tool_use) → tick 2 (answer)
└── …
```

`session.send(...)` returns a handle that is both an `AsyncIterable` of stream
events and a `.result` promise:

```tsx
// await the final result…
const { response, ticks, usage, stopReason } = await handle.result;

// …or stream as it happens
for await (const event of handle) {
  if (event.type === "content-delta") process.stdout.write(event.delta);
}
```

## Structured results

Ask for a shape; get a typed, validated value back:

```tsx
const { data } = await (
  await session.send({
    messages: [{ role: "user", content: "Summarize this ticket." }],
    output: z.object({
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      tags: z.array(z.string()),
    }),
  })
).result;
```

When the turn has tools, agentick does **not** force every token through a
JSON schema. It injects a **terminal tool** whose input schema _is_ your
output schema; the model calls it to deliver the final answer, and that
call ends the execution — **"done" and "shaped" are the same event.**
Validation is provider-enforced tool-argument constraint (every provider,
including Anthropic), the model keeps its full voice on intermediate
ticks, and prose + data ride the same final turn (`response` + `data`,
`stopReason: "output_delivered"`).

The guarantee ladder is explicit, not hopeful: description-driven natural
path → one forced wrap-up tick (`tool_choice` forcing — a hard provider
guarantee) → typed error in the residual sliver. A nonconforming answer
**rejects** (`ResponseValidationError`); you never receive a malformed
object.

Tree tier: `<Output schema={...} />` declares "every execution of this
agent produces this shape"; send-level `output` overrides it per
execution. Bare sends without tools use provider-native `responseFormat`
instead — the same machinery behind `generateObject`. Full guide:
[`docs/proposals/v2/guide-structured-outputs.md`](docs/proposals/v2/guide-structured-outputs.md).

## The package landscape

v2 is composed of focused `@agentick/*-next` packages (the metapackage will bundle
the built-ins into one install). The ones you touch building an agent:

| Package                    | What it gives you                                                     |
| -------------------------- | --------------------------------------------------------------------- |
| `@agentick/app`            | `createApp` — the runtime root; `/react` gives the reconciler         |
| `@agentick/compiler-react` | JSX components + `createTool` (the React surface)                     |
| `@agentick/timeline`       | `<Timeline>` — the conversation, yours to shape                       |
| `@agentick/knobs`          | `useKnob` / `<Knobs>` — model-settable state                          |
| `@agentick/gates`          | `gate` / `useGate` — named exit conditions                            |
| `@agentick/tool`           | `createTool`, transforms, dispatch                                    |
| `@agentick/model-ai-sdk`   | `aisdk(...)` — wrap any Vercel AI SDK provider                        |
| `@agentick/session`        | the session harness (send / dispatch / spawn / channels)              |
| `@agentick/gateway`        | multi-app server + wire + auth ([README](packages/gateway/README.md)) |
| `@agentick/client`         | the client that talks to a gateway over the wire                      |
| `@agentick/mcp`            | connect to / expose Model Context Protocol servers                    |

Foundations (`spec`, `runtime`, `pubsub`, `utils`) sit
underneath; you rarely import them directly.

## Status & docs

v2 is **pre-release**, moving fast on `feat/v2`. The v1 line lives under
`packages/` and remains the stable published release.

- **[`example/v2-real`](example/v2-real)** — the runnable reference agent.
- **[`docs/proposals/v2/STATUS.md`](docs/proposals/v2/STATUS.md)** — the running progress log.
- **[`docs/proposals/v2/blueprint/`](docs/proposals/v2/blueprint/)** — the architecture ADRs (start with `00-overview.md`).
- Every package has its own README with the full API.

## License

MIT
