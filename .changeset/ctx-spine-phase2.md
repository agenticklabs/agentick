---
"@agentick/spec": minor
---

ADR 91 Phase 2 — the ctx spine feeds the starved seams. New
`OperationCtx = RuntimeContext & Observability & Ops` (spec) as the
canonical trunk+facets intersection. `ResourceResolver` /
`TemplateResolver` gain `(uri, ctx?)`; `PromptDeclaration.render` gains
`(args, ctx?)`; MCP `CompletionContext` extends `OperationCtx`;
`TaskWorkContext` becomes `OperationCtx & TaskWorkVerbs` (a task body
can now log/trace/run with its owning session's identity).
`deriveContext` gains a boundary-extras parameter minting the whole
composed context branded (descriptor-based composition preserves live
getters); tool-executor and MCP context builders return
`Derived<...>`. MCP: the auth pre-gate's verdict now carries the
authenticated user (`AuthPreGateVerdict`), forwarded on
`McpConnectionInfo.authenticatedUser` — the authenticator runs exactly
once per initialize with function-form instructions.
