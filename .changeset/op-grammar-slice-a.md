---
"@agentick/mcp": minor
---

ADR 92 Slice A — the ingress family joins the operation grammar. Every
MCP server request crossing runs as a named, journaled, guardable op
(`mcp:command:<verb>`) with the connection dimension + authenticated
identity on its scope; work inside a crossing journals as a child
(parentOpId + connection dim, two levels deep); the security pipeline
rides the op guard seam (stages unchanged on the wire — byte-identical
frames); per-op-class journal policy (call-tool/initialize persisted,
reads bus-only). Subscription dispatch runs as
`subscriptions:command:dispatch` (guard-vetoable scheduled fires).
Admission failures emit a discrete event (connection shape + failure
class, never credentials). Runtime spine rule: child op scopes inherit
the ambient crossing's work-path + identity dimensions.
