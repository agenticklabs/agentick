---
name: create-adapter
description: Create a new model adapter for agentick. Use when asked to add support for a new model provider (Anthropic, Mistral, Cohere, etc).
---

# Create a Model Adapter

Model adapters translate between agentick's compiled context and a model provider's API.

## Steps

1. Create a new adapter package:

```bash
mkdir -p packages/adapters/my-provider/src
```

2. Create `packages/adapters/my-provider/package.json`:

```json
{
  "name": "@agentick/my-provider",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@agentick/core": "workspace:*",
    "@agentick/shared": "workspace:*"
  },
  "peerDependencies": {
    "my-provider-sdk": "^1.0.0"
  }
}
```

3. Create `packages/adapters/my-provider/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

4. Implement the adapter in `packages/adapters/my-provider/src/index.ts`:

```typescript
import { createAdapter } from "@agentick/core/model";

export interface MyProviderConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
}

export const MyProviderModel = createAdapter({
  metadata: {
    id: "my-provider",
    provider: "my-provider",
    type: "language",
  },

  prepareInput(input, config: MyProviderConfig) {
    // Transform CompiledStructure → provider-specific request format
    return {
      model: config.model,
      messages: convertMessages(input.messages),
      tools: convertTools(input.tools),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    };
  },

  processOutput(output) {
    // Transform provider response → ModelOutput
    return {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: output.content }],
        },
      ],
      usage: {
        inputTokens: output.usage?.input_tokens ?? 0,
        outputTokens: output.usage?.output_tokens ?? 0,
      },
      stopReason: mapStopReason(output.stop_reason),
    };
  },

  async execute(input) {
    // Non-streaming API call
    const client = new MyProviderClient({ apiKey: input.apiKey });
    return await client.chat(input);
  },

  async *executeStream(input) {
    // Streaming API call — yield raw provider chunks
    const client = new MyProviderClient({ apiKey: input.apiKey });
    for await (const chunk of client.chatStream(input)) {
      yield chunk;
    }
  },

  mapChunk(chunk) {
    // Transform provider chunk → AdapterDelta (or null to skip)
    if (chunk.type === "content_block_delta") {
      return { type: "text", delta: chunk.delta.text };
    }
    if (chunk.type === "tool_use") {
      return { type: "tool_call", name: chunk.name, input: chunk.input };
    }
    return null; // Skip irrelevant chunks
  },
});

// Export lowercase factory (convention)
export const myProvider = MyProviderModel;
```

5. `createAdapter` returns a `ModelClass` — both a JSX component and a factory function.

## Usage Patterns

```tsx
// JSX (best practice — dynamic, conditional):
<MyProviderModel model="my-model-v1" temperature={0.7} />;

// Factory:
const model = myProvider({ model: "my-model-v1" });

// With createAgent:
const agent = createAgent({ model: myProvider({ model: "my-model-v1" }) });
```

## Reference Adapters

Study these existing adapters:

| Adapter | Path                            | Notes                                           |
| ------- | ------------------------------- | ----------------------------------------------- |
| OpenAI  | `packages/adapters/openai/src/` | Native API, streaming with separate usage chunk |
| Google  | `packages/adapters/google/src/` | Gemini API                                      |
| AI SDK  | `packages/adapters/ai-sdk/src/` | Wraps Vercel AI SDK LanguageModel               |

## Key Files

- `createAdapter`: `packages/core/src/model/`
- Adapter docs: `packages/adapters/README.md`
- Existing adapters: `packages/adapters/*/src/index.ts`

## Verification

```bash
pnpm install
pnpm --filter @agentick/my-provider typecheck
pnpm --filter @agentick/my-provider test
```
