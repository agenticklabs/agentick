# @agentick/model-ai-sdk-next

Vercel AI SDK bridge for Agentick v2 (ADR 52) — wraps any `ai` package
`LanguageModel` as a `LanguageModelAdapter`. The progressive-adoption
path: keep your existing `@ai-sdk/*` provider setup, gain JSX agents,
sessions, tool harnesses, and observability.

## Quick Start

```ts
import { openai } from "@ai-sdk/openai";
import { aisdk } from "@agentick/model-ai-sdk-next";

const app = await createApp(<Agent />, {
  executor: aisdk(openai("gpt-4o")),
});
```

## API

`aisdk(model, options?)` → `LanguageModelAdapter`

- `model` — any AI SDK `LanguageModel` (model handle or plain id
  string).
- `options.target` — override the self-described `ExecutionTarget`
  (defaults derive from the model handle's `provider` + `modelId`).

This adapter uses the AI SDK as a **provider library** — one
`generateText` / `streamText` call per executor round; agentick runs
the loop. The "AI SDK as execution engine" archetype (their loop, their
tool dispatch) is a separate ADR 52 follow-up.

Per-part `providerMetadata` forwards as AI SDK `providerOptions` 1:1.

## Verified by

- `src/__tests__/ai-sdk-executor.spec.ts` — bridge behavior against
  `MockLanguageModelV2` (target derivation, tool-call extraction,
  finish-reason vocabulary, abort).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.

## Roadmap & known gaps

- Reasoning / file / source stream parts are not yet mapped
  (`mapChunk` ignores them).
- `aisdk(model, { tools })` registration with the app handler resolver.
