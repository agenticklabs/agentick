---
"@agentick/spec": minor
---

ADR 91 Phase 1 — the ctx spine. `RuntimeContext` (the pure-data trunk)
moves from `@agentick/runtime` into `@agentick/spec` (augmentation of
`RuntimeContextUser` retargets to `declare module "@agentick/spec"`).
New `Derived<C>` brand + `deriveContext(parent?, facets)` in runtime —
the single boundary-context constructor with lazy Observability/Ops
facets. `ToolHandlerCtx` / `WireExtensionContext` extend the trunk
(flat identity re-declarations removed); `StoreCtx` collapses to a
literal `extends RuntimeContext`. Breaking rename:
`WireExtensionContext.transport` → `wire`. MCP and tool-executor
context construction routes through the deriver.
