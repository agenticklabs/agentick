---
"@agentick/spec": minor
"@agentick/loop-executor": minor
"@agentick/session": minor
"@agentick/gateway": minor
"@agentick/tool-executor": minor
---

Three follow-ups riding one slice. (1) The run-level `execution` summary
event now EXISTS: the loop emits `kind: "execution"` (output, usage,
stopReason, durationMs) after `execution-end` on any terminal carrying a
result — exactly as the per-tick `"tick"` follows `"tick-end"` — and the
session forwards it as the `type: "execution"` StreamEvent, which was
declared in spec but had no producer anywhere. Adopters now get a
per-execution duration, not just per-tick. (2) BREAKING: the superseded
`session/timeline_history` gateway porcelain is DELETED — handler, spec
`WireMethods` row, and the `SessionTimelineHistoryParams`/`Entry`/
`Result` types (the `Entry.cursor` co-location affordance was never
populated by anything and dies with it). `timeline/history` — the
harness's own grant-gated declared read — is the one wire door; the
bounded-tool-output hint now points there. (3) `LoopExecutorFactory`,
`ToolExecutorFactory`, and `SessionHarnessFactory` all type `deps` as
OPTIONAL, matching their implementations' documented local-substrate
fallback (the `CompilerFactory` cure applied to its three twins) —
dep-less construction is now reachable through the public types and
pinned by tests in all three packages.
