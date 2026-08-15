# ADR 99 — Failed ticks flow through the decide fold (malformed-output recovery)

**Status:** DRAFT 2026-08-15 (Fable, with Ryan)
**Depends on:** ADR 89 §3 (`loop:tick` is a command; settle is IN, decide is OUT), ADR 67 (session continuation decision / `TickEndForwardDecision`), ADR 83 (one interceptor primitive), ADR 52 (model adapters own provider normalization), usage-cost.md §6 (the honesty rule).
**Motivated by:** production incident (Ernesto, 2026-08-15) — the model emitted a tool call with unparseable JSON arguments; the run stopped with `executor_failed` and dead air; the user had to type "try again."

## Problem

A model that emits a malformed tool call kills the run. The stream/adapter
failure lands as a failed `ExecutorTerminal`, and the loop breaks with
`stopReason: "executor_failed"` **before** the decide fold ever runs
(`loop-executor/src/harness.ts` — the pre-notify break; `notifyTickEnd` is
explicitly gated on `stopReason !== "executor_failed"`). The failure is
invisible to every continuation authority the framework already has: gates,
`useOnTickEnd`, session hooks. No policy can say "that was the model's
nondeterministic garbage — go again."

The recovery is embarrassingly cheap because of an invariant we already hold:
**a failed tick persists nothing.** `applyExecutorResult` / `applyToolResults`
run only on the success path, so the timeline after a failed tick is identical
to the timeline before it. Re-issuing the model call requires no repair, no
rollback, no synthetic tool_result — just another loop iteration.

Two adjacent defects on the tool path surfaced during the same investigation
(slice 4). They are independent bugs, fixed regardless of the recovery story.

## Non-seam: why `onTickFailure` is not a thing

Three candidate homes were considered and two rejected:

- **A new `onTickFailure` lifecycle hook** — rejected. It would be a third
  continuation authority next to the two that exist (the loop's provisional
  disposition and the session's decide fold). ADR 89 already answers where
  continuation policy lives: decide, in the `run-execution` while-loop.
- **Retry as transform middleware on `loop:tick`** — rejected. ADR 83 makes
  `onLoopTick` an op-scoped transform that could legally re-invoke `next`
  (base-harness even anticipates "transform (retry) middleware"). But the tick
  body catches executor failure internally and returns a _succeeded command_
  whose `TickResult.executorTerminal` is failed — a retrying transform would
  re-enter the same tick, re-emit every per-tick event under the same
  `tickId`, hide the failed attempt from the event stream, and compete with
  decide for continuation authority.
- **The decide fold** — accepted. `NotifyTickEndInput` already carries
  `outcome: CommandOutcome`; the shape anticipated non-success ticks. The only
  structural defect is that a failed terminal breaks out before reaching it.

**`continue` after a failed tick IS retry, by construction.** Nothing was
persisted, so the next iteration renders the same tree over the same timeline —
an identical model call, as a _new_ tick with a fresh `tickId`. No re-entrancy,
no duplicate events; clients observe "tick N failed, tick N+1 succeeded" and can
render a retry affordance honestly.

## Slice 1 — taxonomy: `MalformedModelOutput`

Recovery policy must distinguish "the model emitted garbage" (nondeterministic —
retry is promising) from "this request is deterministically bad" (retry is
futile, and billed). Only the adapter can tell them apart, and the adapter
already owns that duty: `mapProviderError?(cause): ExecuteErrorChannel`
(`model/src/language-model-adapter.ts`).

- Add `MalformedModelOutput` to the `ExecuteError` family
  (`spec/src/errors/harnesses.ts`), sibling of `ProviderRejected` /
  `StreamFailed` / `ProviderTimeout` / `ProviderAborted`. Carries `cause` plus
  the standard `causeMessage` fold. Fields: optional `toolName` /
  `rawArguments` (redacted from `toJSON` — model output may carry user data).
- Adapters classify in their existing `mapProviderError`: AI-SDK invalid-tool-
  input errors, Google malformed-function-call finish reasons, unparseable
  tool-argument JSON at finalize (slice 4a) all map here. **Providers define
  their specific failure modes at the adapter — the classification never leaks
  provider strings upward; the `_tag` is the contract.**
- `streamTerminal` (loop harness) passes an already-typed `ExecuteError`
  through instead of unconditionally wrapping in `ProviderRejected`.

## Slice 2 — mechanism: failed terminals reach decide

- The loop no longer breaks on `executorTerminal.outcome === "failed"` before
  notify. It calls `notifyTickEnd` with the failed `TickResult` (the input
  shape already fits), folds the returned `TickEndForwardDecision`, and only
  then maps an un-overridden failure to `stopReason: "executor_failed"` +
  `stopCause` exactly as today.
- **The fold's default flips on outcome.** Succeeded tick: abstain resolves to
  the loop's provisional disposition (unchanged). Failed tick: abstain resolves
  to **stop** — retry happens only when something force-continues. Fail-safe:
  absent any policy, behavior is byte-identical to today.
- `canceled` and `vetoed` terminals do NOT enter the fold — an abort is not a
  failure to recover from, and a veto is a policy decision that already
  happened. Only `failed` is eligible.
- Hard backstop: `maxConsecutiveFailedTicks` (loop option, default 3), sibling
  of `maxTicks`. Counts consecutive ticks with a failed terminal; resets on
  success. The cap is mechanism; how many retries actually happen is policy
  (slice 3). A run stopped by the cap reports the LAST failure as `stopCause`.
- `TickResult` gains `consecutiveFailures: number` so any decide participant
  can bound its own policy without private state.

## Slice 3 — bundled policy (the flippable opinion)

The session's `notifyLifecycleFx` fold gains a third predicate, after gates (a)
and loop-control requests (b):

- **(c) tick-failure policy.** Default:
  `failed && error is MalformedModelOutput && consecutiveFailures < 2 → continue`
  (i.e. retry once); anything else → abstain (= stop, per the flipped default).
- Replaceable, seam-over-setting, with a declarative shorthand (ADR 42
  dichotomy — config-object is sugar over the live form):

  ```ts
  tickFailurePolicy?:
    | Partial<Record<ExecuteError["_tag"], number>>              // retry budget per class
    | ((error: ExecuteError, info: { tickIndex; consecutiveFailures }) => "retry" | "stop");
  // e.g. { MalformedModelOutput: 1, StreamFailed: 1 }
  ```

  The taxonomy IS the config namespace: one option, keyed by the same `_tag`
  vocabulary the adapters emit — no `max<Mode>Retries` option per failure
  class. Typed against `ExecuteError["_tag"]` so a typo breaks at compile
  time. The table desugars into the bundled predicate; supplying either form
  replaces the default entirely; the loop's hard caps still bound both.
  Layering: adapter-level `withRetry` owns pre-first-chunk transient transport
  errors (429/5xx/network); tick retry owns post-stream failures — the classes
  `withRetry` correctly refuses to replay.

- Tree-level participation comes for free: once failed ticks flow through
  notify, `useOnTickEnd` sees them and `useLoopControl().continueAfterTick()`
  force-continues — the exact bridge gates already use. No new tree API.
- Client visibility: each attempt is a real tick on the event stream. The
  `tick-start` after a failed tick carries `retryOfTick?: number` so a UI can
  collapse the failed attempt instead of rendering dead air.

## Slice 4 — independent tool-path fixes

These are bugs today, with or without recovery:

**(a) The accumulator's silent `{}` coercion.**
`StreamAccumulator.toolCallInput` returns `{}` when the argument buffer fails
to parse (`model/src/stream-accumulator.ts`). Under `fromStandardSchema` that
produces a validation error against arguments the model never sent; under
`permissiveValidator` (e.g. bridge-from-MCP tools) **the tool executes with
empty input, silently wrong.** Fix: an unparseable argument buffer is a
`MalformedModelOutput` surfaced at stream finalize — the tick fails, slice 2/3
recover. Rationale: there is no faithful `tool_use` block to persist
(persisted model output must be verbatim), so feedback-via-tool_result is not
available for this class; retry is.

**(b) Empty-content error results.**
A hard dispatch failure (unknown tool, `ToolValidationError`) becomes a failed
tool result with `content: []` (loop harness dispatch-failure arm), persisted
verbatim — the model receives `is_error: true` with an empty body and cannot
self-correct. Fix: the loop renders the typed error into the result content
(`[{ type: "text", text: err.message }]`), leaning on the family's
`causeMessage` discipline so validation issues arrive as sentences. This class
(parseable-but-invalid) deliberately does NOT retry the tick: the `tool_use`
block is valid, the paired error result IS the feedback loop, and the model
self-corrects on the next tick.

The resulting split is the whole design in one line: **retry when there is
nothing coherent to show the model; feedback when there is.**

## Open points

1. **Usage on failed ticks.** The provider bills for a malformed generation,
   but a failed terminal drops usage on the floor — the run under-reports
   spend, violating the honesty rule (usage-cost.md §6). Wants: failed
   terminals carry `usage?` when the adapter observed it, folded as unpriced-
   but-measured. Separate slice; not blocking.
2. **Session-restart recovery.** A run that already stopped `executor_failed`
   (pre-ADR sessions, or cap-exhausted) still requires a fresh `send`. Out of
   scope: the timeline is clean, so a bare re-send already works.

## Rollout

1. Slice 1 (spec + adapters): `MalformedModelOutput`, adapter classification,
   `streamTerminal` pass-through.
2. Slice 4b (loop): error message into failed tool-result content.
3. Slice 4a (model): finalize-time malformation instead of `{}` coercion —
   lands with slice 1 (it produces the new error).
4. Slice 2 (loop + spec + session): failed terminals through notify, flipped
   abstain, `maxConsecutiveFailedTicks`, `consecutiveFailures`, `retryOfTick`.
5. Slice 3 (session + app): bundled predicate + `tickFailurePolicy` option.

## Verification (every claim a test)

- Adapter conformance: each shipped adapter maps its provider's malformed-
  output shape to `MalformedModelOutput` (fixture per provider). The nudge for
  ALL adapter authors is structural: `runExecutorConformance` takes a REQUIRED
  `errorFixtures` input — per `ExecuteError["_tag"]`, provider-native error
  fixtures that must classify to that class, or an explicit `"not-applicable"`.
  Thrown from the stub client and asserted on the EXECUTOR's error path
  (end-to-end, not the mapping function in isolation). Typed against the tag
  union, so adding a taxonomy class breaks every adapter's conformance file at
  compile time — the taxonomy propagates itself. `mapProviderError` stays
  optional at runtime (the `ProviderRejected` fold is the fail-safe default);
  the conformance input is where silence becomes a decision.
- Loop: failed tick persists nothing (timeline byte-identical before/after) —
  the invariant retry rests on.
- Loop: failed terminal reaches `notifyTickEnd`; abstain → stop with today's
  `stopCause`; force-continue → next tick issues an identical model request.
- Loop: `maxConsecutiveFailedTicks` stops a permanently failing model; counter
  resets on success.
- Session: bundled policy retries `MalformedModelOutput` exactly once; a
  supplied `tickFailurePolicy` replaces it; `canceled`/`vetoed` never retry.
- Tree: `useOnTickEnd` observes a failed tick; `continueAfterTick()` retries.
- Accumulator: unparseable argument buffer fails finalize; no `{}` dispatch
  under `permissiveValidator`.
- Dispatch: `ToolValidationError` produces a persisted tool_result whose text
  contains the validation issues; model-visible on the next tick's request.
