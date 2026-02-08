# @agentick/agent

Opinionated agent composition for Agentick. Provides the `<Agent>` component and `createAgent()` factory — high-level building blocks on top of `@agentick/core` primitives.

## Installation

```bash
pnpm add @agentick/agent
```

## Quick Start

### Level 0: No JSX Required

```typescript
import { createAgent } from "@agentick/agent";
import { knob } from "@agentick/core";
import { openai } from "@agentick/openai";

const agent = createAgent({
  system: "You are a helpful researcher.",
  model: openai("gpt-4o"),
  tools: [SearchTool, Calculator],
  knobs: {
    mode: knob("broad", { description: "Search mode", options: ["broad", "deep"] }),
  },
});

const session = await agent.session();
await session.send({
  messages: [{ role: "user", content: [{ type: "text", text: "Research quantum computing" }] }],
}).result;
```

### Level 1: JSX Component

```tsx
import { Agent } from "@agentick/agent";
import { useKnob, createApp } from "@agentick/core";
import { openai } from "@agentick/openai";

function MyAgent() {
  const [verbose] = useKnob("verbose", false, { description: "Verbose output" });

  return (
    <Agent
      system={`You are a researcher. ${verbose ? "Be thorough." : "Be concise."}`}
      model={openai("gpt-4o")}
      tools={[SearchTool]}
      temperature={0.7}
      tokenBudget={{ maxTokens: 8000, headroom: 500 }}
    >
      <MyCustomSection />
    </Agent>
  );
}

const app = createApp(MyAgent);
```

## API

### `<Agent>` Component

Renders common agent boilerplate in order:

1. Model configuration
2. System prompt section
3. Tool components
4. Knob bindings
5. Declarative sections
6. User's children
7. `<Knobs />` section + `set_knob` tool
8. Timeline (with optional budget props)

#### Props

| Prop              | Type                             | Description                                         |
| ----------------- | -------------------------------- | --------------------------------------------------- |
| `system`          | `string`                         | System prompt (rendered as a model-visible section) |
| `model`           | `EngineModel`                    | Model adapter                                       |
| `tools`           | `ToolClass[]`                    | Tools the model can call                            |
| `knobs`           | `Record<string, KnobDescriptor>` | Declarative knobs (each bound via `useKnob`)        |
| `children`        | `ReactNode`                      | Additional children (sections, tools, etc.)         |
| `responseFormat`  | `ResponseFormat`                 | Structured output format                            |
| `temperature`     | `number`                         | Sampling temperature                                |
| `maxTokens`       | `number`                         | Max output tokens                                   |
| `topP`            | `number`                         | Top-p (nucleus) sampling                            |
| `providerOptions` | `ProviderGenerationOptions`      | Provider-specific options                           |
| `timeline`        | `AgentTimelineConfig \| false`   | Timeline options, or `false` to suppress            |
| `tokenBudget`     | `AgentTokenBudgetConfig`         | Token budget for timeline compaction                |
| `sections`        | `AgentSectionConfig[]`           | Declarative sections rendered in order              |

#### Token Budget

Control timeline compaction via the `tokenBudget` prop:

```tsx
<Agent
  tokenBudget={{
    maxTokens: 4000,
    strategy: "sliding-window",  // "truncate" | "sliding-window" | custom function
    headroom: 500,               // reserve tokens for safety margin
    onEvict: (entries) => console.log(`Evicted ${entries.length} entries`),
  }}
/>
```

The budget props are forwarded to `<Timeline>`. See the core README for details on compaction strategies.

#### Response Format

Request structured output via the `responseFormat` prop:

```tsx
// JSON output
<Agent model={model} responseFormat={{ type: "json" }} />

// JSON Schema (structured output)
<Agent
  model={model}
  responseFormat={{
    type: "json_schema",
    schema: { type: "object", properties: { answer: { type: "string" } } },
    name: "response",
  }}
/>
```

For Zod schemas, call `zodToJsonSchema()` yourself. The format is forwarded to `<Model>` and mapped to the provider's native format by the adapter.

#### Timeline Config

```tsx
// Suppress timeline entirely
<Agent timeline={false} />

// Filter timeline
<Agent timeline={{ limit: 20, roles: ["user", "assistant"] }} />
```

#### Declarative Sections

```tsx
<Agent
  sections={[
    { id: "context", content: "Today is Monday." },
    { id: "rules", content: <MyRulesComponent />, audience: "model" },
  ]}
/>
```

### `createAgent(config, options?)`

Create an `App` from a config object — no JSX required.

```typescript
const app = createAgent(
  {
    system: "You are helpful.",
    model: openai("gpt-4o"),
    tools: [SearchTool],
  },
  { maxTicks: 10 },
);

const result = await app.run({ messages: [...] }).result;
```

`config` accepts all `AgentProps` except `children`. For conditional tools, hooks, or composition, use `<Agent>` directly.

### `agentComponent(config)`

Convert an `AgentConfig` to a `ComponentFunction` for use with `session.spawn()`:

```typescript
const result = await ctx.spawn(
  agentComponent({ system: "Summarize this.", model: summaryModel }),
  { messages: [...] },
);
```

## Exports

```typescript
// Components
export { Agent } from "./agent";
export { createAgent, agentComponent } from "./create-agent";

// Types
export type { AgentProps, AgentTokenBudgetConfig, AgentTimelineConfig, AgentSectionConfig } from "./agent";
export type { AgentConfig } from "./create-agent";
```
