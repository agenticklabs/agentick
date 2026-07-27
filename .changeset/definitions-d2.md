---
"@agentick/timeline": minor
---

ADR 93 D2 — the client read door. `timeline:history` is now a DECLARED
wire-exposed command on the harness (`exposure: "wire"`): the dynamic lane
projects it as `timeline/history`, admission is the existing two-step
(deny-by-default exposure, then a grant on the `timeline:history` scope
label, same-principal target rule), and the payload/result are fully
serializable — a seq-cursored page with `nextFromSeq` present iff the page
was capped (sparse-seq safe: `lastSeq + 1`, a lower bound, never a claim).
Reads are a journaling CLASS: `timeline:command:history` is bus-only by
default (observable live, never durable), and an adopter `policy` layers
over the class per-key. The in-process `history()` face runs the same
command body — hooks and guards fire on both paths. Client:
`session.timeline.history()` is the raw stateless page (Posture B pages
straight into its own store); `loadOlder()` is its cursor-tracking
scroll-back sugar, spliced at the window head. Wire rows moved to a
type-only `wire-augment.ts` so the browser subpath types the door without
loading server-bridge augmentations. The old `session/timeline_history`
gateway porcelain is superseded (deletion queued with its spec rows).
