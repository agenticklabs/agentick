---
"@agentick/shared": minor
"@agentick/core": minor
"@agentick/openai": minor
"@agentick/google": minor
"@agentick/apple": minor
"@agentick/huggingface": minor
---

Unified EmbedInput API and embed support on adapters

- **EmbedInput**: New single-object input shape (`{ input, model?, dimensions?, taskType? }`) mirroring ModelInput style. Replaces previous `(texts, options)` positional params.
- **embed as Procedure**: `EngineModel.embed` is now a Procedure with middleware, ALS context, and telemetry support.
- **OpenAI adapter**: Added `embeddingModel` config option and `embed()` support via OpenAI embeddings API.
- **Google adapter**: Added `embeddingModel` config option and `embed()` support via Google embedContent API, including `dimensions` and `taskType` passthrough.
- **Per-request model override**: API adapters (OpenAI, Google) respect `input.model` to override the configured embedding model per-request.
- **Custom XML tag passthrough**: Collector and markdown renderer now pass through unrecognized XML tags as custom blocks.
