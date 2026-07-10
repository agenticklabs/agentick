# ADR 77 — The operation spine: fiber-through-the-process, location-transparent boundaries, dual-typed edges

**Status:** DRAFT 2026-07-10 (Fable, for Ryan). **Builds on:** ADR 19 (foundation — `Operation` / `runOperation` / `runHarnessProtocol`), ADR 31 (harness hierarchy), ADR 26/27 (everything-is-a-harness), ADR 33 (client + transports — JSON-RPC/native-JS wire), ADR 76 (operation middleware — its FiberRef tier-4 depends on this), ADR 49 (three planes). **Governing principle:** [[feedback_capability_not_opinion]], and: *the Effect fiber tree should span exactly one process — break only where the process breaks.*

## TL;DR

**All framework-internal operations carry one Effect fiber, threaded start-to-finish, through a single process.** Harness-to-harness calls *compose* Effects (`yield*`) instead of each running its own `runPromise` root. `runPromise` happens only at true edges: the public/wire API, and each node's inbound message handler. The fiber breaks **only** at process/node boundaries (cluster), where it is stitched by W3C trace context — never incidentally.

**Edges are native JavaScript** — `Promise`, plain objects, `AsyncIterable` — so non-Effect users need zero Effect knowledge. **And they are dual-typed**: Effect users get the composable Effect too, via a spike-validated form (below). The single-object "both an Effect and a Promise" is **impossible** (proven — it hard-crashes `runPromise`); the viable dual is a lazy thenable wrapper that carries the Effect as `.effect`, or explicit twins.

Telemetry, native `parentOpId` propagation, structured interruption, and ADR 76's middleware-context all **fall out** of the intact spine — they are not separate features. Telemetry was only ever a *symptom* of the broken tree.

## Problem — the fiber tree is broken at every harness boundary (verified)

`runHarnessProtocol` is a bare `Effect.runPromiseExit`, and **every** harness runs its operations through its *own* root. Worse, orchestration drops out of Effect entirely:

- The loop's operation body is `return Effect.tryPromise({ try: () => this.runExecutionAsync(input) })` (`loop-executor/harness.ts:149`) — and `runExecutionAsync` is ordinary `async/await` calling `executor.execute(...)`.
- The session invokes the loop the same way (`Effect.tryPromise(...)`, `session/harness.ts:497,612`).

So the "operation tree" is **~40 independent `runPromise` roots joined by `await`.** Consequences, all one root cause:

1. **Telemetry can't propagate.** Every operation emits an `Effect.withSpan` (`base-harness.ts:687`), but across separate roots there is no shared fiber/tracer context, so the spans run against the no-op tracer and never export. (ADR-pending telemetry work is downstream of this.)
2. **`parentOpId` is hand-threaded** at each `runOperation` call, precisely because FiberRef can't cross roots.
3. **Middleware-context (ADR 76 tier-4) can't work** — a FiberRef-carried request middleware can't reach a separate root.

## Null hypothesis (why the cheap fixes are wrong)

- *ALS.* Would carry a runtime across the Promise-joined roots. Rejected on the standing bar (targeted + purposeful + *meaningfully better than Effect*): it is **not** better than Effect — the Effect-native answer (intact tree) is strictly better; ALS only papers over a tree **we** broke. Masking debt, not beating Effect.
- *Thread a runtime through ~40 boundaries + every constructor (~80 edits).* Works within the broken-tree architecture, but is **throwaway** — once the tree is mended there is one root and the threaded runtime is dead weight. Investing in the wrong architecture.

Both symptom-patches lose to fixing the cause.

## Decision

### 1. Fiber-through-the-process

Internal harness-to-harness calls **compose** the callee's Effect into the caller's fiber (`yield* callee.op(input)`), not `tryPromise` across a fresh root. `runOperation` already *returns* an Effect; nested operations thus nest natively. `runPromise` is pushed to the true edges only.

### 2. Location transparency (local compose / remote message)

The callee reference is either a **local impl** or a **remote proxy**, both exposing the same Effect-returning internal protocol:

- **Local** → the proxy is `Effect.suspend(() => localImpl(input))` — composes into the caller's fiber. One tree.
- **Remote** → the proxy is `Effect.tryPromise(() => inbox.ask(address, msg))` — the fiber breaks **here**, at the node edge, which is correct (a fiber can't span processes). The two node-local trees are stitched by `traceparent` carried on the inbox message (the same W3C propagation the client already does, ADR 33/telemetry).

So the tree spans exactly one process and breaks exactly at node boundaries. Cluster is the *less-likely* path (the local fast path is the common, well-optimized one) but is designed-in, not bolted-on.

### 3. Dual-typed edges (native-JS primary, Effect twin) — spike-validated

Public/wire methods return **native JS** (`Promise` for one-shot, `AsyncIterable` for streams, plain objects for data). Effect users get the composable Effect too. **The form matters — the spike settled it:**

| Form | Result |
| --- | --- |
| One object that *is* an Effect **and** thenable | ❌ **Hard-crashes** `runPromise` — Promise-resolution *adopts* thenables and Effect's runtime re-enters `runPromise` infinitely (stack overflow, reproduced). |
| Promise-primary, eager `runPromise` + `.effect` accessor | ❌ **Double-executes** for Effect users (eager run + their `yield*` run) — a side-effect bug. |
| **Lazy wrapper: NOT an Effect; thenable that runs on `await`; carries the lazy Effect as `.effect`** | ✅ Single execution per consumer, `isEffect === false`, no crash. (v1 `ProcedurePromise` lineage.) |
| Explicit twins (`op()` → Promise, `opEffect()` → Effect) | ✅ Bulletproof, less ergonomic. |

**Decision:** the edge returns the **lazy-wrapper dual** by default — `await result` runs it (native path); `yield* result.effect` composes it (Effect path). **Contract:** Effect users compose via `.effect` and do **not** `await` (awaiting eagerly runs a separate root). The wrapper is **never** an Effect (must satisfy `isEffect === false`) — that invariant is what prevents the crash. Explicit twins remain the escape hatch where the wrapper's contract is too subtle.

### 4. Interruption + error channels (the semantics that *change*)

- **Interruption becomes structured.** With one tree, aborting a request interrupts all nested operations natively (Effect fibers). This is *better* than today's ad-hoc `loop.abort`, but it is a **behavior change** — code that assumed a nested op couldn't be interrupted must be audited. Explicitly tested.
- **Error channels compose.** Each root normalizes errors today; composed, the typed `E` channels must line up across harnesses (leans on the `AgentickError` `_tag`/`catchTag` discipline, [[feedback_effect_catchtag_abstract_class]]). Typecheck catches mismatches; the migration threads `E` deliberately.

## What falls out (not separate features)

- **Telemetry:** one `Effect.provide(tracerLayer)` at the edge → every `withSpan` nests and exports natively. `createApp({ telemetry })` becomes real.
- **`parentOpId`:** propagates via FiberRef — **delete** the manual threading on the spine.
- **Middleware tier-4 (ADR 76):** FiberRef call-scoped middleware works, on the same intact tree.

## How we don't break things (non-negotiable safeguards)

The confidence is *earned by method*, not assumed:

1. **Dual-path coexistence.** The Effect path is added *alongside* the Promise path; nothing is deleted until its replacement is green. **Every commit ships a working system.**
2. **Characterization tests before the loop rewrite.** Pin the loop's current behavior (continuation, retries, tool orchestration, abort) so the `Effect.gen` version is *provably* behavior-preserving.
3. **Spine-first, one boundary at a time, behind the full gate** (workspace `tsc` + full suite green before the next boundary).
4. **Edge contract frozen.** Public signatures stay native-JS throughout; the Effect twin is additive → nothing external breaks by construction.
5. **Interruption + error-channel get explicit tests** — the two semantics that actually change.

## Staged plan

- **S1 — mend the spine.** session → loop → executor → tool-executor compose Effects locally; `runPromise` moves to the session/app edge. Leaf harnesses (knobs/state) keep local roots for now (graceful partial). *The loop `Effect.gen` rewrite is the crux — characterization tests first.*
- **S2 — tracer at the edge.** Spine spans nest + export; delete manual `parentOpId` on the spine. **Telemetry lands here.**
- **S3 — cluster (deferred).** Remote-proxy Effect + `traceparent` on inbox messages. Design now, build when clustering is real.
- **S4 — leaves (later).** Convert knobs/state/etc. if/when their spans matter.

## Rejected alternatives

- **ALS runtime propagation** — masks the broken tree; fails the "better than Effect" bar.
- **~80-edit runtime threading** — throwaway once the tree is mended.
- **Thenable-Effect single-object dual** — spike-proven `runPromise` crash.
- **Promise-eager + `.effect`** — double-executes side-effecting operations.
- **Big-bang all-harnesses conversion** — drops migration confidence from high to moderate; the whole point is incremental dual-path.

## Confidence

- **Design correctness:** HIGH.
- **Edge = native-JS, contract unchanged → nothing external breaks:** HIGH.
- **Dual-typed edge (lazy-wrapper form):** HIGH — spike-validated single-execution, no crash.
- **Migration doesn't break things:** HIGH *with* the safeguards above; MODERATE if rushed/big-banged. The loop `Effect.gen` rewrite is the concentrated risk; interruption semantics change for the better and need explicit tests.

## Open questions

1. **Dual form per surface.** Lazy-wrapper everywhere, or explicit twins for the subtle cases (streaming `AsyncIterable` + Effect `Stream`)? Lean: lazy-wrapper for one-shot; a `Stream`/`AsyncIterable` twin for streams (the thenable trick doesn't apply to iterables).
2. **Spine extent.** Does S1 stop at tool-executor, or also pull in reconciler/timeline immediately? Lean: stop at the execution spine; add others per-need.
3. **Interruption contract.** Exact semantics when a composed sub-operation is interrupted mid-flight (partial state applied?) — pin during S1 with tests.
4. **`runHarnessProtocol` fate.** Becomes the edge-only runner (with the tracer-provide), or is inlined at each edge? Lean: keep it as the single edge runner, now Layer-aware.

## References

- `packages-next/runtime/src/substrate/base-harness.ts` — `runOperation` (returns Effect), `runHarnessProtocol` (`:1543`), `Effect.withSpan` (`:687`).
- `packages-next/loop-executor/src/harness.ts:149` — the `tryPromise` → plain-async drop-out (the crux to undo).
- `docs/proposals/v2/blueprint/76-operation-middleware-scoping.md` — tier-4 FiberRef middleware, unblocked by this.
- Spike (2026-07-10, not committed): thenable-Effect → `runPromise` stack overflow; lazy-wrapper → single-execution dual. Findings inlined in §3.
