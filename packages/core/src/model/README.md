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
  prepareInput: (input) => ({
    /* provider format */
  }),
  mapChunk: (chunk) => ({ type: "text", delta: chunk.text }),
  execute: async (input) => provider.generate(input),
  executeStream: async function* (input) {
    /* yield chunks */
  },
});
```

`createAdapter` returns a `ModelClass` — both an `EngineModel` and a JSX component. Use as `<Model model={myModel} />` or pass to `createApp({ model: myModel })`.

## Custom Blocks

Custom blocks let adapters intercept XML-like tags in the model's text output, strip them from the text stream, and handle them as structured content. They're used for application-level signals that the model outputs inline — interpretations, completion signals, debug info, etc.

Define custom blocks on `createAdapter`:

```typescript
import { createAdapter } from "@agentick/core/model";

const model = createAdapter({
  // ... standard adapter options ...

  customBlocks: {
    // Passthrough — accumulate as CustomContentBlock in content array
    citation: {},

    // Transform — rewrite into a different delta
    interpretation: {
      transform(block) {
        return [{ type: "text", delta: `[Interpretation: ${block.content}]` }];
      },
    },

    // Suppress — consume as side effect, remove from output
    done: {
      transform(block) {
        setDoneFlag(true);
        return []; // empty array suppresses the block
      },
    },

    // Override XML tag name — intercept <dbg> but use "debugInfo" as semantic key
    debugInfo: {
      tag: "dbg",
    },

    // onStart callback — fires when opening tag found, before content
    progress: {
      onStart(attrs) {
        showProgressIndicator(attrs.label);
      },
    },
  },
});
```

When the model outputs `text<interpretation>insight</interpretation>more`, the adapter:

1. Strips `<interpretation>insight</interpretation>` from text output
2. Calls the tag's `transform` (if defined) to decide what to emit
3. Emits `custom_block_start`, `custom_block_delta`, `custom_block_end` stream events
4. Accumulates the block as a `CustomContentBlock` in `message.content` (preserving temporal position)

### CustomBlockDefinition

```typescript
interface CustomBlockDefinition {
  /** XML tag to intercept. Defaults to the config key. */
  tag?: string;
  /** Transform the complete block before accumulation.
   *  void → passthrough as CustomContentBlock
   *  AdapterDelta[] → emit these instead ([] suppresses) */
  transform?(block: CustomBlockInput): AdapterDelta[] | void;
  /** Called when opening tag found, before content. Side-effect only. */
  onStart?(attrs: Record<string, string>): void;
}
```

### CustomContentBlock

Custom blocks are stored as `CustomContentBlock` in the message's content array, preserving their temporal position relative to text:

```typescript
interface CustomContentBlock {
  readonly type: "custom";
  readonly tag: string; // semantic name (config key, not XML tag)
  readonly content: string;
  readonly attrs: Record<string, string>;
  readonly selfClosing?: boolean;
}
```

Use `isCustomBlock()` from `@agentick/shared` for type narrowing:

```typescript
import { isCustomBlock } from "@agentick/shared";

for (const block of message.content) {
  if (isCustomBlock(block)) {
    console.log(block.tag, block.content);
  }
}
```

## Delta Transforms

Delta transforms are low-level streaming middleware that process `AdapterDelta`s between `mapChunk` output and `StreamAccumulator` input. Custom blocks are built on delta transforms, but the `deltaTransform` option is also available for arbitrary stream manipulation.

```typescript
interface DeltaTransform {
  process(delta: AdapterDelta): AdapterDelta[];
  flush(): AdapterDelta[];
}
```

### Pipeline Order

When both `customBlocks` and `deltaTransform` are defined, the pipeline is:

```
provider chunk → mapChunk() → AdapterDelta
  → custom blocks extraction (StreamTagParser + CustomBlockTransform)
    → user deltaTransform
      → StreamAccumulator → StreamEvent
```

Custom blocks run first (tags stripped from text), then user transforms operate on clean text.

### Composing Transforms

Multiple transforms compose into a pipeline via `composeDeltaTransforms`:

```typescript
import { composeDeltaTransforms } from "@agentick/core/model";

const pipeline = composeDeltaTransforms(
  markdownBufferer, // coalesces text into render-friendly chunks
  contentRewriter, // rewrites specific patterns
);

createAdapter({
  ...options,
  deltaTransform: pipeline,
});
```

Or pass an array directly — `createAdapter` composes automatically:

```typescript
createAdapter({
  ...options,
  deltaTransform: [markdownBufferer, contentRewriter],
});
```

### Use Cases

- **Markdown buffering** — coalesce char-by-char text deltas into line/paragraph boundaries for smoother UI rendering
- **Content rewriting** — rewrite patterns in the text stream before accumulation
- **Custom accumulation** — emit custom delta types for application-specific handling

### StreamTagParser (Advanced)

For direct control over tag parsing without the `customBlocks` config, use `StreamTagParser` as a delta transform:

```typescript
import { StreamTagParser } from "@agentick/core/model";

const parser = new StreamTagParser({
  tags: {
    think: {
      onStart(attrs) {
        /* opening tag found */
      },
      onContent(content, attrs) {
        /* block complete */
      },
      onSelfClosing(attrs) {
        /* self-closing tag */
      },
    },
  },
});

createAdapter({
  ...options,
  deltaTransform: parser,
});
```

This is the lower-level API that `customBlocks` builds on. Use it when you need full control over the parsing behavior or want to combine with other transforms manually.

See `packages/adapters/README.md` for detailed adapter documentation.
