# @agentick/timeline-next

**The timeline IS the conversation.** One append-only log per session —
every user message, every model generation, every tool result, every
turn — durable, replayable, and rendered back to the model on every
tick. Agentick's core bet is that context is *re-rendered from facts*
each tick rather than accumulated in a prompt string, and the timeline
is where those facts live.

## The one thing you must know: `<Timeline/>` IS the mechanism

Nothing injects conversation history automatically. The timeline
reaches the model **only** because your agent renders it:

```tsx
import { Timeline } from "@agentick/timeline-next/react";

function Agent() {
  return (
    <>
      <System>You are a helpful assistant.</System>
      <Calculator.Tool />
      {/* THE CONVERSATION — projection → <Message> nodes → model context. */}
      <Timeline />
    </>
  );
}
```

Omit it and the model receives a system-only context while your users
type into the void — a bug class severe enough that the reconciler now
emits a `timeline-not-rendered` diagnostic when the timeline holds
messages no component rendered. This inversion is deliberate: the
component boundary is where filtering, compaction, and formatting
become *your* declarative choices instead of framework policy.

## Consumption semantics (ADR 53 — offsets, not tiers)

There is no pending queue. Input **appends the moment it arrives** —
at `send()` and mid-execution — and consumption is **non-destructive**:
every tick re-renders the whole log, so nothing is ever "consumed away."
The distinctions other frameworks model as tiers are *derived facts*:

- **`trailingInput()`** — input entries after the last assistant entry
  (the structural "not yet replied to" set; style it, prompt resume
  with it — nothing load-bearing reads it).
- **Steering** — a `send()` while an execution runs JOINS it: messages
  append, the in-flight handle returns, and the loop's continuation
  predicate runs another tick so the model addresses the new input.
  "Wait — use the staging account" is native behavior:

```ts
const handle = await session.send({ messages: [{ role: "user", content: "do the thing" }] });
// ... the agent is mid-run ...
const same = await session.send({ messages: [{ role: "user", content: "wait — dry-run only!" }] });
// same === handle; the next tick sees the correction.
```

- **Turn boundaries** — at each execution end the session appends a
  `kind: "boundary"` record (outcome + the turn's aggregate usage,
  `visibility: "log"` so the model never sees it). Load-bearing
  NOWHERE — it is emitted data: turn segmentation for UIs and eval,
  cost-per-turn in the record (a failed tick's spend appears here even
  though it produced no entry). Opt out with `turnBoundaries: false`.
- **Provenance** — execution-produced entries carry
  `metadata.executionId` / `tickId`, and every assistant entry carries
  its generation's `metadata.usage` (one tick = one generation = one
  assistant entry). "Show me turn 3" and "cost per message" are log
  queries, not new systems.

## Two tiers, one truth

| Tier | What it is |
| --- | --- |
| **Persisted log** | Append-only ground truth. Never rewritten. |
| **Projection** | The model-visible view. `compact()` rewrites it (fold, summarize, evict) — the log is untouched, so compaction is always reversible re-derivation. |

`<Timeline/>` renders the projection. `readPersisted()` is the
uncompacted record. `history({ fromSeq, limit })` pages the durable log
by the store's frozen `seq` cursor (#168).

## Durability — stores, not snapshots (ADR 49)

Inject a `TimelineStore` and the session becomes **open-or-rehydrate**:
`createSession({ sessionId })` with entries in the store hydrates the
log before first render — create and resume are the same call. Writes
trail through a write-behind pump (default) or await per-append
(`writePolicy: "through"`); the `flush()` barrier at execution end
guarantees any process that subsequently loads the store sees every
completed execution.

```ts
const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  session: { timeline: { store: mySqliteStore } },   // implement TimelineStore,
});                                                   // certify with the conformance suite
```

Seeding IS resuming — `run({ history })` replays a previous session's
`snapshot().timeline` verbatim through the same hydration path (the
eval/replay loop).

## API sketch

```ts
session.timeline.read()            // projection snapshot { entries, version }
session.timeline.readPersisted()   // the uncompacted log
session.timeline.trailingInput()   // input after the last assistant entry
session.timeline.append(...e)      // admin/import path (bypasses the loop)
session.timeline.compact(strategy) // rewrite the projection; log untouched
session.timeline.history(opts)     // seq-cursored durable reads (store-optional)
session.timeline.subscribe(fn)     // any projection/log mutation
```

Declared commands (ADR 51): `timeline:append`, `timeline:compact`
(wire-exposed, signal form — the resident strategy runs), `timeline:replaceProjection`,
`timeline:resetProjection`. Enumerable via `timeline:commands`.

`TimelineStore` port: `load` / `append → seq[]` / `sessions` / `delete`
/ optional `prune` + `history`. Entries are opaque to the store; `seq`
is the frozen ordering identity (#133/#168). Reference impl:
`MemoryTimelineStore`; certify adapters with `runTimelineStoreConformance`.

## Verified by

- `src/__tests__/harness.spec.ts` + `conformance.ts` — append/projection
  invariants, turn boundaries + trailing-input fold, compaction.
- `src/__tests__/harness-store.spec.ts` — write policies, flush barrier,
  failure typing, `turnBoundaries: false`, cursored history.
- `src/__tests__/integration-with-reconciler.spec.tsx` — `<Timeline/>` →
  `context.entries` (the mechanism itself).
- Session-level: steering/join, send serialization, provenance stamps
  (`@agentick/session-next` extended-surface suite).

## Roadmap & known gaps

- `TODO(trail-pending-render)` is CLOSED by ADR 53; `TODO(trail-entry-kinds)`
  remains (richer non-message kinds; `role: "event"` conflation deferred).
- SQLite/Postgres store adapters (#132).
- `<Timeline/>` trailing-input styling + boundary turn-separators
  (ADR 53 wave 2).
