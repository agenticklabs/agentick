# ADR 86 — Execution abort as a first-class, observable event (server + client)

**Status:** DRAFT 2026-07-14 (Fable, with Ryan)
**Depends on:** ADR 83 (one interceptor primitive / hookable ops), ADR 77 (spine cancellation — `loop.abort()` + per-execution `AbortController`).
**Motivated by:** ADR 85 (UI needs to observe aborts).

## Problem

Abort is triggerable everywhere but **observable nowhere as a first-class seam**:

- **Server:** `LoopExecutorHarness.abort({ executionId, reason })` fires a
  per-execution `AbortController` (ADR 77). It is a plain method — NOT a hookable
  op. `tool:abort` is hooked, but that's *tool* cancellation, not the *execution*.
  An aborted run only surfaces after the fact via `onAfterLoopRunExecution`
  (`stopReason: "aborted"`) — you can't hook the abort *itself* (for audit,
  cleanup, metrics, or a guard that defers a shutdown-abort).
- **Client:** `handle.abort(reason)` triggers it; there is no callback for "this
  run was aborted." Adopters infer it from `handle.status === "aborted"` or the
  terminal — no `onAbort`.

The UI (ADR 85) is covered via the firehose terminal event, but a first-class
`onAbort` is the clean ergonomic both sides deserve.

## 1. Server — `loop:abort` becomes a hookable op

Route `LoopExecutorHarness.abort()` through `runOperation` (the same move that made
`send`/`elicit`/etc. hookable, ADR 83). Op id `loop:abort` → the standard triad:

| Hook | fires | use |
| --- | --- | --- |
| `onBeforeLoopAbort` | when abort is requested, BEFORE the `AbortController` fires | observe / transform the reason; **guard** may `defer`/`veto` a soft abort (e.g. finish the current tick first) |
| `onLoopAbort` | the full middleware wrap | wrap teardown |
| `onAfterLoopAbort` | after the controller fired + in-flight work torn down | audit / metrics / cleanup |

- Input = `{ executionId, reason? }`; output = `void`.
- **Distinct from `tool:abort`** (tool-level). `loop:abort` is the execution axis.
- The existing `onAfterLoopRunExecution` (`stopReason: "aborted"`) still fires —
  `loop:abort` is the *cause* seam, the terminal is the *effect*. A guard on
  `loop:abort` is the only way to make an abort *conditional*.
- Add `loop:abort` to `CommandRegistry` (loop-executor package), the name-lock
  (`hook-lifecycle-names.spec`), and the HOOK-LIFECYCLE table.

## 2. Client — `onAbort` on the handle + the session

- **`SessionExecutionHandle.onAbort(listener: (reason?: string) => void): Unsubscribe`**
  — fires once when THIS execution transitions to `aborted` (whether via local
  `handle.abort()` or observed over the wire). Implemented off the handle's status
  transition; idempotent (fires at most once, like a terminal).
- **`SessionHandle.onAbort(listener: (info: { executionId; reason? }) => void): Unsubscribe`**
  — pre-scoped session observer (the tier-1 pattern, ADR 85 §6): fires for *any*
  execution aborted on the session, folded from the firehose terminal
  (`outcome: "aborted"`) events. This is what a UI's "cancelled" affordance binds.
- Both are pure OBSERVERS (no veto — the client can't veto a server abort; it
  requests one via `handle.abort()` / `session/abort`).

## 3. Symmetry

```
trigger:   handle.abort()  ─wire→  loop.abort()               (session/abort method)
observe:   handle.onAbort / session.onAbort  ←firehose─  onBeforeLoopAbort / onAfterLoopAbort
```
Server hooks are the authoritative seam (can guard); client hooks are the
projection (observe). Same event, two sides — the abort twin of ADR 85's
send/receive symmetry.

## 4. Non-goals / notes

- No new wire method — `session/abort` already exists; this adds the *hook* seams
  around the existing trigger + the client observer.
- Guarding an abort (`onBeforeLoopAbort` → defer) is powerful but sharp — a hung
  guard could keep a run un-abortable. The structural `AbortController` remains the
  un-hookable floor for hard aborts (signal-driven / timeout); `loop:abort` hooks
  wrap the *cooperative* path.

## 5. Rollout

1. Route `LoopExecutorHarness.abort` through `runOperation` (`loop:abort`), add to
   `CommandRegistry` + name-lock + HOOK-LIFECYCLE.
2. `SessionExecutionHandle.onAbort` (spec + session + client impls).
3. `SessionHandle.onAbort` (client, folds the firehose terminal).
4. Tests: server guard defers an abort; observer fires once with the reason; client
   `handle.onAbort` fires on local + observed abort.
