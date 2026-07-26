# @agentick/timeline

**The timeline is the conversation.** One append-only log per session — every user message, every model generation, every tool result, every turn boundary — durable, replayable, and re-rendered to the model on every tick.

That last part is the bet. Agentick doesn't accumulate a prompt string across turns; it re-derives context from facts each tick, and the timeline is where the facts live. Everything else in this package follows from that: compaction rewrites a _view_, never the log; the client is a _fold_ over an event stream, never a second copy of the truth.

## Install

```bash
npm install @agentick/timeline
```

Subpaths: `/react` (components + hooks), `/client` (browser-side view), `/strategies` (compaction), `/testing` (stub + conformance suites).

## Quick start

The conversation reaches the model by default. Write nothing and it still surfaces:

```tsx
function MinimalAgent() {
  return <System>You are a helpful assistant.</System>;
}
```

`<Timeline/>` is how you **override** that default — to filter, compact, or reshape what folds into context:

```tsx
import { Timeline } from "@agentick/timeline/react";

function Agent() {
  return (
    <>
      <System>You are a helpful assistant.</System>
      <Timeline maxTokens={100_000} roles={["user", "assistant"]} />
    </>
  );
}
```

> [!IMPORTANT]
> Rendering `<Timeline/>` suppresses the default fold — the log is never folded twice. Omitting it doesn't drop the conversation; there is no way to silently forget the timeline.

`<Transcript>` is the same component under a name that reads better in chat-shaped apps.

## Two tiers, one truth

| Tier              | What it is                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Persisted log** | Append-only ground truth. Never rewritten.                                                                         |
| **Projection**    | The model-visible view. `compact()` rewrites it — the log is untouched, so compaction is reversible re-derivation. |

`<Timeline/>` renders the projection. `readPersisted()` is the uncompacted record. `history({ fromSeq, limit })` pages the durable log by the store's frozen `seq` cursor.

```ts
const { entries, version } = session.timeline.read(); // projection snapshot
session.timeline.readPersisted(); // the uncompacted log
session.timeline.trailingInput(); // input after the last assistant entry
session.timeline.subscribe(() => rerender()); // any projection or log mutation
await session.timeline.history({ limit: 50 }); // seq-cursored durable read
await session.timeline.compact(strategy); // rewrite the projection
```

### Reading it from a component — `useTimeline`

`useTimeline()` is the same projection snapshot, as a hook. That's enough to build your own `<Timeline>` — map the entries and render whatever you want:

```tsx
import { Message, Project } from "@agentick/compiler-react";
import { useTimeline } from "@agentick/timeline/react";
import type { MessageTimelineEntry } from "@agentick/spec";

const isMessage = (e: { kind: string }): e is MessageTimelineEntry => e.kind === "message";

export function MyTimeline() {
  const { entries } = useTimeline(); // the projection — what the model sees

  return (
    <Project projectionKey="timeline">
      {entries
        .filter(isMessage)
        .filter((e) => e.visibility !== "log") // journaled, never rendered
        .map((e) => (
          <Message key={e.message.id} {...e.message} />
        ))}
    </Project>
  );
}
```

That is, near enough, what `<Timeline>` does — it adds the filters, the token budget, and the render prop on top.

> [!IMPORTANT]
> The `<Project projectionKey="timeline">` wrapper is not decoration. It's what claims the `timeline` surfacing key and suppresses the default fold. Map entries into `<Message>` without it and the conversation lands in context **twice** — once from your component, once from the default projection.

Both tiers are reachable from render, so a component can also report on the projection rather than render it:

```tsx
import { Section, useBridges } from "@agentick/compiler-react";
import { useTimeline } from "@agentick/timeline/react";

export function CompactionNotice() {
  const { entries } = useTimeline();
  const { timeline } = useBridges();
  const dropped = timeline.readPersisted().length - entries.length;
  if (dropped <= 0) return null;

  return (
    <Section id="compaction-notice">
      {`${dropped} earlier turns were compacted out of context. Say so if you need detail from them.`}
    </Section>
  );
}
```

The hook returns `{ entries, version }` and is backed by `useSyncExternalStore`, so a component re-renders as the projection's `version` advances. It is read-only by design — writes go through `session.timeline` or the declared commands, never through the hook. For the uncompacted log, reach the bridge directly as above.

## No pending queue

Input **appends the moment it arrives** — at `send()` and mid-execution — and consumption is non-destructive. Every tick re-renders the whole log, so nothing is ever "consumed away." The distinctions other frameworks model as tiers are derived facts here:

**Steering is native.** A `send()` while an execution is running _joins_ it: the messages append, the in-flight handle comes back, and the loop runs another tick so the model addresses the new input.

```ts
const handle = await session.send({ messages: [{ role: "user", content: "do the thing" }] });
// ... the agent is mid-run ...
const same = await session.send({ messages: [{ role: "user", content: "wait — dry-run only" }] });
console.log(same === handle); // true — the running execution absorbed the correction
```

**`trailingInput()`** is the structural "not yet replied to" set: input entries after the last assistant entry. Style it, resume a prompt from it — nothing load-bearing reads it.

**Turn boundaries** are appended at each execution end: outcome plus the turn's aggregate usage, marked `visibility: "log"` so the model never sees them. They're emitted data, not control flow — turn segmentation for UIs and eval, and cost-per-turn including a failed tick's spend that produced no entry. Pass `turnBoundaries: false` to opt out.

**Provenance** rides every entry the framework produces: `metadata.executionId` and `metadata.tickId`, plus `metadata.usage` on each assistant entry (one tick, one generation, one assistant entry). "Show me turn 3" and "cost per message" are log queries, not new subsystems.

## Fine-grained rendering

`<Timeline>` takes a render function over the kept entries — total control of what the model sees, per entry, per block. The pattern worth stealing: keep the current turn and all assistant output verbatim, collapse old heavy tool results into references the model can chase.

```tsx
import { useState } from "react";
import { Timeline } from "@agentick/timeline/react";
import { Message, useOnExecutionStart } from "@agentick/compiler-react";

const edges = (t: string) => (t.length <= 280 ? t : `${t.slice(0, 140)}\n…\n${t.slice(-140)}`);

export function ReferenceTimeline() {
  // Provenance beats clock math: "is this from the current turn?" is an
  // exact comparison against the stamped executionId, not a heuristic.
  const [currentExecution, setCurrentExecution] = useState<string>();
  useOnExecutionStart((e) => setCurrentExecution(e.executionId));

  return (
    <Timeline maxTokens={100_000} strategy="sliding-window" preserveRoles={["system", "user"]}>
      {(entries) =>
        entries.map(({ message }) => {
          // Assistant output stays verbatim — summarizing it teaches the
          // model to produce summaries.
          if (message.role === "assistant") return <Message key={message.id} {...message} />;
          // The current turn stays verbatim.
          if (message.metadata?.executionId === currentExecution) {
            return <Message key={message.id} {...message} />;
          }
          // Older entries: heavy tool results become a chaseable reference.
          // The tool layer wrote the payload to disk and stamped { path,
          // bytes } on the block; pair with a read_file tool and the model
          // looks it up on demand instead of carrying it every tick.
          const content = message.content.map((block) => {
            if (block.type === "tool_result") {
              const ref = block.metadata?.file as { path: string; bytes: number } | undefined;
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

Three things compose there: the render prop with its `filter`/`roles`/`limit` pre-filters and `maxTokens`/`strategy`/`preserveRoles`/`headroom`/`onEvict` budget compaction; provenance stamps for exact turn detection; and block-level `metadata` as your decoration channel. Extracting heavy payloads to disk is a _tool_ concern — the timeline just renders what the blocks carry.

> [!WARNING]
> KV-cache discipline is yours to keep. Never rewrite old rendered entries between ticks — evict whole entries, which `sliding-window` does, so the prefix stays cache-stable.

## Adaptive compaction

`compact()` and the `<Timeline>` budget props are the levers; `useContextInfo` is the gauge. It reads accumulated usage against the model's declared context window, so a component can compress harder as the window fills:

```tsx
import { useContextInfo } from "@agentick/compiler-react";
import { Timeline } from "@agentick/timeline/react";

function AdaptiveTimeline() {
  const { utilization } = useContextInfo(); // 0..1, or undefined until known
  const tight = (utilization ?? 0) > 0.75;
  return (
    <Timeline
      strategy="sliding-window"
      preserveRoles={["system", "user"]}
      headroom={tight ? 4096 : 8192} // reserve more as the window fills
    />
  );
}
```

Set the policy once and it rides every tick — verbatim when roomy, aggressive when tight.

### Compaction strategies

A `CompactStrategy` is a plain value: a source tier plus an async function over its entries, whose return becomes the new projection. `fromHandler` is the escape hatch that turns any function into one.

```ts
import { fromHandler } from "@agentick/timeline/strategies";

const keepRecent = fromHandler({
  source: "persisted", // or "projection" — default "persisted"
  handler: async ({ entries }) => entries.slice(-20),
});

await session.timeline.compact(keepRecent);
```

Bind one at construction and `compact()` with no argument runs it — including a bare `timeline:compact` verb arriving over the wire. An explicit call-site strategy wins over the bound default; calling with neither rejects with a typed error.

## Durability — stores, not snapshots

Inject a `TimelineStore` and sessions become open-or-rehydrate: `createSession({ sessionId })` with entries in the store hydrates the log before first render. Create and resume are the same call.

```ts
import { withTimeline, MemoryTimelineStore } from "@agentick/timeline";

const timeline = withTimeline({
  store: new MemoryTimelineStore(), // swap for a durable adapter
  writePolicy: "behind", // "behind" (default) | "through"
  compact: keepRecent, // construction-bound default strategy
});
```

Writes trail through a write-behind pump by default, or await per-append with `writePolicy: "through"`. The `flush()` barrier at execution end guarantees that any process loading the store afterwards sees every completed execution. Store failures surface as typed errors — `TimelineWriteFailed` from the append or the flush, `CompactHandlerFailed` when a strategy (an LLM call, say) blows up — never as an unhandled defect.

Compaction never touches the store. Seeding is resuming: replaying a previous session's entries goes through the same hydration path, which is what makes eval and replay loops work.

`TimelineStore` is a log-shaped port — `append → seq[]`, `read`, `keys`, `delete`, plus optional `prune` and `history`. Entries are opaque to it and `seq` is the frozen ordering identity. The bundled `MemoryTimelineStore` is a plain in-memory log. Certify your own adapter with `runTimelineStoreConformance` from `/testing`; shipped adapters are [@agentick/timeline-fs](../timeline-fs) (JSONL) and [@agentick/timeline-postgres](../timeline-postgres).

## The client timeline

The browser-side timeline is a **fold over the session event stream** — no read RPC, no bespoke channel. Every append runs through the command path, and the resulting lifecycle envelope carries the appended entries; the client subscribes to exactly those envelopes and folds them onto a growing array.

Importing the subpath registers `session.timeline` on the client:

```ts
import "@agentick/timeline/client";

const t = client.session(sessionId).timeline;

t.subscribe(() => render(t.list())); // re-render on any change

onScrollTop(async () => {
  const { done } = await t.loadOlder(50); // page older history in at the head
  if (done) detachScrollHandler(); // reached the log's tail
});
```

That's the whole scroll-back loop. `loadOlder()` wraps a cursored, bounded read over the durable log, tracks its own cursor across calls, and splices each page at the head.

**Or feed your own store instead.** The handle is a typed subscription; your shape can be the truth:

```ts
t.subscribe(() => myStore.ingest(t.list().map(toMyMessage)));
```

Both postures are first-class: the handle _is_ your state (bind a UI straight to `list()` and `subscribe()`), or the handle _feeds_ your state. The framework owns no client cache, so nothing fights an adopter whose message model isn't ours — `metadata` passes through and carries your join keys.

The window verbs are local view mutations with no wire round-trip: `seed(entries)` replaces the window with server-hydrated history, `prepend`/`append` splice at head and tail, `clear()` empties it. `view({ filter })` mints an additional filtered projection over the _same_ wire subscription — no second subscribe — and closes independently.

> [!NOTE]
> There is no framework-level dedup. Live appends carry a bus cursor while durable history carries the timeline `seq` — two numbering systems, so a single-key merge would need a server change that isn't worth it. When an optimistic `append` is later echoed by the server, reconcile by matching `message.metadata.clientId`, the correlation id that rides `send()` straight onto the folded entry.

### The headless factory

`timelineView` is what the handle is built on. Reach for it directly when you're composing rather than binding:

```ts
import { timelineView } from "@agentick/timeline/client";

// `initial` seeds the fold with server-hydrated history; `fromCursor`
// resumes the live tail from AFTER that seed so appends aren't
// double-counted. Omit both → empty, tailing live from now.
const view = timelineView(client, sessionId, {
  initial: serverHydratedEntries,
  fromCursor: lastSeenCursor,
  visibility: (e) => e.visibility !== "log",
});

view.get(); // readonly TimelineEntry[] — synchronous (getSnapshot)
view.subscribe(() => rerender()); // useSyncExternalStore(view.subscribe, view.get)
view.onChange((append) => console.log(append.entries.length)); // raw live folds

view.prepend(olderEntries); // scroll-back: splice at the HEAD
view.append([optimisticEntry]); // optimistic: splice at the TAIL
```

Both splices are copy-on-write — a new array reference each time, satisfying the `useSyncExternalStore` contract — and a no-op on an empty or fully-filtered batch. The live fold keeps tailing and interleaves correctly after any prior splice. `/client` depends only on the generic client and the shapes package, never the server-side implementation, so it can't drag the session runtime into a browser bundle.

## API

### `@agentick/timeline`

| Export                                          | Purpose                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `withTimeline(options?)`                        | Session extension: store, write policy, default compaction |
| `TimelineHarness`                               | The implementation, for direct construction                |
| `MemoryTimelineStore`                           | Bundled in-memory log store                                |
| `TimelineHandle` (type)                         | What `session.timeline` exposes                            |
| `TimelineStore` / `TimelineEntry` / `SeqTagged` | Port and data types, re-exported from the shapes package   |

### `session.timeline`

| Method                          | Returns                                            |
| ------------------------------- | -------------------------------------------------- |
| `read()`                        | Projection snapshot `{ entries, version }`         |
| `readPersisted()`               | The uncompacted durable log                        |
| `trailingInput()`               | Input entries after the last assistant entry       |
| `inputEntryCount()`             | Count of input entries in the persisted log        |
| `append(...entries)`            | Append to log + projection atomically              |
| `compact(strategy?)`            | Rewrite the projection; resolves a `CompactResult` |
| `history({ fromSeq?, limit? })` | Seq-tagged durable page; flushes writes first      |
| `endTurn(input)`                | Emit the turn-boundary record                      |
| `subscribe(fn)`                 | Fires on any projection or log mutation            |

Addressable verbs, enumerable via `timeline:commands`: `timeline:append`, `timeline:compact`, `timeline:replaceProjection`, `timeline:resetProjection`.

### `@agentick/timeline/react`

| Export                              | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `<Timeline>`                        | Override the default fold; filter, budget, or render-prop it |
| `<Transcript>`                      | The same component, chat-shaped name                         |
| `useTimeline()`                     | Projection snapshot; re-renders when the version advances    |
| `compactEntries` / `getEntryTokens` | The budget primitives `<Timeline>` uses internally           |

`<Timeline>` props: `roles`, `filter`, `limit` (pre-filters) · `maxTokens`, `strategy`, `preserveRoles`, `headroom`, `guidance`, `onEvict` (budget) · `children` as a render function or static JSX.

### `@agentick/timeline/client`

| Export              | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `session.timeline`  | Registered on import: window + `loadOlder` + minted views |
| `timelineView(...)` | The headless fold the handle is built on                  |

### `@agentick/timeline/testing`

| Export                          | Purpose                                    |
| ------------------------------- | ------------------------------------------ |
| `stubTimelineHarness(initial?)` | Standalone instance with its own substrate |
| `runTimelineHarnessConformance` | Certify an alternate implementation        |
| `runTimelineStoreConformance`   | Certify a store adapter                    |

## Patterns

**Durable adapters.** [@agentick/timeline-fs](../timeline-fs) and [@agentick/timeline-postgres](../timeline-postgres) implement `TimelineStore`; both pass the conformance suite.

**Rendering.** [@agentick/compiler-react](../compiler-react) owns `<Message>`, `<System>`, the content block components, and `useContextInfo`.

**Shapes.** [@agentick/spec](../spec) owns `TimelineEntry`, `TimelineStore`, `CompactStrategy`, and `Cursor`.

**Wire.** [@agentick/gateway](../gateway) serves `session/timeline_history` for scroll-back. Its optional `truncateToolResults` policy trims oversized tool output on client-facing frames only — the durable log and the model-facing projection always keep the full bytes, and a truncated block carries `metadata.bounded`. Off by default, and orthogonal to compaction.

## Roadmap & known gaps

- **SQLite adapter** — the recommended first durable store isn't shipped. Filesystem and Postgres are.
- **Richer entry kinds** — non-message records beyond turn boundaries are still coarse; `role: "event"` conflation is deferred.
- **`<Timeline>` turn affordances** — trailing-input styling and boundary turn-separators aren't built.
- **Cursor vs. seq** — the live tail is bus-cursor-ordered while durable history is seq-ordered, and the two are deliberately not unified. An app doing true infinite-scroll-up reconciles final ordering itself.
- **`useTimeline` has no dedicated suite.** It is exercised through `<Timeline>`, which reads the projection through it; the re-render-on-version-advance path isn't pinned on its own.

## Verified by

- `src/__tests__/harness.spec.ts` + `conformance.ts` — append/projection invariants, inbox addressability, snapshot round-trip across instances.
- `src/__tests__/harness-store.spec.ts` — write-behind and write-through, flush barrier and idempotence, hydration on resume, typed store failures, cursored `history()`, `turnBoundaries: false`, and that compaction never touches the store.
- `src/__tests__/compact-default.spec.ts` — construction-bound default strategy, call-site override, typed rejection with neither, the bare `timeline:compact` verb, verb enumeration.
- `src/__tests__/integration-with-compiler.spec.tsx` — `<Timeline/>` overriding the default fold, role/limit/predicate filtering, the render prop, budget eviction with `onEvict`, `preserveRoles`, the reference collapse pattern above, and `<Transcript>` identity.
- `src/client/__tests__/timeline-view.spec.ts` + `timeline-handle.spec.ts` + `timeline-fanout.spec.ts` — `initial` seeding, `fromCursor` threading with no double-count, visibility filtering, copy-on-write refs, the window splices, `loadOlder` cursor advance and tail latch, and one shared subscription across minted views.
- Steering and provenance stamps are covered in [@agentick/session](../session) (`extended-surface.spec.ts`); the `session/timeline_history` wire read in [@agentick/gateway](../gateway).
