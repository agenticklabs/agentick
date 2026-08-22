# Execution resume — re-drive a crashed `running` execution across a restart

**Status:** PROPOSED (for Ryan). A seam rider on **#311** (checkpointing / eviction
unification). Design-only; no code here. Depends on and is framed against
[`checkpointing.md`](./checkpointing.md) — its `§3.2` (blind leaf hooks) and `§4`
(one recovery path) are the constraints this must not break.
**Mirrors:** the tasks-harness boot reconciliation (ADR 68 — orphaned `working` →
`interrupted`, `packages/tasks/src/executor.ts`).
**Peer review:** shape confirmed and approved as a design by the #311 author;
their four review notes are folded into §2–§3 and §5.

## TL;DR

Today a session that **completes** a turn survives a restart (kill-resume
acceptance, ADR 49). A session that was **mid-execution** when the process died
does not: on the next open it hydrates the committed history and goes idle — the
in-flight execution is abandoned. This proposal adds the missing half **without
touching the blind checkpoint hooks and without adding a second recovery path**:

- **Capability (framework):** a boot reconciliation pass marks a crashed
  `running` execution `interrupted` — the exact shape ADR 68 already uses for
  tasks. It never re-drives on its own.
- **Policy (adopter):** a typed callback, `onInterruptedExecution(records, attempt)
→ "resume" | "drop"`, decides re-drive per execution — where crash-loop
  budgeting, multi-node ownership, and product policy live. Default `drop`.
- **Re-drive:** `resumeExecution(executionId)` — a _stripped send_ that adopts the
  existing execution id and continues from the last committed tick. Never
  `restore()`.

Capability firmly, policy flippable. One recovery path intact.

## 1. The signal is already durable, and already clean

No new status store is needed. The session's durable record already persists
`status` + `currentExecutionId` at the execution-start transition (E11
upsert-on-transition, `session-state.ts` — untouched by #311): a send does
`bumpExecutionCount → setCurrentExecutionId → setStatus("running")`, and
`setStatus`'s write-through persists that record. A crash never runs the
completion transition, so after restart the record still reads
**`running` + the execution id**.

It is an _unambiguous_ signal under #311, because **eviction never runs
mid-execution** (`isEvictable` refuses in-flight sessions — `§4`). So a durable
`running` cannot be a clean evict; it can only be a crash. The reconcile needs no
trigger-awareness to distinguish them — it reads a record, nothing more.

## 2. The seam is at the app/resume layer, not in a checkpoint hook

`§3.2` makes the leaf hooks (`CheckpointCapable.persist`/`hydrate`)
**blind to their trigger** — that blindness is what buys the one-recovery-path
uniformity in `§4`, and the explicit `session:restore` hooks fire only on the
restore _command_, never on a restart. So re-drive detection **must not** live in
hydrate/persist/restore. It lives one layer up, where the trigger is known: the
**app resume/boot path** (near `resumeSession`), after the record is adopted and
before the session is announced sendable.

This preserves `§4`. The reconcile runs on _every_ open — evict-resume, restart,
crash — identically. It simply finds nothing to do on the paths that never leave
`running` (evict, clean restart), and acts only on a crash. Same code path, no new
branch; the reconcile is a no-op unless a crashed execution is present.

**Placement (post-p6):** resume and destroy now share `rebuildFromRecord`. Put the
reconcile **mark** on that shared path so every rebuild gets it uniformly — but
**gate the callback invocation to the resume/create path only**. A destroy-rebuild
must record the honest interruption yet must never fire `onInterruptedExecution`:
the mark is harmless there, the re-drive is not (you are destroying the session).

## 3. The contract

### 3.1 Boot reconciliation — capability

At the app resume/boot boundary, for each opened session whose durable record is
`status: "running"` with a `currentExecutionId`, record the interruption
**additively** — do NOT introduce a session-level `interrupted` status:

1. move `currentExecutionId` → a new **`interruptedExecutionId`** field,
2. bump a durable **`resumeAttempts`** counter, and
3. set `status` → **`idle`** (the session is sendable again regardless of the
   re-drive decision), optionally appending a timeline system event (see §3.3).

That is the whole framework capability by default: it makes the crash _honest_.
It does not re-drive.

**Why not an `interrupted` status.** The session has ONE session-level `status`
and no per-execution rows; `interrupted` is an _execution outcome_, not a session
lifecycle state. Growing the FSM with it ripples into the wire status projections
(ADR 101) and conflates the two — and after a `drop` the session must read `idle`
anyway. The additive `interruptedExecutionId` is the queryable half the callback
reads; the session status stays a clean two-value lifecycle.

### 3.2 `onInterruptedExecution` — policy

An optional adopter callback, modelled on the interceptor-ctx convention —
**pure data in, decision out**, so it decides without reaching into harness state
and is trivially testable:

```ts
interface InterruptedExecution {
  readonly execution: ExecutionRecord; // executionId, lastCommittedTick, lastSeq
  readonly session: SessionRecord; // sessionId, recipe id, owner/principal
  readonly attempt: number; // resumeAttempts so far (crash-loop budget)
}

type OnInterruptedExecution = (
  ctx: InterruptedExecution,
) => "resume" | "drop" | Promise<"resume" | "drop">;
```

The three hazards of naive auto-resume are _handled here_, not ignored:

- **crash-loop** — the callback drops once `attempt` exceeds its budget; a poisoned
  execution cannot re-crash the process forever.
- **multi-node** — with shared durable stores, the callback does the ownership check
  hydrate structurally cannot; a replica that does not own the execution returns
  `drop`.
- **product policy** — default is `drop` (safe); `resume` is opt-in per execution.

### 3.3 New persistence — two additive record fields (no new status)

- **`interruptedExecutionId?`** — set by the reconcile as it clears
  `currentExecutionId`. This is the durable, queryable handle the callback keys on;
  cleared when the execution is resumed-to-completion or dropped.
- **`resumeAttempts`** — an integer bumped by the reconcile each time it records an
  interruption. The crash-loop budget and the callback's `attempt` input.

Nothing else about resume is stored — the timeline and the E11 record already carry
the coordinates, and the session `status` is untouched (§3.1).

**Optionally, the honest place is the timeline.** In addition to the record field,
the reconcile MAY append an event-role entry —
`<SystemEvent event="execution-interrupted" executionId=… lastTick=…/>`. It is
durable like any timeline entry, and — unlike a record field — it puts the
interruption **in front of the model** on the next turn, which is arguably the most
truthful surface for "your previous attempt was cut off." Proposed as opt-in; the
record field is the load-bearing half, the timeline event is the honesty half.

### 3.4 `resumeExecution(executionId)` — the re-drive

A **stripped `send`**: the normal send path from the mint point _onward_, minus the
mint and the input-append —

1. read the timeline's max committed `(tickId, seq)` for `executionId`;
2. seed the runtime: `currentExecutionId = executionId` (from the record),
   **`currentTick = lastCommittedTick + 1`**, seq continuing — the one live gap
   today (`currentTick` resets to 0; `session-state.ts` `TODO(store-phase-N)`);
3. re-invoke the loop's `run-execution` with the _same_ id and **no new messages**.
   The loop is a fold over the timeline: with history rehydrated to tick N it renders
   tick N+1 and continues to completion, where `setStatus("idle")` cleans the record.

It is **not** built on `restore()` — a #311 p6 fix rejects `restore()` while an
execution is in flight, and this path deliberately re-enters one.

**`resumeSession` must not block on the re-drive.** A `"resume"` decision _starts_ an
execution; awaiting its completion inside `resumeSession` would make open-latency
proportional to a whole turn. The re-driven execution is announced through the normal
execution-handle / bus machinery (identical to a fresh `send`), and `resumeSession`
returns the session promptly — a subscriber observes the resumed turn exactly as it
would a live one.

## 4. Scope

- **Root sessions only.** `§4` ratifies spawned children as _process-bound_ — a
  child's build call (component ref, props, runner/model overrides) is not durable,
  so a crashed sub-agent execution can be marked `interrupted` but not re-driven.
  Resume targets sessions with a durable recipe.
- **Last-partial-tick idempotency is deferred** — resume re-enters at the last
  _committed_ tick boundary (the flush barrier guarantees those are clean); a tool
  call that fired but did not commit may re-fire. Per-tool idempotency key is the
  later hardening. "Within reason" is the accepted contract for v1.

## 5. Rejected

- **Auto-resume inside hydrate/restore.** Breaks `§3.2` (blind hooks) and the
  `§4` one-recovery-path property; owns none of the crash-loop / multi-node
  hazards. Replaced by reconcile-to-`interrupted` + adopter callback.
- **A separate execution-status table.** The E11 session record already holds
  `status` + `currentExecutionId`; the timeline holds the tick coordinates. No new
  store.
- **An `interrupted` session status.** An execution outcome masquerading as a
  session-lifecycle state — it ripples into the ADR-101 wire status projections and
  the session must read `idle` after a drop anyway. The additive
  `interruptedExecutionId` field (§3.1/§3.3) is the queryable home instead.
- **`restore()`-based re-drive.** Rejects in-flight (p6); wrong tool.
- **Resuming spawned children.** Process-bound (`§4`).
- **A boolean `autoResume` setting.** Seam over setting — a boolean cannot express
  crash-loop budget or multi-node ownership; the typed callback can.

## 6. Verification

A `runExecutionResumeAcceptance` suite, sibling to `kill-resume-acceptance`,
parameterized over a real store: script a turn that is **killed mid-execution**
(after tick N commits, before completion) → a fresh open reconciles the record to
`interrupted` and bumps `resumeAttempts` → an `onInterruptedExecution` returning
`"resume"` re-drives → the turn completes under the **same `executionId`** with
`tickId` continuing from N+1, and the final result reaches the model on the next
send. A companion case: the callback returning `"drop"` (and the default) leaves the
execution `interrupted` and the session idle. A crash-loop case: `attempt` exceeding
budget forces `drop` without a re-drive.

## 7. What #311 is asked to host

- The reconcile **mark** on the shared `rebuildFromRecord` path (uniform across
  rebuilds), with the **callback gated to the resume/create path** — proposed as a
  **seam** for the #311 author to shape, not a direct patch.
- The `onInterruptedExecution` config slot + `InterruptedExecution` records, and the
  non-blocking `resumeSession` contract (§3.4).
- The two additive record fields: `interruptedExecutionId?` and `resumeAttempts`
  (and, opt-in, the `execution-interrupted` timeline system event).
- `resumeExecution` as a session capability (a stripped send), and the
  `currentTick`-from-store seed (`store-phase-N`).

Everything else — detection, the loop's execution-id adoption, the timeline fold,
the ADR-68 reconciliation template — already exists.
