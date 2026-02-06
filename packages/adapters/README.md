# Tentickle Adapters

Model adapters connect Tentickle to AI providers. This document explains how to create custom adapters.

## Available Adapters

| Package             | Provider            | Description           |
| ------------------- | ------------------- | --------------------- |
| `@tentickle/openai` | OpenAI              | Native OpenAI API     |
| `@tentickle/google` | Google AI / Vertex  | Native Google GenAI   |
| `@tentickle/ai-sdk` | Any AI SDK provider | Vercel AI SDK wrapper |

## Creating Custom Adapters

Use `createAdapter` from `@tentickle/core/model` to create adapters with minimal boilerplate.

### Basic Structure

```typescript
import { createAdapter, StopReason, type ModelClass } from '@tentickle/core/model';

export function createMyProviderModel(config: MyConfig): ModelClass {
  const client = new MyProviderClient(config);

  return createAdapter<ProviderInput, ProviderOutput, ProviderChunk>({
    metadata: {
      id: 'my-provider',
      provider: 'my-provider',
      capabilities: [{ stream: true, toolCalls: true }],
    },

    prepareInput: (input) => {
      // Transform Tentickle ModelInput → provider format
      return {
        model: config.model,
        messages: input.messages.map(toProviderMessage),
        tools: input.tools?.map(toProviderTool),
      };
    },

    mapChunk: (chunk) => {
      // Transform provider chunks → AdapterDelta
      if (chunk.type === 'text') {
        return { type: 'text', delta: chunk.text };
      }
      if (chunk.type === 'done') {
        return { type: 'message_end', stopReason: StopReason.STOP };
      }
      return null; // Ignore unknown chunks
    },

    execute: (input) => client.generate(input),
    executeStream: (input) => client.stream(input),
  });
}
```

### The ModelClass Pattern

`createAdapter` returns a `ModelClass` - a unified type that works as both:

1. **EngineModel** - For programmatic use with `createApp` and direct calls
2. **JSX Component** - For declarative use in agent trees

```typescript
const model = createMyProviderModel({ model: 'my-model' });

// Use with createApp
const app = createApp(MyAgent, { model });

// Use as JSX
<model temperature={0.9}>
  <MyAgent />
</model>

// Direct calls
const result = await model.generate({ messages: [...] });
```

## AdapterDelta Types

The `mapChunk` function returns `AdapterDelta` types that the framework accumulates:

```typescript
type AdapterDelta =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'tool_call_end'; id: string; input?: unknown }
  | { type: 'message_start'; model?: string }
  | { type: 'message_end'; stopReason: StopReason; usage?: UsageStats }
  | { type: 'usage'; usage: Partial<UsageStats> }
  | { type: 'error'; error: Error | string }
  | { type: 'content_metadata'; metadata: ContentMetadata };
```

### Common Patterns

**Text streaming:**

```typescript
if (chunk.delta?.content) {
  return { type: 'text', delta: chunk.delta.content };
}
```

**Tool calls (complete):**

```typescript
if (chunk.toolCall) {
  return {
    type: 'tool_call',
    id: chunk.toolCall.id,
    name: chunk.toolCall.name,
    input: chunk.toolCall.args,
  };
}
```

**Tool calls (streamed):**

```typescript
// First chunk with name
if (chunk.toolCallStart) {
  return { type: 'tool_call_start', id: chunk.id, name: chunk.name };
}
// Argument chunks
if (chunk.toolCallDelta) {
  return { type: 'tool_call_delta', id: chunk.id, delta: chunk.args };
}
```

**Message end:**

```typescript
if (chunk.finishReason) {
  return {
    type: 'message_end',
    stopReason: mapFinishReason(chunk.finishReason),
    usage: chunk.usage ? {
      inputTokens: chunk.usage.promptTokens,
      outputTokens: chunk.usage.completionTokens,
      totalTokens: chunk.usage.totalTokens,
    } : undefined,
  };
}
```

**Separate usage chunk (OpenAI pattern):**

```typescript
// Some providers send usage in a separate final chunk
if (chunk.usage && !chunk.choices?.length) {
  return { type: 'usage', usage: { ... } };
}
```

## StopReason Values

```typescript
import { StopReason } from '@tentickle/shared';

StopReason.STOP           // Normal completion
StopReason.MAX_TOKENS     // Hit token limit
StopReason.TOOL_USE       // Model wants to call tools
StopReason.CONTENT_FILTER // Content was filtered
StopReason.ERROR          // Error occurred
StopReason.OTHER          // Other reasons
```

## Advanced Options

### Lifecycle Hooks

Add hooks for JSX usage:

```typescript
createAdapter({
  // ... other options

  onMount: (ctx) => {
    console.log('Model mounted');
  },
  onUnmount: (ctx) => {
    console.log('Model unmounted');
  },
});
```

### Reconstructing Raw Response

For DevTools and debugging, reconstruct what a non-streaming response would look like:

```typescript
createAdapter({
  // ... other options

  reconstructRaw: (accumulated) => ({
    id: `response-${Date.now()}`,
    model: accumulated.model,
    choices: [{
      message: {
        role: 'assistant',
        content: accumulated.text,
        tool_calls: accumulated.toolCalls.map(tc => ({
          id: tc.id,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      },
      finish_reason: accumulated.stopReason,
    }],
    usage: {
      prompt_tokens: accumulated.usage.inputTokens,
      completion_tokens: accumulated.usage.outputTokens,
      total_tokens: accumulated.usage.totalTokens,
    },
  }),
});
```

### Metadata Extraction

Extract citations, annotations, or other metadata:

```typescript
createAdapter({
  // ... other options

  extractMetadata: (chunk, accumulated) => {
    if (chunk.citations?.length) {
      return {
        citations: chunk.citations.map(c => ({
          text: c.citedText,
          url: c.source?.url,
          title: c.source?.title,
        })),
      };
    }
    return undefined;
  },
});
```

## Message Transformation

Configure how messages are transformed for specific models:

```typescript
createAdapter({
  metadata: {
    id: 'my-provider',
    capabilities: [
      { stream: true, toolCalls: true },
      {
        messageTransformation: (modelId, provider) => ({
          preferredRenderer: 'markdown', // or 'xml'
          roleMapping: {
            event: 'user',      // How to render event messages
            ephemeral: 'user',  // How to render ephemeral content
          },
          delimiters: {
            useDelimiters: true,
            event: '[Event]',
            ephemeral: '[Context]',
          },
        }),
      },
    ],
  },
  // ...
});
```

## Testing Adapters

```typescript
import { describe, it, expect } from 'vitest';
import { createMyProviderModel } from './my-provider';

describe('MyProviderAdapter', () => {
  it('generates text', async () => {
    const model = createMyProviderModel({ model: 'test-model' });

    const result = await model.generate({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.message.content).toBeDefined();
  });

  it('streams text', async () => {
    const model = createMyProviderModel({ model: 'test-model' });
    const events: StreamEvent[] = [];

    for await (const event of model.stream!({
      messages: [{ role: 'user', content: 'Hello' }],
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'content_delta')).toBe(true);
    expect(events.some(e => e.type === 'message')).toBe(true);
  });
});
```

## Convenience Wrapper Pattern

Export a simple factory function for ergonomic usage:

```typescript
// my-provider.ts
export function myProvider(config?: MyConfig): ModelClass {
  return createMyProviderModel(config ?? {});
}

// Usage
import { myProvider } from '@tentickle/my-provider';
const model = myProvider({ model: 'my-model' });
```
