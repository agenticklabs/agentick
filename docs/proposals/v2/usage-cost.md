# Usage → cost

**Status:** contract, partially implemented (2026-07-31)
**Supersedes on the cost axis:** the float-USD estimator in
`@agentick/model` (`estimateCost` / `ModelPricing` / `SEED_PRICING`,
#186 + #204). See [§9 Convergence](#9-convergence-with-agentickmodel).

A session that ran costs money. This document defines how many tokens of
which kind were spent, at what rate, by which model, and what a total is
allowed to claim.

---

## 1. The problem, stated as defects

Four things are wrong today. Each is a money bug, not a modelling
preference.

**D1 — the rollup is flat across models.** `ExecutionRunResult.usage`,
`SessionRecord.usage` and the turn-boundary record each carry ONE
`UsageStats`. A session can change model mid-flight (`setModel`, a
per-send override, a per-tick `<Model>`, a spawn override), so that one
bag routinely mixes a $0.25/MTok model with a $15/MTok model. **Cost is
not a function of a flattened bag.** No amount of downstream cleverness
recovers it; the information is destroyed at fold time.

**D2 — cost is never recorded.** `estimateCost` has exactly one caller
in the workspace: `packages/app/src/telemetry-defaults.ts`, which
annotates an OTel span. That number is ephemeral. It is not on
`SendResult`, not on the timeline, not on `SessionRecord`, not in any
snapshot. A restored session knows how many tokens it burned and has no
idea what they cost.

**D3 — cost is recomputed from present-day rates.** Because nothing is
stamped, every read reprices history. When a provider changes a price —
or an adopter fixes a wrong seed row — last quarter's invoices silently
change. An accounting record that mutates retroactively is not an
accounting record.

**D4 — the framework ships prices, undated, and applies them silently.**
`SEED_MODELS` carries approximate USD rates and `estimateCost` falls
back to them _by default_ when a target declares none. The rows happen
to be right today (verified against current list pricing: Opus $5/$25,
Sonnet $3/$15, Haiku $1/$5 per MTok, cache reads at 0.1× input and cache
writes at 1.25×). That is the problem, not the reassurance: **a table
that is correct on the day it is written and is applied as a silent
default will be wrong later, and nothing about the shape of the output
will change when it is.** A consumer gets the same confident number
either way.

Three concrete ways it goes wrong, none of which the table can express:

- **Longest-prefix matching across a repriced family.** The key
  `anthropic/claude-opus` matches every Opus that ever existed. Opus 3
  listed at $15/$75; today's Opus lists at $5/$25. One prefix, one rate,
  two different truths — and the older model silently gets the newer
  price.
- **Introductory and promotional pricing.** Sonnet 5 currently lists at
  $3/$15 with a $2/$10 introductory rate through 2026-08-31. A static
  undated row cannot hold a rate that expires.
- **Cache-write tiers.** `ModelPricing` has exactly one
  `cacheWritePerMTok`. Anthropic prices a 5-minute-TTL cache write at
  1.25× input and a 1-hour-TTL write at 2×. The single field silently
  under-bills every long-TTL write.

The fix is not a better table. It is refusing to guess: rates come from
the adopter, and a tick with no rate is reported as unpriced (§6).

Two lesser defects found in the same audit, fixed here:

**D5 — Anthropic loses cache writes on the streaming path.**
`mapChunk`'s `message_start` arm folds only `cache_read_input_tokens`
into `inputTokens` and never emits `cacheCreationTokens`;
`message_delta` re-emits only `cachedInputTokens`. The non-streaming
`toUsageStats` folds both correctly. So a _streamed_ Anthropic call
reports zero cache-write tokens — and cache writes are the expensive
kind (1.25× input).

**D6 — Google under-reports billable output.** `candidatesTokenCount`
_excludes_ `thoughtsTokenCount`, but Gemini bills thinking tokens at the
output rate. Anthropic and OpenAI both _include_ reasoning inside their
output counter. The normalization is therefore inconsistent across
adapters and Google under-bills.

---

## 2. Token kinds

`UsageStats` (`@agentick/spec`, `data/execution-result.ts`) already
defines the kinds. This document does not add fields; it makes the
containment rules **normative for all adapters**, because pricing is
where a violated containment rule turns into a wrong number.

| Field                 | Contains                               | Normative rule                                                                       |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `inputTokens`         | every prompt token the model read      | `cachedInputTokens` and `cacheCreationTokens` are **subsets** of it, never additions |
| `outputTokens`        | every generated token                  | `reasoningTokens` is a **subset** of it, never an addition                           |
| `cachedInputTokens`   | prompt-cache **reads**                 | ⊆ `inputTokens`                                                                      |
| `cacheCreationTokens` | prompt-cache **writes**                | ⊆ `inputTokens`                                                                      |
| `reasoningTokens`     | extended thinking / o-series reasoning | ⊆ `outputTokens`                                                                     |
| `totalTokens`         | `inputTokens + outputTokens`           | —                                                                                    |

The subset rule for input was already normative (#186). The subset rule
for **reasoning is new**, and it is the one that makes D6 a defect
rather than a difference of opinion. It is chosen this way because two
of three providers already report it that way, and because the
alternative (reasoning as a peer of output) forces every consumer that
wants "how many tokens did this generate" to know which provider it was
talking to.

**Adapters normalize. Nothing downstream compensates.** An adapter whose
provider reports disjointly folds at the seam:

- **Anthropic** — `input_tokens` excludes both cache counters; fold both
  in. (Fixes D5 on the streaming path.)
- **OpenAI** — `prompt_tokens` already includes `cached_tokens`;
  `completion_tokens` already includes `reasoning_tokens`. Pass through.
  OpenAI has no cache-write charge, so `cacheCreationTokens` is absent,
  not zero.
- **Google** — `promptTokenCount` already includes
  `cachedContentTokenCount`; `candidatesTokenCount` **excludes**
  `thoughtsTokenCount`, so fold thoughts into `outputTokens`. (Fixes
  D6.) `totalTokenCount` already counts them, which is why the existing
  code's `totalTokens` and `input + output` disagree today.
- **AI SDK** — the SDK's own normalized names map 1:1; pass through.

**Absent ≠ zero.** A provider that does not report a kind leaves the
field `undefined`. Writing `0` claims "this model did no cache writes",
which is a different statement from "this provider does not tell us".
The distinction survives into pricing: an absent kind contributes
nothing and costs nothing; it never triggers the unpriced path.

---

## 3. Money

```ts
/** ISO-4217 code. */
type Currency = string;

/**
 * Money as an INTEGER count of micro-units: 1_000_000 micros = 1 unit
 * (1 USD, 1 EUR). Never a float.
 */
interface Cost {
  readonly amountMicros: number;
  readonly currency: Currency;
  /** The RateCard that produced this. Stamped, never recomputed. */
  readonly rateRef: string;
}
```

Floats are wrong here for the ordinary reason — `0.1 + 0.2` — and for a
specific one: a cost total is a **fold over hundreds of ticks**, so
representation error accumulates in exactly the direction nobody audits.
Micro-units give six decimal places of USD, which is three more than any
provider prices to, and integer addition is exact and order-independent.

---

## 4. Rate cards

```ts
type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

interface RateCard {
  /**
   * Stable identity, stamped on every Cost this card produces. Date it:
   * a price change is a NEW card, not an edit to an existing one.
   * e.g. "anthropic:claude-sonnet-5@2026-07-01"
   */
  readonly id: string;
  readonly currency: Currency;
  /** Micro-units of `currency` per MILLION tokens, per kind. */
  readonly perMTok: Partial<Record<TokenKind, number>>;
  /** Flat per-call fee in micro-units (gateway surcharge, per-request minimum). */
  readonly perCallMicros?: number;
}
```

`perMTok` is per **million** tokens because per-token rates in micros
are sub-integer ($3/MTok = 0.003 µ/token). Per MTok they are clean
integers: $3/MTok = `3_000_000`.

`id` is required. A stamped cost whose rate card cannot be named is
unauditable — you can see what was charged and not why. Dating the id is
a convention, not enforced, but a card whose id is stable across a price
change defeats the whole record.

### 4.1 Arithmetic

Subset containment (§2) means the rates apply to **disjoint remainders**,
not to the raw counters. Charging the `input` rate against `inputTokens`
while also charging `cacheRead` against `cachedInputTokens` bills cached
tokens twice.

```
freshInput = max(inputTokens − cachedInputTokens − cacheCreationTokens, 0)
freshOutput = max(outputTokens − reasoningTokens, 0)   // only when a `reasoning` rate exists
```

When `perMTok.reasoning` is **absent**, reasoning tokens are priced at
the `output` rate — which is what all three providers actually do — so
`freshOutput = outputTokens` and no split occurs. A `reasoning` rate is
therefore an opt-in for the case where a provider prices thinking
separately.

A kind with tokens but **no rate** falls back to its parent kind's rate
(`cacheRead`/`cacheWrite` → `input`, `reasoning` → `output`). A missing
`input` or `output` rate is not a fallback case — see §6.

**Rounding is deferred to the end, exactly once:**

```
subMicroTotal = Σ_kind (tokens_kind × perMTok_kind)      // integer, exact
amountMicros  = round(subMicroTotal / 1_000_000) + perCallMicros
```

Not "round each kind, then sum". Per-kind rounding introduces up to five
half-micro errors per tick and makes the total depend on kind ordering.
One division at the end is exact until the last step and
order-independent. Round half away from zero; every input is
non-negative.

### 4.2 Where rates come from

**Rates are declared at model construction.** The model declaration is
already where provider identity lives; splitting "which model" from
"what it costs" across two config sites means they drift.

```ts
const model = anthropic("claude-sonnet-5", {
  rates: {
    id: "anthropic:claude-sonnet-5@2026-07-01",
    currency: "USD",
    perMTok: {
      input: 3_000_000,
      output: 15_000_000,
      cacheRead: 300_000,
      cacheWrite: 3_750_000,
    },
  },
});
```

The adapter puts this on its self-described `ExecutionTarget.rates`, so
it rides the target through the per-tick model cascade (`<Model>` >
per-send > session default) with zero extra plumbing. A per-tick
`<Model>` override carries _its own_ card automatically — which is the
whole reason rates belong on the target and not in an app-level table
keyed by model name.

**The framework ships no prices.** No seed, no default, no
longest-prefix guess. An unpriced model produces no cost (§6), which is
a true statement; a seeded guess produces a false one. If a dated,
opt-in constants module is ever added, it must be an explicit import
that an adopter passes in — never a fallback.

### 4.3 The resolver seam

Declared rates cover the static case. Dynamic pricing — per-tenant
contracts, marketplace markup, volume tiers, a rate that depends on the
request — needs a callback, not a table.

```ts
interface CostResolverInput {
  readonly target: ExecutionTarget;
  readonly usage: UsageStats;
  readonly sessionId: string;
  readonly executionId: string;
  readonly tickId: string;
}

type CostResolver = (input: CostResolverInput) => RateCard | Cost | undefined;
```

Set on `AppHarnessOptions.costResolver`. **The resolver wins over
declared rates whenever it returns a value.** Returning `undefined`
falls through to `target.rates`.

The return union is deliberate and both arms are real:

- Return a **`RateCard`** to say "here are the rates, you do the
  arithmetic" — the per-tenant-contract case.
- Return a **`Cost`** to say "I did the arithmetic" — the marketplace
  case, where the number billed is not a function of tokens at all
  (flat per-seat, a markup on a negotiated rate, a credit system).

Discriminate structurally: a `Cost` has `amountMicros`.

This is a seam, not a setting, for the reason the codebase applies
elsewhere: pricing policy is unbounded, and any enum we ship would be a
guess at which three policies matter.

---

## 5. Stamping: per tick, at act time

**A tick's cost is computed once, when the tick settles, and never
again.** This is the whole answer to D3. A price change published
tomorrow cannot reach yesterday's records, because yesterday's records
hold a number and a `rateRef`, not a recipe.

The stamping site is **`LoopExecutorHarness`, at tick settlement**
(`packages/loop-executor/src/harness.ts`, where `accumulateUsage(acc.usage,
result.usage)` runs).

> **Correction to the original plan.** The brief specified
> model-executor. That is the wrong site: the model-executor produces a
> result but does not know _which model produced it_. The per-tick
> `<Model>` cascade resolves in the loop (`tickTarget`, harness.ts:964),
> so the loop is the earliest place where usage and the resolved target
> are both in hand — and it is also where the run-level fold lives, so
> stamping and rolling up stay in one place.

Resolution order at settlement:

1. `costResolver(input)` → a `Cost` (used verbatim) or a `RateCard`
   (priced by §4.1).
2. `tickTarget.rates` → priced by §4.1.
3. Neither → **no cost**. The tick is _unpriced_, which is a recorded
   fact (§6), not a zero.

### 5.1 One stamp, two planes

The stamp happens **once**. It is then projected onto two planes with
different jobs, and confusing them is how cost systems go wrong.

|            | **Truth plane**                                              | **Metrics plane**                        |
| ---------- | ------------------------------------------------------------ | ---------------------------------------- |
| Where      | execution events / journal, and the session-record aggregate | `ctx.metrics`                            |
| Job        | accounting — this is what billing reads                      | observation — dashboards, alerts, trends |
| Guarantees | durable, complete, per-model, survives restore               | best-effort                              |

**Money must never live only in the metrics plane.** A metrics pipeline
is lossy _by design_: it samples, pre-aggregates, expires old series, and
sheds labels under cardinality pressure. Every one of those is a correct
thing for telemetry to do and a catastrophic thing for an invoice. So the
metrics emission is strictly a **mirror** of a fact already durably
recorded — it is never the only writer of a number, and nothing reads it
back for accounting.

The honesty rule crosses to the metrics plane intact: alongside cost and
token histograms, the unpriced-tick **counter** is mandatory. A dashboard
that shows spend must be able to show how much of the spend it could not
see, or it shows a confident, silently-low number — the same defect as
§6, one layer out.

What ships: `session.tick.cost_micros` (histogram),
`session.tick.tokens` (histogram, labelled by kind), and
`session.tick.unpriced` (counter). A tick that reported no usage at all
emits nothing — not even an unpriced count, because unmeasured is not
unpriced.

Labels stay low-cardinality: `provider`, `modelId`, `currency`, `kind`.
Deliberately **not** `rateRef` — it is adopter-chosen and _dated_, so
labelling by it mints a fresh time series on every price change,
forever — and not `sessionId` / `executionId` / `tickId`, since per-tick
identity is the definition of a cardinality explosion. That identity
rides spans and logs, never a metric label. A metrics backend that falls
over is a worse outcome than a coarser chart.

**Live in-turn cost display is a third thing, and it is neither plane's
accounting.** A UI showing spend tick over tick folds the `tick` stream
events client-side. That is _display_: it can lag, drop, or reconnect
mid-turn without consequence, because the durable record is written
independently and the client's running number is never read back. Do not
be tempted to make the client's fold authoritative because it is the one
the user is looking at.

The stamped `Cost` and the tick's model identity land on:

- the loop's `tick` / `tick-end` stream events (live observation + the
  client-side display fold),
- `SessionMessageMetadata` alongside the existing `usage` — the durable
  per-generation record on the timeline,
- `ApplyExecutorResultInput.result`, so the session can write both — and
  that same site is where the metrics mirror is emitted, because it is
  the one place the tick's cost and resolved model are both in hand and
  already being written.

---

## 6. The honesty rule

> A total is either complete, or it says how much of itself is missing.
> An unpriced tick never rolls up as zero.

Zero is a claim: "this cost nothing." An unpriced tick cost something —
we just cannot say what. Folding it in as zero produces a total that is
confidently, silently low, and low in the direction that nobody
double-checks. This is not a hypothetical: any app running one priced
model and one unpriced one gets a total that looks authoritative and
under-reports.

```ts
type CostRollup =
  | {
      readonly kind: "complete";
      readonly amountMicros: number;
      readonly currency: Currency;
      readonly ticks: number;
      readonly rateRefs: readonly string[];
    }
  | {
      readonly kind: "partial";
      /** A LOWER BOUND. The true cost is this plus the unpriced ticks. */
      readonly amountMicros: number;
      readonly currency: Currency;
      readonly pricedTicks: number;
      readonly unpricedTicks: number;
      readonly rateRefs: readonly string[];
    };
```

Discriminated rather than a flat shape with an `unpricedTicks: number`
that consumers may ignore, for the reason `StopCause` is discriminated
in this codebase: the two demand **different words on screen**
("$1.23" vs "at least $1.23"), and a flat shape lets every consumer
render the wrong one by omission. A union forces the reader to notice.

- No usage at all → `cost` is **absent**, not a zero `complete`.
- Some ticks priced, some not → `partial`, `amountMicros` = the priced
  subset.
- No ticks priced, some unpriced → `partial` with `amountMicros: 0` and
  `unpricedTicks: n`. Structurally distinct from "cost nothing".
- **Mixed currency**: a rollup carries one currency — the first one it
  sees. A tick priced in a _different_ currency counts toward
  `unpricedTicks`, because it genuinely is unpriced _in this total_.
  It remains fully priced in its own `byModel` bucket, which is where a
  multi-currency consumer must read. Summing across currencies is the
  same class of lie as summing unpriced ticks as zero.
  <!-- TODO(trail-cost-multicurrency): per-currency buckets if a real
       consumer needs a single multi-currency total. -->

---

## 7. Rollups: per-model all the way up

```ts
/** Keyed `provider/modelId`; `"unknown"` when the target names neither. */
type ModelKey = string;

interface ModelUsage {
  readonly provider?: string;
  readonly modelId?: string;
  readonly usage: UsageStats;
  readonly ticks: number;
  readonly cost?: CostRollup;
}

interface UsageRollup {
  /** Flat token totals across every model. Safe to sum; meaningless to price. */
  readonly usage: UsageStats;
  readonly byModel: Readonly<Record<ModelKey, ModelUsage>>;
  readonly cost?: CostRollup;
}
```

The flat `usage` stays — "how many tokens did this session burn" is a
real question with a real flat answer, and context-window and
rate-limit consumers already read it. What changes is that it is no
longer the _only_ answer. `byModel` is what makes cost computable, and
it is preserved at every level: **tick → execution → session.**

Landing sites:

| Level     | Where                              | Gains                                      |
| --------- | ---------------------------------- | ------------------------------------------ |
| tick      | loop `tick` / `tick-end` events    | `cost?`, model identity                    |
| tick      | `SessionMessageMetadata`           | `cost?`, `model?` next to existing `usage` |
| execution | `ExecutionRunResult`, `SendResult` | `byModel`, `cost?`                         |
| turn      | turn-boundary timeline record      | `byModel`, `cost?`                         |
| session   | `SessionRecord`                    | `byModel`, `cost?`                         |

Folding rules: `usage` folds by `mergeUsageStats` semantics (absent
optional kinds stay absent until some tick reports one). `byModel` folds
per key. `cost` folds per §6 — `complete + complete` (same currency) is
`complete`; anything touching a `partial` or a foreign currency is
`partial`.

### 7.2 Every hop between these levels is an allowlist

Adding a field to a type does not make it travel. Three separate places
in this pipeline copy a payload forward by naming each field, and each
one silently drops anything it does not name:

- `TimelineHarness.appendTurnBoundary` builds the boundary record with an
  `omitUndefined({ usage, stopCause, target })` spread.
- The session projects the loop's internal `LoopStreamEvent`s onto the
  wire `StreamEvent`s field by field (§8).
- `SessionRuntime.commit` rebuilds the `SessionRecord` slot by slot.

All three dropped `byModel` and `cost` on the first pass, and **none of
them failed to compile** — the fields are optional, so an omitted one is
a legal value everywhere. Only a test that reads the far end catches it.
That is why the landing-site table above is a checklist and why each row
has its own assertion in §10, rather than one end-to-end test standing
in for all of them.

### 7.1 The boundary: write-time within a session, query-time across the graph

This is the load-bearing line of the whole rollup design.

**Within a session, rollup is write-time.** tick → execution → record,
with the per-model breakdown preserved at every level. One writer, one
lineage, no ambiguity about who owns the number.

**Across the graph, rollup is query-time.** Sub-agent sessions (joined by
`spawnPath`) and task executions (joined by `scope.sessionId`) are
**never** propagated root-ward at write time.

#### Three reasons there is no root-ward write, each sufficient alone

1. **Write amplification.** A deep tree would re-write every ancestor
   record on every tick of every descendant. The cost of doing the
   accounting would scale with depth × tick count — paid continuously,
   for a number nobody has necessarily asked for.
2. **Structural double-count.** If a parent's record contained its
   children's spend, then _summing records_ — the most natural operation
   any consumer performs, and exactly what a billing export or a
   per-principal total does — counts every descendant once per ancestor
   above it. The error is silent, grows with depth, and always
   overstates. Note this is a property of the shape, not of any
   particular consumer being careless: there is no way to sum a set of
   records correctly once they overlap.
3. **Attribution is policy, not fact.** Who pays for a detached task, or
   for a sub-agent shared between two parents, is the adopter's call —
   and so is whether a session spawned _after_ its parent finished
   belongs to that parent's total. Write-time rollup freezes one answer
   into the record and destroys the others. A query lets the caller pick
   the scope; a write picks it for them, permanently.

#### What the framework owes in exchange

Refusing to write is only defensible if asking is easy. The join keys
already exist — `SessionRecord.spawnPath` (full ancestor chain,
root-first) and the per-session stamped `cost` sit on the same record —
so spec ships the fold:

```ts
import { rollupTree, inSpawnTree } from "@agentick/spec";

const tree = rollupTree(await store.list({ appId }, ctx), rootSessionId);
tree?.cost; // complete | partial, for the whole subtree
tree?.byModel; // per-model across every descendant
```

`rollupTree` takes any records satisfying `CostAttributionRecord` (which
`SessionRecord` already does), matches the subtree with `inSpawnTree`,
and folds usage, `byModel`, and cost. Because the root is a _parameter_,
the same records answer "this whole tree", "this subtree", or "this
session alone" — the scope stays the caller's, which is reason 3 made
concrete.

#### The honesty rule extends to the tree

**A tree total is `partial` if any descendant contributes unpriced
work.** Two ways that happens, and the second is the subtle one:

- a descendant's own rollup is already `partial` — `mergeCostRollups`
  propagates it, nothing extra needed;
- a descendant has usage but **no cost rollup at all**.
  `mergeCostRollups(acc, undefined)` returns `acc` unchanged, so a naive
  fold would report `complete` while an entire branch went unaccounted
  for. `rollupTree` degrades explicitly in that case.

One limit the fold cannot cover: a descendant whose record was never
handed in. Missing rows are indistinguishable from a tree that does not
contain them, so **the caller owns the completeness of the input** —
pass what a `list` returned, not a hand-picked subset.

**What is missing is the filter, and it is deliberately not added here.**
`SessionStoreQuery` scopes by `parentSessionId` — _direct children_ — and
by `root`. There is no ancestor-chain predicate, so a transitive tree
query today means walking `parentSessionId` level by level: N+1 round
trips, and it does not page.

The fix is one field — `spawnPathContains?: string` on
`SessionStoreQuery` — and it belongs _in the query_ for the reason the
`principal` field's own docblock already argues: a filter the store does
not know about has to be applied after the page is cut, which returns
pages shortened by discarded rows and a `nextCursor` promising rows
already thrown away. Paging and scoping have to be decided in the same
place.

It is not added in this pass because `SessionStoreQuery` is a structural
interface implemented by every session-store adapter, and an adapter
that does not recognize a new field **ignores it silently and returns
too many records**. For a cost query that means a tree total that
over-counts, with no error and nothing in the shape of the result to
say so — precisely the failure mode §6 exists to prevent. Landing the
field means landing it in the conformance suite and every adapter in the
same change, or not at all.

<!-- TODO(trail-spawn-tree-query): add `spawnPathContains` to
     SessionStoreQuery + the store conformance suite + every adapter, as
     one change. Until then, tree attribution is a client-side
     parentSessionId walk. -->

Until it lands, `rollupTree` works on whatever the caller can obtain —
an app-scoped `list`, or a `parentSessionId` walk. The _fold_ is shipped
and correct today; only the paged one-shot filter is outstanding.

---

## 8. Wire

Cost rides where usage already rides: **no new verbs, no new topics.**
The tick and execution stream events and the session record aggregate
already project to clients, and each gains the same fields it gains
in-process — `TickEvent` / `TickEndEvent` gain `cost` + `model`,
`ExecutionEvent` and `SessionRecord` gain `byModel` + `cost`. A client
that renders usage renders cost by reading one more field on a payload
it already receives.

It does **not** ride automatically, and assuming it would was a mistake
worth recording. The wire `StreamEvent` types in
`spec/data/streaming.ts` are separate, explicitly-fielded types from the
loop's internal `LoopStreamEvent`; the session projects one onto the
other field by field. Anything not named in that projection is dropped
silently — which is exactly how a field lands in-process, passes its
tests, and is invisible to every client.

An unpriced tick must emit **no `cost` key at all**, not `cost: null` or
`cost: undefined`. Absent means "we could not price this"; a serialized
null is a different claim, and one a JSON consumer will read as a value.

---

## 9. Convergence with `@agentick/model`

`@agentick/model` already holds a cost estimator (#186/#204):
`ModelPricing` (float USD/MTok), `SEED_PRICING`, `resolvePricing`,
`estimateCost`, plus `ExecutionTarget.pricing` mirroring `ModelPricing`
structurally in spec. It is not touched by this work — a concurrent
session owns that package.

**Two cost systems is a defect, and this document does not pretend
otherwise.** They differ on every axis that matters: float vs integer,
seeded-by-default vs adopter-supplied, ephemeral span annotation vs
stamped durable record, flattened vs per-model. The new vertical is an
accounting record; the existing one is a telemetry estimate. They should
not both exist at v2.0.

The convergence diff, for whoever owns `@agentick/model` next:

1. Delete `SEED_PRICING`, and the `pricing` rows from `SEED_MODELS`.
   `ModelInfo` keeps `contextWindow` / `maxOutputTokens` /
   `capabilities` / `tokenEstimator` — those are facts about a model,
   not prices that go stale. Rates leave the registry entirely; they
   live on the target (§4.2).
2. Delete `estimateCost`, `resolvePricing`, `mergePricing`,
   `PricingTable`, `ModelPricing`, and `CostEstimate`. Their one caller
   (`packages/app/src/telemetry-defaults.ts`) reads the stamped `Cost`
   off the tick instead of recomputing — which also fixes the span
   annotation reporting a _different_ number from the record.
3. Delete `ExecutionTarget.pricing` from spec; `ExecutionTarget.rates`
   replaces it.
4. Keep `mergeUsageStats` — it is the usage fold, unrelated to pricing,
   and this vertical uses it.

Until that lands, `estimateCost` keeps working off `target.pricing` and
the two are independent. Nothing in this vertical reads `target.pricing`
or `SEED_PRICING`, so there is no silent cross-talk — just duplication.

---

## 10. Verified by

| Claim                                                            | Test                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Adapters normalize every kind with correct containment           | per-adapter fixture suites (`model-anthropic`, `model-openai`, `model-google`, `model-ai-sdk`) |
| Anthropic streaming reports cache writes (D5)                    | `model-anthropic` streaming usage fixture                                                      |
| Google folds thoughts into output (D6)                           | `model-google` usage fixture                                                                   |
| Cache read/write are not double-charged                          | `spec` cost-arithmetic suite                                                                   |
| Flat per-call fee applies once per tick                          | `spec` cost-arithmetic suite                                                                   |
| Rounding is deferred and order-independent                       | `spec` cost-arithmetic suite                                                                   |
| Resolver beats declared rates; `undefined` falls through         | `loop-executor` stamping suite                                                                 |
| A resolver-returned `Cost` is used verbatim                      | `loop-executor` stamping suite                                                                 |
| An unpriced tick yields `partial`, never a zero `complete`       | `spec` rollup suite + `session` integration                                                    |
| Per-model breakdown survives a two-model session                 | `session` integration suite                                                                    |
| `rateRef` is stamped on every priced record                      | `loop-executor` stamping suite                                                                 |
| Sub-agent cost is absent from the parent's rollup                | `session` spawn suite                                                                          |
| `cost` + `model` reach the wire tick event                       | `session` wire-projection suite                                                                |
| An unpriced tick emits no `cost` KEY on the wire                 | `session` wire-projection suite                                                                |
| `byModel` + `cost` survive snapshot → restore                    | `session` snapshot suite                                                                       |
| A tree rolls up at any depth; a sibling tree is excluded         | `spec` tree-rollup suite                                                                       |
| The same records answer a different root (scope is the caller's) | `spec` tree-rollup suite                                                                       |
| A descendant with usage and no cost makes the TREE `partial`     | `spec` tree-rollup suite                                                                       |
| A zero-usage descendant does NOT make the tree partial           | `spec` tree-rollup suite                                                                       |
| Cost / token / unpriced-tick metrics mirror the stamp            | `session` metrics-mirror suite                                                                 |
| Metrics labels carry no unbounded dimension                      | `session` metrics-mirror suite                                                                 |

## 11. Roadmap & known gaps

- **Not built:** the §9 convergence — two cost systems coexist until
  `@agentick/model` is free to change.
- **Not built:** a dated opt-in price constants module. Deliberate; §4.2.
- **Not built:** per-currency rollup buckets; mixed currency degrades to
  `partial` (§6).
- **Not built — and this vertical inherits the defect it names in D4:**
  a single `cacheWrite` rate. Anthropic prices a 5-minute-TTL cache
  write at 1.25× input and a 1-hour-TTL write at 2×, and its API reports
  the split (`cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`). `UsageStats` collapses both into
  `cacheCreationTokens`, so no rate card can price them differently.
  Closing this means splitting the kind at the adapter _and_ in
  `UsageStats` — `TokenKind` is a closed union, so it is a spec change,
  not a config one. Long-TTL-cache workloads are under-billed until
  then.
  <!-- TODO(trail-cache-ttl-tiers) -->
- **Not built:** rates that expire. A `RateCard` is a constant, so
  introductory or promotional pricing with an end date has to be
  handled by the adopter's `costResolver`, which sees the tick and can
  branch on a clock. That is the right home — a dated rate is policy —
  but it means declared `rates` alone cannot express one.
- **Not built:** `maxCost` as a send-level bound (the `maxTicks` analog).
  The stamped per-tick `Cost` is the input a budget guard needs, so this
  is now a small addition rather than a subsystem.
  <!-- TODO(trail-budget-guard) -->
- **Built, with one piece outstanding:** agent-tree attribution. The
  fold (`rollupTree` / `inSpawnTree`) ships and is correct, including
  the tree honesty rule. What is missing is the `spawnPathContains`
  store predicate that would make it a single _paged_ query instead of a
  fold over an app-scoped `list` or a `parentSessionId` walk — see §7.1
  for why that field cannot land piecemeal.
  <!-- TODO(trail-spawn-tree-query) -->
- **Not built:** per-principal cost aggregation. Same shape as §7.1 —
  a query over `SessionRecord.principal`, not a write-time rollup. This
  one is closer than the tree query: `SessionStoreQuery.principal`
  already exists, so it is `rollupTree`'s sibling over an existing
  filter.
  <!-- TODO(trail-principal-quotas) -->
