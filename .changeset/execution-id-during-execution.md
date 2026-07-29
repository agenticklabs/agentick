---
"@agentick/client-core": minor
---

`handle.executionId` is known DURING the execution, not only after it.

The client send handle assigned `executionId` inside the `session/send` response
handler — and that response does not arrive until the turn is over. So for the
entire life of an execution the getter returned `""`, which is precisely the
window in which the id is useful.

What it costs a consumer: the id is how a UI decides whether a committed timeline
entry belongs to the turn it is currently streaming. One conversation arrives in
two halves — the live event stream and the committed timeline — and something has
to hand over between them. Comparing every committed entry against `""` answers
"not mine" for all of them, so the hand-over never happens and the turn renders
TWICE: the same words, once from the stream and once from the timeline, under two
different row ids.

Every `StreamEventBase` carries `executionId`, so the id is on the first frame.
`events()` now takes it from the first event that names it, and keeps that one —
a later event cannot relabel an execution mid-turn.

Caveat, stated rather than hidden: this advances the getter only while something
is consuming `events()`. A caller that awaits `.result` alone still sees `""`
until it resolves, exactly as before. Knowing the id at `send()` time with no
consumer means minting it client-side and passing it in the send params (the
`clientId` pattern) — a change of id-minting authority, not a tweak. Marked
`TODO(execution-id-at-send)`.

Verified by `client-core/src/__tests__/execution-handle-id.spec.ts`, whose
fixture keeps `session/send` pending forever — the state a real client is in for
the whole of a running turn, and the state the old getter could say nothing
about.
