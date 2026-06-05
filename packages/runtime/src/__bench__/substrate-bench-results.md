# Substrate hot-path benchmark results

**Last run:** 2026-06-05 · `pnpm vitest bench --run packages/runtime/src/__bench__/substrate.bench.ts`
**Hardware:** Darwin arm64 (M-series).

Per-bench numbers below — `mean` column from vitest output. Earlier
baselines from the 2026-06-02 streaming-bench pass are referenced for
context; they measured the full executor.run path (not just bus
operations) so they include adapter mapping cost on top of the bus.

## Core substrate (unchanged across Phase A/B)

| Bench | hz | mean (μs/op) |
|---|---:|---:|
| `bus.publish`, no listeners (lazy fan-out skip) | 1,927,232 | 0.52 |
| `bus.publish`, 1 matching subscriber | 158,478 | 6.31 |
| `bus.publish`, 1 non-matching subscriber (index short-circuit) | 1,844,321 | 0.54 |
| `bus.publishLazy`, no subscribers (build SKIPPED) | 1,940,755 | 0.52 |
| `bus.publishLazy`, 1 subscriber (build RUNS) | 178,995 | 5.59 |
| `journal.append`, unique opIds | 699,948 | 1.43 |
| `journal.append`, repeated (opId, phase) — idempotent dedup | 1,617,820 | 0.62 |
| `inbox.send`, fresh messageIds | 114,107 | 8.76 |
| `inbox.send`, same messageId (cache hit) | 1,559,190 | 0.64 |
| `runOperation`, empty body, fresh opIds | 22,993 | 43.49 |
| `runOperation`, empty body, idempotent replay | 136,254 | 7.34 |
| `LocalChannelPublisher`, no subscriber (lazy skip) | 1,903,729 | 0.53 |
| `LocalChannelPublisher`, 1 subscriber (full envelope) | 155,135 | 6.45 |

## Streaming simulation (10 ops × 10 deltas via `runOperation`)

| Bench | hz | mean (μs/op) |
|---|---:|---:|
| eager `emitDelta` (no subscriber) | 3,683 | 271.5 |
| lazy `emitDeltaLazy` (no subscriber) | 4,446 | 224.9 |

`lazy` is **1.21× faster** than `eager` here. Build-skip win shows
because the no-subscriber probe avoids constructing 100 payloads.

## Phase A — `compileQuery` per-event filter cost

| Bench | hz | mean (μs/op) | vs `matchesQuery` |
|---|---:|---:|---:|
| `matchesQuery` (generic walk) — `{surface, phase}` | 29,555,036 | 0.034 | — |
| compiled closure — same query | 38,292,023 | 0.026 | **1.30× faster** |
| `matchesQuery` — name-prefix + surface | 25,078,176 | 0.040 | — |
| compiled closure — same | 38,741,190 | 0.026 | **1.54× faster** |
| `matchesQuery` — composite (all fields) | 9,232,825 | 0.108 | — |
| compiled closure — composite | 20,972,710 | 0.048 | **2.27× faster** |

Phase A's win is in the filter primitive itself — meaningful at high
subscriber counts where the matcher walks every event for every sub.

## Phase B — per-surface batching: producer cost

`publish(executor:delta, …)` with subscribers attached, batching OFF
(`batch: {}`) vs ON (default policy — `executor:delta` 8ms/4):

| Subscribers | Batching OFF (hz / μs) | Batching ON (hz / μs) | Speedup |
|---:|---:|---:|---:|
| 1 | 175,794 / 5.69 | 332,572 / 3.01 | **1.89×** |
| 3 | 63,801 / 15.67 | 144,245 / 6.93 | **2.26×** |

`publishBatch` direct path vs equivalent loop of single publishes:

| Bench | hz | mean (μs / 8-event batch) | vs loop |
|---|---:|---:|---:|
| `publishBatch(8 events)`, 1 subscriber | 98,340 | 10.17 | — |
| `8× publish()`, 1 subscriber, no batching | 22,338 | 44.77 | **4.40× slower** |

`publishBatch` is the adopter-facing knob for callers who already have
a batch in hand (cluster nodes forwarding, replay drivers, future
ring-buffer pulls). The 4.4× delta is real but only realised when the
caller skips the accumulator entirely.

## Phase B — end-to-end: 64 deltas × 3 subscribers (bus only)

Full producer-to-consumer path. Producer publishes 64 events; three
subscribers each drain to completion via `Stream.take(64)`.

| Scenario | hz | mean (ms / full run) | Speedup |
|---|---:|---:|---:|
| batching OFF | 640 | 1.56 | — |
| batching ON (default policy) | 1,107 | 0.90 | **1.73×** |

## Phase B — end-to-end: OpenAI executor (real adapter hot path)

`OpenAIExecutor.run` against `StubOpenAIClient` over 100 streaming
text deltas, 1 subscriber draining `{surface: "executor", phase: "delta"}`.
Captures the executor's full pipeline (chunk iterate → mapChunk →
`emitDeltaLazy` → `StreamAccumulator` → normalize) AND the bus path.
This is the closest bench to the actual production hot path.

| Scenario | hz | mean (ms / 100-delta run) | Speedup |
|---|---:|---:|---:|
| batching OFF (`{ batch: {} }`) | 1,558 | 0.64 | — |
| batching ON (default policy) | 2,679 | 0.37 | **1.72×** |

The full-executor speedup mirrors the bus-only number — confirming the
win is real on the path adopters actually run and that no executor-level
work is needed to capture it.

## Honest read against the ADR 29 "~10× per-delta win" target

ADR 29 set "~10× per-delta win with one subscriber" as Phase B's
target. We hit **1.89×** on that exact shape. The gap has a concrete
cause, not a missing optimisation:

The 10× figure was anchored to the 2026-06-02 streaming-bench number of
**+20 μs per delta with one subscriber** (full executor.run path,
includes adapter mapping). Phase A's `compileQuery` (already shipped)
moved the per-event filter cost from ~108 ns to ~26 ns on composite
queries — the bus-only baseline is now **5.69 μs/publish with one
subscriber**, ~3.5× cheaper than the number ADR 29 was written
against.

Against today's actual baseline:

- **Transparent batching wins 1.7×–2.3×** on the publish hot path.
- **`publishBatch` wins 4.4×** when adopters batch explicitly.
- **End-to-end** with 3 subscribers wins **1.73×**.

The remaining cost is dominated by `Effect.runPromise` / `Effect.suspend`
runtime entrance per `publish` call (~3 μs floor). Batching does not
reduce that floor — it only amortises the fan-out portion. To push
further we would need either (a) executors aggregating their own
batches and calling `publishBatch` once per N tokens, or (b) avoiding
the Effect runtime entrance on the hot path (e.g., a sync
`publishUnsafe` for in-fiber callers). Neither is in Phase B scope.

**Decision:** ship Phase B as-is with the transparent win. Adopters
who need more reach for `publishBatch` directly. Phase C's ring
buffer + cursor protocol shifts subscriber cost more substantially
than batching alone could.
