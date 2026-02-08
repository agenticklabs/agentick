# Model System

Model adapters and configuration for Agentick. Defines the `EngineModel` interface that all model adapters implement.

## Key Types

### EngineModel

The primary interface for models. Created via `createAdapter()`.

```typescript
interface EngineModel {
  metadata: ModelMetadata;
  generate: Procedure<(input: ModelInput) => Promise<ModelOutput>>;
  stream?: Procedure<(input: ModelInput) => AsyncIterable<StreamEvent>>;
  fromEngineState?: (input: COMInput) => Promise<ModelInput>;
  toEngineState?: (output: ModelOutput) => Promise<EngineResponse>;
}
```

### ModelMetadata

Adapter-provided metadata about the model:

```typescript
interface ModelMetadata {
  id: string;
  model?: string;
  provider?: string;
  capabilities: ModelCapabilities[];

  // Context limits
  contextWindow?: number;
  maxOutputTokens?: number;

  // Capabilities
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;

  // Token estimation
  tokenEstimator?: TokenEstimator;
}
```

#### Token Estimator

Model adapters can provide a `tokenEstimator` function in metadata for accurate token counting. When provided, the compiler uses it instead of the default `char/4 + 4` heuristic to annotate compiled entries with token estimates.

```typescript
import { createAdapter } from "@agentick/core";
import { encoding_for_model } from "tiktoken";

const enc = encoding_for_model("gpt-4o");

const model = createAdapter({
  metadata: {
    id: "gpt-4o",
    provider: "openai",
    capabilities: [{ stream: true, toolCalls: true }],
    tokenEstimator: (text) => enc.encode(text).length,
  },
  // ... adapter methods
});
```

The estimator must be **synchronous** — the compile loop runs multiple iterations per tick and async estimation would add unacceptable latency. For provider-grade accuracy, use a local tokenizer (tiktoken, etc.).

### ModelInput

Extends `@agentick/shared`'s `ModelInput` with backend-specific fields:

```typescript
interface ModelInput extends BaseModelInput {
  providerOptions?: ProviderGenerationOptions;
  libraryOptions?: LibraryGenerationOptions;
  messageTransformation?: Partial<MessageTransformationConfig>;
}
```

### ResponseFormat

Normalized structured output format, defined in `@agentick/shared`:

```typescript
type ResponseFormat =
  | { type: "text" }
  | { type: "json" }
  | { type: "json_schema"; schema: Record<string, unknown>; name?: string };
```

Available on both `ModelInput` (per-call) and `ModelConfig` (adapter default). Set via `<Model responseFormat={...} />` or the `responseFormat` field on `AgentProps`.

Each adapter maps `ResponseFormat` to the provider's native format:

| Provider | `"json"`                                   | `"json_schema"`                                                  |
| -------- | ------------------------------------------ | ---------------------------------------------------------------- |
| OpenAI   | `{ type: "json_object" }`                  | `{ type: "json_schema", json_schema: { schema, strict: true } }` |
| Google   | `responseMimeType: "application/json"`     | + `responseSchema`                                               |
| AI SDK   | `response_format: { type: "json_object" }` | `output: "object"` + schema                                      |

### ModelConfig

Per-adapter default configuration:

```typescript
interface ModelConfig extends BaseModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  responseFormat?: ResponseFormat;
}
```

## Creating Adapters

```typescript
import { createAdapter } from "@agentick/core";

const myModel = createAdapter({
  metadata: {
    id: "my-model",
    provider: "my-provider",
    capabilities: [{ stream: true, toolCalls: true }],
  },
  prepareInput: (input) => ({ /* provider format */ }),
  mapChunk: (chunk) => ({ type: "text", delta: chunk.text }),
  execute: async (input) => provider.generate(input),
  executeStream: async function* (input) { /* yield chunks */ },
});
```

`createAdapter` returns a `ModelClass` — both an `EngineModel` and a JSX component. Use as `<Model model={myModel} />` or pass to `createApp({ model: myModel })`.

See `packages/adapters/README.md` for detailed adapter documentation.
