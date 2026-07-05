# ADR 53 — Offsets, not tiers: timeline consumption semantics

**Status:** DRAFT — pending Ryan sign-off (⛔)
**Date:** 2026-07-04
**Depends on:** ADR 49 (stores-not-snapshots, fold = re-render), #133/#168
(frozen `seq`), ADR 51 (command registry; verb deletions), ADR 48 §5
(session single-writer)
**Supersedes:** the pending-queue tier of the v2 timeline
(`queue`/`drain`/`PendingEntry`/`readPending`)

## TL;DR

The pending tier did three jobs in v1 — distinct rendering, retry
semantics, and the loop's continuation predicate — and v2 kept the tier
while losing all three (drain-at-send-start makes it a dead pass-through;
the 2026-07-04 deep-dive documented every loss). We delete the tier and
replace all three jobs with **facts in the log**:

1. **One append-only log.** Input appends the moment it arrives — at
   send AND mid-execution. No queue, no drain. Facts first (ADR 49).
2. **Provenance stamps.** Entries carry `executionId`/`tickId` in
   metadata. "Created during the current execution" is a *query*, not a
   tier.
3. **Execution-boundary entries.** At execution completion the session
   appends a `kind: "boundary"` entry (`visibility: "log"` — never
   rendered to the model). The **committed offset** is derived by fold:
   everything before the last boundary is consumed; everything after is
   not. Kafka consumer semantics, by name: the timeline is the log, the
   execution loop is the consumer, the boundary is the committed offset.
4. **Continuation predicate**: the loop keeps ticking while unconsumed
   input exists (or the model asked for tools). Mid-execution arrivals
   become visible **next tick** — native steering.
5. **Rendering distinctions move to `<Timeline>`**: above-offset input
   renders distinctly (v1's pending styling, restored as a component
   concern over derived facts).

Nothing changes in the store contract (#132 proceeds untouched);
`seq` (#168) is unaffected; two declared verbs die.

## 1. Motivation — the three jobs and where v2 stands

**v1** (`packages/core/src/session.ts`, `timeline.tsx`): inbound
messages sat in `_queuedMessages`; the executing tick rendered them
distinctly (`DefaultPendingMessage`); `ingestTickResult` committed them
to `_timeline` only after the model returned; and **continuation was
requested while messages were still queued** — pending.length was the
loop's continue signal.

**v2 today**: the tier exists (`_pending`, `queue`/`drain` commands,
`PendingEntry`, `readPending()`) but `drain()` runs once at send-start,
before the loop. Consequences, all verified 2026-07-04:

- Nothing renders pending — `<Timeline>` reads the projection only
  (the spec and session comments claiming otherwise were corrected in
  the same deep-dive's fix wave).
- Input commits *before* the model sees it — no retry semantics.
- Messages queued mid-execution are invisible until the next `send` —
  the living-context bet, broken for input.
- The loop has no input-driven continuation — it stops on stopReason
  regardless of what arrived while it ran.

The tier costs a lifecycle, a type, two declared verbs, and a
notify cycle — and buys nothing.

## 2. The design

### 2.1 One log; input appends immediately

`session.send({ messages })` appends input entries directly (no queue,
no drain). Messages arriving mid-execution (a second `send`, a wire
`session/send`, a connector) append the same way, immediately. The
user's words are a fact the moment they arrive; v1's in-memory queue
could lose them on crash — the log cannot.

### 2.2 Provenance stamps

Timeline entries gain typed optional provenance in `MessageMetadata`:

```ts
interface MessageMetadata {
  readonly executionId?: string;  // execution that created this entry
  readonly tickId?: string;       // tick that created it (model/tool output)
  readonly usage?: UsageStats;    // the GENERATION's usage — assistant
                                  // entries only (see below)
  // ... existing: cache, providerMetadata, index signature
}
```

**Per-generation usage (ratified 2026-07-05):** one tick = one model
call = one canonical assistant entry (the accumulator synthesizes a
single assistant message per generation), so every execution-produced
assistant entry is stamped with that generation's `UsageStats` at
`applyExecutorResult` (the session already holds it there). Normative
for the loop path — the framework stamps it, adopters do nothing.
Optional on the type: imported/seeded assistant entries have no
generation behind them. User and tool-result entries carry none (not
generations).

This yields three accounting levels, each with distinct authority:
entry = per-generation attribution; boundary = the TURN's ground-truth
aggregate; session state = lifetime. The boundary aggregate is NOT
redundant with the entry sum: a tick that fails mid-turn billed tokens
but appended no assistant entry — only the boundary (and session
lifetime) capture that usage. Cost queries over the record: per-message
from entries, per-turn from boundaries, discrepancy between the two =
paid-but-unmaterialized generations (retries, aborted streams) — a
diagnostic in itself.

Stamped by the session at append (it already knows both — they ride
`EventScope` on every operation). "Entries from the current execution",
"the model's output for turn N", "everything the user said before tick
3" become queries over the log. Eval, replay, devtools turn-views, and
`<Timeline>` filters all read the same facts. No tier.

### 2.3 Execution-boundary entries — the committed offset

At execution completion (terminal outcome, after the final
`applyExecutorResult`/`applyToolResults` appends), the session appends:

```ts
{
  kind: "boundary",
  visibility: "log",             // never rendered to model context
  boundary: {
    executionId,
    outcome: "succeeded" | "failed" | "aborted",
    usage?: UsageStats,          // the turn's aggregate — #186's spine
                                 // lands cost-per-turn in the record
  },
}
```

`TimelineEntry` grows its first non-message kind — the spec comment at
`session-harness.ts:107` ("Future kinds") anticipated exactly this.
Every existing `e.kind === "message"` filter keeps working unchanged.

**The committed offset is order-derived, not seq-derived:** everything
persisted *before* the last successful boundary entry is consumed;
everything after is not. Deriving from log ORDER (not `seq` arithmetic)
matters because under write-behind the harness doesn't know store seqs
at decision time — but it always knows its own ledger order, and every
store's `load()` returns that order. `seq` (#168) stays what it is: the
store's durable cursor identity for `history({fromSeq})` paging;
boundary entries are seq-tagged like everything else, so *paging by
turn* falls out.

**Why an entry and not session state:** zero new state to persist or
restore — hydration recomputes the offset by fold, exactly like every
other timeline fact (ADR 49: fold = re-render, applied to consumption).
Crash-safe by construction: a crash before the boundary append leaves
the turn uncommitted, and its input is retried by the next execution.
This is at-least-once input processing — the standard, correct default.

Only `outcome: "succeeded"` boundaries advance the offset. Failed and
aborted executions append their boundary (the *attempt* is a fact — it
carries usage and segmentation) but do not commit consumption.

### 2.4 The continuation predicate

The seam already exists: `TickEndForwardDecision`
(`{ kind: "continue" } | { kind: "stop" }`) — the session already
forwards a decision to the loop at tick end. The rule becomes:

> At tick end, if the model did not request tools AND no unconsumed
> input entries exist beyond what this tick's render included → stop
> (append succeeded-boundary). If unconsumed input exists → continue.

The loop learns nothing about timelines; the session computes the
predicate against its own harness. `maxTicks` bounds the
steering-livelock case as it bounds everything else
(`TODO(trail-budget-guard)` tightens it later).

**Atomicity note (the one sharp edge):** the "no unconsumed input"
check and the boundary append must be atomic with respect to the
harness's in-memory ledger — one synchronous section, no `await`
between check and append. JS single-threading makes this a discipline
requirement, not a lock: the session performs
`checkUnconsumedAndAppendBoundary` as a single harness call. An arrival
in the microtask before the check → continues the loop; after the
append → next execution's input. No lost window.

### 2.5 What counts as "input"

A named predicate constant, not configuration:

```ts
const isInputEntry = (e: TimelineEntry) =>
  e.kind === "message" && e.message.role === "user";
```

Tool results are loop-internal (already applied within the tick);
assistant entries are output. Adopter-defined input kinds can extend
this when a third consumer exists — not before.

### 2.6 Steering — the emergent capability

Immediate append + per-tick render + continue-on-unconsumed-input =
**a user can interrupt a running agent and be heard next tick**. "Wait —
use the staging account" arrives, the current tick finishes, the next
tick's render includes it (via `<Timeline>`), the loop continues until
the model addresses it and goes quiet. No new mechanism — this IS the
mechanism. The living-context bet, applied to input.

### 2.7 `<Timeline>` renders the distinctions

The component (not the framework) styles consumption state:

- Above-offset input entries render distinctly (v1's
  `DefaultPendingMessage`, restored as a prop/default over derived
  facts).
- Boundary entries are `visibility: "log"` — the existing filter
  already drops them from model context; a UI timeline may render them
  as turn separators.
- Execution/tick filters ride provenance stamps.

### 2.8 Deletions

- `_pending`, `PendingEntry`, `readPending()`
- `timeline:queue`, `timeline:drain` declared commands (VERB-MATRIX
  rows removed — both were wire-no; the matrix ratification carried
  Ryan's caveat to re-evaluate timeline verbs)
- `TimelineQueueInput`/`TimelineQueueResult`/`TimelineDrainResult`
  spec types; the drain step in `sendBody`
- The queue/drain conformance + inbox-routing tests migrate to
  append + boundary coverage

One tier, two verbs, three types, one lifecycle. No compatibility
shims (house rule).

## 3. Fit with the framework as it exists

| Existing piece | Interaction |
| --- | --- |
| ADR 49 fold-=-re-render | Extended, not amended: consumption becomes a log-derived fact; hydration recomputes the offset like everything else. |
| #168 frozen `seq` | Untouched. Offset is order-derived; `seq` remains the store's cursor identity. Boundary entries are seq-tagged → turn paging free. |
| `TickEndForwardDecision` | The continuation seam already exists; the predicate slots into it. No loop-protocol change. |
| ADR 48 single-writer session | The atomic check-and-append leans on it — one writer per session makes the synchronous section sufficient. |
| ADR 51 registry | Two verbs deleted; `timeline:append` unchanged (still the admin/import path); the wire lane (#141) never exposed queue/drain. |
| #132 SQLite store | Zero contract change. Boundary entries are opaque entries. |
| #186 usage spine | Boundary entries carry the turn's usage — cost-per-turn lands in the record; devtools turn view falls out. |
| #187 `run({history})` | Seeded logs replay with their boundaries → eval gets turn segmentation verbatim. |
| `timeline-not-rendered` diagnostic | Unchanged and MORE important — steering only works if `<Timeline>` is rendered. |
| Compaction | Projection-only, as today. The offset derives from the persisted fold; compaction cannot move it. `prune` below a boundary is natural turn-retention. |

## 4. Migration plan

Wave 1 (hands-on — semantics): spec types (boundary kind, provenance
fields, deletions), TimelineHarness (append-only path,
`checkUnconsumedAndAppendBoundary`, offset fold at hydrate), session
`sendBody` (append instead of queue/drain; boundary at terminal;
predicate into tick-end decision).

Wave 2 (delegable — mechanical): call-site + test migrations for
queue/drain removal; `<Timeline>` above-offset rendering + boundary
separators; client `readPending` consumers → projection + offset.

Wave 3 (delegable): VERB-MATRIX + ADR 49/51 cross-reference updates;
examples gain a steering demo.

## 5. Open questions (non-blocking)

- Boundary entries for **spawned/child sessions** — same mechanism per
  session (each session is its own consumer); cross-session
  choreography is out of scope.
- Whether `session.send` on a session with a RUNNING execution should
  join (append + let continuation pick it up, returning the running
  handle) or start a queued next execution — proposal: **join** is the
  steering path; a second concurrent `send` returns the in-flight
  handle. Needs a ratified line in the session protocol docs.
- Anonymous `[key: string]` metadata already permitted arbitrary
  stamps; the typed `executionId`/`tickId` fields are the blessed
  names.
