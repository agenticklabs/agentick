# @agentick/timeline-next

**The timeline IS the conversation.** One append-only log per session —
every user message, every model generation, every tool result, every
turn — durable, replayable, and rendered back to the model on every
tick. Agentick's core bet is that context is _re-rendered from facts_
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
become _your_ declarative choices instead of framework policy.

## Consumption semantics (ADR 53 — offsets, not tiers)

There is no pending queue. Input **appends the moment it arrives** —
at `send()` and mid-execution — and consumption is **non-destructive**:
every tick re-renders the whole log, so nothing is ever "consumed away."
The distinctions other frameworks model as tiers are _derived facts_:

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

## Fine-grained rendering — the render prop

`<Timeline>` accepts a render function over the kept entries — **total
control of what the model sees, per entry, per block**. The canonical
adopter pattern (ported from ernesto's `KnowifyTimeline`): current-turn
and assistant content verbatim, old heavy tool results collapsed to
_references the model can chase_:

```tsx
import { useState } from "react";
import { Timeline } from "@agentick/timeline-next/react";
import { Message, useOnExecutionStart } from "@agentick/reconciler-next/react";

const edges = (t: string) =>
  t.length <= 280 ? t : `${t.slice(0, 140)}\n…\n${t.slice(-140)}`;

// v2 has no <Text> component — content blocks are the currency. Build a
// ContentBlock[] and pass it via the `content` prop (verified by
// integration-with-reconciler.spec.tsx "README reference pattern").
export function ReferenceTimeline() {
  // Provenance beats clock math: the framework stamps
  // metadata.executionId on every entry it produces (ADR 53) — "is this
  // from the current turn?" is an exact comparison, not a timestamp
  // heuristic.
  const [currentExecution, setCurrentExecution] = useState<string>();
  useOnExecutionStart((e) => setCurrentExecution(e.executionId));

  return (
    <Timeline maxTokens={100_000} strategy="sliding-window" preserveRoles={["system", "user"]}>
      {(entries) => {
        entries.map(({ message }) => {
          // ICL safety: assistant output ALWAYS verbatim — summarized
          // assistant turns teach the model to produce summaries.
          if (message.role === "assistant") return <Message key={message.id} {...message} />;
          // Current turn: verbatim.
          if (message.metadata?.executionId === currentExecution)
            return <Message key={message.id} {...message} />;
          // OLD entries: map blocks to compact forms. Heavy tool
          // results render as a file reference — the tool layer wrote
          // the full payload to disk and stamped { path, bytes } on the
          // block's metadata; pair with a read_file tool and the model
          // can look the result up ON DEMAND instead of carrying it in
          // every context.
          const content = message.content.map((block) => {
            if (block.type === "tool_result") {
              const ref = block.metadata?.file; // { path, bytes } stamped by the tool layer
              return {
                type: "text" as const,
                text: ref
                  ? `[${block.name}] full result at ${ref.path} (${ref.bytes}B) — read_file if needed`
                  : `[${block.name}]`,
              };
            }
            if (block.type === "text") return { type: "text" as const, text: edges(block.text) };
            return { type: "text" as const, text: `[${block.type}]` };
          });
          return <Message key={message.id} role={message.role} content={content} />;
        })
      }
    </Timeline>
  );
}
```

The pieces composing here: the render prop (`(entries, budget) =>
ReactNode`) with `filter`/`roles`/`limit` pre-filters and
`maxTokens`/`strategy`/`preserveRoles`/`headroom`/`onEvict` budget
compaction; provenance stamps for exact turn detection; and
block-level `metadata` as the adopter's decoration channel (the
"extract heavy payloads to disk, render a reference" pattern is a TOOL
concern — the timeline just renders what the blocks carry). KV-cache
discipline is yours to keep: never rewrite old rendered entries between
ticks — evict whole entries (sliding-window does) so the prefix stays
cache-stable.

## Two tiers, one truth

| Tier              | What it is                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persisted log** | Append-only ground truth. Never rewritten.                                                                                                         |
| **Projection**    | The model-visible view. `compact()` rewrites it (fold, summarize, evict) — the log is untouched, so compaction is always reversible re-derivation. |

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
session.timeline.read(); // projection snapshot { entries, version }
session.timeline.readPersisted(); // the uncompacted log
session.timeline.trailingInput(); // input after the last assistant entry
session.timeline.append(...e); // admin/import path (bypasses the loop)
session.timeline.compact(strategy); // rewrite the projection; log untouched
session.timeline.history(opts); // seq-cursored durable reads (store-optional)
session.timeline.subscribe(fn); // any projection/log mutation
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
