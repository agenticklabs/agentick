# Model Adapters

Agentick is model-agnostic. Adapters translate between the framework's compiled context and model-specific APIs.

## Available Adapters

| Package               | Provider      | Models                          |
| --------------------- | ------------- | ------------------------------- |
| `@agentick/openai`    | OpenAI        | GPT-4o, GPT-4, o1, o3          |
| `@agentick/google`    | Google        | Gemini Pro, Flash (API + Vertex) |
| `@agentick/anthropic` | Anthropic     | Claude Opus 4, Sonnet 4, Haiku  |
| `@agentick/bedrock`   | AWS Bedrock   | Claude, Nova, Llama via Bedrock |
| `@agentick/ai-sdk`    | Vercel AI SDK | Any AI SDK-compatible model     |

## Usage as JSX Components

The recommended way — declare the model in your component tree:

```tsx
import { OpenAIModel } from "@agentick/openai";
import { GoogleModel } from "@agentick/google";
import { AnthropicModel } from "@agentick/anthropic";
import { BedrockModel } from "@agentick/bedrock";

function MyAgent() {
  return (
    <>
      <OpenAIModel model="gpt-4o" temperature={0.7} />
      {/* or: <AnthropicModel model="claude-sonnet-4-20250514" /> */}
      {/* or: <BedrockModel model="us.anthropic.claude-sonnet-4-20250514-v1:0" /> */}
      <System>You are helpful.</System>
      <Timeline />
    </>
  );
}
```

Because the model is a component, it's dynamic:

```tsx
function MyAgent({ useGoogle }: { useGoogle: boolean }) {
  return (
    <>
      {useGoogle ? <GoogleModel model="gemini-2.0-flash" /> : <OpenAIModel model="gpt-4o" />}
      <System>You are helpful.</System>
      <Timeline />
    </>
  );
}
```

## Usage as Factory Functions

For config objects (e.g. `createAgent`), use the lowercase factory:

```tsx
import { openai } from "@agentick/openai";
import { google } from "@agentick/google";
import { anthropic } from "@agentick/anthropic";
import { bedrock } from "@agentick/bedrock";

// Returns a ModelClass
const model = openai({ model: "gpt-4o", temperature: 0.7 });
// or: anthropic({ model: "claude-sonnet-4-20250514" })
// or: bedrock({ model: "us.anthropic.claude-sonnet-4-20250514-v1:0", region: "us-east-1" })

// Use with createAgent
const agent = createAgent({
  model: openai({ model: "gpt-4o" }),
  system: "You are helpful.",
});

// Or pass to <Agent> component
<Agent model={openai({ model: "gpt-4o" })} />;
```

The lowercase factory returns a `ModelClass` — both a callable and a value that `<Agent>` wraps in a `<Model>` component internally.

## Vercel AI SDK Adapter

Use any model supported by the Vercel AI SDK:

```tsx
import { aiSdk } from "@agentick/ai-sdk";
import { openai } from "@ai-sdk/openai";

const model = aiSdk({ model: openai("gpt-4") });

const agent = createAgent({
  model,
  system: "You are helpful.",
});
```

## Building Custom Adapters

Implement four methods with `createAdapter`:

```tsx
import { createAdapter } from "@agentick/core/model";

const MyProvider = createAdapter({
  metadata: {
    id: "my-provider",
    provider: "my-provider",
    type: "language",
  },

  prepareInput(input, config) {
    // Transform compiled context → provider-specific format
    return { messages: input.messages, model: config.model };
  },

  processOutput(output) {
    // Transform provider response → ModelOutput
    return { messages: [...], usage: {...}, stopReason: ... };
  },

  async execute(input) {
    // Non-streaming call
    return await myApi.chat(input);
  },

  async *executeStream(input) {
    // Streaming call — yield provider chunks
    for await (const chunk of myApi.chatStream(input)) {
      yield chunk;
    }
  },

  mapChunk(chunk) {
    // Transform provider chunks → AdapterDelta
    return { type: "text", delta: chunk.content };
  },
});
```

`createAdapter` returns a `ModelClass` — usable as both a JSX component and a programmatic value.

See `packages/adapters/README.md` for comprehensive documentation.
