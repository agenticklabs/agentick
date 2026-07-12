# Spine-compose plan (ADR 77 + ADR 79 — "A")

Staged, gated build to compose the session operation spine into one fiber tree
(structured concurrency + free nested telemetry), with `runPromise` only at the
entity edge. **The edge contract stays frozen** (`session.send()` remains
`Promise`-returning) → gateway/client/wire/examples untouched.

**Rules:** dual-path coexistence (keep the Promise path until the Effect path is
proven) · one boundary at a time · every box lands **workspace `tsc` green + full
suite green** before the next · leaf-up order (a harness's `.fx` exists before its
consumer composes it).

---

## Gate 0 — Characterization completeness (BLOCKS every rewrite below)

**✅ CLOSED.** The loop rewrite's net is comprehensive.
`packages-next/loop-executor/src/__tests__/characterization.spec.ts` — **28 tests**.

- [x] **Executor-failure paths** — `failed`→`executor_failed`, `canceled`→`aborted`,
      `vetoed`→`vetoed` (incl. fail-on-Nth-tick). *(Via the improved fake's scripted `outcome`.)*
- [x] **Streaming vs non-streaming** — gating; streaming forwards deltas; non-streaming
      synthesizes; **streaming `.result`-reject → `executor_failed`**.
- [x] **Tool-dispatch outcomes** — soft error (`isError`), hard throw (caught, `error`
      captured), `applyToolResults` skipped when 0, **provider-side tool_result not dispatched**.
- [x] **Usage accumulation** — summed across ticks; terminal = sum.
- [x] **Event sequence** — run-level bookends + tool-dispatch order.
- [x] **maxTicks cap** — `max_ticks` stop.

**Mitigations baked in (design, not just boxes):**
- [x] **Differential seam** — `runChar(makeLoop?)`; the SAME scenarios run against the
      future `Effect.gen` loop → validate the rewrite by *diffing traces*, not hoping.
- [x] **Invariant assertions** — `assertLoopInvariants` (bounds, defined outcome,
      monotone usage, no-dangling) → catches whole *classes* of drift.

**Gate:** ✅ met. The loop is now safe to compose (Stage 3).

---

## Stage 1 — `.fx` surface (additive, behavior-neutral)

- [x] **`BaseHarness.fxProxy()`** — a `Proxy` exposing each declared command's composable
      Effect under its ergonomic action name (`fx.<action>` → `commandEffect(<surface>:<action>)`),
      auto-derived from the naming convention. Returns the Effect (not a Promise); the plain
      `harness.<action>()` stays the edge facade. *(The runtime already existed as
      `commandEffect` — timeline's `drain` composes over it; `.fx` is the sugar.)* Proven in
      `base-harness.spec` (fx.add composes; plain method is a Promise; fx twins nest in one gen).
- [x] **Per-harness typed `get fx()`** over `fxProxy()` — **knobs is the reference harness**.
      `KnobsFx` (spec) declares the Effect twins; `get fx(): KnobsFx { return this.fxProxy() as
      unknown as KnobsFx; }`. The typed getter (over an index-signature base) sidesteps the
      getter-override/contravariance friction. Proven in `knobs/fx-surface.spec`.
- [x] **`PromiseView<T>`** mapped type (spec) — homomorphic; rewrites each Effect-returning method
      to its awaited Promise form, drops `E`/`Ctx`. **Effect is canonical, Promise derived** — the
      erasure runs one way only (can't recover `E`), so there is no `EffectView` inverse. Knobs'
      protocol async surface is now `PromiseView<KnobsFx>` — single source of truth. Type-level dual
      of utils' `liftToEffect` (runtime boundary bridge).

**Gate:** ✅ met — workspace `tsc` 145/145; knobs 63/63; zero behavior change (nothing composes yet).

**Stage 1 ✅ CLOSED** (`33c08e80`). The `.fx` pattern is proven end-to-end on the reference
harness: runtime (`fxProxy`/`commandEffect`), typing (`KnobsFx` + `PromiseView`), and the
edge-facade derivation. Stage 2 replicates the twin onto the spine protocols.

## Stage 2 — Effect-returning spine protocols (additive)

- [ ] `spec-next`: Effect twins for `LoopExecutorProtocol`, executor,
      tool-executor, reconciler, `StateApplicator`, session.
- [ ] Each spine harness implements its `.fx` twin (the `run` Effect it already builds).

**Gate:** green; still no composition.

## Stage 3 — Compose the spine, leaf-up (each behind dual-path + green gate)

- [ ] **Executor** composes; the model HTTP call stays `Effect.tryPromise(adapter.execute)`
      (external I/O — a legit Promise boundary).
- [ ] **Tool-executor** composes; the user tool handler stays `Effect.tryPromise(handler)`.
- [ ] **Reconciler** composes; the react-reconciler render stays `Effect.tryPromise`.
- [ ] **Loop `Effect.gen` rewrite (THE CRUX)** — `runExecutionAsync` → generator,
      `yield* executor.fx.run(...)` etc. **Characterization suite stays green UNCHANGED.**
      Interruption + error-channel behavior explicitly re-tested.
- [ ] **Session** — `send` composes `yield* loop.fx.runExecution`; `runPromise` once
      at the entity edge on the tracer runtime.

**Gate per box:** workspace green + full suite + characterization unchanged.

## Stage 4 — Telemetry falls out

- [ ] Extend the tracer `ManagedRuntime` from app-edge to **session edge**
      (one injection per entity, not per harness — supersedes ADR 78 brick #2).
- [ ] Delete manual `parentOpId` threading on the spine (FiberRef propagates).
- [ ] Whitelabel namespace read from fiber context (reaches every spine span).
- [ ] **Verify end-to-end:** a `session.send` under a collecting tracer produces a
      **nested** trace tree (session > tick > model-call + tool spans).

## Stage 5 — Enhancements unlocked (opt-in, post-compose)

Not required to land the spine; enabled by it. Each is its own decision:

- [ ] Structured cancellation (abort → clean teardown of in-flight model/tool work).
- [ ] `Effect.timeout` on runs / sub-ops.
- [ ] Middleware tier-4 (ADR 76 FiberRef call-scoped) across the composed spine.
- [ ] Bounded-concurrent tool dispatch (`Effect.all` w/ concurrency + interruption).
- [ ] `.fx` documented as the adopter-facing Effect surface (Effect-native composability).

## Stage 6 — Cleanup

- [ ] Remove dead Promise paths once the Effect path is proven.
- [ ] READMEs / ARCHITECTURE docs updated; `.fx` + edge-facade documented.

---

**Cross-refs:** ADR 77 (spine + `.fx` + dual edge), ADR 79 (granularity: session =
co-located entity; cluster = bus/inbox), ADR 78 (brick #1 edge runtime + whitelabel
namespace — kept; brick #2 superseded), ADR 33 (wire = JSON-RPC 2.0, edge frozen).

**Safe first move:** Gate 0 (characterization completeness) — low-risk, unblocks the crux.
