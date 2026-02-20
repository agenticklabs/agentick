---
"@agentick/shared": minor
"@agentick/core": minor
"@agentick/gateway": minor
"@agentick/connector": minor
"@agentick/connector-telegram": minor
"@agentick/apple": minor
"@agentick/huggingface": minor
"agentick": minor
---

feat: embeddings, gateway plugins, unix socket transport

- Shared: embeddings types (`EmbeddingProvider`), `splitMessage` utility
- Core: embedding support on adapters and engine models, `entry_committed` event, `executionId` on TickState
- Gateway: plugin system with lifecycle management, Unix socket transport with shared RPC factory
- Connector: re-export `splitMessage` from shared
- Connector-telegram: rewrite as GatewayPlugin
- Apple: embedding support via Apple Intelligence
- Huggingface: new adapter for local embeddings via Transformers.js
- Agentick: re-export `jsx-runtime` and `jsx-dev-runtime` from core
- Fix: sub-path exports in publishConfig, Procedure wrapping for Tool handler
