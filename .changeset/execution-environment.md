---
"@agentick/core": minor
---

Add ExecutionEnvironment, SessionRef, SpawnOptions, async close()

- ExecutionEnvironment interface with 6 optional hooks: prepareModelInput, executeToolCall, onSessionInit, onPersist, onRestore, onDestroy
- SessionRef narrow interface for environment lifecycle hooks (avoids generic type friction)
- SpawnOptions (3rd arg to session.spawn()) for overriding model, environment, maxTicks
- session.close() is now async (Promise<void>) — properly awaits onDestroy, child closes, compiler unmount
- createTestEnvironment() with function interceptor support in @agentick/core/testing
- Dead code cleanup: removed obsolete streaming accumulation and processStream from EngineModel
