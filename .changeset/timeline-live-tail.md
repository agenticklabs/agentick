---
"@agentick/timeline": minor
"@agentick/session": minor
---

The client's live timeline tail actually delivers now. It never did.

`session.timeline` folds every `timeline:command:append` requested-phase envelope
onto its window. That fold is implemented, documented, and unit-tested against a
stub client — and over a real wire it received nothing, ever. A client window
grew only from its own optimistic appends and from explicit `loadOlder` paging.
So every fact the server committed — the canonical copy of the user's message,
each tick's assistant entry, the turn boundary — arrived nowhere until something
paged for it.

Two correct-looking halves that disagreed on one field:

- The gateway narrows a `{ kind: "session", id }` subscription to
  `query.scope.sessionId === id`
  (`gateway/src/wire/subscriptions-extension.ts`).
- `TimelineHarness` stamped its own `scopeId` as the emitted
  `EventScope.sessionId`, and a session's timeline is constructed
  `<sessionId>:timeline`.

An envelope announcing itself from session `"s1:timeline"` therefore never
satisfied a subscription to session `"s1"`. Nothing errored; the subscription
opened, matched nothing, and stayed open.

`scopeId` is right as it stands — it is the harness's work-axis identity, the
inbox address root (`timeline:<scopeId>`) and the log's store key, and it has to
stay composed or two harnesses on one session would collide.
`EventScope.sessionId` answers a different question ("which session did this
happen in"), and the codebase already had the slot for it: `parentScope`, which
`ElicitationHarness` and `TasksHarness` are both given at the same construction
site. **Timeline was the one bridge that never took it.** It does now, from both
construction paths (`session-bridges.ts` and the session extension).

How it surfaced, and why it went unnoticed for so long: a turn whose execution
fails writes no assistant entry — no generation completed — so its `failed` turn
boundary is the only evidence the turn happened at all. A UI folding the timeline
showed the user's message and then silence, indistinguishable from a message that
was never sent. On SUCCESSFUL turns the gap is invisible, because a streaming
consumer renders the answer from the execution's own event stream and never needs
the committed copy.

Verified by `transport-in-process/src/__tests__/timeline-live-tail-e2e.spec.ts`:
a real gateway, a real transport, the registered client handle — a server append
and an `endTurn` both land in the client's window, and the emitted envelope's
scope is asserted to be the session rather than the harness. Reverting either
half of the fix fails it.

Known gap, marked `TODO(parent-scope-audit)` at the slot: `session-bridges.ts`
constructs knobs, state, resources and subscriptions the same way and gives none
of them a `parentScope`. Any of those that emit have the same dead live
projection, and each needs the same e2e shape to prove otherwise. Not swept
blind in this change.
