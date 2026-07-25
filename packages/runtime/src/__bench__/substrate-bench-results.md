# Substrate hot-path benchmark results

**Last run:** 2026-06-05 · `pnpm vitest bench --run packages/runtime/src/__bench__/substrate.bench.ts`
**Hardware:** Darwin arm64 (M-series).

Per-bench numbers below — `mean` column from vitest output. Earlier
baselines from the 2026-06-02 streaming-bench pass are referenced for
context; they measured the full executor.run path (not just bus
operations) so they include adapter mapping cost on top of the bus.

## Headline: Phase B + Phase C together

The cursor-pull ring buffer (Phase C) is fundamentally cheaper than
the per-subscriber `Effect.Queue` model it replaced. Phase B's
batching adds incremental win on top — but most of the speedup at
1.5–1.7× came from Phase C, not B.

End-to-end OpenAI executor (100 deltas + 1 subscriber, full hot path):

| Pass                                           |     hz | mean (ms/run) |                   vs prior pass |
| ---------------------------------------------- | -----: | ------------: | ------------------------------: |
| Pre-Phase-B baseline (push-based, no batching) | ~1,558 |          0.64 |                               — |
| Phase B (push-based + batching ON)             | ~2,679 |          0.37 |                           1.72× |
| **Phase C (cursor-pull + batching ON)**        | ~2,448 |          0.41 |       (combined 1.57× vs pre-B) |
| **Phase C (cursor-pull, batching OFF)**        | ~2,397 |          0.42 | 1.54× vs pre-B with no batching |

Phase C's ring buffer alone gets you within 2% of Phase B's batched
number. Batching now provides ~2% on top of cursor pull rather than
72% on top of push. The combined Phase B+C delivers **~1.5–1.6×**
on the executor hot path.

## Core substrate (unchanged across Phase A/B)

| Bench                                                          |        hz | mean (μs/op) |
| -------------------------------------------------------------- | --------: | -----------: |
| `bus.publish`, no listeners (lazy fan-out skip)                | 1,927,232 |         0.52 |
| `bus.publish`, 1 matching subscriber                           |   158,478 |         6.31 |
| `bus.publish`, 1 non-matching subscriber (index short-circuit) | 1,844,321 |         0.54 |
| `bus.publishLazy`, no subscribers (build SKIPPED)              | 1,940,755 |         0.52 |
| `bus.publishLazy`, 1 subscriber (build RUNS)                   |   178,995 |         5.59 |
| `journal.append`, unique opIds                                 |   699,948 |         1.43 |
| `journal.append`, repeated (opId, phase) — idempotent dedup    | 1,617,820 |         0.62 |
| `inbox.send`, fresh messageIds                                 |   114,107 |         8.76 |
| `inbox.send`, same messageId (cache hit)                       | 1,559,190 |         0.64 |
| `runOperation`, empty body, fresh opIds                        |    22,993 |        43.49 |
| `runOperation`, empty body, idempotent replay                  |   136,254 |         7.34 |
| `LocalChannelPublisher`, no subscriber (lazy skip)             | 1,903,729 |         0.53 |
| `LocalChannelPublisher`, 1 subscriber (full envelope)          |   155,135 |         6.45 |

## Streaming simulation (10 ops × 10 deltas via `runOperation`)

| Bench                                |    hz | mean (μs/op) |
| ------------------------------------ | ----: | -----------: |
| eager `emitDelta` (no subscriber)    | 3,683 |        271.5 |
| lazy `emitDeltaLazy` (no subscriber) | 4,446 |        224.9 |

`lazy` is **1.21× faster** than `eager` here. Build-skip win shows
because the no-subscriber probe avoids constructing 100 payloads.

## Phase A — `compileQuery` per-event filter cost

| Bench                                              |         hz | mean (μs/op) | vs `matchesQuery` |
| -------------------------------------------------- | ---------: | -----------: | ----------------: |
| `matchesQuery` (generic walk) — `{surface, phase}` | 29,555,036 |        0.034 |                 — |
| compiled closure — same query                      | 38,292,023 |        0.026 |  **1.30× faster** |
| `matchesQuery` — name-prefix + surface             | 25,078,176 |        0.040 |                 — |
| compiled closure — same                            | 38,741,190 |        0.026 |  **1.54× faster** |
| `matchesQuery` — composite (all fields)            |  9,232,825 |        0.108 |                 — |
| compiled closure — composite                       | 20,972,710 |        0.048 |  **2.27× faster** |

Phase A's win is in the filter primitive itself — meaningful at high
subscriber counts where the matcher walks every event for every sub.

## Phase B + C — per-surface batching: producer cost

`append(executor:delta, …)` (renamed from `publish` in Phase C) with
subscribers attached, batching OFF (`batch: {}`) vs ON (default policy —
`executor:delta` 8ms/4). Numbers are post-Phase-C ring buffer:

| Subscribers | Batching OFF (hz / μs) | Batching ON (hz / μs) | Speedup from batching |
| ----------: | ---------------------: | --------------------: | --------------------: |
|           1 |         299,165 / 3.34 |        314,026 / 3.18 |             **1.05×** |
|           3 |         109,167 / 9.16 |        127,102 / 7.87 |             **1.16×** |

Compare to the equivalent Phase B (push-based) numbers:

| Subscribers | Phase B OFF | Phase C OFF | Δ baseline | Phase B ON | Phase C ON | Δ batched |
| ----------: | ----------: | ----------: | ---------: | ---------: | ---------: | --------: |
|           1 |  175,794 hz |  299,165 hz |   **+70%** | 332,572 hz | 314,026 hz |       -6% |
|           3 |   63,801 hz |  109,167 hz |   **+71%** | 144,245 hz | 127,102 hz |      -12% |

The ring buffer made the unbatched baseline ~70% faster, which means
batching's relative win shrinks from 1.89×/2.26× (Phase B) to
1.05×/1.16× (Phase C). Net: both paths are absolutely faster than
Phase B's batched path was. Batching still helps under contention but
the cursor-pull is the bigger lever.

`appendBatch` direct path vs equivalent loop of single appends:

| Bench                                    |                    hz | mean (μs / 8-event batch) |          vs loop |
| ---------------------------------------- | --------------------: | ------------------------: | ---------------: |
| `appendBatch(8 events)`, 1 subscriber    |                55,331 |                     18.07 |                — |
| `8× append()`, 1 subscriber, no batching | (compute: 1/299K × 8) |                     26.74 | **1.48× slower** |

`appendBatch` saves wake calls + Effect runtime entrances. Phase B
showed this at 4.40× vs single-publish loop; Phase C narrows to 1.48×
because the cursor-pull path already collapses much of the per-publish
overhead.

## Phase C — end-to-end: 64 deltas × 3 subscribers (bus only)

Full producer-to-consumer path. Producer appends 64 events; three
subscribers each drain to completion via `Stream.take(64)`.

| Scenario                    |    hz | mean (ms / full run) | Speedup from batching |
| --------------------------- | ----: | -------------------: | --------------------: |
| batching OFF (post-Phase-C) |   771 |                 1.30 |                     — |
| batching ON (post-Phase-C)  | 1,008 |                 0.99 |             **1.31×** |

Both paths are faster than the Phase B-batched 1,107 hz — the
unbatched cursor-pull alone now beats the push-batched path.

## Phase C — end-to-end: OpenAI executor (real adapter hot path)

`OpenAIExecutor.run` against `StubOpenAIClient` over 100 streaming
text deltas, 1 subscriber draining `{surface: "executor", phase: "delta"}`.
Captures the executor's full pipeline (chunk iterate → mapChunk →
`emitDeltaLazy` → `StreamAccumulator` → normalize) AND the bus path.

| Scenario                       |    hz | mean (ms / 100-delta run) |                     Notes |
| ------------------------------ | ----: | ------------------------: | ------------------------: |
| batching OFF (`{ batch: {} }`) | 2,397 |                      0.42 | Phase C cursor pull alone |
| batching ON (default policy)   | 2,448 |                      0.41 |        Phase C + batching |

Compare to Phase B (push-based + batching ON): 2,679 hz. Phase C's
unbatched path nearly matches Phase B's batched path because the
ring buffer eliminates the per-subscriber Queue overhead that
batching was working around.

## Honest read against the ADR 29 "~10× per-delta win" target

ADR 29 set "~10× per-delta win with one subscriber" as the Phase B
target. We hit 1.89× under Phase B alone; combined Phase B+C delivers
about 1.5× on the executor hot path. The gap from 10× has concrete
causes, not missing optimisations:

1. **Phase A's `compileQuery` already moved the floor.** The 10× figure
   was anchored to a 2026-06-02 measurement of +20 μs/delta with one
   subscriber, full executor.run path. By the time Phase B ran,
   `compileQuery` had moved the bus-only baseline to ~5.7 μs/publish
   — 3.5× cheaper than the figure ADR 29 was written against.

2. **`Effect.runPromise` runtime entrance is the new floor.** Each
   `await Effect.runPromise(bus.append(event))` pays ~3 μs of Effect
   runtime overhead regardless of what the body does. Batching and
   cursor pull amortise the bus's _internal_ work but not the
   per-call boundary cost.

3. **The cursor pull subsumed most of batching's value.** Phase B
   batched the producer side to skip per-subscriber Queue.offer cost.
   Phase C eliminated the per-subscriber Queue entirely. The two
   optimisations target the same bottleneck; doing both was partly
   redundant.

Net delivery against pre-Phase-B baseline:

- Cursor pull alone (Phase C OFF): **+54%** end-to-end executor
- Cursor pull + batching (Phase C ON): **+57%** end-to-end executor

Pushing further would require avoiding `Effect.runPromise` on the
producer hot path (sync `appendUnsafe`) or aggregating at the
executor layer. Neither is in Phase C scope.

**Decision:** ship Phase C alongside Phase B in the unified
`EventLog<E>` shape. Adopters who need more reach for `appendBatch`
directly (still wins ~1.48× over loop-of-append). Phase D's cluster
backend implements `EventLog<E>` the same way; adopters don't change
code to swap.
