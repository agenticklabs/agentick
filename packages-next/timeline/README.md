# @agentick/timeline-next

**The timeline IS the conversation.** One append-only log per session —
every user message, every model generation, every tool result, every
turn — durable, replayable, and rendered back to the model on every
tick. Agentick's core bet is that context is _re-rendered from facts_
each tick rather than accumulated in a prompt string, and the timeline
is where those facts live.

## The one thing you must know: `<Timeline/>` OVERRIDES the default fold (ADR 63)

The conversation reaches the model by **default** — the compiler ships a
`timeline` surfacing projection that folds the timeline's current
projection (`read()` — post-compaction, minus `visibility: "log"`
entries) into context whenever your tree doesn't override it. Write
nothing and the conversation still surfaces:

```tsx
function MinimalAgent() {
  return <System>You are a helpful assistant.</System>;
  // The timeline surfaces via the default projection (default:timeline).
}
```

`<Timeline/>` is how you **override** that default to filter, compact, or
reshape the fold — it is the one projection of the timeline harness, and
rendering it suppresses the default (lazy — the log is never folded
twice):

```tsx
import { Timeline } from "@agentick/timeline-next/react";

function Agent() {
  return (
    <>
      <System>You are a helpful assistant.</System>
      <Calculator.Tool />
      {/* OVERRIDE the default projection — filter / compact / reshape. */}
      <Timeline maxTokens={100_000} roles={["user", "assistant"]} />
    </>
  );
}
```

Under the hood `<Timeline>` renders its fold inside
`<Project projectionKey="timeline">`, so the compiler tags its entries
`authored:timeline` and skips the default fold. The component boundary is
where filtering, compaction, and formatting become _your_ declarative
choices — but omitting it no longer drops the conversation. (ADR 63
retired the old `timeline-not-rendered` diagnostic for exactly this
reason: there is no longer a way to silently forget the timeline.)

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
import { Message, useOnExecutionStart } from "@agentick/reconciler-react-next";

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
      {(entries) =>
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

## Adaptive auto-compaction (`useContextInfo`)

`compact()` and the `<Timeline>` budget props are the levers; **`useContextInfo`
is the gauge** — real-time context-window utilization, so an adopter can
compress harder as the window fills (the ernesto `KnowifyTimeline`
pattern, now portable because the model registry supplies the window,
#204):

```tsx
import { useContextInfo } from "@agentick/reconciler-react-next";
import { Timeline } from "@agentick/timeline-next/react";

function AdaptiveTimeline() {
  const { utilization } = useContextInfo();       // 0..1, or undefined until known
  const tight = (utilization ?? 0) > 0.75;
  return (
    <Timeline
      strategy="sliding-window"
      preserveRoles={["system", "user"]}
      headroom={tight ? 4096 : 8192}               // reserve more as the window fills
    />
  );
}
```

`useContextInfo` reads `usedTokens` (ADR 53's per-generation usage
stamps) against the model's `contextWindow` (the #204 registry). Set an
auto-compaction policy once and it rides every tick — verbatim when
roomy, aggressive summarization when tight — with KV-cache discipline
intact (evict whole entries; never rewrite old ones).

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

## Client timeline — `fold(session event stream)` (`/client`)

The client-side timeline is a **fold over the session event stream** — no read
RPC, no bespoke channel. Every `timeline.append(...)` runs through the harness
command path (ADR 51); the declared verb `timeline:append` emits a
`timeline:command:append` lifecycle whose **`requested`-phase envelope carries
the appended entries** (`envelope.payload = { entries }`, the argument-bound
phase). `timelineView` subscribes to exactly those envelopes (via
`timelineEventQuery()` in `@agentick/spec-next`) and folds their entries onto a
growing `readonly TimelineEntry[]`.

```ts
import { timelineView } from "@agentick/timeline-next/client";

// `initial` seeds the fold with server-hydrated history (the AI-SDK
// `initialMessages` pattern — e.g. loaded server-side from LogStore.history);
// `fromCursor` resumes the live tail from AFTER that seed so appends are not
// double-counted. Omit both → empty accumulator, tailing live from now.
const view = timelineView(client, sessionId, {
  initial: serverHydratedEntries,
  fromCursor: lastSeenCursor,
  visibility: (e) => e.visibility !== "log", // optional filter (default: all)
});

view.get(); // readonly TimelineEntry[] — synchronous (React getSnapshot)
view.subscribe(() => rerender()); // useSyncExternalStore(view.subscribe, view.get)
view.onChange((append) => { … }); // the raw { entries } each fold sees
```

`timelineView` is a thin façade over the generic `eventView` primitive in
`@agentick/client-core-next` (fold ANY `EventQuery` on a scope, with an optional
`fromCursor`); `channelView` is the same machine pinned to a channel's query.
The `/client` subpath depends only on `client-core` + `spec` — never the
timeline harness runtime — so it never pulls the server harness into a browser
bundle.

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

`TimelineStore` is the concrete **log** archetype — `TimelineStore extends
LogStore<TimelineEntry>` (the port lives in `@agentick/spec-next`, port-home
§6-D; its `logKey` IS the `sessionId`). Port surface: `append → seq[]` / `read`
/ `keys` / `delete` / optional `prune` + `history` (seq-tagged `SeqTagged<T>`).
Entries are opaque to the store; `seq` is the frozen ordering identity
(#133/#168). Reference impl: `MemoryTimelineStore`, an empty
`extends MemoryLog<TimelineEntry>` subclass (`@agentick/store-next`) — the store
needs nothing the generic log doesn't provide (a full in-memory array is the
intended default, no memory strategy legislated, §2.7). Certify adapters with
`runTimelineStoreConformance`, which delegates its store-agnostic trio
(backend-id, empty-read → `[]`, idempotent-delete) to the shared
`runStoreConformance` skeleton.

## Verified by

- `src/__tests__/harness.spec.ts` + `conformance.ts` — append/projection
  invariants, turn boundaries + trailing-input fold, compaction.
- `src/__tests__/harness-store.spec.ts` — write policies, flush barrier,
  failure typing, `turnBoundaries: false`, cursored history.
- `src/__tests__/integration-with-reconciler.spec.tsx` — `<Timeline/>` →
  `context.entries` (the mechanism itself).
- Session-level: steering/join, send serialization, provenance stamps
  (`@agentick/session-next` extended-surface suite).
- `src/client/__tests__/timeline-view.spec.ts` — the client fold: `initial`
  seeding, `fromCursor` threading (no double-count), visibility filtering,
  copy-on-write refs, and the `timeline:command:append` requested-phase query.

## Roadmap & known gaps

- `TODO(trail-pending-render)` is CLOSED by ADR 53; `TODO(trail-entry-kinds)`
  remains (richer non-message kinds; `role: "event"` conflation deferred).
- Store adapters (#132): `@agentick/timeline-fs-next` (JSONL) and
  `@agentick/timeline-postgres-next` have SHIPPED; a SQLite adapter
  (`@agentick/timeline-sqlite-next`, the recommended first durable) is the
  remaining gap.
- `<Timeline/>` trailing-input styling + boundary turn-separators
  (ADR 53 wave 2).
