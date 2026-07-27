---
"@agentick/spec": minor
"@agentick/session": minor
---

Spawn boundary events on the PARENT's stream. `spawn-start`
(`spawnSessionId`, `spawnExecutionId`, `originCallId?`) and `spawn-end`
(`spawnSessionId`, `isError`) bracket one `session.spawn({ send })`, so a
spawn-tree UI can draw a live child node and attach it to the SPECIFIC
tool call that asked for it. `originCallId` is the new
`SpawnInput.originCallId` — passed as data off the dispatch ctx's
`toolCallId`, because `spawn()` runs its operation on a fresh fiber that
cannot observe the dispatch's ambient context (the same Promise-boundary
reason `parentOpId` is threaded explicitly). The unbound spawn form emits
neither event: it has no child execution the parent can name.

RULED, and documented in the session README: a child's INTERIOR events
stay on the child's own handle — nothing is bubbled from one handle onto
another. `sequence` is a per-handle monotonic counter that durable replay
keys on, and the wire fan-out is scoped to one execution's progress
token; bubbling would either re-number foreign events or put a second
session's events on another session's authorized token. To watch a
child's interior, hold its handle. `StreamEventBase.spawnPath`'s
docstring is corrected to say what it is (the emitter's lineage) rather
than implying a bubbling channel.

`StreamEventBase.parentExecutionId` and `RunExecutionInput.parentExecutionId`
are DELETED. Both were declared and set by nothing, and with the boundary
pair the edge they described is expressed once, from the parent side,
alongside the origin call id — keeping them would be a second source of
truth for the same fact. No consumer breaks: nothing populated or read
either field.
