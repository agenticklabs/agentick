# @agentick/apple

Apple Foundation Models adapter for Agentick — on-device inference with macOS 26+.

## Features

- **On-device inference** — No API keys, no external requests, zero cost
- **Privacy-first** — All processing happens locally with Apple Intelligence
- **Structured output** — Native support for JSON schema-constrained generation via `DynamicGenerationSchema`
- **Streaming support** — Real-time token-by-token responses
- **Auto-compiled binary** — Swift bridge compiles automatically on install

## Requirements

- **macOS 26+** (Tahoe or later)
- **Apple Intelligence enabled** (Settings > Apple Intelligence & Siri)
- **Xcode** (for Swift compilation during install)

## Installation

```bash
npm install @agentick/apple
# or
pnpm add @agentick/apple
```

The postinstall script automatically compiles the Swift bridge binary. If compilation fails (e.g., on non-macOS or without Xcode), the package still installs but won't be functional until the binary is available.

## Quick Start

### Simple Text Generation

```typescript
import { apple } from '@agentick/apple';
import { createApp } from 'agentick';

const Agent = () => (
  <>
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
);

const app = createApp(Agent, { model: apple() });
const session = app.createSession();
const result = await session.send({ messages: [{ role: 'user', content: 'Hello!' }] });
```

### Structured Output

```typescript
import { apple } from "@agentick/apple";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const recipeSchema = z.object({
  title: z.string().describe("Recipe name"),
  calories: z.number().int().describe("Total calories"),
  ingredients: z.string().describe("Comma-separated ingredients"),
  steps: z.string().describe("Newline-separated steps"),
});

const result = await session.send({
  messages: [{ role: "user", content: "Create a pasta recipe" }],
  responseFormat: {
    type: "json_schema",
    schema: zodToJsonSchema(recipeSchema),
  },
});

// Result is guaranteed valid JSON matching the schema
const recipe = JSON.parse(result.message.content[0].text);
console.log(recipe.title); // "Spaghetti Carbonara"
```

### JSX Component

```tsx
import { AppleModel } from "@agentick/apple";

const Agent = () => (
  <>
    <AppleModel />
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
);
```

### Direct Execution

You can also use the model directly without creating a session:

```typescript
import { apple } from "@agentick/apple";

const model = apple();

// Simple generation
const result = await model.execute({
  messages: [{ role: "user", content: "Hello!" }],
  stream: false,
});
console.log(result.message.content[0].text);

// Structured output
const structuredResult = await model.execute({
  messages: [{ role: "user", content: "Generate a person profile" }],
  responseFormat: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name" },
        age: { type: "integer", description: "Age in years" },
      },
    },
  },
  stream: false,
});

const person = JSON.parse(structuredResult.message.content[0].text);
console.log(person); // { name: "...", age: 30 }
```

## API

### `apple(config?)`

Factory function that returns a `ModelClass` for use with `createApp`, as a JSX component, or for direct execution.

**Config:**

- `bridgePath?: string` — Path to Swift bridge binary (defaults to auto-compiled binary)
- `model?: string` — Model identifier (defaults to `"apple-foundation-3b"`)

**Returns:** `ModelClass` with:

- `.execute(input)` — Direct generation (returns `Promise<ModelOutput>`)
- `.executeStream(input)` — Streaming generation (returns `AsyncIterable<AdapterDelta>`)
- Use as JSX: `<model>...</model>`

**Example:**

```typescript
const model = apple();

// Direct execution
await model.execute({ messages: [...], stream: false });

// Use with createApp
createApp(Agent, { model });

// Use as JSX component
<model><Agent /></model>
```

### `AppleModel`

JSX component for declarative model configuration.

**Props:**

- `bridgePath?: string`
- `model?: string`

## Model Capabilities

| Feature                           | Supported              |
| --------------------------------- | ---------------------- |
| Text generation                   | ✅                     |
| Streaming                         | ✅                     |
| Structured output (`json_schema`) | ✅                     |
| Tool calling                      | ❌ (compile-time only) |
| Vision/multimodal input           | ❌                     |
| Context window                    | 4096 tokens            |

### Structured Output Details

The adapter uses Apple's `DynamicGenerationSchema` API to enforce schema constraints at generation time. Unlike LLM providers that generate free text and then validate, Apple Foundation Models **guarantee** the output matches your schema.

**Supported types:**

- Primitives: `string`, `integer`, `number`, `boolean`
- Nested objects (unlimited depth)
- Arrays: Not yet supported in this bridge implementation

**Example nested schema:**

```typescript
const schema = {
  type: "object",
  properties: {
    person: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name" },
        age: { type: "integer", description: "Age in years" },
      },
    },
    summary: { type: "string", description: "Brief bio" },
  },
};

const result = await session.send({
  messages: [{ role: "user", content: "Generate a person profile" }],
  responseFormat: { type: "json_schema", schema },
});
```

## Architecture

```
Node.js (agentick adapter)
    ↓ JSON via stdin
Swift Bridge (inference.swift)
    ↓ LanguageModelSession
Apple Foundation Models (on-device)
    ↓ stdout JSON/NDJSON
Node.js (agentick adapter)
```

The adapter spawns the Swift bridge as a child process and communicates via JSON over stdin/stdout. This design avoids FFI complexity and provides a stable interface despite Swift's evolving runtime.

### Manual Compilation

If you need to recompile the bridge manually:

```bash
cd node_modules/@agentick/apple
swiftc -parse-as-library -framework FoundationModels -O inference.swift -o bin/apple-fm-bridge
```

## Limitations

- **macOS 26+ only** — Foundation Models framework isn't available on earlier versions
- **Apple Intelligence required** — Model must be downloaded and enabled in System Settings
- **No tool calling** — While the framework supports tools via the `@Generable` macro, they must be compile-time Swift types. Dynamic tool schemas from Node.js would require bidirectional IPC.
- **No vision input** — The public `LanguageModelSession` API is text-only. Underlying models may support images, but it's not exposed.
- **Limited context** — 4096 token window (confirmed empirically)
- **Array schemas unsupported** — Current bridge doesn't implement array handling in `DynamicGenerationSchema` conversion

## Troubleshooting

### "Model not available" error

Apple Intelligence must be enabled and the model downloaded:

1. Open **System Settings** > **Apple Intelligence & Siri**
2. Enable Apple Intelligence
3. Wait for model download (may take several minutes)

### Compilation fails on install

Ensure Xcode is installed:

```bash
xcode-select --install
```

Or download from the App Store / developer.apple.com.

### Sandbox access issues

If running in a restricted environment (e.g., Cursor sandbox), the process may not have access to the model:

```typescript
// Use outside sandbox or request appropriate permissions
const app = createApp(Agent, { model: apple() });
```

### Guardrail violations

Apple's on-device models include safety guardrails. Requests for harmful, illegal, or repetitive content may be rejected with:

```
Model not available: guardrailViolation(...)
```

This is expected behavior and cannot be disabled.

## License

MIT

## Related

- [agentick](https://github.com/agenticklabs/agentick) — Main framework
- [@agentick/openai](../openai) — OpenAI adapter
- [@agentick/google](../google) — Google Gemini adapter
