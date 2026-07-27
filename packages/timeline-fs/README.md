# @agentick/timeline-fs

**A conversation, on disk, as one JSONL file.** `fsTimelineStore` is the filesystem `TimelineStore` — one append-only `.jsonl` transcript per session, written with Node built-ins and nothing else. No native module, no compile step, no third-party runtime dependency.

It is also the smallest complete worked example of the store port: four required verbs, two optional ones, a store-assigned `seq` that has to survive a process restart. If you are writing your own adapter, read this one first — the whole contract fits in 340 lines of `node:fs/promises`.

## Install

```bash
npm install @agentick/timeline-fs
```

## Quick start

Point the timeline at a directory. That is the entire wiring:

```ts
import { createApp } from "@agentick/app/react";
import { defineTimeline } from "@agentick/timeline";
import { fsTimelineStore } from "@agentick/timeline-fs";

const app = await createApp(MyAgent, {
  model,
  timeline: defineTimeline({ store: fsTimelineStore({ dir: "./.agentick/transcripts" }) }),
});
```

With a store configured, `createSession({ sessionId })` is **open-or-rehydrate**: a session id whose entries already sit in the directory hydrates its log before the first render, so create and resume are the same call.

```ts
const session = await app.createSession({ sessionId: "chat-42" });
session.timeline.read().entries; // yesterday's conversation, back in context
```

The directory is created lazily on first write, and a read against a missing directory resolves empty rather than throwing — so a fresh checkout needs no setup step.

## The file is the API

```
./.agentick/transcripts/Y2hhdC00Mg.jsonl
```

```jsonl
{"seq":0,"entry":{"kind":"message","message":{"id":"m1","role":"user","content":[…]}}}
{"seq":1,"entry":{"kind":"message","message":{"id":"m2","role":"assistant","content":[…]}}}
```

One line per entry, `seq` written inline. Which means the transcript is greppable with the tools you already have:

```sh
# every role, in order
jq -r '.entry.message.role' ./.agentick/transcripts/*.jsonl

# what did the user actually ask?
jq -r 'select(.entry.message.role == "user") | .entry.message.content[].text' \
  ./.agentick/transcripts/*.jsonl
```

The filename is `base64url(sessionId)`, which emits only `[A-Za-z0-9_-]`. A session id therefore **cannot** escape `dir` — no separator, no `..`, no NUL byte survives the encoding, so traversal is structurally impossible rather than validated against. `keys()` decodes the names back.

## `seq` survives the process

`seq` is the log's ordering identity, and the port freezes three properties: **strictly increasing** within a session, **never reused**, **stable across `prune`**. A file adapter has to work for those, because the counter lives in memory while the file lives on disk.

| Situation                       | What happens                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Normal append                   | In-memory cursor assigns; the batch lands in one `appendFile` syscall         |
| Cold start on an existing file  | Cursor seeds lazily from the max line `seq` + 1                               |
| `prune` leaves survivors        | File rewritten with survivors only; cursor untouched, so survivors keep `seq` |
| `prune` erases every line       | Cursor persisted to a sibling `<encoded-id>.hwm` — an integer, no entry data  |
| Cold start after prune-to-empty | No line to seed from, so `seed` falls back to the `.hwm` high-water mark      |
| `delete`                        | File, sidecar, and cursor all removed — the session ends, next append is `0`  |

The sidecar is the one non-obvious piece. Erase every line and a naive adapter has nothing left to read a counter from, so it restarts at `0` — silently colliding with retired seqs and hiding new entries from anyone holding a `history({ fromSeq })` cursor. The `.hwm` file closes that gap while keeping erasure clean: it holds an integer and never a payload, so a GDPR-class `prune` really did delete the content.

The empty `.jsonl` is deliberately **retained** after a prune-to-empty, so `delete` still reports the session as present. `keys()` excludes it by size, and never enumerates the sidecars.

Operations on one session are chained through an in-process mutex, so cursor-seeding and appending stay atomic under concurrent calls — defence in depth over the single-writer execution lease the timeline already holds.

## Implementing your own

`fsTimelineStore` is a factory that returns an object implementing `TimelineStore` directly. There is no `defineFsStore`, no base class, no wrapper — and yours doesn't need one either. Two ways in, same port:

**Inline, from verbs** — `defineTimelineStore` when your durability is a few statements against a table you already have:

```ts
import { defineTimelineStore } from "@agentick/timeline";

const store = defineTimelineStore({
  backend: "my-log",
  append: (logKey, entries) => insertReturningSeq(logKey, entries),
  read: (logKey) => selectEntries(logKey),
  keys: () => selectDistinctKeys(),
  delete: (logKey) => deleteLog(logKey),
  history: (logKey, o) => selectEntriesFrom(logKey, o?.fromSeq, o?.limit),
});
```

**A published adapter** — a factory returning an object that `implements TimelineStore`, which is exactly what this package does.

### The verbs

| Verb                            | Required | Contract                                                                                                |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `append(logKey, entries, ctx)`  | yes      | The **only write**. Returns one `seq` per entry, in input order. `[]` in, `[]` out                      |
| `read(logKey, ctx)`             | yes      | Full ordered read — the hydration fold input. `[]` for an unseen key. A **defensive copy**              |
| `keys(ctx)`                     | yes      | Every key holding entries. Order unspecified; a pruned-empty key is not listed                          |
| `delete(logKey, ctx)`           | yes      | Ends the log. Idempotent; `true` when entries were removed. Next append starts a fresh `seq`            |
| `history(logKey, options, ctx)` | no       | Seq-tagged window: `seq >= fromSeq`, at most `limit`. Powers paging, replay, scroll-back                |
| `prune(logKey, before, ctx)`    | no       | Retention / erasure: drop entries with absolute `seq < before.seq`. Never called by compaction          |
| `query` / `mutate`              | derived  | The generic `Store` seam. `defineTimelineStore` derives both; a class delegates to `history` / `append` |

Three rules the types cannot enforce, and the ones an adapter gets wrong:

- **The entry round-trip is lossless.** Entries are opaque blobs — whatever `append` took, `read` returns, in order, structurally identical. `seq` is _store-assigned_ and is never a field on the entry; it is the return of `append`, the tag on `history`, and the argument to `prune`.
- **`read` returns a copy.** Mutating the array a caller got back must never reach into the store. Re-parsing the file per call, as this adapter does, gets that for free; an in-memory adapter has to copy on purpose.
- **The log is append-only.** There is no `replace`. `prune` is the single destructive verb, and compaction never touches the store — it rewrites the model-facing projection only.

### `StoreCtx`

Every data method takes a `StoreCtx` as its final parameter. Two lines of truth:

- An **in-memory** store accepts and ignores it — it holds no durable state that identity or idempotency would change.
- A **durable** store reads `ctx.opId` as the **idempotency key** to dedup a retried write, and `ctx.principal` (plus the `EventScope` coordinates) to scope reads and writes by tenant.

`ctx.signal` is an optional abort a long-running read may honor. Every field is optional: outside an active operation scope they are `undefined`, so never assume one is there.

### Certify it

`seq` monotonicity, never-reuse, and prune-stability are not type-checkable. Run the suite:

```ts
import { runTimelineStoreConformance } from "@agentick/timeline/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

runTimelineStoreConformance({
  label: "fs",
  factory: async () => {
    const dir = await mkdtemp(join(tmpdir(), "timeline-fs-"));
    dirs.push(dir);
    return fsTimelineStore({ dir });
  },
});
```

The suite runs against a **real** backend — a real temp directory here, a real Postgres in [@agentick/timeline-postgres](../timeline-postgres). It skips the `prune` cases when your store omits the verb (`capabilities.prune` defaults to feature detection), and takes a `skip` flag for a backend that may be absent in CI.

Write the suite first, watch it fail, then implement. Anything it cannot reach — restart behavior, in this package's case — is an adapter-specific test you add yourself.

## Operational notes

**Retention.** `prune(sessionId, { seq })` is the erasure verb: it rewrites the transcript keeping only `seq >= before.seq` and returns the count removed. Survivors keep their `seq`. Nothing schedules it — retention policy is yours.

**Backups.** A `.jsonl` plus its optional `.hwm` is the complete state of one session. Copy the directory; there is no index to rebuild.

**Sizing.** Every `read` re-parses the whole file. That is the right trade for the local pole — small transcripts, cheap syscalls — and the wrong one for a session with tens of thousands of entries. `history({ fromSeq, limit })` bounds a paged read, but it still parses the file to satisfy it; a SQL adapter is the answer past that point.

**Concurrency.** One process per session. The in-process mutex serializes calls within a process; it does not coordinate two processes over an NFS mount.

## API

### `fsTimelineStore(options): TimelineStore`

| Option | Type     | Description                                                         |
| ------ | -------- | ------------------------------------------------------------------- |
| `dir`  | `string` | Directory the per-session `.jsonl` files live in. Created on write. |

`backend` is `"fs"`. Implements `append`, `read`, `keys`, `delete`, plus both optionals (`history`, `prune`) and the derived `query` / `mutate` seam.

## Patterns

**Timeline.** [@agentick/timeline](../timeline) owns `TimelineStore`, `defineTimelineStore`, `MemoryTimelineStore`, the write-behind pump, and the conformance suite. The store is durability; compaction, projection, and rendering all stay there.

**The cloud pole.** [@agentick/timeline-postgres](../timeline-postgres) is the same port over a shared table — the choice when replicas rehydrate a session on whichever node receives the next message. A local file is single-writer by nature.

**Shapes.** [@agentick/spec](../spec) owns `TimelineEntry`, `TimelineStore`, `LogQuery` / `LogMutation`, `SeqTagged`, and `StoreCtx`.

## Roadmap & known gaps

- **`StoreCtx` is accepted and ignored.** This adapter dedups nothing on `ctx.opId` and scopes nothing by `ctx.principal` — a re-driven append writes twice, and one directory is one tenant.
- **Whole-file reads.** `read` and `history` both parse the entire transcript; there is no lazy tail or line index.
- **No compaction of the file.** `prune` rewrites in place with survivors, which rewrites the whole file. A large transcript pruned often pays for it.
- **Single-process only.** The mutex is in-process. Two processes over the same directory can interleave appends and duplicate a `seq`.

## Verified by

- `src/__tests__/conformance.spec.ts` — the shared `runTimelineStoreConformance` suite against a real temp directory (`mkdtemp`, `afterEach` cleanup): append ordering, one strictly-increasing `seq` per entry, empty-append no-op, `history` paging by `fromSeq` / `limit` with prune-stable tags, per-session isolation, defensive-copy `read`, enumeration of non-empty sessions, idempotent `delete`, and a stable non-empty `backend`. Green in any environment — no external dependency.
- `src/__tests__/restart.spec.ts` — restart durability, which the shared suite cannot reach: a brand-new store over the same directory (cold cursor) continues `seq` past prune-erased entries instead of restarting at `0`, a `history({ fromSeq })` cursor held across the restart still finds the new entry at its true `seq`, `delete` after a prune-to-empty ends the session so a later append restarts at `0`, and `keys()` never enumerates the `.hwm` sidecar.
