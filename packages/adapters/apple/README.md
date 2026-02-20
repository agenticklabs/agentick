# @agentick/apple

Apple on-device AI for Agentick — inference and embeddings via Foundation Models and NaturalLanguage, running entirely on your machine.

## Features

- **On-device inference** — No API keys, no external requests, zero cost
- **On-device embeddings** — 512-dimensional vector embeddings via `NLContextualEmbedding`
- **Privacy-first** — All processing happens locally with Apple Intelligence
- **Structured output** — JSON schema-constrained generation via `DynamicGenerationSchema`
- **Streaming** — Real-time token-by-token responses
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

The postinstall script compiles the Swift bridge binary. If compilation fails (e.g., on non-macOS or without Xcode), the package still installs but won't be functional until the binary is available.

## Quick Start

### Text Generation

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

### Embeddings

```typescript
import { appleEmbedding } from "@agentick/apple";

const embed = appleEmbedding();

// Single text
const { embeddings, dimensions } = await embed("Hello world");
console.log(dimensions); // 512
console.log(embeddings[0].length); // 512

// Batch
const { embeddings } = await embed([
  "machine learning and AI",
  "deep neural networks",
  "the cat sat on the mat",
]);
// embeddings → number[3][512]
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

const recipe = JSON.parse(result.message.content[0].text);
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

## API

### `apple(config?)`

Factory function returning a `ModelClass` for text generation.

| Option       | Type     | Default                 | Description                 |
| ------------ | -------- | ----------------------- | --------------------------- |
| `bridgePath` | `string` | auto-detected           | Path to Swift bridge binary |
| `model`      | `string` | `"apple-foundation-3b"` | Model identifier            |

Returns a `ModelClass` usable with `createApp`, as JSX, or for direct execution.

### `AppleModel`

JSX component wrapping `apple()` for declarative model configuration. Accepts the same props as `apple()`.

### `appleEmbedding(config?)`

Factory function returning a callable embedding function.

| Option       | Type              | Default       | Description                                          |
| ------------ | ----------------- | ------------- | ---------------------------------------------------- |
| `bridgePath` | `string`          | auto-detected | Path to Swift bridge binary                          |
| `script`     | `EmbeddingScript` | `"latin"`     | Script model to load (see below)                     |
| `language`   | `string`          | —             | BCP-47 code (e.g. `"en"`, `"fr"`) for better results |

Returns an `AppleEmbeddingFunction`:

```typescript
const embed = appleEmbedding({ script: "latin" });

// Call with a single string or array
const result = await embed("Hello world");
const batch = await embed(["Hello", "World"]);

// Result shape
result.embeddings; // number[][] — one vector per input text
result.dimensions; // number — vector dimensionality (512)
result.model; // "apple-contextual-embedding"
result.script; // "latin"
```

#### Script Models

Each script model covers a group of languages. You pick the script, not individual languages:

| Script              | Languages                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"latin"` (default) | English, French, German, Spanish, Portuguese, Italian, Dutch, Swedish, Danish, Norwegian, Finnish, Polish, Czech, Hungarian, Romanian, Slovak, Croatian, Indonesian, Turkish, Vietnamese |
| `"cyrillic"`        | Russian, Ukrainian, Bulgarian, Kazakh                                                                                                                                                    |
| `"cjk"`             | Chinese, Japanese, Korean                                                                                                                                                                |
| `"indic"`           | Hindi, Marathi, Bangla, Urdu, Punjabi, Gujarati, Tamil, Telugu, Kannada, Malayalam                                                                                                       |
| `"thai"`            | Thai                                                                                                                                                                                     |
| `"arabic"`          | Arabic                                                                                                                                                                                   |

The optional `language` parameter (BCP-47 code like `"en"`, `"ja"`, `"ru"`) refines results when you know the input language.

## Capabilities

| Feature                           | Supported                               |
| --------------------------------- | --------------------------------------- |
| Text generation                   | Yes                                     |
| Streaming                         | Yes                                     |
| Structured output (`json_schema`) | Yes                                     |
| On-device embeddings              | Yes — 512-dim via NLContextualEmbedding |
| Tool calling                      | Not yet — see [Roadmap](#roadmap)       |
| Vision/multimodal                 | No                                      |
| Context window                    | 4096 tokens                             |

### Structured Output

Uses Apple's `DynamicGenerationSchema` to enforce constraints at generation time — the model **cannot** produce invalid output.

Supported types: `string`, `integer`, `number`, `boolean`, nested objects. Arrays not yet supported in bridge.

## Architecture

```
Node.js (agentick)
    │
    ├── Text generation ──▶ stdin JSON ──▶ Swift Bridge ──▶ FoundationModels
    │                                          │                    │
    │                                          ◀── stdout JSON/NDJSON ──┘
    │
    └── Embeddings ──▶ stdin JSON ──▶ Swift Bridge ──▶ NLContextualEmbedding
                                           │                    │
                                           ◀── stdout JSON ────┘
```

Single Swift binary (`apple-fm-bridge`) handles both operations, routed by the `operation` field:

- `"generate"` (default) — text generation via `LanguageModelSession`
- `"embed"` — vector embeddings via `NLContextualEmbedding`

### Manual Compilation

```bash
cd node_modules/@agentick/apple
swiftc -parse-as-library -framework FoundationModels -framework NaturalLanguage -O inference.swift -o bin/apple-fm-bridge
```

## Roadmap

### Tool Calling

Apple Foundation Models support tool calling via the `Tool` protocol — the model can autonomously call Swift functions and use results in its response. Our adapter currently doesn't support this because Apple's tool loop runs internally within `session.respond()`.

The path forward is a **bidirectional bridge protocol**: proxy `Tool` structs in Swift that write `tool_call` messages to stdout and read `tool_result` responses from stdin, letting agentick's tool executors handle execution while Apple's framework manages the model loop.

### Embedding Improvements

- Cosine similarity utility functions
- Batch performance optimization (keep model loaded across calls)
- Configurable pooling strategies (mean, CLS, max)

## Limitations

- **macOS 26+ only** — Foundation Models framework isn't available on earlier versions
- **Apple Intelligence required** — Model must be downloaded and enabled in System Settings
- **Limited context** — 4096 token window
- **No vision input** — `LanguageModelSession` API is text-only
- **Array schemas unsupported** — `DynamicGenerationSchema` doesn't support dynamic array generation

## Troubleshooting

### "Model not available" error

1. Open **System Settings** > **Apple Intelligence & Siri**
2. Enable Apple Intelligence
3. Wait for model download (may take several minutes)

### Compilation fails on install

```bash
xcode-select --install
```

### "Embedding model assets not downloaded"

The NLContextualEmbedding model assets may need to be downloaded. Ensure Apple Intelligence is enabled and the device has internet access for the initial download.

### Guardrail violations

Apple's on-device models include safety guardrails. Requests for harmful or repetitive content may be rejected — this is expected and cannot be disabled.

## License

MIT

## Related

- [agentick](https://github.com/agenticklabs/agentick) — Main framework
- [@agentick/openai](../openai) — OpenAI adapter
- [@agentick/google](../google) — Google Gemini adapter
