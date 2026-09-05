# @agentick/model-chatjimmy

**ChatJimmy as a plain object.** `chatjimmy()` returns a `LanguageModelAdapter` for [chatjimmy.ai](https://chatjimmy.ai), the public front for Taalas's hardware-embodied Llama 3.1 8B. Zero Effect, zero substrate, zero SDK — the wire is one `fetch`.

The endpoint is not OpenAI-compatible. It takes `{ messages, chatOptions, attachment }` and answers with raw completion text followed by a `<|stats|>{…}<|/stats|>` trailer. This adapter owns that dialect so nothing else has to.

## Install

```bash
npm install @agentick/model-chatjimmy
```

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { chatjimmy } from "@agentick/model-chatjimmy";

const app = await createApp(<Agent />, { model: chatjimmy() });
```

Or drive it directly:

```ts
import { generate } from "@agentick/model";
import { chatjimmy } from "@agentick/model-chatjimmy";

const result = await generate({
  model: chatjimmy(),
  messages: [{ role: "user", content: [{ type: "text", text: "Explain vector clocks." }] }],
});
```

## Standalone

No app, no session — the free functions in `@agentick/model` drive the adapter directly and return the same normalized result the executor would.

```ts
import { generate, generateStream, generateObject } from "@agentick/model";
import { chatjimmy } from "@agentick/model-chatjimmy";
import { z } from "zod";

const model = chatjimmy();
const messages = [
  { role: "user", content: [{ type: "text", text: "Write a haiku about silicon." }] },
];

// One call, one result.
const result = await generate({ model, messages });
result.output; // ContentBlock[]
result.usage; // UsageStats

// Streaming — the same deltas the executor emits; `result` resolves once the stream drains.
const handle = generateStream({ model, messages });
for await (const delta of handle.stream) {
  if (delta.type === "content-delta") process.stdout.write(delta.delta);
}
await handle.result;

// Structured output — parsed and validated against any Standard Schema.
const { object } = await generateObject({
  model,
  schema: z.object({ total: z.number(), currency: z.string() }),
  messages: [{ role: "user", content: [{ type: "text", text: "Parse: $42 USD" }] }],
});
```

The wire has no response-format field or tool channel, so `generateObject` validates only — ask for JSON in the prompt — and `tools` are dropped. The `<|stats|>` trailer rides on `result.finishMetadata.chatjimmy`. `withRetry`, `withFallback` and `tapModel` wrap the adapter itself; see the [@agentick/model README](../model/README.md).

## API

`chatjimmy(model = "llama3.1-8B", options?)` → `LanguageModelAdapter<ChatJimmyResponse, ChatJimmyChunk, ChatJimmyRequest>`

| Option            | Purpose                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `clientOptions`   | `baseURL` (default `https://chatjimmy.ai`), extra `headers`, a custom `fetch` |
| `topK`            | `chatOptions.topK`. The site sends 8                                          |
| `stream`          | Drive the streaming call from `execute()` too. Default `false`                |
| `target`          | Replace the self-described `ExecutionTarget`                                  |
| `rates`           | Price card for usage accounting                                               |
| `providerOptions` | Target-level `{ chatjimmy: { systemPrompt, topK, selectedModel } }` defaults  |

`providerOptions.chatjimmy` is typed as `Partial<ChatJimmyChatOptions>` and is spread onto `chatOptions` last, tree over target.

## What the wire can and cannot do

- **Text only.** `capabilities.media` is the empty declaration, so the executor declines every image, document, audio and video part before the adapter sees them. Tool declarations are not advertised (`supportsTools: false`); replayed `tool_use` / `tool_result` parts are flattened to text so a mixed timeline still reads.
- **Roles.** `system` is legal anywhere in the list and is where `grounding` lands. `tool` and `event` lower to `user`.
- **No generation knobs.** `temperature`, `maxOutputTokens` and friends have no wire field and are dropped.
- **Streaming is nominal.** The model decodes at roughly 16k tokens/s, so a whole reply typically arrives in one network chunk. `openStream` exists for contract parity and handles a trailer split across chunks.
- **Errors.** A non-2xx answer throws `ChatJimmyHttpError` with `status`, which the executor's default classification maps to `ProviderRejected`.
- **Stats.** The trailer becomes `usage` (`prefill_tokens` / `decode_tokens` / `total_tokens`), `stopReason` (`stop` → `end`, `length` → `max_tokens`), and rides whole on the result's `finishMetadata.chatjimmy`.

Browser-shaped headers (`Origin`, `Referer`) are sent by default. The endpoint answers without them today; they cost nothing and keep working if that changes.
