# @agentick/anthropic

Native Anthropic Messages API adapter for Agentick.

## Installation

```bash
pnpm add @agentick/anthropic @anthropic-ai/sdk
```

## Usage

### Factory Pattern (Recommended)

```tsx
import { anthropic } from "@agentick/anthropic";
import { createApp } from "@agentick/core";

const model = anthropic("claude-sonnet-4-20250514");

// Use with createApp
const app = createApp(MyAgent, { model });
const session = await app.session();
await session.run({ messages: [{ role: "user", content: [{ type: "text", text: "Hello!" }] }] });

// Or with config object
const model = anthropic({
  model: "claude-opus-4-20250514",
  maxTokens: 8192,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

### JSX Component Pattern

```tsx
import { AnthropicModel } from "@agentick/anthropic";

function MyAgent() {
  return (
    <AnthropicModel model="claude-sonnet-4-20250514" maxTokens={4096}>
      <System>You are helpful.</System>
      <Timeline />
    </AnthropicModel>
  );
}
```

## Features

- **Streaming** - Full streaming support with deltas
- **Tool calling** - Native Anthropic tool use
- **Extended thinking** - Reasoning/thinking blocks from supported models
- **Vision** - Image understanding via base64 or URL
- **Prompt caching** - Anthropic cache control support
- **Documents** - PDF and document content blocks

## Configuration

| Option            | Type       | Description                                         |
| ----------------- | ---------- | --------------------------------------------------- |
| `model`           | `string`   | Model name (e.g., `claude-sonnet-4-20250514`)       |
| `apiKey`          | `string?`  | API key (env: `ANTHROPIC_API_KEY`)                   |
| `baseURL`         | `string?`  | Custom API endpoint (env: `ANTHROPIC_BASE_URL`)      |
| `maxTokens`       | `number?`  | Maximum tokens to generate                           |
| `headers`         | `object?`  | Additional request headers                           |
| `timeout`         | `number?`  | Request timeout in milliseconds                      |
| `maxRetries`      | `number?`  | Maximum retry attempts                               |
| `client`          | `Anthropic?` | Pre-configured Anthropic SDK client instance       |
| `customBlocks`    | `object?`  | Custom block definitions to intercept from output    |
| `deltaTransform`  | `function?`| User-facing delta transform                          |

## Environment Variables

| Variable              | Description          |
| --------------------- | -------------------- |
| `ANTHROPIC_API_KEY`   | Anthropic API key    |
| `ANTHROPIC_BASE_URL`  | Custom API endpoint  |

## Models

- `claude-opus-4-20250514`
- `claude-sonnet-4-20250514`
- `claude-3-5-haiku-20241022`
- `claude-3-5-sonnet-20241022`

## Exports

- `anthropic(configOrModel)` - Factory function returning `ModelClass`
- `createAnthropicModel(config)` - Same as `anthropic()`
- `AnthropicModel` - JSX component for declarative usage
