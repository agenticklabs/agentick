---
"@agentick/spec": minor
"@agentick/store": minor
"@agentick/timeline": minor
"@agentick/timeline-fs": minor
"@agentick/timeline-postgres": minor
---

The last N entries of a log are readable. "Open this thread on its most
recent 20 messages" — the first read every chat UI performs — had no
expression anywhere in the framework: `LogQuery` and `history` took a
lower bound only, and the same lower-bound-only shape was mirrored at
every layer above (the `timeline/history` payload, the harness face, the
client handle). The first real consumer paid for that absence four
times over: it paged FORWARD from the log's head accumulating up to 25
pages to find the tail, kept its own mirrored copy of the window to do
it, re-seeded the handle from that copy (clobbering live appends), and
its scroll-UP affordance loaded NEWER entries.

The window is now `{ fromSeq?, toSeq?, limit? }` — one named
`LogHistoryOptions` shared by the port, the harness, and the wire
payload, so the shape cannot drift between them. Both bounds are
inclusive and `limit` truncates **from the end the query anchored at**:
declare a `fromSeq` and you get the first `limit` (forward paging,
unchanged); declare none and you get the last `limit` at or below
`toSeq`, defaulting to the log's tail. Rows always come back ascending
by `seq`. Adapters implement the reverse slice once (`MemoryLog`,
`timeline-fs`, `timeline-postgres` — `ORDER BY seq DESC LIMIT n`,
re-ascended), which is why this belongs at the port rather than being
re-solved per adapter; the conformance suite certifies it.

Above it: `timeline/history` replies now carry the cursor that continues
the direction asked in (`nextFromSeq` forward, `nextToSeq` backward), and
`session.timeline.loadOlder()` is a TRUE tail-anchored backward pager —
it opens on the log's newest page, walks down by `nextToSeq`, and splices
each page at the head, so page two lands above page one and scroll-back
needs no app-side mirror, re-seed, or re-sort. `hydrateTail(n)` is now
one round-trip instead of a `ceil(N / page)` forward seek.

BREAKING for callers that read a bare `{ limit: n }`: that used to mean
the log's FIRST n and now means its LAST n. Forward paging declares its
lower bound — `{ fromSeq: 0, limit: n }`.
