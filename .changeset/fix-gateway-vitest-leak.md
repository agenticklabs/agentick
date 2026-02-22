---
"@agentick/gateway": patch
---

Remove testing utility re-exports from main entrypoint to prevent vitest from being required at runtime. Testing utilities are available via `@agentick/gateway/testing` subpath import.
