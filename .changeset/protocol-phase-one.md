---
"@agentick/gateway": minor
"@agentick/core": patch
"@agentick/shared": patch
---

Formalize gateway protocol with full schema discovery

Phase 1 — Protocol foundation:

- Add `protocolVersion` to ConnectMessage/ConnectedMessage handshake
- Send ConnectedMessage on WebSocket and Unix socket auth completion
- New built-in methods: `schema`, `tool-catalog`, `tool-confirm`, `tool-dispatch`
- Add `audience` field to ToolDefinition (shared)
- Add `getToolDefinitions()` to Session interface (core)

Phase 2 — Complete schema discovery:

- `schema` method returns full protocol contract: every method with JSON Schema
  for params and response, every event type with category, every error code
- Extract `MODEL_EVENT_TYPES`, `ORCHESTRATION_EVENT_TYPES`, `RESULT_EVENT_TYPES`
  from shared (zero-maintenance event catalog)
- Structured error codes using shared's error hierarchy (`isNotFoundError`,
  `isGuardError`, etc.) instead of catch-all `METHOD_ERROR`
- Custom method `response` schema support via `MethodDefinitionInput.response`
- Breaking: `SchemaPayload` shape changed — unified `methods` record replaces
  `builtInMethods`/`customMethods` split (no external consumers yet)
