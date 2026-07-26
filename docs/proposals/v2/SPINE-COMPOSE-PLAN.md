# Spine-compose plan (ADR 77 + ADR 79 — "A")

> **STATUS — LANDED (Stages 0–6).** The session spine is one Effect fiber; telemetry
> nests; abort does structured teardown of in-flight work; tool calls dispatch in
> parallel; execution timeout is opt-in; `.fx` + the edge-facade are documented as
> first-class public surfaces. Deferred (own designs, not spine-compose): the
> whole-spine whitelabel namespace (`TODO(stage-4: fiber-context-namespace)`) and
> ADR 76 middleware tier-4. Every box below landed workspace `tsc` 145/145 + full
> suite green + the 28-test characterization diff byte-identical.

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
      `vetoed`→`vetoed` (incl. fail-on-Nth-tick). _(Via the improved fake's scripted `outcome`.)_
- [x] **Streaming vs non-streaming** — gating; streaming forwards deltas; non-streaming
      synthesizes; **streaming `.result`-reject → `executor_failed`**.
- [x] **Tool-dispatch outcomes** — soft error (`isError`), hard throw (caught, `error`
      captured), `applyToolResults` skipped when 0, **provider-side tool_result not dispatched**.
- [x] **Usage accumulation** — summed across ticks; terminal = sum.
- [x] **Event sequence** — run-level bookends + tool-dispatch order.
- [x] **maxTicks cap** — `max_ticks` stop.

**Mitigations baked in (design, not just boxes):**

- [x] **Differential seam** — `runChar(makeLoop?)`; the SAME scenarios run against the
      future `Effect.gen` loop → validate the rewrite by _diffing traces_, not hoping.
- [x] **Invariant assertions** — `assertLoopInvariants` (bounds, defined outcome,
      monotone usage, no-dangling) → catches whole _classes_ of drift.

**Gate:** ✅ met. The loop is now safe to compose (Stage 3).

---

## Stage 1 — `.fx` surface (additive, behavior-neutral)

- [x] **`BaseHarness.fxProxy()`** — a `Proxy` exposing each declared command's composable
      Effect under its ergonomic action name (`fx.<action>` → `commandEffect(<surface>:<action>)`),
      auto-derived from the naming convention. Returns the Effect (not a Promise); the plain
      `harness.<action>()` stays the edge facade. _(The runtime already existed as
      `commandEffect` — timeline's `drain` composes over it; `.fx` is the sugar.)_ Proven in
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
- [x] **Streaming edge de-risked + made singular** (`d2525696`) — the DUAL of the Promise edge: - `AsyncStream<Item, Result>` (spec) — the streaming facade type, dual of `Promise<A>`. - `runHarnessStream` (runtime) — the bridge, sibling of `runHarnessProtocol`. All the
      Queue/fork/Promise machinery lives here ONCE; each streaming edge supplies only its
      sink-fold `build` + policy hooks. Executor's `executeStream` facade rewritten over it
      (~120 lines → the reused bridge); the 8 backpressure/cancellation tests stay green. - `ExecutorFx.executeStream(input, sink): Effect<TOutput, E>` — the canonical sink-fold twin.
      The ONE exception to `PromiseView`: its facade differs in arity (`(input): AsyncStream`),
      so hand-declared on both surfaces — they share the bridge, not a mapped type. - **Finding:** the Effect-native streaming side is _simpler_ than the facade — the loop
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
      The loop holds protocol-typed refs (`RunExecutionInput.modelExecutor/.reconciler/.toolExecutor`),
      so `yield* input.modelExecutor.fx.run(...)` requires `fx` on the PROTOCOL, not just the concrete
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

**DISCOVERY (2026-07-12, verified against the code before starting):** the Stage-2
close-out ("remaining twins: StateApplicator + session") **undercounted**. Tracing every
downstream call in `runExecutionAsync` against the `.fx` surface that actually exists,
**4 of ~11 internal harness calls are twinned** (`renderTree`, `run`, `executeStream`,
`dispatch`). A clean `Effect.gen` loop — one that composes with **zero internal
`tryPromise` islands** (wrapping an internal harness call in `tryPromise` re-launches its
own `runPromise` root via the facade, re-severing the fiber at exactly the boundary Stage 3
mends: span detaches, interrupt doesn't reach it) — needs these **7 more twins first**:

| Twin needed              | Harness         | Loop call site                                               | Why (path)                                                      |
| ------------------------ | --------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `project`                | executor        | streaming path                                               | project → executeStream → normalize is split on the stream path |
| `normalize`              | executor        | streaming path                                               | ″                                                               |
| `compileForTick`         | tool-executor   | every tick                                                   | precedence-resolved model tool set                              |
| `replaceReconcilerTools` | tool-executor   | every tick                                                   | sync IR tool decls into the registry                            |
| `notifyLifecycle`        | reconciler      | 2 awaited (tick-start/tick-end bridges) + ~4 fire-and-forget | ADR 67 settle-before-decide ordering rides the two awaited ones |
| `applyExecutorResult`    | StateApplicator | per tick                                                     | writes the timeline the next render reads                       |
| `applyToolResults`       | StateApplicator | per tick                                                     | ″                                                               |

`tryPromise` survives ONLY at the two genuine external-I/O boundaries — `adapter.execute`
(inside the executor) and the user tool handler (inside tool-executor). `notifyTickEnd` is a
**session-provided callback** (not a harness method); it stays a Promise callback wrapped in
`tryPromise` as an interim until the session twin lands (its Effect variant is session-twin
territory). Fire-and-forget `void notifyLifecycle` stays detached (hook throws must not fail
the run — telemetry nesting is low-value there); only the two _awaited_ lifecycle bridges twin.

**Corrected order (twin-completion is the low-risk additive tranche; the loop rewrite is the crux):**

- [x] **executor `project` + `normalize`** twins (`f63a7ff9`; unblocks the stream path).
- [x] **tool-executor `compileForTick` + `replaceReconcilerTools`** twins. Refined finding:
      `replaceReconcilerTools` is `runOperation`-backed (journaled span) → genuine twin, facade
      `PromiseView`-derived; the registry's plain-`Error` binding-mismatch throw now maps to a
      typed `ToolValidationError` on the `E` channel (catchable, per the pre-existing intent).
      `compileForTick`/`list` are PURE reads that bypass `runOperation` — no span, so calling them
      via `Effect.promise` would NOT sever the fiber; `compileForTick` still gets an `Effect.sync`
      twin for loop uniformity, but its facade stays bare `async` (no `runHarnessProtocol` on the
      hot per-tick path). `list` needs no twin (loop never calls it). Both impls (harness +
      `defineToolExecutor`) done; +4 proofs incl. binding-mismatch → catchable failure.
- [x] **reconciler `notifyLifecycle`** — **NULL HYPOTHESIS HELD: no twin needed.** Verified both impls
      (CallbackReconciler → spec callback; React ReconcilerHarness → `state.lifecycle.dispatch`) are
      bare `async` passthroughs — NOT `runOperation`/`runHarnessProtocol`-backed, no span, no
      `runPromise` root inside. So the loop composes them fiber-clean via `Effect.promise` (the 2
      awaited bridges) / detached `void` (the ~4 fire-and-forget) with NO severing and NO lost span.
      A dedicated twin would be surface-uniformity theater. The session's own `notifyLifecycle`
      (= the tick-end `notifyTickEnd` decision) is likewise bare async → stays a callback via
      `Effect.promise`. **The real twin criterion is sharpened: twin iff `runHarnessProtocol`-backed
      (launches a `runPromise` root).**
- [x] **`StateApplicator` fx** (`applyExecutorResult` + `applyToolResults`) — GENUINE: the session's
      impls ARE `runHarnessProtocol`-backed (would sever + drop the write's exit-normalization).
      `StateApplicatorFx` added to spec; the two apply facades derive via `PromiseView`; `appendEntry`
      needs no twin (loop never calls it). Session extracts `applyExecutorResultFx`/`applyToolResultsFx` + wires the loop-facing adapter's `fx` (`Effect.asVoid` drops `ApplyResult` → the loop's `void`).
      `NoopStateApplicator` + recording doubles gain `fx` recording on BOTH edges so the
      characterization diff holds byte-identical when the loop switches facade→fx in step 5. +3 proofs.
      **Twin surface now COMPLETE — every `runHarnessProtocol`-backed spine call the loop makes has a
      composable twin.**
- [x] **Loop `Effect.gen` rewrite (THE CRUX)** — DONE. `runExecutionAsync` (Promise-chained) →
      one `Effect.gen` fiber; `runExecutionBody` composes every downstream call via its `.fx` twin
      (`yield* reconciler.fx.renderTree`, `executor.fx.{project,run,executeStream,normalize}`,
      `toolExecutor.fx.{replaceReconcilerTools,compileForTick,dispatch}`, `stateApplicator.fx
    .apply*`). **Zero internal `tryPromise` islands.** The imperative control flow (while/break/
      accumulate) is UNCHANGED — `Effect.gen` preserves it; only `await facade()` → `yield* fx()`.
      The two locally-handled failures (streaming `.result` reject, hard tool throw) are caught
      in-body via `Effect.either`; everything else folds to `ExecutionError` via a boundary
      `Effect.catchAll`; `finally` → `Effect.ensuring`. Bridge notifications (`notifyLifecycle`/
      `notifyTickEnd`, no span, bare async) awaited in-fiber via `awaitBridge` (a bare
      `Effect.tryPromise` — NOT a severing root) or fire-and-forget. **Characterization 28
      byte-identical green** on the first diff; loop-executor 50 green; workspace 145/145; full
      packages-next suite green. - **KEY FINDING (surfaced by session integration, exactly as intended):** overriding/patching
      an executor's PUBLIC facade (`run`/`executeStream`/`project`) does NOT intercept the `.fx`
      twin — both derive from the same private impl, but a facade override doesn't touch it. So the
      moment internal composition moved facade→fx, two test doubles that intercepted the facade
      (the kill-resume `SpyLanguageModelExecutor`, the steering monkey-patch) went silently inert.
      Fixed by intercepting at the fx edge. This is the correct architecture (adopters decorate at
      the adapter/runner layer, not by overriding executor facades — ADR 52 killed the subclass
      tier) — but it's a real contract the fx surface now enforces.
- [x] **Session** — DONE. `send` runs the COMPOSED loop (`loop.fx.runExecution`, one fiber) on the
      telemetry runtime. The facade `loop.runExecution` IS `runHarnessProtocol(loop.fx
    .runExecution(...))` on the DEFAULT runtime; the session now calls `runHarnessProtocol(loop.fx
    .runExecution(...), this.telemetryRuntime)` — a one-line swap that routes the whole execution's
      span tree to the adopter's tracer. `undefined` runtime → default → behavior-preserving.
      `notifyTickEnd` stays a session callback (awaited in-fiber via `awaitBridge` in the loop — no
      separate Effect variant needed; the loop rewrite already handles it). NOTE: the loop runs
      BACKGROUNDED (send returns the handle before it finishes), so it is its own root fiber on the
      tracer runtime, NOT a `yield*` child of send — but because the loop is one fiber, its execution
      span is the trace root and everything nests under it.

**Gate per box:** workspace green + full suite + characterization unchanged.

## Stage 4 — Telemetry falls out

**THE PAYOFF LANDED.** The Stage-3 crux did the hard part; Stage 4 was a ~1-line
routing change + forwarding the runtime. Findings (verified by the telemetry map):
most of the plumbing already existed — `runHarnessProtocol(eff, runtime?)` already
takes the runtime, spans already emit via `Effect.withSpan` in `runOperation`, and
`parentOpId` already auto-threads via the `RuntimeContextRef` FiberRef.

- [x] **Extend the tracer runtime from app-edge to session edge.** `SessionHarnessOptions` gains
      `telemetryRuntime?` + `telemetryNamespace?`; the AppHarness forwards its app-scoped
      `ManagedRuntime` (+ namespace) at session construction. `send` runs the composed loop via
      `runHarnessProtocol(loop.fx.runExecution(...), this.telemetryRuntime)` — the whole execution's
      `Effect.withSpan` tree reaches the adopter's tracer.
- [x] **Manual `parentOpId` threading — ALREADY GONE on the spine.** `runOperation` auto-sets
      `parentOpId` from the ambient FiberRef (`getContext.opId`) for same-fiber nested ops. The
      Stage-3 crux (loop = one fiber) means every downstream op inherits the execution's opId
      automatically. The only residual manual threading is the cross-fiber INBOX seam, which FiberRef
      fundamentally cannot cross — correct to keep. Nothing to delete.
- [ ] **Whitelabel namespace across the spine — FOLLOW-UP (not the payoff).** Deferred: the namespace
      is currently PER-HARNESS (`this.telemetryNamespace` in `spanAttributes`), set at each harness's
      construction — and the spine harness constructors (loop/executor/tool/reconciler) don't even
      accept it, so a whole-spine whitelabel needs the namespace read from FIBER CONTEXT (ADR 78 brick
      #2) rather than per-harness fields. Orthogonal to nesting; its own small change. `TODO(stage-4:
    fiber-context-namespace)`.
- [x] **Verify end-to-end — DONE.** `session/__tests__/telemetry.spec.ts`: a `session.send` under a
      collecting tracer produces a **nested** trace tree — `loop:command:run-execution` (root) >
      `{executor:command:project/normalize/run, reconciler:command:render-tree, tool:command:*}`,
      every child's `parent_op_id` == the execution's `op_id` AND Effect's own span-parent agrees.
      Path-agnostic (streaming or non-streaming). + a no-telemetry-runtime behavior-preserving case.

## Stage 5 — Enhancements unlocked (opt-in, post-compose)

Not required to land the spine; enabled by it. Each is its own decision:

- [x] **Structured cancellation** — DONE. `loop.abort()` now tears down IN-FLIGHT model/tool work
      immediately, not at the next tick boundary. A per-execution `AbortController` (fired by
      `abort()`) is merged with the caller's `input.signal` into one `execSignal` threaded to
      `executor.fx.run`/`executeStream` + `toolExecutor.fx.dispatch`. The executor turns the signal
      into REAL Effect fiber interruption of the provider call (`withExternalAbort` + `tryPromise`
      fiber signal); the tool executor honors `DispatchInput.signal` on the handler. **Design choice:
      signal-forwarding, NOT raw fiber-interrupt of the whole loop** — it PRESERVES the accumulator
      (partial output/usage up to the abort → a canceled terminal that still carries what was
      generated) and keeps the 28-test char behavior byte-identical; interrupting the loop fiber
      would discard partial results and diverge from the net. Propagates to the public edge:
      `session.send(...).abort()` → `loop.abort()` → structured teardown. Proof:
      `loop-executor/__tests__/cancellation.spec.ts` — a HANGING executor/tool aborted mid-flight
      settles a canceled terminal promptly (would time out if the signal didn't reach it). char 28 +
      loop 50 + executor/session/app green (575); workspace 145/145.
- [x] **Bounded-concurrent tool dispatch** — DONE. A tick's tool calls dispatch CONCURRENTLY via
      `Effect.all` (`input.toolConcurrency` / `SendInput.toolConcurrency`, **default `"unbounded"`**;
      a number caps in-flight, `1` = sequential opt-out). `Effect.all` keeps results in CALL-ORDER
      regardless of concurrency (deterministic persistence + next-tick model view); only the per-tool
      lifecycle EVENTS interleave. Interruption falls out — each dispatch carries `execSignal` and
      `Effect.all` propagates interrupt to its children, so abort/timeout tears down all in-flight
      tool fibers. Proof: `cancellation.spec.ts` — a RENDEZVOUS test (tool A awaits a gate tool B
      opens; sequential would deadlock, parallel completes) + call-order assertion + a
      `toolConcurrency: 1` sequential opt-out.
- [x] **`Effect.timeout` (execution timeout)** — DONE, opt-in. `input.timeoutMs` / `SendInput
    .timeoutMs`, **NO default** (mechanism not policy). A per-execution timer fires the SAME
      structured-abort path (controller + aborted map) so in-flight work tears down; the terminal
      lands `canceled` with `stopReason: "timeout"` (new stop reason, threaded through
      `ExecutionRunResult` + `SendResult`). Timer cleared on every exit via `Effect.ensuring`. Proof
      in `cancellation.spec.ts`.
- [x] **`.fx` documented as a first-class public surface** — DONE (Stage 6 docs). BOTH the Promise
      edge-facade AND the `.fx` Effect-native twin are documented as first-class public API — the
      facade the ergonomic default, `.fx` the peer for adopters composing Effects (NOT a second-class
      escape hatch). See the loop-executor README "The fiber spine" section.
- [ ] Middleware tier-4 (ADR 76 FiberRef call-scoped) — DEFERRED. Out of the spine-compose scope; it
      is its own ADR 76 design (call-scoped `Context.Reference`+`provide`), not a "finish-off" item.

## Stage 6 — Cleanup

- [x] **Dead Promise paths — CHECKED, none to remove (finding).** The facades (`loop.runExecution`,
      `executor.run`, …) are the FROZEN public entity edge (`LoopExecutorProtocol` etc.) — the session
      uses `.fx` internally now, but the facade remains the public contract + is exercised by
      conformance/tests. Grep confirmed `loop.runExecution` has zero non-test production callers, yet
      it's not "dead" — it's the public API. The dual surface is the intended end state, not a
      migration artifact. Nothing removed.
- [x] **READMEs / ARCHITECTURE — `.fx` + edge-facade documented.** loop-executor README gains a "The
      fiber spine — `.fx` and the edge-facade (ADR 77)" section (dual public surface + the three
      fall-out capabilities: nested telemetry, structured cancellation, parallel tools, timeout) +
      Status + Verified-by rows + the ADR 77 / SPINE-COMPOSE-PLAN cross-refs.

---

**Cross-refs:** ADR 77 (spine + `.fx` + dual edge), ADR 79 (granularity: session =
co-located entity; cluster = bus/inbox), ADR 78 (brick #1 edge runtime + whitelabel
namespace — kept; brick #2 superseded), ADR 33 (wire = JSON-RPC 2.0, edge frozen).

**Safe first move:** Gate 0 (characterization completeness) — low-risk, unblocks the crux.
