# @agentick/ai-sdk

Vercel AI SDK adapter for Agentick. Use any AI SDK provider (OpenAI, Anthropic, Google, Mistral, etc.).

## Installation

```bash
pnpm add @agentick/ai-sdk ai @ai-sdk/openai
# or @ai-sdk/anthropic, @ai-sdk/google, etc.
```

## Usage

### Factory Pattern (Recommended)

```tsx
import { createAiSdkModel } from "@agentick/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { createApp } from "@agentick/core";

const model = createAiSdkModel({
  model: openai("gpt-4o"),
  temperature: 0.7,
});

// Use with createApp
const app = createApp(MyAgent, { model });
const session = await app.session();
await session.run({ messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }] });

// Or use as JSX component
function MyAgent() {
  return (
    <model maxTokens={4096}>
      <System>You are helpful.</System>
      <Timeline />
    </model>
  );
}

// Or call directly
const result = await model.generate({
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Multiple Providers

```tsx
import { createAiSdkModel } from "@agentick/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

// OpenAI
const gpt4 = createAiSdkModel({ model: openai("gpt-4o") });

// Anthropic
const claude = createAiSdkModel({ model: anthropic("claude-3-5-sonnet-20241022") });

// Google
const gemini = createAiSdkModel({ model: google("gemini-2.0-flash") });
```

### JSX Component Pattern

```tsx
import { AiSdkModel } from "@agentick/ai-sdk";
import { openai } from "@ai-sdk/openai";

function MyAgent() {
  return (
    <AiSdkModel model={openai("gpt-4o")} temperature={0.7} maxTokens={4096}>
      <System>You are helpful.</System>
      <Timeline />
    </AiSdkModel>
  );
}
```

## Configuration

| Option        | Type            | Description                |
| ------------- | --------------- | -------------------------- |
| `model`       | `LanguageModel` | AI SDK model instance      |
| `temperature` | `number?`       | Sampling temperature       |
| `maxTokens`   | `number?`       | Maximum tokens to generate |
| `system`      | `string?`       | Default system prompt      |
| `tools`       | `ToolSet?`      | AI SDK tools to include    |

## Supported Providers

Any provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/providers):

- OpenAI (`@ai-sdk/openai`)
- Anthropic (`@ai-sdk/anthropic`)
- Google (`@ai-sdk/google`)
- Mistral (`@ai-sdk/mistral`)
- Cohere (`@ai-sdk/cohere`)
- Azure (`@ai-sdk/azure`)
- Amazon Bedrock (`@ai-sdk/amazon-bedrock`)
- And more...

## Exports

- `aiSdk(config)` - Convenience factory (recommended)
- `createAiSdkModel(config)` - Full factory function returning `ModelClass`
