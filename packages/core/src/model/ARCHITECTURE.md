# Model Module Architecture

> **The AI model integration layer for Agentick**

The model module provides the abstraction layer for integrating AI language models (LLMs) into Agentick. It defines a unified interface for model operations, supports multiple providers through adapters, and handles the transformation between engine state and model-specific formats.

---

## Table of Contents

1. [Overview](#overview)
2. [Module Structure](#module-structure)
3. [Core Concepts](#core-concepts)
4. [API Reference](#api-reference)
5. [Data Flow](#data-flow)
6. [Usage Examples](#usage-examples)
7. [Provider Adapters](#provider-adapters)

---

## Overview

### What This Module Does

The model module provides:

- **Unified Model Interface** - `EngineModel` defines a consistent API for all AI models
- **Adapter Pattern** - Transform between Agentick's format and provider-specific formats
- **Generation Operations** - Both streaming and non-streaming generation
- **State Transformation** - Convert between engine state (COMInput) and model input/output
- **Hook System** - Middleware for intercepting and modifying model operations
- **Message Transformation** - Handle special message types (events, ephemeral) for model consumption

### Why It Exists

Agentick needs to work with multiple AI providers (OpenAI, Anthropic, Google, etc.) while maintaining a consistent internal representation. The model module:

1. **Abstracts provider differences** - Each provider has different APIs, message formats, and capabilities
2. **Normalizes input/output** - Converts Agentick's rich content types to model-understandable formats
3. **Enables composability** - Models work seamlessly with the engine's component system
4. **Supports extensibility** - New providers can be added through the adapter pattern

### Design Principles

- **Provider agnostic** - Core engine code never depends on specific providers
- **Procedure-based execution** - All model operations are wrapped in kernel procedures for tracking
- **Transformation pipeline** - Clear separation between engine format and provider format
- **Single API** - Use `createAdapter()` for all model creation (simple to complex)

---

## Module Structure

```
model/
├── model.ts              # Core interfaces (EngineModel, ModelInput, ModelOutput)
├── adapter.ts            # createAdapter() factory
├── model-hooks.ts        # Hook registry for model operations
├── index.ts              # Public exports
└── utils/
    ├── language-model.ts # fromEngineState/toEngineState transformers
    └── index.ts          # Utils exports
```

```mermaid
graph TB
    subgraph "Model Module"
        EM[EngineModel Interface]
        CA[createAdapter]
        MH[ModelHookRegistry]
    end

    subgraph "Transformation Layer"
        FES[fromEngineState]
        TES[toEngineState]
        MT[MessageTransformation]
    end

    subgraph "External Adapters"
        AISDK[ai-sdk adapter]
        OPENAI[openai adapter]
        GOOGLE[google adapter]
    end

    CA --> EM

    EM --> FES
    EM --> TES
    FES --> MT

    AISDK --> CA
    OPENAI --> CA
    GOOGLE --> CA

    MH --> EM
```

### File Overview

| File                      | Size      | Purpose                                          |
| ------------------------- | --------- | ------------------------------------------------ |
| `model.ts`                | 822 lines | Core interfaces, factory functions, ModelAdapter |
| `model-hooks.ts`          | 95 lines  | Hook middleware registry for model operations    |
| `utils/language-model.ts` | 767 lines | Engine state transformation utilities            |

---

## Core Concepts

### 1. EngineModel Interface

The primary interface that all models must implement:

```typescript
interface EngineModel<TModelInput = ModelInput, TModelOutput = ModelOutput> {
  /** Model metadata (id, description, capabilities, etc.) */
  metadata: ModelMetadata;

  /** Generate a response (non-streaming) */
  generate: Procedure<(input: TModelInput) => Promise<TModelOutput>>;

  /** Generate a streaming response */
  stream?: Procedure<(input: TModelInput) => AsyncIterable<StreamEvent>>;

  /** Convert engine state (COMInput) to model input */
  fromEngineState?: (input: COMInput) => Promise<TModelInput>;

  /** Convert model output to engine response */
  toEngineState?: (output: TModelOutput) => Promise<EngineResponse>;

  /** Aggregate stream events into final output */
  processStream?: (events: StreamEvent[]) => Promise<TModelOutput>;
}
```

**Key insight**: Both `generate` and `stream` are kernel Procedures, providing automatic tracking, middleware support, and telemetry.

### 2. Model Creation with `createAdapter()`

All models in Agentick are created using `createAdapter()`:

```
┌─────────────────────────────────────────────────────────────────┐
│                    createAdapter(options)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  AdapterOptions<TProviderInput, TProviderOutput, TProviderChunk>│
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ metadata:     ModelMetadata                              │    │
│  │                                                         │    │
│  │ prepareInput:   ModelInput → ProviderInput               │    │
│  │ mapChunk:       ProviderChunk → AdapterDelta | null      │    │
│  │ execute:        ProviderInput → ProviderOutput           │    │
│  │ executeStream:  ProviderInput → AsyncIterable<Chunk>     │    │
│  │                                                         │    │
│  │ // Optional:                                            │    │
│  │ processOutput:  ProviderOutput → ModelOutput             │    │
│  │ reconstructRaw: StreamAccumulator → raw                  │    │
│  │ fromEngineState: COMInput → ModelInput                   │    │
│  │ toEngineState:   ModelOutput → EngineResponse            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                     │
│                           ▼                                     │
│               ModelClass (EngineModel + JSX Component)          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key features:**

- Returns a `ModelClass` that works both as an `EngineModel` and a JSX component
- Wraps `generate()` and `stream()` as kernel Procedures (automatic tracking, telemetry)
- Built-in stream accumulation for tool calls, reasoning, and usage stats
- Returns `ExecutionHandle` from generate/stream for consistent async patterns

### 3. Message Transformation

The model module handles transformation of Agentick's rich message types to formats models understand:

```
┌─────────────────────────────────────────────────────────────────┐
│                Message Transformation Pipeline                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  COMInput                                                       │
│  ├── timeline: [system, user, assistant, event, tool...]       │
│  ├── ephemeral: [context entries with positions]                │
│  └── sections: {config, state, etc.}                           │
│                                                                 │
│                         │                                       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │            MessageTransformationConfig                   │    │
│  │  ├── preferredRenderer: 'markdown' | 'xml'               │    │
│  │  ├── roleMapping:                                        │    │
│  │  │   ├── event: 'user' | 'developer' | 'system'          │    │
│  │  │   └── ephemeral: 'user' | 'developer' | 'system'      │    │
│  │  ├── delimiters:                                         │    │
│  │  │   ├── event: '[Event]' | { start, end }               │    │
│  │  │   └── ephemeral: '[Context]' | { start, end }         │    │
│  │  └── ephemeralPosition: 'flow' | 'start' | 'end' | ...   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                         │                                       │
│                         ▼                                       │
│  ModelInput                                                     │
│  ├── messages: [system, user, assistant, user, tool...]        │
│  ├── tools: ToolDefinition[]                                   │
│  └── model config (temperature, maxTokens, etc.)               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Transformations applied:**

- **Event messages** → Converted to user/developer role with optional delimiters
- **Ephemeral entries** → Interleaved at configured positions
- **Code/JSON blocks** → Converted to markdown text (models don't support code blocks natively)
- **System messages** → Consolidated from sections or timeline

### 4. Model Hooks

Hooks allow middleware to intercept model operations:

```typescript
type ModelHookName =
  | "fromEngineState" // Before converting COMInput → ModelInput
  | "generate" // Around non-streaming generation
  | "stream" // Around streaming generation
  | "toEngineState"; // After converting ModelOutput → EngineResponse
```

Hooks are middleware functions that can transform args/results:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Hook Pipeline                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  model.generate(input)                                          │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────┐                                                │
│  │ Global Hook │──▶ transform input                             │
│  └─────────────┘                                                │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │ Instance Hook│──▶ transform input                            │
│  └──────────────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                                               │
│  │ execute(input)│──▶ actual generation                         │
│  └──────────────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  Hooks can also transform output on the way back                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5. ModelInput and ModelOutput

Normalized formats for model communication:

```typescript
interface ModelInput {
  messages: Message[];
  tools?: ModelToolReference[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  providerOptions?: ProviderGenerationOptions;
  libraryOptions?: LibraryGenerationOptions;
  messageTransformation?: Partial<MessageTransformationConfig>;
}

interface ModelOutput {
  message?: Message;
  messages?: Message[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCalls?: ToolCall[];
  stopReason: StopReason;
  model: string;
  createdAt: string;
  raw: any;
}
```

---

## API Reference

### adapter.ts

#### `createAdapter<TProviderInput, TProviderOutput, TProviderChunk>(options)`

Factory function for creating model adapters:

```typescript
import { createAdapter } from '@agentick/core/model';

const model = createAdapter({
  metadata: {
    id: 'my-model',
    provider: 'my-provider',
    capabilities: [{ stream: true, toolCalls: true }]
  },

  prepareInput: (input: ModelInput) => ({
    // Transform to provider format
    model: input.model,
    messages: input.messages.map(m => ({ ... })),
  }),

  mapChunk: (chunk: ProviderChunk): AdapterDelta | null => {
    // Transform provider chunk to normalized delta
    if (chunk.text) return { type: 'text', delta: chunk.text };
    if (chunk.toolCall) return { type: 'tool_call', ... };
    return null; // Ignore unknown chunks
  },

  execute: async (input) => provider.generate(input),
  executeStream: async function*(input) { yield* provider.stream(input) },

  // Optional: custom output processing
  processOutput: (output) => ({ ... }),

  // Optional: reconstruct raw for streaming (builds ModelOutput.raw)
  reconstructRaw: (accumulated) => ({ ... }),

  fromEngineState, // Usually import from utils/language-model
  toEngineState,   // Usually import from utils/language-model
});
```

**Returns:** `ModelClass` - An `EngineModel` that also works as a JSX component.

**AdapterDelta types:**

- `{ type: 'text', delta: string }` - Text content
- `{ type: 'reasoning', delta: string }` - Reasoning/thinking content
- `{ type: 'tool_call', id, name, input }` - Complete tool call
- `{ type: 'tool_call_start', id, name }` - Start of streamed tool call
- `{ type: 'tool_call_delta', id, delta }` - Tool call argument chunk
- `{ type: 'tool_call_end', id, input? }` - End of streamed tool call
- `{ type: 'message_start' }` - Message started
- `{ type: 'message_end', stopReason, usage }` - Message completed
- `{ type: 'usage', usage }` - Standalone usage update
- `{ type: 'error', error }` - Error occurred

### model.ts

#### `isEngineModel(value)`

Type guard to check if a value implements EngineModel:

```typescript
if (isEngineModel(model)) {
  const output = await model.generate(input);
}
```

### model-hooks.ts

#### `ModelHookRegistry`

Registry for model operation middleware:

```typescript
const registry = new ModelHookRegistry();

// Register a hook
registry.register("generate", async (args, envelope, next) => {
  console.log("Before generate:", args);
  const result = await next();
  console.log("After generate:", result);
  return result;
});

// Get all middleware for a hook
const middleware = registry.getMiddleware("generate");
```

### utils/language-model.ts

#### `fromEngineState(input, modelOptions?, model?)`

Convert COMInput to ModelInput:

```typescript
const modelInput = await fromEngineState(comInput, {
  temperature: 0.7,
  maxTokens: 1000,
});
```

**Transformations performed:**

1. Extract timeline messages (filter kind='message')
2. Transform event messages based on transformation config
3. Interleave ephemeral entries at configured positions
4. Convert unsupported blocks (code, json) to text
5. Build system message from sections or timeline
6. Merge model options

#### `toEngineState(output)`

Convert ModelOutput to EngineResponse:

```typescript
const response = await toEngineState(modelOutput);
// response.newTimelineEntries - messages to add
// response.toolCalls - pending tool calls
// response.executedToolResults - provider-executed tools
// response.shouldStop - whether engine should stop
// response.stopReason - structured stop information
```

---

## Data Flow

### Model Request/Response Flow

```mermaid
sequenceDiagram
    participant Engine
    participant Model as EngineModel
    participant FES as fromEngineState
    participant Transform as Transformers
    participant Provider
    participant TES as toEngineState

    Engine->>Model: generate(COMInput)
    activate Model

    Model->>FES: fromEngineState(comInput)
    activate FES
    Note over FES: Transform messages<br/>Interleave ephemeral<br/>Convert blocks
    FES-->>Model: ModelInput
    deactivate FES

    Model->>Transform: prepareInput(modelInput)
    Transform-->>Model: ProviderInput

    Model->>Provider: execute(providerInput)
    activate Provider
    Provider-->>Model: ProviderOutput
    deactivate Provider

    Model->>Transform: processOutput(providerOutput)
    Transform-->>Model: ModelOutput

    Model->>TES: toEngineState(modelOutput)
    activate TES
    Note over TES: Extract messages<br/>Identify tool calls<br/>Determine stop reason
    TES-->>Model: EngineResponse
    deactivate TES

    Model-->>Engine: EngineResponse
    deactivate Model
```

### Streaming Flow

```mermaid
sequenceDiagram
    participant Engine
    participant Model as EngineModel
    participant Transform as Transformers
    participant Provider

    Engine->>Model: stream(modelInput)
    activate Model

    Model->>Transform: prepareInput(modelInput)
    Transform-->>Model: ProviderInput

    Model->>Provider: executeStream(providerInput)
    activate Provider

    loop For each chunk
        Provider-->>Model: ProviderChunk
        Model->>Transform: processChunk(chunk)
        Transform-->>Model: StreamEvent
        Model-->>Engine: yield StreamEvent
    end

    deactivate Provider

    Note over Engine: Collect chunks for aggregation

    Engine->>Model: processStream(chunks)
    Model-->>Engine: ModelOutput

    deactivate Model
```

### Hook Execution Flow

```mermaid
graph LR
    subgraph "Hook Pipeline"
        GH[Global Hooks]
        IH[Instance Hooks]
        OP[Operation]
    end

    Input --> GH
    GH --> IH
    IH --> OP
    OP --> Result

    GH -.-> |transform| IH
    IH -.-> |transform| OP
    OP -.-> |transform| Result
```

---

## Usage Examples

### Creating a Simple Adapter

```typescript
import { createAdapter } from "@agentick/core/model";
import { fromEngineState, toEngineState } from "@agentick/core/model/utils";
import { MyProviderSDK } from "my-provider";

const model = createAdapter({
  metadata: {
    id: "my-provider:gpt-4",
    provider: "my-provider",
    capabilities: [{ stream: true, toolCalls: true }],
  },

  prepareInput: (input) => ({
    model: input.model || "gpt-5.2",
    messages: input.messages.map((m) => ({
      role: m.role,
      content: m.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    })),
    temperature: input.temperature,
  }),

  mapChunk: (chunk) => {
    if (chunk.text) return { type: "text", delta: chunk.text };
    if (chunk.finish_reason) {
      return { type: "message_end", stopReason: chunk.finish_reason, usage: chunk.usage };
    }
    return null;
  },

  execute: (input) => MyProviderSDK.generate(input),
  executeStream: (input) => MyProviderSDK.stream(input),

  fromEngineState,
  toEngineState,
});
```

### Using AI SDK Adapter

```typescript
import { aiSdk } from "@agentick/ai-sdk";
import { openai } from "@ai-sdk/openai";

const model = aiSdk({
  model: openai("gpt-5.2"),
  temperature: 0.7,
  maxTokens: 4096,
});

// Use with app
const app = createApp(MyAgent, { model });
```

### Using OpenAI Adapter

```typescript
import { openai } from "@agentick/openai";

const model = openai({ model: "gpt-4o" });

// Use in JSX
function Agent() {
  return (
    <>
      <model />
      <System>You are helpful.</System>
      <Timeline />
    </>
  );
}
```

### Registering Model Hooks

```typescript
import { configureEngine } from "agentick";

// Global hooks via engine configuration
configureEngine({
  hooks: {
    model: {
      generate: [
        async (args, envelope, next) => {
          console.log("Model generating with input:", args[0].messages.length, "messages");
          const start = Date.now();
          const result = await next();
          console.log("Generation took:", Date.now() - start, "ms");
          return result;
        },
      ],
    },
  },
});

// Instance hooks on ModelAdapter
class MyAdapter extends ModelAdapter {
  static hooks = {
    generate: [myMiddleware],
    stream: [myStreamMiddleware],
  };
}
```

### Custom Message Transformation

```typescript
const model = createAdapter({
  metadata: {
    id: "my-model",
    provider: "my-provider",
    capabilities: [
      {
        messageTransformation: (modelId, provider) => ({
          preferredRenderer: "markdown",
          roleMapping: {
            event: provider === "anthropic" ? "developer" : "user",
            ephemeral: "user",
          },
          delimiters: {
            useDelimiters: true,
            event: { start: "<!-- Event:", end: " -->" },
            ephemeral: "[Context]",
          },
          ephemeralPosition: "after-system",
        }),
      },
    ],
  },
  // ... rest of config
});
```

---

## Provider Adapters

Agentick provides official adapters for popular AI SDKs:

### ai-sdk Adapter

Wraps Vercel AI SDK models:

```typescript
import { createAiSdkModel } from "agentick/adapters/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

// OpenAI via AI SDK
const openaiModel = createAiSdkModel({
  model: openai("gpt-5.2"),
});

// Anthropic via AI SDK
const claudeModel = createAiSdkModel({
  model: anthropic("claude-3-5-sonnet-20241022"),
});
```

### Adapter Responsibilities

Each adapter must handle:

1. **Input transformation** - Convert ModelInput to provider format
2. **Output transformation** - Convert provider response to ModelOutput
3. **Stream handling** - Transform provider chunks to StreamEvent
4. **Tool conversion** - Convert tool definitions to provider format
5. **Error mapping** - Map provider errors to Agentick errors
6. **Stop reason mapping** - Normalize finish reasons

### Creating New Adapters

1. **Use `createAdapter()`** for all model creation
2. **Implement `mapChunk()`** to normalize provider streaming chunks to `AdapterDelta`
3. **Define messageTransformation** in capabilities for proper event/ephemeral handling
4. **Map all stop reasons** to StopReason enum values
5. **Handle streaming properly** - emit correct delta types for text, tools, and usage

---

## Summary

The model module provides:

- **`EngineModel`** - Unified interface for all AI models
- **`createAdapter()`** - Factory function for creating model adapters (returns `ModelClass`)
- **`fromEngineState()` / `toEngineState()`** - Engine state transformation
- **`ModelHookRegistry`** - Middleware for model operations
- **Message transformation** - Handle events, ephemeral, and special content types
- **Stream accumulation** - Built-in handling of tool calls, reasoning, and usage stats

This abstraction layer enables Agentick to work with any AI provider while maintaining a consistent internal representation and providing automatic tracking, middleware support, and observability.
