---
"@agentick/session": minor
---

ADR 92 Slice B — lifecycle & security mutations join the operation
grammar. `session:command:spawn` + `app:command:create-child-session`
(spawn/fork enveloped with parent linkage — `app.guard` can now veto a
spawn; the ADR 48 `onSessionCreate` behavior unchanged);
`session:command:close` (bus-only) with idle eviction routed through it
(`reason: "evicted" | "closed"` — `close()` gains an optional
`SessionCloseInput`); `live:command:{stop,close}` (in-process teardown
enveloped; `start` deferred to the sync-return design pass);
`credentials:command:{set,delete}` under the structural redaction law —
the secret is never an op input, so no journal record, bus envelope,
guard, or middleware can observe it (asserted over the full journal +
bus with fragment checks). New scope dims: `streamId`,
`credentialNamespace`/`credentialKey`.
