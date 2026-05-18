# 17 — Open Questions (Consolidated)

**Status:** Synthesized

Every open question across the v2 proposal set, deduped, grouped by
topic, with the blueprint's lean (where there is one) and source
references. This list is the punch list for crystallization.

Three statuses:

- **OPEN** — no position taken; needs decision.
- **LEAN** — blueprint takes a position pending sign-off.
- **DECIDED** — closed in source proposals or by the blueprint
  (recorded here for reference but not actionable).

## A. Type system gaps (placeholders)

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| A1 | `features[]` enumeration | compiled-spec.md §OQ4 | LEAN | 8-name registry in `02-data-model.md` |
| A2 | `OutputRef` shape | compiled-spec.md (no §; referenced as TBD) | LEAN | `OutputDeclaration` shape per `02-data-model.md` |
| A3 | `ToolAnnotations` shape | compiled-spec.md (referenced) | LEAN | inherit v1's intent/timeout/defaultResult/ui |
| A4 | `MCPDeclaration` shape | compiled-spec.md §RuntimeDeclarations | LEAN | id, serverName, transport, config, exposes |
| A5 | `ModelSelection` shape | compiled-spec.md §SpecConfig | LEAN | `{ kind: "by-id" \| "by-ref"; ... }` |
| A6 | `ResponseFormat` shape | compiled-spec.md (V1-INHERITED) | DECIDED | inherit from v1 |
| A7 | `TargetCapabilities` shape | executor.md §ExecutionTarget | LEAN | synthesized from v1 ContextUpdateEvent |
| A8 | `KnobState`, `ChannelState`, `SubscriptionIntent`, `ResolvedValue` | runtime.md (referenced) | LEAN | placeholders in `08-session-harness.md` |
| A9 | `SessionRecord` exact shape | runtime.md §Storage | LEAN | placeholder in `14-state-tiers.md` |
| A10 | `ReconcilerSnapshot` exact shape | compiler-harness.md §commands (opaque) | **DECIDED 2026-05-08** | locked in `03-reconciler-harness.md` §Snapshot rules |
| A11 | `StateApplicator` interface | loop-executor.md §commands | LEAN | placeholder in `05-loop-executor.md` |
| A12 | `ContinuationPolicy` interface | loop-executor.md §OQ5 | LEAN | function + interceptor combo |
| A13 | `ExecutorDelta` minimum shape | executor.md §OQ1 | LEAN | 6-kind union per `02-data-model.md` |
| A14 | `FormatterCapabilities.optionsSchema` mechanism | renderer-harness.md §OQ4 | LEAN | per-renderer Standard Schema |
| A15 | `ToolHandlerCtx` exact shape | tool-executor.md (V1-INHERITED) | LEAN | synthesized from v1 stateful tool pattern |
| A16 | `ToolRegistry` interface | tool-executor.md (placeholder) | LEAN | placeholder in `07-tool-executor.md` |
| A17 | `HookBridges` shape | compiler-harness.md §Hooks | LEAN | placeholder in `03-reconciler-harness.md` |
| A18 | `GatewayProtocol` exact shape | gateway.md (placeholder) | LEAN | placeholder in `12-gateway.md` |
| A19 | `PersistenceBackend` exact methods | runtime.md §Backend interface | LEAN | placeholder in `14-state-tiers.md` |
| A20 | `SessionRegistry` shape | app-harness.md (placeholder) | LEAN | placeholder in `09-app-harness.md` |

## B. Compile-and-render

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| B1 | Compile-until-stable iteration cap | compiler-harness.md §OQ1 | LEAN | 16 iterations |
| B2 | Forced-stable hard fail vs warn | compiler-harness.md §OQ1 | LEAN | warn-only in dev, warn+metric in prod |
| B3 | Equality strategy for stable check | compiler-harness.md (referenced) | LEAN | hash-on-emit (SHA-256 of canonicalized JSON) |
| B4 | Async cancellation across hibernate | compiler-harness.md §OQ2 | LEAN | cancel + re-run on restore; doc `useData` for persisted resolves |
| B5 | Handler ID validation | compiler-harness.md §OQ3 | LEAN | registry rebuilt per render; compile fails on duplicates/unbound refs |
| B6 | Hook bridge typing strictness | compiler-harness.md §OQ4 | OPEN | — |
| B7 | Renderer output uniformity | compiler-harness.md §OQ5 | OPEN | — |
| B8 | Free-root content during loop = error or warn | compiler-harness.md §OQ6 | LEAN | warn by default, strict-mode hard fail |
| B9 | `useResolved` Layer 1 vs Layer 2 naming | (gap) | LEAN | Layer 1 = persistent, Layer 2 = compile-cache |
| B10 | Renderer streaming support | renderer-harness.md §OQ3 | LEAN | ship the surface, no v2 built-in |
| B11 | `renderToText` separate command vs flag | renderer-harness.md §OQ2 | LEAN | separate command |
| B12 | Renderer impls package home | renderer-harness.md §OQ1 | LEAN | `@agentick/react` for v2 |
| B13 | Section projection minimum format | compiled-spec.md §OQ5 | LEAN | XML-tag wrapping for Anthropic/Google; developer-msg with prefix for OpenAI |

## C. Executor

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| C1 | Tool call detection timing (immediate vs buffered) | executor.md §OQ2 | OPEN | — |
| C2 | Parallel tool dispatch policy | executor.md §OQ3 | LEAN | per-call hint via `ToolAnnotations.intent`; loop interceptor for global override |
| C3 | Provider retry policy boundaries (adapter vs runtime) | executor.md §OQ4 | OPEN | — |
| C4 | Structured output schema mismatch error mapping | executor.md §OQ5 | OPEN | typed `OutputValidationError`; sign-off pending |
| C5 | `ExecutionTarget` strictness before projection | executor.md §OQ6 | LEAN | best-effort if provider known and adapter declares fallback |
| C6 | Provider-side tool execution opt-out marker | executor.md §OQ7 | LEAN | absence-from-`toolCalls` is the contract |
| C7 | `raw` payload policy | executor.md §OQ8 | LEAN | opt-in via `RunInput.includeRaw`, default false |
| C8 | Cross-family base events (project/normalize) for non-LM | executor.md §OQ9 | LEAN | three-phase events universal; tool-call events LM-specific |

## D. Loop executor

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| D1 | Package home (`@agentick/runtime` vs `@agentick/loop`) | loop-executor.md §OQ1 | LEAN | internal under `@agentick/runtime` |
| D2 | Public API or internal only | loop-executor.md §OQ2, DL | DECIDED | internal-only in v2 |
| D3 | State applicator narrow interface | loop-executor.md §OQ4 | LEAN | placeholder in `05-loop-executor.md` |
| D4 | Continuation as policy object vs interceptor only | loop-executor.md §OQ5 | LEAN | both: named policy + interceptors |

## E. Session

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| E1 | `pause` / `resume` semantics | runtime.md (referenced) | LEAN | placeholder in `08-session-harness.md` |
| E2 | `inject` semantics | runtime.md (referenced) | LEAN | placeholder in `08-session-harness.md` |
| E3 | `recover` strategy taxonomy | runtime.md (referenced) | LEAN | placeholder in `08-session-harness.md` |
| E4 | `session.shell` no-sandbox behavior | (gap) | LEAN | `ToolNotFoundError` |
| E5 | Spawn promotion in cluster mode (registered vs ephemeral) | runtime.md §spawn (gap) | LEAN | opt-in via `{ persist: true }` |
| E6 | Hibernation default policy | runtime.md §OQ6 | LEAN | 15 min idle, LRU cap = max(N_cores * 32, 256) |
| E7 | Snapshot granularity (what's persisted vs derived) | runtime.md §OQ4 | LEAN | small structured per `14-state-tiers.md` |
| E8 | Forced abort timeout for hibernate | (gap) | LEAN | 5s default |
| E9 | Default timeline window size on hydration | runtime.md (referenced) | OPEN | — |
| E10 | Persistence backend default | runtime.md (referenced) | LEAN | SQLite for embedded, Postgres for prod |
| E11 | Spec version migration on restore mismatch | (gap) | OPEN | — |

## F. Events / interceptors

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| F1 | Interceptor registry shape (single vs per-namespace) | harness-principle.md §OQ1 | OPEN | single per harness, per-event-name dispatched |
| F2 | Interceptor response merge rules | harness-principle.md §OQ2 | LEAN | veto > replace > defer > proceed; spelled out in `01-` |
| F3 | Interceptor timeout / cancellation | harness-principle.md §OQ3 | OPEN | default 30s? |
| F4 | Cross-harness event propagation convention | harness-principle.md §OQ4 | LEAN | tags + same name + scope augmentation |
| F5 | Cross-process / cross-node harness boundaries | harness-principle.md §OQ5 | DECIDED | cluster wraps; same harness shape |
| F6 | TestHarness helper | harness-principle.md §OQ6 | OPEN | — |
| F7 | Query DSL richness (`EventQuery` enough?) | harness-principle.md §OQ7 | LEAN | `EventQuery` sufficient for v2 |
| F8 | Symmetry exceptions to phase contract | harness-principle.md §OQ8 | LEAN | none; document if encountered |
| F9 | Backpressure policy (slow + zero subscribers) | (gap) | LEAN | lazy fan-out + per-subscriber bounded buffer |
| F10 | DevTools event split mechanism | spec-package.md (referenced) | LEAN | separate PubSub, same envelope |
| F11 | Default channel retention | (gap) | LEAN | 256 entries OR 30 minutes |
| F12 | `next()` typing for input rewrites | (gap) | OPEN | — |
| F13 | Cluster-wide event id format | (gap) | OPEN | — |

## G. Spec package and protocol

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| G1 | Vendor extension key prefix (`x-` vs namespace) | spec-package.md §OQ1 | LEAN | `x-` |
| G2 | Protocol granularity (one per harness vs grouped) | spec-package.md §OQ2 | LEAN | one per harness |
| G3 | Guard strictness defaults | spec-package.md §OQ3 | LEAN | structural only by default |
| G4 | Schema publication strategy | spec-package.md §OQ4 | OPEN | npm + immutable URL future |
| G5 | Event envelope minimum required fields | spec-package.md §OQ5 | LEAN | `id`, `opId`, `surface`, `name`, `phase`, `timestamp`, `scope` |
| G6 | Canonical role set (developer fifth?) | compiled-spec.md §OQ1 | LEAN | no; treat as projection of system |
| G7 | Resource declaration vs MCP resource family | compiled-spec.md §OQ2 | OPEN | — |
| G8 | JSON Schema generation tool | spec-package.md (referenced) | OPEN | — |
| G9 | Per-spec-version directories vs mutable schemas | spec-package.md (referenced) | LEAN | per-version directories |
| G10 | TypeBox vs plain TS | spec-package.md (referenced) | DECIDED | plain TS + generated schema |
| G11 | `@standard-schema/spec` dep vs inline | spec-package.md §OQ2 | DECIDED | inline |
| G12 | Spec deprecation semantics | spec-package.md (referenced) | OPEN | — |

## H. Cluster

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| H1 | Routing substrate default | cluster.md §OQ1 | LEAN | `@effect/cluster` (Effect Cluster) |
| H2 | Activation policy ownership (runtime vs cluster) | cluster.md §OQ2 | LEAN | runtime interceptor on `hibernate` |
| H3 | Cross-node ordering guarantees | cluster.md §OQ3 | LEAN | per-session strict; cross-session best-effort |
| H4 | Durability coupling for migration | cluster.md §OQ4 | OPEN | — |
| H5 | Operational profile defaults | cluster.md §OQ5 | OPEN | — |
| H6 | Migration overhead bounds | runtime.md §OQ9 | OPEN | — |
| H7 | Supervisor failover semantics | runtime.md §OQ10 | OPEN | — |
| H8 | Multi-tenant rate-limiter mechanism | runtime.md §OQ11 | LEAN | backend-managed (Redis token store) |
| H9 | Cluster bus backbone choice | runtime.md §OQ8 | LEAN | Redis Streams (small/medium), NATS JetStream (high-throughput) |
| H10 | App-level interceptor replication mechanism | (gap) | OPEN | — |

## I. Gateway

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| I1 | Default transport set for v2 | gateway.md §OQ1 | LEAN | HTTP+SSE, WebSocket, in-process |
| I2 | Resume semantics mandatory vs optional | gateway.md §OQ2 | LEAN | mandatory for HTTP+SSE / WS |
| I3 | Error envelope standardization | gateway.md §OQ3 | OPEN | — |
| I4 | Policy plugin API shape | gateway.md §OQ4 | LEAN | gateway-scope interceptors |
| I5 | Co-located vs separate fleet guidance | gateway.md §OQ5 | OPEN | — |
| I6 | Server-side resume buffer defaults | runtime.md §OQ16 | LEAN | 256 events / 5 minutes |
| I7 | Resume request older than buffer policy | runtime.md §OQ16 | LEAN | `ResumeWindowExceededError`; full resync |

## J. Tool executor

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| J1 | OutputDeclaration ↔ Tool wiring | (gap) | LEAN | synthetic handler captured by id |
| J2 | Provider-side tool explicit marker shape | (gap; see C6) | LEAN | absence-from-toolCalls |
| J3 | Client tool registration mechanism in v2 | (gap) | LEAN | gateway-side bridge handler |
| J4 | Confirmation timeout default | (gap) | LEAN | inherit `tool.timeout` from declaration; default 30s |
| J5 | `always: true` allow-list scope | (V1-INHERITED) | LEAN | session-scoped |

## K. Persistence

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| K1 | Default persistence backend | runtime.md §OQ18 | LEAN | SQLite embedded; Postgres prod |
| K2 | Default timeline window size | runtime.md §OQ19 | OPEN | — |
| K3 | Large-content inline threshold | (gap) | OPEN | — |
| K4 | Channel storage tier vs main persistence | (gap) | LEAN | channel storage may differ from session record store |
| K5 | Composable Layer composition rules | (gap) | LEAN | per-concern Layers; merge by Tag |

## L. Observability

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| L1 | Recording mode taxonomy (full / lightweight / none) | (V1-INHERITED) | LEAN | inherit v1 taxonomy |
| L2 | Metric names and units | (gap) | LEAN | listed in `09-app-harness.md` |
| L3 | DevTools surface (separate API) | runtime.md §OQ15 | LEAN | `app.devTools.events()` separate from `app.events()` |
| L4 | Span naming convention | (gap) | LEAN | matches event names |
| L5 | OTel `recordException` without breaking error-reference identity | runtime substrate 2026-05-16 | **DECIDED 2026-05-18** | use standard `Effect.withSpan` — get full trace hierarchy + exception recording. Effect enhances stack traces by reconstructing the top-level failure object, but inner Error references in `.cause` are preserved as-is. Structural equality (`toEqual`, `toMatchObject` with `expect.objectContaining`), `instanceof`, `_tag` pattern matching, and property access all work normally. Only `error === originalError` reference identity on the outer failure object is lost. Adopters needing such checks should use `_tag` or `instanceof` instead. See findings below. |
| L6 | Bus publish hot-path performance budget | runtime substrate (gap) | **DECIDED 2026-05-17** | benchmarks landed; numbers in §Benchmark results below. Lazy emission validated (12× speedup); runOperation target revised 10 → 50 μs after measuring Effect framework cost. |
| L7 | Journal idempotency-key set unbounded growth | runtime substrate (gap) | **OPEN** | `MemoryJournal.appendedKeys` Set grows for every distinct (opId, phase). Long-lived sessions accumulate. Bound via LRU or TTL? |
| L8 | Substrate self-instrumentation (metrics on the bus itself) | runtime substrate (gap) | **OPEN** | how do we know if the substrate is the bottleneck under load? `subscriberCount`, journal size, inbox cache size — surfaced where? |

## M. Spec wire compatibility

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| M1 | Wire compatibility across spec versions | runtime.md §OQ17 | LEAN | version negotiation at transport handshake |
| M2 | Migration path from v1 | runtime.md §OQ12 | DECIDED | major-version cut; no compat shims |
| M3 | AG-UI adapter shape | runtime.md §OQ13 | LEAN | separate `@agentick/ag-ui-adapter` package |
| M4 | Bundle size for client (no Effect leak) | runtime.md §OQ14 | OPEN | verify empirically |

## N. Misc / cross-cutting

| # | Question | Source | Status | Lean |
| --- | --- | --- | --- | --- |
| N1 | Reconciler 0.31 → 0.32+ track | compiler-harness.md (referenced) | LEAN | pin minor; track patch |
| N2 | JSX namespace conflicts with React | compiler-harness.md (referenced) | LEAN | `jsxImportSource` per file |
| N3 | Server components alignment | compiler-harness.md (referenced) | OPEN | revisit later |
| N4 | Async stress testing patterns | compiler-harness.md (referenced) | OPEN | — |
| N5 | The "ingest results" mechanism (direct command vs indirect via state + rerender) | (resolved 2026-05-08) | **DECIDED** | hybrid: timeline writes via direct method call (`session.applyExecutorResult`); tick-end notification via `loop.onTickEnd → session.notifyLifecycle → react.notifyLifecycle` (lifecycle handler chain). See `15-flows/b-tick-and-tool-loop.md`. |

## Priority sign-off list

Ranked by impact on getting the design crystallized.

**Decided:**
- ~~A10 — `ReconcilerSnapshot` shape~~ ✓ locked 2026-05-08; see
  `03-reconciler-harness.md` §Snapshot rules.
- ~~A11 — `StateApplicator` interface~~ ✓ locked 2026-05-08; structural
  Pick of session harness apply commands; see `08-session-harness.md`.
- ~~N5 — Ingest mechanism~~ ✓ resolved 2026-05-08; hybrid (direct method
  for timeline writes; lifecycle handler chain for tick-end). See
  `15-flows/b-tick-and-tool-loop.md`.
- ~~F2 — Handler verdict merge rules~~ ✓ locked 2026-05-08; veto >
  replace > defer > proceed. See `01-harness-principle.md`.

**New since the five-surface model:**

- ~~Five-surface harness contract~~ ✓ locked 2026-05-08; see
  `01-harness-principle.md`. Replaces the earlier "events for
  everything" framing.
- ~~MessageInbox substrate~~ ✓ locked 2026-05-08; see `19-foundation.md`.

**Outstanding (next up):**

1. **A19 — `PersistenceBackend` methods.** Storage adapters depend on
   it.
2. **A13 — `ExecutorDelta` shape.** Locks streaming wire format.
3. **C6 — Provider-side tool execution marker.** Affects every
   executor adapter.
4. **B5 — Handler ID validation mechanism.** Long-lived primitives
   cross-cutting.
5. **A1 — `features[]` registry.** Spec-level versioning concern.
6. **E11 — Spec version migration on restore.** Forward compat
    behavior.
7. **Inbox idempotency cache size + TTL.** New from foundation work.
8. **Per-harness inbox message catalogs.** Each harness's accepted
    messages. Mostly listed in per-harness docs; needs cross-validation.
9. **Cluster routing layer integration with `@effect/cluster`.** Spike
    needed (carried from H1).
10. ~~**L5 — OTel exception recording without breaking error-reference
    identity.**~~ ✓ decided 2026-05-18: use standard `Effect.withSpan`;
    accept narrow loss of outer-wrapper `===` identity in exchange
    for full OTel integration. Structural equality / instanceof /
    `_tag` matching all preserved. See L5 section below for
    investigation + adopter patterns.
11. ~~**L6 — Bus publish hot-path benchmark.**~~ ✓ landed 2026-05-17;
    numbers in §Benchmark results. Lazy emission validated.
12. **L7 — Journal idempotency-key Set bound.** Currently unbounded;
    long-lived sessions leak memory. Need TTL or LRU. **Gates v2.0
    release** (not a Phase 4 blocker).
13. **L8 — Substrate self-instrumentation.** How a deployment knows
    if the bus is overloaded. Needs metric surface.

Items 1–2 are gating for spec package implementation. Items 3–9 are
gating for runtime implementation. Items 10–11 are gating for Phase 4c
(executor harness). Items 12–13 are gating for v2.0 release.

## Substrate scalability + observability (running notes)

Captured 2026-05-16 after foundation refinements landed. These are the
real concerns about the substrate's behavior under load — not design
gaps in the architecture, but unknowns in the implementation that need
empirical answers before adapters pile on.

### Hot paths to measure

| Path | Per-call cost | Frequency under load | Total budget |
| --- | --- | --- | --- |
| `bus.publish(ev)` | O(subscribers) match + Queue.offer per match | every envelope (3+ per op) | ~30k Queue.offer/sec at 10k ops/sec × 1 subscriber |
| `journal.append(ev)` | Set.add(idempotency) + array.push + listener loop + maybe splice | ≤2 per op (requested, terminal) | ~20k/sec at 10k ops/sec |
| `runOperation` overhead | `Effect.gen` body + ~6 yields + FiberRef set + Scope acquire/release | per op | unmeasured |
| Subscriber buffer overflow | sliding queue eviction (drop-oldest default) | bursty model streaming | bounded by `bufferSize` (default 256) |

### Concrete concerns

1. **Bus emit overhead under streaming.** A streaming model produces
   N tokens/sec as `delta` envelopes. At 100 tokens/sec × 10 concurrent
   sessions × 3 bus subscribers (devtools + telemetry + audit) = 3k
   Queue.offer/sec. Effect's `Queue.offer` is fast but uncached
   `matchesQuery` for non-trivial queries (prefix / scope-filter) is
   the cost driver. Profile under realistic patterns.

2. **`MemoryJournal.appendedKeys` unbounded growth.** Idempotency Set
   stores every `(opId, phase)` key forever. Long-lived sessions
   accumulate. Fix: TTL eviction matching the ring buffer's drop point
   (when the matching envelope drops from the buffer, its key drops
   too).

3. **Slow subscriber detection.** If one subscriber lags, its Queue
   fills, drop-oldest evicts events. No diagnostic emitted today —
   the slow consumer just silently misses events. Need an envelope
   like `bus:subscriber:overflow` or a metric.

4. **`Effect.scoped` finalizer overhead.** Every operation acquires
   and releases a Scope. Cost is bounded but not zero. Stress-test
   what happens at 10k ops/sec.

5. **FiberRef set/clear cost.** `withContext` reads, merges, locally
   sets the FiberRef. Per-op. Should be O(1) — verify.

6. **Inbox idempotency cache** — already bounded (10k entries, 10min
   TTL). Track hit rate under realistic ask/tell patterns to validate
   the cap.

### L5 investigation + decision (2026-05-17 → 2026-05-18)

Tried three approaches for "preserve reference identity through
`Effect.withSpan`":

1. Direct `Effect.withSpan(body)` — outer failure object reconstructed.
2. `Effect.either` inside `withSpan`, re-fail outside — same result;
   the reconstruction happens via fiber-runtime tracing instrumentation,
   not via `withSpan`'s top-level wrap.
3. `useSpan` (no parent attachment) — preserves identity but children
   don't inherit the span as parent (loss of trace hierarchy).

**Decision (2026-05-18): use standard `Effect.withSpan` — accept the trade.**

Empirical findings on what Effect's instrumentation actually preserves:

- **Top-level failure reference is lost.** `Effect.fail(wrapper)` →
  through `withSpan` → `Cause.failureOption` returns a different
  reference for the *outer* wrapper object.
- **Inner references are preserved.** `wrapper.cause` (the original
  Error reference passed into the wrapper) survives intact —
  `received.cause === innerOriginal` returns true when the wrapper
  itself was reconstructed.
- **All structural data is preserved.** Same enumerable + non-enumerable
  own properties, same prototype chain, same `instanceof` result,
  same `_tag` discriminator, identical stack trace (Effect copies it
  byte-for-byte).
- **Standard matchers work as expected.** `toEqual` and `toMatchObject`
  treat the reconstructed value as equal to the original because they
  do deep structural equality. The only path that breaks is exact
  reference equality (`===`) on the outer failure object.

Recommended adopter patterns:

```ts
// ✓ All of these work normally:
catch (err) {
  if (err._tag === "ToolHandlerError") { ... }      // tag match
  if (err instanceof OperationOutcomeError) { ... }  // prototype check
  if (err.cause?.message === "boom") { ... }         // property access
}

// In tests:
await expect(...).rejects.toMatchObject({
  _tag: "ToolHandlerError",
  cause: expect.objectContaining({ message: "boom" }),
});
```

```ts
// ✗ These will fail under OTel-enabled substrates:
catch (err) {
  if (err === originalSentinel) { ... }   // identity check on wrapper
}

// In tests:
await expect(...).rejects.toBe(originalError);  // strict equality
```

Rationale for accepting the trade rather than building Option B':

1. The cost is narrow (only outer-wrapper `===` identity).
2. The substitute idioms (`_tag`, `instanceof`, `objectContaining`)
   are what adopters use in practice anyway.
3. Effect provides full OTel span context propagation and exception
   recording out of the box — Option B' would re-implement what we'd
   be paying anyway to disable.
4. Effect framework cost is already 26 μs/op; a custom Tracer path
   would add more, not less.

Substrate (`base-harness.ts`) restored to `Effect.withSpan` direct
usage. JSDoc on `annotateOperationSpan` documents the contract.

### Benchmark plan (deferred to before Phase 4c lands)

1. Write `packages/runtime/bench/substrate.bench.ts` (Vitest bench API).
2. Scenarios:
   - `runOperation` empty body × 100k iterations
   - `bus.publish` × 1M with 1 / 10 / 100 subscribers
   - `journal.append` × 1M (mix of unique opIds + idempotent dups)
   - `inbox.send` × 1M (mix of unique + dup messageIds)
   - Streaming simulation: 100 concurrent operations × 100 delta
     envelopes each
3. Targets:
   - `runOperation` empty body: < 10μs / op
   - `bus.publish` no subscribers: < 1μs / call (lazy fan-out)
   - `bus.publish` 1 subscriber: < 5μs / call
   - `journal.append`: < 5μs / call
4. Compare with v1 EventEmitter-based path for sanity check.

### Benchmark results (2026-05-17, M-series Mac, Node 24)

Source: `packages/runtime/src/__bench__/substrate.bench.ts`.

| Operation                                  | Mean        | Target  | Status     |
| ------------------------------------------ | ----------- | ------- | ---------- |
| `bus.publish` no listeners                 | 0.5 μs      | < 1 μs  | ✓ 2× under |
| `bus.publish` 1 non-matching subscriber    | 0.5 μs      | —       | ✓ surface index short-circuit works |
| `bus.publish` 1 matching subscriber        | 6.0 μs      | < 5 μs  | ✗ 20% over |
| `bus.publishLazy` no subscribers           | 0.5 μs      | < 1 μs  | ✓ 2× under |
| `bus.publishLazy` 1 subscriber             | 6.0 μs      | —       | parity w/ eager publish |
| `journal.append` fresh                     | 1.4 μs      | < 5 μs  | ✓ 3.5× under |
| `journal.append` idempotent dedup          | 0.6 μs      | —       | early-exit |
| `inbox.send` fresh                         | 9.0 μs      | —       | baseline |
| `inbox.send` cache hit                     | 0.6 μs      | —       | excellent  |
| **`runOperation` fresh**                   | **46.8 μs** | < 10 μs | **✗ 4.7× over** |
| `runOperation` idempotent replay           | 7.5 μs      | —       | short-circuits at lookupTerminal |
| `LocalChannelPublisher` no subscriber      | 0.5 μs      | —       | lazy skip working |
| `LocalChannelPublisher` 1 subscriber       | 6.8 μs      | —       | parity with bus.publish 1-sub |

**Streaming simulation (10 concurrent ops × 10 delta envelopes each):**

| Variant | Mean wall time | Per-emission cost |
| --- | --- | --- |
| Eager (`emitDelta`)         | 289 μs / iter | 2.9 μs |
| Lazy  (`emitDeltaLazy`)     | 229 μs / iter | 2.3 μs |

Lazy emission is ~20% faster end-to-end when no subscriber matches —
validates the construction-on-demand design under realistic streaming
load.

### Findings + decisions

1. **Lazy emission is the correct call.** `publishLazy` no-subs at 0.5 μs
   vs. constructing-and-publishing at 6.0 μs is a **12× speedup** on the
   no-listener hot path. The subscriber index short-circuit (~100 ns)
   is the load-bearing optimization. **Confirmed.**

2. **The substrate index works as designed.** A subscriber on a
   non-matching surface costs the same as having no subscriber
   (0.5 μs) because the index reports "no match for this surface" and
   `publish` early-returns. **Confirmed.**

3. **Bus publish 1-subscriber is 20% over target.** 6.0 μs vs 5 μs
   target. Most of the overhead is `Effect.suspend` + `Effect.all`
   + the deliver loop (`Queue.offer` ~1 μs of Effect-runtime
   plumbing). Possible micro-optimizations: skip `Effect.all` when
   only one subscriber matches; inline the for-loop in `publish`.
   **Acceptable as-is for now**; revisit if streaming workloads
   surface the gap.

4. **`runOperation` empty body is 4.7× over the original 10 μs target.**
   46.8 μs per empty operation. Decomposition (from diagnostic
   benches removed pre-commit):
   - 3 publishes (`requested` + `before` + `terminal`) at ~7 μs each
     = 21 μs
   - Effect framework overhead: ~26 μs
     - `Effect.scoped` Scope acquisition/release
     - `withContext` FiberRef.locally
     - Nested `Effect.gen` yields (~10 microtask boundaries)
     - `handlers.run` (empty registry still allocates one effect)
     - `Effect.tap` / `Effect.tapError` / `annotateOperationSpan` pipe
       chain

   **Target revised:** original 10 μs was aspirational given how
   much work the phase contract does. Realistic budget for an
   Effect-native substrate at this surface area: **< 50 μs**.
   Substrate cost at 50 μs is 0.5% of a typical 10 ms tool call,
   0.05% of a typical 100 ms model call. Real-world throughput
   isn't substrate-limited.

5. **Idempotent replay is fast.** Cached terminal lookup short-circuits
   to 7.5 μs (vs 46.8 μs cold path). For workloads with retries / dedup
   loads, this is the desired skew.

6. **`inbox.send` fresh at 9 μs.** Setup-heavy: creates a Fiber via
   `Effect.runFork` to host the handler, registers in the idempotency
   cache, returns the ack. Cache-hit at 0.6 μs proves the memoization
   path is cheap. Acceptable.

### Open optimizations (later)

- **`bus.publish` 1-subscriber 20% miss.** Inline the deliver loop;
  skip `Effect.all` when only one matching subscriber. Would close
  the gap. **Not blocking Phase 4c.**
- **`runOperation` framework overhead.** ~26 μs of Effect plumbing.
  Could inline the nested `Effect.gen` blocks into one, skip
  `Effect.scoped` when no body finalizers are registered. ~15-20 μs
  recoverable. **Defer** — revisit if Phase 4c executor benches show
  substrate as the bottleneck.

### Comparison with v1

Not measured. v1's substrate is structurally different (EventEmitter
+ no phase contract + no idempotency by default). A direct comparison
isn't apples-to-apples. The relevant baseline is v1's session-level
operation throughput, which we'll re-baseline after the executor
harness lands.

### Components going into reconciler-react

Decision 2026-05-16: user-facing component wrappers (`<Section>`,
`<Message>`, `<H1>`, `<Tool>`, etc.) live in the matching reconciler
package — `@agentick/reconciler-react` for the React variant. Not a
separate `@agentick/components` package. Rationale: components are
inherently coupled to the reconciler's intrinsics; future Solid or
Vue reconcilers would ship their own component sets. example/v2
currently defines them locally as a stopgap; they graduate into
reconciler-react before Phase 4e (session harness) lands so app
authors can `import { Section, Tool } from "@agentick/reconciler-react"`.
