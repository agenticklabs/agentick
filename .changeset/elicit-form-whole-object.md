---
"@agentick/spec": minor
"@agentick/elicitation": minor
"@agentick/mcp": minor
---

`Elicit` gains `form(message, schema)` / `tryForm(message, schema)` — the
whole-object ask the single-field helpers (`text`, `select`, `number`, …) are
shortcuts over. The caller hands a `StandardSchemaV1`; its JSON shape IS the
request schema and the client's whole answer comes back validated by it — no
single-key wrapping, no pluck. This is the deferred `object<T>` method landing
(MCP #171d.2.3), and it lets a caller that already holds a schema — a
model-authored `ask_user`, a plugin asking for a config object — elicit a
multi-field answer in one round-trip.

Both transports implement it: the in-process `buildElicitSugar` exposes the
existing `runForm` primitive, and `buildMcpElicit` sends the schema as
`requestedSchema` and validates the returned `content` object. The tasks
elicit proxies dispatch it generically with no change; note that a live
`StandardSchemaV1` carries a `validate()` function and so cannot cross a forked
task's process boundary — `form` is in-process only, matching the existing
cross-process guard.
