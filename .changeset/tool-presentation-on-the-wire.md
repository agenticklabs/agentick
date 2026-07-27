---
"@agentick/spec": minor
"@agentick/loop-executor": minor
"@agentick/session": minor
---

`ToolPresentation` crosses to the client. The four un-collapsed label
materials (`name` / `title` / `summary` / `narration`) the tool executor
already resolves at dispatch — `summary` being the author's
`displaySummary` annotation resolved against the VALIDATED input — were
computed and then thrown away on the wire path; `presentation` is now an
optional field on `tool-dispatch-end` and `tool-dispatch`, threaded
through `LoopExecutionEvent` and `buildOnEvent`. No new types, no second
resolution site, and the framework still presumes no precedence — the
client composes.

Deliberately NOT on `tool-dispatch-start`, contrary to where the label is
wanted first: resolution happens INSIDE the dispatch (it needs the
validated input and the model's stripped narration), strictly after the
start event is emitted. A slot there would be structurally
always-undefined, and filling it would mean re-resolving off the raw
declaration — a second, divergent path for the same fact. Pinned by a
test asserting `tool-dispatch-start` carries no `presentation`.
