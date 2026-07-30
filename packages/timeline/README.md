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

`<Timeline/>` renders the projection. `readPersisted()` is the uncompacted record. `history({ fromSeq, toSeq, limit })` reads the durable log by the store's frozen `seq` — in either direction.

```ts
const { entries, version } = session.timeline.read(); // projection snapshot
session.timeline.readPersisted(); // the uncompacted log
session.timeline.trailingInput(); // input after the last assistant entry
session.timeline.subscribe(() => rerender()); // any projection or log mutation
await session.timeline.history({ limit: 50 }); // the durable log's LAST 50
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

The simplest form is a function of the entries — set it on the definition and `compact()` with no argument runs it:

```ts
defineTimeline({
  compact: (entries, ctx) => {
    ctx.log.debug({ compacting: entries.length });
    return entries.slice(-20);
  },
});
```

A `CompactStrategy` is the same thing as a configured value: a source tier plus an async function over its entries. `fromHandler` turns any function into one, and it is what you pass at a call site.

```ts
import { fromHandler } from "@agentick/timeline/strategies";

const keepRecent = fromHandler({
  source: "persisted", // or "projection" — default "persisted"
  handler: async ({ entries }) => entries.slice(-20),
});

await session.timeline.compact(keepRecent);
```

Both forms go in the same `compact` slot. The no-argument `compact()` is the form that can arrive as a bare `timeline:compact` verb over the wire — a strategy is executable configuration and never travels, so the resident default is what runs, optionally taking advisory `instructions` off the signal. An explicit call-site strategy wins over the bound default; calling with neither rejects with a typed error.

## Configuring it — `defineTimeline`

One object configures the timeline, and it goes on the app:

```ts
import { createApp } from "@agentick/app";
import { defineTimeline, hydrateTail } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";

const app = await createApp(Agent, {
  model,
  timeline: defineTimeline({
    store: fsTimelineStore({ dir: "./.agentick/transcripts" }),
    hydrate: hydrateTail(200), // open on the last 200 entries
    compact: async (entries) => entries.slice(-40), // the bound default
    writePolicy: "behind", // "behind" (default) | "through"
  }),
});
```

`defineTimeline` is identity plus a brand — it returns the object you gave it, so it is a value you can export from a config module, import in a test, and override a slot on. Nothing is constructed and no store is opened until a session installs it; each session builds its own timeline from the plan.

The wrapper is optional. `timeline: { store }` is the same type and works identically; `defineTimeline` exists so a definition can be named, shared, and recognized.

For a runtime-built or conditional install, `withTimeline(definition)` takes the same object and goes in `extensions: []`. A live `TimelineHarness` instance is accepted anywhere a definition is — the escape hatch for when you own the lifecycle.

### Genesis — what a session opens on

`hydrate(ctx)` decides what a session's timeline holds at open. It runs once, after identity is stamped and before the first render, so the first compile already sees the resumed conversation.

```ts
defineTimeline({
  store,
  // `ctx` is the session's real context: identity, principal, logging — plus
  // `ctx.store`, this definition's own store, typed as the adapter you passed.
  hydrate: async (ctx) => {
    const all = await ctx.store.read(ctx.sessionId ?? "", ctx);
    return all.filter((e) => e.visibility !== "log");
  },
});
```

Two hydrators ship with the package:

| Hydrator             | Opens on              | Cost                                                                                                        |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hydrateFromStore()` | The whole durable log | The full log in memory. **The default** when a `store` is set.                                              |
| `hydrateTail(n)`     | The last `n` entries  | `n` entries, whatever the log's length — it pages through the store's cursored read and never calls `read`. |

> [!IMPORTANT]
> What a hydrator returns is a **seed**, not a write. Genesis entries are never appended, so nothing is written back to the store. A hydrator that returns entries it also appends duplicates the log on every resume — this is the one mistake to know about, and the conformance suite asserts against it.
>
> Genesis runs on **create and resume, never on fork or spawn**: a forked child inherits its parent's conversation directly, so re-running genesis would duplicate it.

A hydrator that throws fails `createSession` with `TimelineHydrateFailed` — there is no half-hydrated session.

Because genesis is a function of the real context, sources beyond a store are just code: `ctx.principal` for a tenant-scoped read, `ctx.journalReader` to fold an event log, or a literal array for a fixture.

```ts
defineTimeline({ hydrate: async () => fixtureEntries }); // seed a test or an eval
```

### Writes and failure

Writes trail through a write-behind pump by default, or await per-append with `writePolicy: "through"`. The `flush()` barrier at execution end guarantees that any process loading the store afterwards sees every completed execution. Store failures surface as typed errors — `TimelineWriteFailed` from the append or the flush, `CompactHandlerFailed` when a strategy (an LLM call, say) blows up — never as an unhandled defect.

Compaction never touches the store.

### The store port

`TimelineStore` is a log-shaped port — `append → seq[]`, `read`, `keys`, `delete`, plus optional `prune` and `history`. Entries are opaque to it and `seq` is the frozen ordering identity. The bundled `MemoryTimelineStore` is a plain in-memory log; shipped adapters are [@agentick/timeline-fs](../timeline-fs) (JSONL) and [@agentick/timeline-postgres](../timeline-postgres).

When durability is a few lines against a table you already have, `defineTimelineStore` builds a conforming store from its verbs — the `query`/`mutate` seam is derived for you:

```ts
import { defineTimelineStore } from "@agentick/timeline";

const store = defineTimelineStore({
  backend: "pg",
  append: (key, entries) => insertReturningSeq(key, entries),
  read: (key) => selectEntries(key),
  keys: () => selectDistinctKeys(),
  delete: (key) => deleteLog(key),
  history: (key, o) => selectEntryWindow(key, o), // { fromSeq?, toSeq?, limit? }
});
```

`history` is optional in the port but worth implementing: it is what bounded hydration, history paging, and client scroll-back all use. Either way, certify the result with `runTimelineStoreConformance` from `/testing` — the `seq` contract (strictly increasing, never reused, stable across `prune`) is not something types can check.

### Hooks and guards

A definition carries the timeline's own interceptors, named by bare verb:

```ts
defineTimeline({
  hooks: {
    onBeforeAppend: (input) => log.debug({ appending: input.entries.length }),
    onAfterCompact: (result) => metrics.count("compaction", result.entriesAfter),
  },
  guards: {
    append: (input) =>
      input.entries.length > 500 ? { kind: "veto", reason: "batch too large" } : undefined,
  },
});
```

These are colocation sugar over the same interceptors `createApp({ hooks, guards })` installs under discriminated names (`onBeforeTimelineAppend`, `guards: { timelineAppend }`). Scope decides order: app-level interceptors wrap definition-level ones, and an app guard vetoes before a definition guard is consulted.

## The client timeline

The browser-side timeline is a **fold over the session event stream** for everything live — no bespoke channel. Every append runs through the command path, and the resulting lifecycle envelope carries the appended entries; the client subscribes to exactly those envelopes and folds them onto a growing array. History older than the connection is the one thing a fold can't give you, and that is a **read** — one grant-gated command, not a second stream.

Importing the subpath registers `session.timeline` on the client:

```ts
import "@agentick/timeline/client";

const t = client.session(sessionId).timeline;

t.subscribe(() => render(t.list())); // re-render on any change

await t.loadOlder(50); // open on the conversation's last 50 entries

onScrollTop(async () => {
  const { done } = await t.loadOlder(50); // the 50 below those, at the head
  if (done) detachScrollHandler(); // reached the log's head
});
```

That is the whole scroll-back loop, and it is **tail-anchored**: the first call reads the log's newest page, each later call walks down by the previous page's cursor, and every page splices at the head — so page two lands above page one and the window accumulates in log order. Opening a thread on its most recent messages is one call, and there is nothing for the app to mirror, re-seed, or re-sort. Live appends keep landing at the tail while scroll-back grows the head, so the two never fight.

### The granted read — `history()`

Both faces ride ONE wire door: `timeline/history`, the harness's own declared command (`timeline:history`, `exposure: "wire"`). `history()` is the raw page — seq-tagged rows plus the cursor to continue with — and it mutates no view, which is what you want when your message model is the truth:

```ts
let cursor: number | undefined;
do {
  const page = await t.history({ toSeq: cursor, limit: 200 }); // newest page first
  myStore.ingest(page.entries.map(({ seq, entry }) => toMyMessage(seq, entry)));
  cursor = page.nextToSeq; // absent ⇒ you reached the log's head
} while (cursor !== undefined);
```

The window is `{ fromSeq?, toSeq?, limit? }`, both bounds inclusive, and **`limit` truncates from the end you anchored at**: declare a `fromSeq` and you get the first `limit` (forward); declare none and you get the last `limit` at or below `toSeq`, which defaults to the log's tail. So `{ limit: 200 }` is the newest 200 and `{ fromSeq: 0, limit: 200 }` is the oldest 200. Rows always come back ascending by `seq`, whichever end selected them.

The reply hands back exactly one cursor — the one that continues the direction you asked in: `nextFromSeq` (`lastSeq + 1`) forward, `nextToSeq` (`firstSeq - 1`) backward. Either is present **iff** the page filled its `limit`, so a loop terminates on the first short page. Both are BOUNDS in a sparse `seq` space, never a promise that an entry sits at that number.

> [!IMPORTANT]
> The read is **deny-by-default**, twice over. The timeline's write verbs are not wire-exposed at all, so `timeline/append` is `MethodNotFound` from a client — indistinguishable from a method that doesn't exist. The read IS exposed, and therefore still needs a grant on the `timeline:history` scope; without one the call is `Forbidden`. Tenancy is structural on top of that: a caller can hold `*` and still be denied another principal's session by the same-principal target rule. See [@agentick/gateway](../gateway) for the grant recipe.

The read is journaled **bus-only**: a scroll-back is observable live (metrics, tracing, an audit subscriber) but never enters the durable recovery spine — a read changes nothing, so there is nothing to replay. Writes on the same surface keep journaling. An adopter `policy` layers over that per verb.

`session.timeline.history()` on the server is the same command's in-process face: same body, same hooks and guards, minus the paging cursor.

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

| Export                                            | Purpose                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `defineTimeline(definition?)`                     | Name a timeline definition — identity + brand, inert until install |
| `defineTimelineStore(verbs)`                      | Build a conforming `TimelineStore` from its log verbs              |
| `hydrateFromStore()`                              | Genesis: the whole durable log (the default when a store is set)   |
| `hydrateTail(n)`                                  | Genesis: the last `n` entries, without loading the log             |
| `withTimeline(definition?)`                       | The same definition as a session extension, for `extensions: []`   |
| `TimelineHarness`                                 | The implementation, for direct construction                        |
| `MemoryTimelineStore`                             | Bundled in-memory log store                                        |
| `TimelineDefinition` / `TimelineHydrator` (types) | The definition surface and the genesis seam's signature            |
| `TimelineHandle` (type)                           | What `session.timeline` exposes                                    |
| `TimelineStore` / `TimelineEntry` / `SeqTagged`   | Port and data types, re-exported from the shapes package           |

Definition slots: `store` · `hydrate` · `compact` · `writePolicy` · `turnBoundaries` · `hooks` · `guards`.

### `session.timeline`

| Method                                  | Returns                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `read()`                                | Projection snapshot `{ entries, version }`                                 |
| `readPersisted()`                       | The uncompacted durable log                                                |
| `trailingInput()`                       | Input entries after the last assistant entry                               |
| `inputEntryCount()`                     | Count of input entries in the persisted log                                |
| `append(...entries)`                    | Append to log + projection atomically                                      |
| `compact(strategy?)`                    | Rewrite the projection; no-arg runs the bound default                      |
| `history({ fromSeq?, toSeq?, limit? })` | Seq-tagged durable page (a bare `limit` is the tail); flushes writes first |
| `endTurn(input)`                        | Emit the turn-boundary record                                              |
| `subscribe(fn)`                         | Fires on any projection or log mutation                                    |

Addressable verbs, enumerable via `timeline:commands`: `timeline:append`, `timeline:compact`, `timeline:replaceProjection`, `timeline:resetProjection`, `timeline:history`. Two are wire-exposable and therefore grantable — `timeline:compact` and `timeline:history`; the rest are reachable only from the trusted domains (in-process, inbox, cluster).

That enumeration is itself a wire door: `await client.session(id).timeline.commands()` returns the same rows with their exposure, which is how a client learns the write verbs are unreachable rather than inferring it from a `MethodNotFound`. See [@agentick/gateway](../gateway#discovery--two-doors).

### `@agentick/timeline/react`

| Export                              | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `<Timeline>`                        | Override the default fold; filter, budget, or render-prop it |
| `<Transcript>`                      | The same component, chat-shaped name                         |
| `useTimeline()`                     | Projection snapshot; re-renders when the version advances    |
| `compactEntries` / `getEntryTokens` | The budget primitives `<Timeline>` uses internally           |

`<Timeline>` props: `roles`, `filter`, `limit` (pre-filters) · `maxTokens`, `strategy`, `preserveRoles`, `headroom`, `guidance`, `onEvict` (budget) · `children` as a render function or static JSX.

### `@agentick/timeline/client`

| Export                                         | Purpose                                                        |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `session.timeline`                             | Registered on import: window + the granted read + minted views |
| `timelineView(...)`                            | The headless fold the handle is built on                       |
| `TimelineHistoryInput` / `TimelineHistoryPage` | The read's request + page shapes (types)                       |

`session.timeline`: `list()` · `get(id)` · `subscribe(fn)` · `seed`/`prepend`/`append`/`clear` (local window) · `history({ fromSeq?, toSeq?, limit? })` (one granted page, no splice) · `loadOlder(limit?)` (tail-anchored scroll-back) · `view({ filter })` · `close()`.

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

**Wire.** Scroll-back is the harness's own `timeline:history` command, projected as `timeline/history` by [@agentick/gateway](../gateway)'s dynamic lane and gated by a grant on that verb — no gateway-resident read handler. The gateway's optional `truncateToolResults` policy trims oversized tool output on client-facing frames only — the durable log and the model-facing projection always keep the full bytes, and a truncated block carries `metadata.bounded`. Off by default, and orthogonal to compaction.

## Roadmap & known gaps

- **SQLite adapter** — the recommended first durable store isn't shipped. Filesystem and Postgres are.
- **Richer entry kinds** — non-message records beyond turn boundaries are still coarse; `role: "event"` conflation is deferred.
- **`<Timeline>` turn affordances** — trailing-input styling and boundary turn-separators aren't built.
- **Cursor vs. seq** — the live tail is bus-cursor-ordered while durable history is seq-ordered, and the two are deliberately not unified. Scroll-back grows the head and the fold appends at the tail, so ordinary use never collides; an app that needs an exact interleaving at the seam reconciles it itself.
- **`useTimeline` has no dedicated suite.** It is exercised through `<Timeline>`, which reads the projection through it; the re-render-on-version-advance path isn't pinned on its own.
- **The log still travels in snapshots.** A session snapshot carries the full durable log, because that is currently the only way to transplant a conversation into a session with a different id _and_ a different store (a fork, a cross-node move). Holding only the projection in memory waits on a transplant mechanism.
- **Per-session definition overrides.** Configuration is app-wide; `createSession` takes no `timeline` override yet.
- **A guard's `ctx` has no calling principal.** Bridge harnesses aren't principal-stamped, so `ctx.principal` is undefined inside `guards: { history }` and friends — key local rules on `ctx.sessionId`. Cross-principal admission is the wire choke point's job (and is already enforced there), so this bounds how narrow a namespace-local rule can be, not whether tenancy holds.
- **A read's terminal envelope carries the page.** Operation terminals carry their result, so a large scroll-back page is published to the session bus (journaling is already off for reads). Subscribers on that session see it; another principal cannot. A size-summary projection for read terminals is the fix.

## Verified by

- `src/__tests__/harness.spec.ts` + `conformance.ts` — append/projection invariants, inbox addressability, snapshot round-trip across instances.
- `src/__tests__/harness-store.spec.ts` — write-behind and write-through, flush barrier and idempotence, hydration on resume, typed store failures, cursored `history()`, `turnBoundaries: false`, and that compaction never touches the store.
- `src/__tests__/compact-default.spec.ts` — construction-bound default strategy, call-site override, typed rejection with neither, the bare `timeline:compact` verb, verb enumeration.
- `src/__tests__/definition.spec.ts` — `defineTimeline` identity + non-enumerable brand, inertness (no store touched, no hydrator run), the inline-bag equivalence, and `defineTimelineStore` under the full store conformance suite plus its loud failure on a `fromSeq` query without `history`.
- `src/__tests__/hydrators.spec.ts` — `hydrateFromStore` as the store-backed default, and the bounded-memory proof: an N-entry store with `hydrateTail(k)` reads the tail in ONE cursored `history` call carrying a limit of `k`, never calls `read`, and transfers less than the log; plus the announced fallback when a store has no `history`.
- `src/__tests__/genesis.spec.ts` — the seed law (genesis never reaches `append`, while a real append still does), typed `TimelineHydrateFailed` with nothing half-installed, the `ctx.store` facet carrying identity + the journal reader, the `compact(entries, ctx)` sugar in both dichotomy arms, the drop-layer `hooks:`/`guards:` bags, and the cascade order (app guards → definition guards → app before → definition before, afters unwinding reverse).
- `src/__tests__/ctx-store.type.spec.ts` — compile-time pins on `ctx.store` inference from the `store` slot, its interplay with the derivation brand, and the variance that lets a definition specialized on a concrete adapter fit a port-typed slot.
- The genesis lifecycle laws — the app-level `timeline` slot, ordering before first render, `createSession` failing on a throwing hydrator, and no genesis on fork or spawn — are covered in [@agentick/app](../app) (`genesis-lifecycle.spec.tsx`).
- `src/__tests__/integration-with-compiler.spec.tsx` — `<Timeline/>` overriding the default fold, role/limit/predicate filtering, the render prop, budget eviction with `onEvict`, `preserveRoles`, the reference collapse pattern above, and `<Transcript>` identity.
- `src/__tests__/history-command.spec.ts` — `timeline:history` as a declared read: the `exposure: "wire"` declaration and its enumeration, payload validation + normalization (the lane's `sessionId` never steers the read, and every seq bound is a non-negative integer), the cursor semantics in both directions (`nextFromSeq` forward, `nextToSeq` for a bare-`limit` tail read, each iff the page filled its limit), the inclusive upper bound composing with the lower one, the flush before reading, the loud failure as an operation failure when the store has no cursored read, and the bus-only journal class (on the bus, absent from the journal, while `append` stays journaled) with an adopter policy layering over it.
- `src/client/__tests__/timeline-view.spec.ts` + `timeline-handle.spec.ts` + `timeline-handle.conformance.spec.ts` + `timeline-fanout.spec.ts` — `initial` seeding, `fromCursor` threading with no double-count, visibility filtering, copy-on-write refs, the window splices, `history()` reading `timeline/history` (upper bound included) and splicing nothing, `loadOlder` opening on the tail and walking backward so page two lands above page one, its head latch, live appends surviving a scroll-back, and one shared subscription across minted views.
- Steering and provenance stamps are covered in [@agentick/session](../session) (`extended-surface.spec.ts`); the grant tier in [@agentick/gateway](../gateway) (`timeline-history-grant.spec.ts`); and the full client scroll-back — a 25-entry log paged backward from its tail into log order by `loadOlder` alone, seq continuity in both directions, `MethodNotFound` on the unexposed write verb, `Forbidden` without a grant, and the cross-principal denial — in [@agentick/transport-in-process](../transport-in-process) (`timeline-history-e2e.spec.ts`).
