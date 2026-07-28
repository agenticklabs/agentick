---
"@agentick/client-core": patch
"@agentick/tool-executor": patch
"@agentick/prompts": patch
"@agentick/skills": patch
"@agentick/resources": patch
---

Nothing to call at boot for a client catalog. The four RPC-polled
projections (`session.tools`, `session.prompts`, `session.skills`,
`session.resources`) already seed themselves on construction AND fire
`subscribe` when the answer lands — so binding `list()` + `subscribe()`
is the entire read path. That was never written down, so the first real
consumer fired three speculative `refresh()` round-trips at every
session open (`session.tools.refresh().catch(() => undefined)` and
friends) purely as a boot barrier, doubling the wire traffic and turning
a failed poll into a silently empty palette.

No new API: the requirement is removed by documenting the contract that
already holds and pinning it with tests. The `ClientHandle` contract, the
four package READMEs, and each handle's own comment now say the same
thing — render what `list()` has, re-render on change, never poll at
boot; `refresh()` is for invalidating a snapshot you already hold. Each
of the four packages gained a test that a subscriber registered while
the seed is still in flight is notified when it lands (with exactly ONE
poll on the wire), and that a failed first poll settles the snapshot
empty — never half-filled — until `refresh()` recovers it.
