# @agentick/timeline-fs-next

Zero-dependency **JSONL file** `TimelineStore` adapter — the local-pole
durable shape from [ADR 49, "stores, not snapshots"](../../docs/proposals/v2/blueprint/49-stores-not-snapshots.md)
(reference-adapter rung 2).

One **append-only `.jsonl` transcript file per session**. Human-greppable,
survivable across restarts, and backed by Node built-ins only — no native
modules, no compile step, no third-party runtime dependency.

## Purpose

The timeline persisted tier is an append-only event log; its durability is
a `TimelineStore` port (ADR 49). `fsTimelineStore` is the file-backed
reference: it persists a session's entries as newline-delimited JSON, one
line per entry, with the store-assigned `seq` written **inline** so the
ordering identity is durable in the file and stable across `prune`.

```
<dir>/<base64url(sessionId)>.jsonl
```

```jsonl
{"seq":0,"entry":{"kind":"message","message":{...}}}
{"seq":1,"entry":{"kind":"message","message":{...}}}
```

## Quick start

```ts
import { createApp } from "agentick";
import { fsTimelineStore } from "@agentick/timeline-fs-next";

// Inject the store on the session's timeline slot. Supplying a store makes
// session construction open-or-rehydrate (ADR 49): a `sessionId` whose
// entries already live in the store hydrates the log before first render.
const app = await createApp(MyAgent, {
  model,
  session: { timeline: { store: fsTimelineStore({ dir: "./.agentick/transcripts" }) } },
});
```

Inspect a transcript directly — it is just JSONL:

```sh
jq -c '.entry.message.role' ./.agentick/transcripts/*.jsonl
```

## API

### `fsTimelineStore(options): TimelineStore`

| Option | Type     | Description                                                                 |
| ------ | -------- | --------------------------------------------------------------------------- |
| `dir`  | `string` | Directory the per-session `.jsonl` files live in. Created lazily on write. |

`backend` is `"fs"`. Implements the full [`TimelineStore`](../timeline/src/store.ts)
port: `load`, `append`, `sessions`, `delete`, `prune`, `history`.

Per ADR 49's "NO `define*` helper" amendment, the adapter follows the
`CredentialsStore` precedent: a factory that returns an object which
`implements TimelineStore` **directly** — no wrapper, no `define*`.

## Design notes

- **`seq` bookkeeping** mirrors `MemoryTimelineStore`. An in-memory
  per-session `nextSeq` cursor assigns seqs while the process holds the
  session (the harness guarantees a single writer per session via the
  execution lease). The cursor is **seeded lazily from the file** (max line
  `seq` + 1) on first touch, so `seq` stays monotonic across restarts while
  at least one line survives. `append` writes the whole batch in **one
  `appendFile`** (one syscall) and returns the assigned seqs.
- **`prune`** rewrites the file keeping only `seq >= before.seq`; survivors
  keep their `seq` and the cursor is untouched, so a later append never
  reuses a retired `seq`. **`delete`** removes the file, the `.hwm` sidecar,
  and the cursor — the session ends and a subsequent append starts fresh.
- **Restart-durable across `prune`-to-empty.** Emptying a session leaves no
  line to re-seed the cursor from, so `prune` writes a per-session sidecar
  `<encoded-id>.hwm` holding **only the integer high-water mark** (no entry
  payload — erasure stays GDPR-clean). `seed` falls back to it when the
  transcript is empty, so a process restart continues `seq` past the erased
  entries and **never reuses** one — honoring the frozen contract's "never
  reused across `prune`" clause across restarts. The empty `.jsonl` is
  retained so `delete` still reports the session as present (matching
  `MemoryTimelineStore`); `sessions()` excludes it by size and never
  enumerates the `.hwm`.
- **Path safety.** The filename is `base64url(sessionId)`, which emits only
  `[A-Za-z0-9_-]`. A session id therefore **cannot** escape `dir` — path
  traversal is structurally impossible, not merely validated against.
- **Per-session serialization.** Operations for a given session are chained
  through an in-process mutex so cursor-seeding and append are atomic even
  under concurrent calls (defence in depth over the single-writer lease).

## Verified by

- `src/__tests__/conformance.spec.ts` — runs `runTimelineStoreConformance`
  against a **real temp directory** (`mkdtemp`, `afterEach` cleanup). All 14
  cases pass: append-only ordering, per-session isolation, defensive-copy
  `load`, enumeration, idempotent `delete`, `history` paging, and the three
  `prune` invariants (absolute-seq erasure, no-reuse-after-prune,
  prune-to-empty keeps the counter). This suite is green in any environment
  — no external dependency.
- `src/__tests__/restart.spec.ts` — fs-specific **restart durability**:
  constructs a brand-new store over the same directory (cold cursor) after a
  `prune`-to-empty and asserts the next append continues past the erased
  seqs (seq 3, not 0), a `history({ fromSeq })` cursor held across the
  restart still sees the new entry, `delete` after prune-to-empty ends the
  session (a later append restarts at 0), and `sessions()` never enumerates
  the `.hwm` sidecar.

## Status & roadmap

- **Status:** complete for the ADR 49 v2.0 contract. Passes the shared
  conformance suite against real files.

### Known gaps

- **Full-file `load`.** No paged/lazy tail yet (ADR 49 open question 1);
  `history({ fromSeq, limit })` covers cursored reads. Very long transcripts
  re-read the whole file per `load` — fine for the local pole (small
  transcripts); the SQL adapters are the answer for large sessions.
