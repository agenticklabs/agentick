# @agentick/openai

Native OpenAI adapter for Agentick.

## Installation

```bash
pnpm add @agentick/openai
```

## Usage

### Factory Pattern (Recommended)

```tsx
import { openai } from "@agentick/openai";
import { createApp } from "@agentick/core";

const model = openai({ model: "gpt-4o" });

// Use with createApp
const app = createApp(MyAgent, { model });
const session = await app.session();
await session.run({ messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }] });

// Or use as JSX component
function MyAgent() {
  return (
    <model temperature={0.9}>
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

### JSX Component Pattern

```tsx
import { OpenAIModel } from "@agentick/openai";

function MyAgent() {
  return (
    <OpenAIModel model="gpt-4o" temperature={0.7} maxTokens={4096}>
      <System>You are helpful.</System>
      <Timeline />
    </OpenAIModel>
  );
}
```

### Azure OpenAI

```tsx
const model = openai({
  apiKey: process.env.AZURE_OPENAI_KEY,
  baseURL: "https://your-resource.openai.azure.com",
  model: "gpt-4o",
});
```

## Configuration

| Option         | Type      | Description                          |
| -------------- | --------- | ------------------------------------ |
| `model`        | `string`  | Model name (e.g., `gpt-4o`)          |
| `apiKey`       | `string?` | OpenAI API key (env: OPENAI_API_KEY) |
| `baseURL`      | `string?` | Custom API endpoint                  |
| `organization` | `string?` | OpenAI organization ID               |
| `temperature`  | `number?` | Sampling temperature (0-2)           |
| `maxTokens`    | `number?` | Maximum tokens to generate           |

## Exports

- `openai(config)` - Factory function returning `ModelClass`
- `createOpenAIModel(config)` - Same as `openai()`
- `OpenAIModel` - JSX component for declarative usage
