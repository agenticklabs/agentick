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

- [x] **Executor `.fx.run`** (`33836abb`) — first spine harness. Unlike knobs, spine ops aren't
      registry commands (they build their Operation inline), so `.fx` is NOT `fxProxy`-derived; the
      harness hand-exposes the `runOperation(op, body)` Effect its `run` already builds. Uniform
      contract stays the typed seam (`get fx()` + `PromiseView`); only the impl behind it differs.
- [x] **Streaming edge de-risked + made singular** (`d2525696`) — the DUAL of the Promise edge:
      - `AsyncStream<Item, Result>` (spec) — the streaming facade type, dual of `Promise<A>`.
      - `runHarnessStream` (runtime) — the bridge, sibling of `runHarnessProtocol`. All the
        Queue/fork/Promise machinery lives here ONCE; each streaming edge supplies only its
        sink-fold `build` + policy hooks. Executor's `executeStream` facade rewritten over it
        (~120 lines → the reused bridge); the 8 backpressure/cancellation tests stay green.
      - `ExecutorFx.executeStream(input, sink): Effect<TOutput, E>` — the canonical sink-fold twin.
        The ONE exception to `PromiseView`: its facade differs in arity (`(input): AsyncStream`),
        so hand-declared on both surfaces — they share the bridge, not a mapped type.
      - **Finding:** the Effect-native streaming side is *simpler* than the facade — the loop
        composes `yield* executor.fx.executeStream(input, sink)` in one fiber, no queue. Machinery
        exists only to bridge one Effect stream into JS's two-consumer shape.
- [ ] **Remaining executor twins** — `project` / `execute` / `normalize` / `abort` into `ExecutorFx`
      (loud `TODO(stage-2)` on the harness). Migrate the protocol's inline Promise methods to
      `PromiseView<Pick<ExecutorFx, …>>` wholesale once the full surface has twins.
- [x] **Loop `.fx.runExecution`** (`5f3449fe`) — the crux harness, same clean extraction.
      `LoopExecutorFx` twin; protocol's `runExecution` derives from `PromiseView`; harness splits
      `runExecutionFx` (Effect) + facade. Internal tick body stays Promise-shaped — the `Effect.gen`
      rewrite is Stage 3, gated by the 28-test characterization diff (still green, unchanged).
- [x] **Reconciler `.fx.renderTree`** (`25467540`) — both impls (CallbackReconciler + the React
      ReconcilerHarness). E channel = the reconciler taxonomy; tightened the react catch to map
      throws → `RenderFailed` (behavior-preserving; 216 tests green).
- [x] **`readonly fx` HOISTED onto the four spine protocols** (`c27f4235`) — THE Stage 2→3 bridge.
      The loop holds protocol-typed refs (`RunExecutionInput.executor/.reconciler/.toolExecutor`),
      so `yield* input.executor.fx.run(...)` requires `fx` on the PROTOCOL, not just the concrete
      class. Every impl + double now provides it — notably `FakeLanguageModelExecutor` gained
      `fx.run` + a sink-fold `fx.executeStream`; structural test doubles gained `fx` sharing the
      facade's logic (recording executors record on the fx path too). **"internal calls go through
      .fx" now typechecks.** Workspace 145/145; 1146 tests green.
- [x] **Tool-executor `.fx.dispatch`** (`4f269ea1`) — where the two `.fx` mechanisms meet.
      `dispatch` IS a registry command, so it COULD be `fxProxy`-derived — but the facade maps the
      door → origin (`viaToOrigin`), which `fxProxy`'s default `"host"` would drop. So the twin
      hand-authors over `commandEffect`. **Sharpened rule: `fxProxy` is sugar only for BARE command
      passthroughs (knobs); a facade with logic on top hand-authors.** Both impls (harness +
      `defineToolExecutor`) done; proof asserts door→origin is preserved through the twin.
- [ ] **`StateApplicator` + session twins** — the loop also calls `stateApplicator.apply*` and the
      session's `send`. `StateApplicator` is a structural `Pick` of session apply-methods; its fx
      twins + the session's own come last. Then Stage 3 rewires the loop body to `yield*` the twins.

**Core spine is composable.** executor / loop / tool-executor / reconciler all expose `fx` on their
protocols — the loop can now compose `input.<dep>.fx.<op>()` in-fiber. `StateApplicator`/session are
the last twins before the Stage 3 `Effect.gen` loop rewrite.

**The `.fx` mechanism decision tree (settled):**
- Op is a BARE command passthrough (facade == `commandEffect`, no extra logic) → `fxProxy` sugar (knobs).
- Op is a command but the facade adds logic (door→origin, etc.) → hand-author over `commandEffect` (tool-executor).
- Op is NOT a command (builds its Operation inline) → hand-author over `runOperation` (executor, loop).
- Op's facade is a non-Promise shape (streaming) → hand-author + a bespoke edge bridge (`runHarnessStream`).
- ALL sit behind the uniform typed `get fx(): XFx` seam.

**Deferred design fork (recorded, not urgent):** streaming canonical form is the **sink-fold**
(`(input, sink) => Effect<Result>`), chosen because it fits `runOperation`'s discrete
request→terminal model with zero new substrate machinery. A `Stream<Item, E>`-returning canonical
(more composable — throttle/merge) would need broadcast-sharing to also yield the result + a
streaming-scoped operation primitive. Revisit only if a consumer needs Stream combinators the loop
doesn't.

**Gate:** ✅ met for executor — workspace 145/145; executor 50/50 (incl. 8 streaming); runtime 189/189.

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
