# ADR 97 — Measuring the request, and deciding outside the tree

**Status:** PROPOSED 2026-08-12 (for Ryan)
**Depends on:** ADR 55 (render-context seam; the `contextInfo` slot), ADR 56 (tree-declared
model per tick — the same two-door problem, solved differently here; see Part 3), ADR 67 (flip the tick-end
order: settle in, decide out), ADR 89 §4 (lifecycle is the projected command-hook system),
ADR 27 (modular built-ins — no privileged center)
**Motivated by:** a production thread that compacted **twice in a row**, the second fold
rewriting the first fold's summary.

## TL;DR

A component **cannot measure the tree it is part of**. So a compaction trigger living in
the tree can only ever read the _previous_ request's size, and a level check on a lagging
measurement fires again on a number the fold did not change. That is the double-compaction,
and it is structural — no amount of relocating the predicate fixes it.

Three rules follow:

1. **Measure the projection.** A request's cost is knowable only after `project` — system
   text folded in, tools attached, sections formatted. Executors stamp it on
   `ExecutionResult.estimate`. _(Landed.)_
2. **Report in the tree; decide outside it.** `useContextInfo()` carries the measurement for
   rendering and display, where one-behind is correct. The fold decision moves to the
   session's tick-end fold, where each measurement arrives exactly once as an event.
3. **A strategy owns policy, not actuation.** `CompactStrategy.shouldCompact` becomes the
   single source of the threshold — and only the threshold. Sampling and firing belong to
   the trigger.

Plus the surface Ryan asked for: a compaction strategy is declarable **in the tree or in
config**, resolved tree-over-config.

## The defect

`<Compaction>` reads `useContextInfo().usedTokens` at `useOnTickStart` and folds when it
crosses a ceiling. `usedTokens` is the previous tick's reported `inputTokens` — the hook
documents this, and for its designed purpose (render less as the window fills) one-behind is
right.

```
Tick A start  usedTokens = 400k ≥ ceiling → fold()   [not awaited]
Tick A        sends the UNFOLDED 293-entry prompt
Tick A end    provider reports 400k          ← measures the prompt actually sent
              fold lands; timeline is now 7 entries
Tick B start  usedTokens = 400k ≥ ceiling → fold() AGAIN
```

The fold shrank the timeline; it did not shrink the number the trigger reads. Nothing
recorded that the trigger had already acted on that reading — the existing `running` ref
guards _concurrent_ folds, not _sequential re-fires on one measurement_. Deterministic
whenever the fold resolves faster than the tick, which is a coin flip.

**Why relocation alone is not the fix.** The measurement a trigger wants is the size of the
prompt about to be sent. That prompt is the output of the render the trigger runs inside.
A brick cannot measure the wall it is being laid into. Any render-time trigger inherits the
lag; the only question is whether it handles it or is surprised by it.

## Two facts, and they are not the same fact

|                     | source                 | exact? | reports the split?                        |
| ------------------- | ---------------------- | ------ | ----------------------------------------- |
| `usage.inputTokens` | the provider           | yes    | **no** — one number for the whole request |
| `estimate`          | us, off the projection | no     | **yes** — messages vs tools               |

The split is the whole reason to compute a second number. **Compaction can only fold
`messages`.** A trigger that counts tool schemas against a ceiling it can only relieve by
folding the conversation crosses that ceiling for a reason folding has no power to fix, and
then folds forever — each pass destroying context while the schemas sit untouched. Call this
the **ratchet**; it is a distinct failure from the lag, and the split is what prevents it.

## Design

### Part 1 — the estimate seam (landed)

- **spec**: `TokenEstimate { messages, tools, total }` on `ExecutionResult.estimate`;
  `ExecutorProtocol.estimateInput?` (optional, feature-detected exactly like
  `executeStream`); `ExecutionTarget.mediaTokens?: Partial<MediaTokenRates>`.
- **model**: `estimateTokenBreakdown(input, { info, media })`. Folds every wire part type
  with a `never` guard — a new part type breaks the build rather than scoring zero, which is
  precisely how tool schemas and all media came to be counted as nothing.
- **adapters**: each states its own `mediaTokens` on the target it derives, beside `pricing`,
  under the same authority argument (#186). Rates are **data**, so they layer
  `adopter registry > target > seed` and a deployment overrides without touching adapter
  code. A table inside `@agentick/model` was rejected: it is closed to any adapter shipped
  outside this repo, which is ADR 27's privileged center wearing a different hat.
  `runMediaDeclarationCheck` ties the two declarations together — an adapter that says which
  media reach the wire must say what they cost.
- **rail**: executor → `ExecutionResult.estimate` → tick-end lifecycle metadata (beside
  `usage`, ADR 89 §4) → `useContextInfo().estimated`.

### Part 2 — the trigger leaves the tree

`SessionHarness.notifyLifecycleFx` (the ADR 67 tick-end fold) gains a compaction rung. It is
already the place where session-owned tick-end predicates run, and its docblock already names
this class of work: _"it writes underneath (the steer drain appends to the timeline; a gate
transition sets its backing knob)."_

```
tick N ends → settled TickResult (usage + estimate)
            → resolve strategy (below)
            → strategy.shouldCompact({ usedTokens, contextWindow }) ?
            → await compact()
            → tick N+1 renders against the folded timeline
```

Three properties, none available in the tree:

- **The measurement stops lagging** — not by being fresher, but because at tick end the
  number describes the request that just went out rather than proxying for the next one.
- **The double-fire cannot occur.** One measurement per tick, delivered as an event. You
  cannot act twice on something that arrives once; polling a level needs edge detection,
  consuming a stream does not.
- **The fold is awaited.** It holds the gap until the next render instead of racing one.

#### The no-progress guard

Event-driven triggering removes the double-fire but **not** the loop, and the loop is the
more expensive failure. `rollingSummary.run` returns its input unchanged in three cases:

```ts
if (fold.length === 0) return entries; // nothing older than the verbatim tail
if (fold.every(isSummary)) return entries; // only summaries left to fold
if (result.truncated) return entries; // a summary cut mid-thought, not persisted
```

Each fold is followed by a fresh measurement. A fold that changes nothing leaves the next
measurement still over the ceiling, so the trigger fires again — a series of _paid model
calls_, worse than the bug being fixed.

The guard reads the fold's own report (`CompactResult.entriesBefore/entriesAfter`), and is
scoped to the **execution**: one refusal stops further attempts until the next user turn.

Two things were tried first and are recorded because both look right and are not:

- **`TimelineSnapshot.version`** is documented as bumping on every projection mutation, so
  it reads like the progress signal. It is not: the harness bumps it for a compaction that
  changed nothing, so the version says _a fold ran_ where the question is _did a fold help_.
- **Scoping the stall to the projection version** rather than the execution is nearly
  useless. An agentic tick appends its tool results, the version bumps, and the stall clears
  — every single time. The loop it exists to stop is exactly the loop that clears it.

A throw counts as a refusal too: retrying a summarizer that just died buys a second model
call to watch it die again.

### Part 3 — two doors

A compaction strategy is declarable where the app is composed or where the conversation is
rendered, resolved **tree > config** — inner-scope-wins, as everywhere else.

```tsx
defineTimeline({ compact: rollingSummary({ keepVerbatim: 6 }) })   // config door
<Compaction strategy={rollingSummary({ keepVerbatim: 6 })} />      // tree door
```

**This is NOT ADR 56's mechanism, and the difference is worth stating** — the plan said it
would be, and building it showed otherwise. ADR 56 puts a `modelRef` in the IR and the live
model on a bridge because the **loop** resolves it, and the loop reads the IR. Compaction
resolves in the session's tick-end fold, which holds the bridges directly
(`bridges.timeline` in a component IS the session's harness instance). So the ref, the
`<compaction-declaration>` intrinsic, and the collector contributor would every one of them
be machinery with no reader.

What is left is the live half alone:

- **spec**: `TimelineHarnessProtocol.declareCompact?(strategy): Unsubscribe`.
- **timeline**: the harness holds a declared strategy that outranks the construction-bound
  one; `defaultStrategy()` resolves tree-then-config. Unsubscribe is identity-checked, so a
  late unmount cannot clear a strategy some other component has since declared —
  `ToolBridge`'s rule.
- **timeline/react**: `<Compaction strategy>` — a `useEffect` over `declareCompact`, and
  nothing else.

Two touchpoints rather than five, and no new IR surface. The generalization ("every config
slot gets a tree door automatically") is still deferred — and this run is evidence for
deferring it, since the second instance of the pattern turned out not to be the same shape
as the first.

**No per-send rung.** Models have three (config / send / tree) because a send legitimately
names a model. Nothing suggests a send names a fold strategy; the rung is added when a caller
needs it, not in anticipation.

## Rejected

- **Default timeouts anywhere in this path.** Standing constraint: work that can genuinely
  take a long time must not be cut off by a clock. The fold trigger is a size decision.
- **A fraction of the context window as the trigger.** Gemini reports 1M, so 0.7 of it is
  700k and a thread costing real money every turn never folds. The managed quantity is
  per-turn cost, not running out of room. The fraction survives only as a backstop for a
  window _smaller_ than the absolute ceiling.
- **Putting the latch inside the strategy.** A `CompactStrategy` is a construction-bound
  value, shared across sessions and reusable. Actuation state is per-session. Merging them
  makes shared configuration stateful, and tick-end triggering removes the need anyway.
- **Keeping `<Compaction>` beside a framework trigger.** Two triggers, each with its own
  threshold, is strictly worse than one trigger in the wrong place. It is deleted.
- **Generalizing the two-door mechanism now.** Each declaration slot costs five touchpoints
  (intrinsic, contributor, `RuntimeDeclarations` field, bridge, resolution). Models is one
  consumer, compaction is two. Extract the mechanism at the third — an abstraction shaped by
  its first two instances is shaped by an accident.

## Consequences

- `rollingSummary({ threshold })` **starts working.** It has always been implemented and
  never called — the README describes a trigger asking the strategy, and no trigger asked.
  Anyone who set it got a value that compiled, typechecked, read correctly, and did nothing.
- Ernesto's `<Compaction>` and its duplicate ceiling are deleted; the number moves to
  `timeline.ts`, which is where the strategy already lives.
- One oversized tick is still paid for before the first fold: the estimate is stamped at
  tick end, so the decision is made after the large request went out. Folding _before_
  sending is possible — the loop holds the projection at `harness.ts:1141` — but requires a
  second render pass, and is deliberately out of scope here.

## Known gaps

### One hole wearing two hats: counting an entry

`keepVerbatim` is an entry COUNT with no token bound, so the ratchet returns by a second
route — six retained entries each carrying a large tool result exceed the ceiling on their
own. The fix is to make it `Sized<>`, matching `threshold` and `maxOutputTokens`.

That is blocked on the same missing thing that makes `@agentick/timeline`'s `getEntryTokens`
a second, weaker estimator (`chars / 4`, an image scores zero): **nothing can correctly count
the tokens in a timeline entry.** Two TODOs, one hole.

Resolution — `estimateBlocks(blocks, { info })` in `@agentick/model`, delegating to the
existing wire-part fold via `messagePartFromBlock`:

- **Not spec.** Spec ships structural behavior (`foldContentBlock`, `toolSpanEnd`) and
  contains no numeric constants at all. `CHARS_PER_TOKEN = 4` and per-modality rates are
  heuristics — knowingly wrong, tuned against provider behavior. Spec owns the shapes
  (`MediaTokenRates`, `TokenEstimate`); model owns the arithmetic.
- **Not utils.** `@agentick/utils` depends on `effect` alone and sits BELOW spec, so it
  cannot see `ContentBlock` without inverting the layering.
- **Lower, do not re-fold.** Folding `ContentBlock` directly would mean two exhaustive folds
  to maintain — the duplication again, better dressed. The lowered form is also what
  actually gets sent, so it is what actually gets billed.
- `@agentick/timeline` takes a dependency on `@agentick/model` (acyclic; model depends only
  on spec and utils). **The absence of that dep is what caused the duplicate**: timeline grew
  its own estimator precisely by avoiding model, and paid for it in blindness to media. The
  dep is the correction, not the cost.

**Landed.** `estimateBlocks` is in `@agentick/model`; `getEntryTokens` delegates to it (an
image in a timeline entry used to cost zero and now costs the model's rate); `keepVerbatim`
is `Sized<{ entries, sizeOf }>`, so a tail can be bounded in the same currency the ceiling is
checked in. Both TODOs closed.

### Genuinely separate

- **The executor estimates with no adopter registry** — the session owns it — so a
  deployment's overridden media rates do not reach the estimate. Pure plumbing, no shared
  cause with the above. `TODO(estimate-adopter-registry)`.
- **`model-ai-sdk` declares no rates**, deliberately: it cannot know which provider is behind
  it (its own standing `TODO(pass-d)`). Its media estimates use the shared floor.
- **Two compaction mechanisms remain, and both are legitimate.** `<Timeline maxTokens>` →
  `compactEntries` EVICTS entries with no model call; `timeline.compact()` → `rollingSummary`
  SUMMARIZES with one. They are not duplicates of each other and neither is deleted — what
  they share, and should stop duplicating, is the arithmetic above.
