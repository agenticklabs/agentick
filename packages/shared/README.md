# @tentickle/shared

Platform-independent types and utilities for Tentickle. Works in both Node.js and browser environments.

## Installation

```bash
pnpm add @tentickle/shared
```

## Model Catalog

Reference data for known LLM models including context windows and capabilities. Supports runtime registration for custom/fine-tuned models.

### Registering Custom Models

Use `registerModel()` to add custom or fine-tuned models that aren't in the built-in catalog:

```typescript
import { registerModel } from "@tentickle/shared";

// Register a custom fine-tuned model
registerModel("myorg/custom-model-v1", {
  name: "My Custom Model",
  provider: "myorg",
  contextWindow: 32768,        // 32k context
  maxOutputTokens: 8192,
  supportsToolUse: true,
  supportsVision: false,
  isReasoningModel: false,
});

// Register multiple models at once
import { registerModels } from "@tentickle/shared";

registerModels({
  "myorg/model-small": {
    name: "My Model Small",
    provider: "myorg",
    contextWindow: 16384,
    maxOutputTokens: 4096,
    supportsToolUse: true,
  },
  "myorg/model-large": {
    name: "My Model Large",
    provider: "myorg",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsToolUse: true,
    supportsVision: true,
  },
});
```

### Looking Up Model Info

```typescript
import { getModelInfo, getContextWindow, getContextUtilization } from "@tentickle/shared";

// Get full model info
const info = getModelInfo("gpt-4o");
console.log(info?.contextWindow);  // 128000
console.log(info?.supportsVision); // true

// Just get context window
const contextWindow = getContextWindow("claude-3-5-sonnet");
console.log(contextWindow);  // 200000

// Calculate utilization percentage
const utilization = getContextUtilization("gpt-4o", 64000);
console.log(utilization);  // 50
```

### ModelInfo Interface

```typescript
interface ModelInfo {
  name: string;              // Display name
  provider: string;          // Provider name (openai, anthropic, google, etc.)
  contextWindow: number;     // Context window size in tokens
  maxOutputTokens?: number;  // Max output tokens
  releaseDate?: string;      // Model release date
  supportsVision?: boolean;  // Supports image input
  supportsToolUse?: boolean; // Supports tool/function calling
  isReasoningModel?: boolean; // Extended thinking model (o1, etc.)
}
```

### Built-in Model Coverage

The catalog includes models from:

- **Anthropic**: Claude 4, Claude 3.5, Claude 3 series
- **OpenAI**: GPT-5, GPT-4.1, GPT-4o, o1/o3 reasoning models
- **Google**: Gemini 3, Gemini 2.5, Gemini 2.0, Gemini 1.5
- **Mistral**: Large 3, Small 3.1, Codestral, Ministral
- **Meta**: Llama 4, Llama 3.1
- **DeepSeek**: Chat, Coder, Reasoner

### Adapter Integration

When using adapters, model info from the adapter takes precedence over the catalog:

```typescript
import { getEffectiveModelInfo, getEffectiveContextWindow } from "@tentickle/shared";

// Adapter metadata overrides catalog values
const effectiveInfo = getEffectiveModelInfo(
  { contextWindow: 256000 },  // Adapter reports 256k
  "custom-model"
);

// Priority: adapter > runtime registry > static catalog
const contextWindow = getEffectiveContextWindow(adapterMetadata, modelId);
```

### Formatting Utilities

```typescript
import { formatContextWindow } from "@tentickle/shared";

formatContextWindow(128000);   // "128K"
formatContextWindow(1000000);  // "1M"
formatContextWindow(2097152);  // "2.1M"
```

## Content Types

### ContentBlock

Content blocks represent different types of content in messages:

```typescript
import type { ContentBlock, TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock } from "@tentickle/shared";

// Text content
const text: TextBlock = {
  type: "text",
  text: "Hello, world!",
};

// Image content
const image: ImageBlock = {
  type: "image",
  source: {
    type: "base64",
    mediaType: "image/png",
    data: "iVBORw0KGgo...",
  },
};

// Tool use (model calling a tool)
const toolUse: ToolUseBlock = {
  type: "tool_use",
  id: "call_123",
  name: "calculator",
  input: { expression: "2 + 2" },
};

// Tool result (response to tool use)
const toolResult: ToolResultBlock = {
  type: "tool_result",
  toolUseId: "call_123",
  content: [{ type: "text", text: "4" }],
};
```

### Message Types

```typescript
import type { Message, UserMessage, AssistantMessage } from "@tentickle/shared";

const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "Hello!" }],
};

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hi there!" }],
};
```

## Stream Events

Events emitted during streaming responses:

```typescript
import type {
  StreamEvent,
  ContentDeltaEvent,
  MessageEndEvent,
  ToolCallEvent,
  ContextUpdateEvent,
} from "@tentickle/shared";

// Text streaming
const delta: ContentDeltaEvent = {
  type: "content_delta",
  delta: "Hello",
  contentIndex: 0,
};

// Context utilization update
const contextUpdate: ContextUpdateEvent = {
  type: "context_update",
  modelId: "gpt-4o",
  modelName: "GPT-4o",
  provider: "openai",
  contextWindow: 128000,
  inputTokens: 1500,
  outputTokens: 500,
  totalTokens: 2000,
  utilization: 1.56,  // percentage
  supportsVision: true,
  supportsToolUse: true,
};
```

## Error Types

Typed errors with codes for proper error handling:

```typescript
import {
  TentickleError,
  ValidationError,
  AbortError,
  isAbortError,
  isTentickleError,
} from "@tentickle/shared";

// Check error types
try {
  await operation();
} catch (error) {
  if (isAbortError(error)) {
    console.log("Operation was cancelled");
  } else if (isTentickleError(error)) {
    console.log(`Error [${error.code}]: ${error.message}`);
  }
}

// Throw typed errors
throw new ValidationError("email", "Invalid email format");
throw new AbortError("User cancelled");
throw AbortError.timeout(30000);  // Timeout via AbortError factory
```

## Input Normalization

Utilities for normalizing various input formats:

```typescript
import { normalizeContent, normalizeMessage } from "@tentickle/shared";

// Normalize string to content blocks
const content = normalizeContent("Hello!");
// [{ type: "text", text: "Hello!" }]

// Normalize various message formats
const message = normalizeMessage("Hello!");
// { role: "user", content: [{ type: "text", text: "Hello!" }] }

const message2 = normalizeMessage({
  role: "user",
  content: "Hello!",
});
// { role: "user", content: [{ type: "text", text: "Hello!" }] }
```

## Tool Types

```typescript
import type { ToolDefinition, ToolCall, ToolResult } from "@tentickle/shared";

const tool: ToolDefinition = {
  name: "calculator",
  description: "Performs mathematical calculations",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression" },
    },
    required: ["expression"],
  },
};
```

## License

MIT
