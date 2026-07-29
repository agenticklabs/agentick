---
"@agentick/spec": minor
"@agentick/loop-executor": minor
"@agentick/session": minor
"@agentick/timeline": minor
---

A turn that ended badly now says WHY — and a veto is not called a failure.

A provider failure does not reject an execution. Neither does a guard veto. The
loop resolves both as terminals carrying a stop reason — correctly, because a turn
that reached a provider and was refused, or that a policy declined, is a turn that
happened. But the resolution was lossy at exactly one statement:

```ts
const executorTerminal = tickResult.executorTerminal;
if (executorTerminal.outcome !== "succeeded") {
  stopReason = /* … */ "executor_failed";
  break; // ← `.error` / `.reason` dropped here
}
```

`ExecutorTerminal` discriminates `{ outcome: "failed"; error }` from
`{ outcome: "vetoed"; reason }`. Only `outcome` was read. So a single word became
the entire account of a bad turn: a missing API key, a model name that does not
exist, a region that refused, and a guard that said no were indistinguishable, and
no caller had a field to look in or any way to know evidence had existed.

It compounded at the timeline. `SessionHarness` records every execution's end as a
`TurnBoundaryEntry`, and that matters more than it sounds: **a turn that dies
before its first tick appends no assistant entry**, because no generation
completed — so the boundary is the only durable evidence on the timeline that the
turn happened at all. A reloaded client read "a turn failed" and nothing else. And
the site that maps that outcome, which already refused to launder a provider
failure as success, **laundered a veto**: a refused turn was recorded as
`succeeded`, indistinguishable from one that answered.

## `StopCause`

New in `@agentick/spec`, and deliberately a discriminated union rather than one
`error` field:

```ts
export type StopCause =
  | { kind: "failed"; error: SerializedAgentickError }
  | { kind: "vetoed"; reason?: string };
```

A veto is a guard verdict — the policy ran, decided no, and the mechanism worked.
A failure is something breaking. Squeezing both into a field named `error`, or
giving a veto an `AgentickError` subclass so it has somewhere to live, makes every
consumer that folds errors count deliberate policy decisions as things going
wrong: error-rate telemetry, alerting, retry policy, eval scoring. That is a
permanent operational cost paid for a one-time naming convenience.

Being discriminated also FORCES a consumer to tell them apart, which it must — the
two need different words and different affordances. A failure means "something
broke, here is what the provider said, retrying may work." A veto means "this was
refused, here is the policy, retrying will not help."

It rides three surfaces, paired with the discriminator already beside it:

- **`ExecutionRunResult.stopCause`** — the loop keeps what it used to drop.
  Present iff `stopReason` is `"executor_failed"` or `"vetoed"`. A cancellation
  carries none: the stop reason already says everything true about it.
- **`SendResult.stopCause`** — the caller's channel, which is the only one they
  can reach, since both endings RESOLVE `handle.result` and a `.catch` never runs.
- **`TurnBoundaryEntry.boundary.stopCause`** (and `TimelineEndTurnInput.stopCause`)
  — the durable half, so the record explains itself after a reload.

`TurnBoundaryEntry.boundary.outcome` gains **`"vetoed"`** as its own member, so the
timeline stops recording refused turns as successful ones.

A turn that succeeded carries no `stopCause` key at all, so a renderer can branch
on its presence.

Verified across all three layers: the loop keeps the cause and keeps the two kinds
apart (`loop-executor` characterization), the timeline records both and neither on
success (timeline conformance), and a real provider failure reaches both the
resolved `SendResult` and the durable boundary through a real session
(`session/__tests__/lifecycle-bridge.spec.tsx`).
