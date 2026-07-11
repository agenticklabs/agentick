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

The loop rewrite is the crux; its net must be comprehensive first. These are pure
*observation* of current behavior — low-risk, touch nothing load-bearing.
`packages-next/loop-executor/src/__tests__/characterization.spec.ts` (13 tests
landed) extends with:

- [ ] **Executor-failure paths** — `failed`→`executor_failed`, `canceled`→`aborted`,
      `vetoed`→`vetoed`; streaming `stream.result` reject → failed terminal.
- [ ] **Streaming vs non-streaming** — `wantsStreaming` gating; streaming forwards
      deltas + **no** synthesis; non-streaming synthesizes content/tool-call/message-end.
- [ ] **Tool-dispatch outcomes** — soft error (`isError:true`→`succeeded:false`);
      hard throw → caught, `error` set, `isError` event; provider-side tools
      (tool_result in output, not in `toolCalls`) **not** dispatched.
- [ ] **Usage accumulation** — summed across ticks; terminal usage = sum.
- [ ] **Event sequence** — execution-start/tick-start/tick-end/tick/execution-end +
      tool-dispatch-{start,end,result} order.
- [ ] **`applyToolResults` skipped when 0 results** (negative case).
- [ ] **maxTicks post-loop normalization** (the line-654 path).

**Gate:** the suite pins every branch the `Effect.gen` rewrite touches. Until then,
no compose work on the loop.

---

## Stage 1 — `.fx` surface (additive, behavior-neutral)

- [ ] `BaseHarness.command()` exposes the operation Effect (`run`) as `harness.fx.<name>`;
      the existing Promise wrapper stays as `harness.<name>` (`runPromise(fx)`).
- [ ] `.fx` = a `Proxy` over the command registry's Effect side.
- [ ] `PromiseView<Protocol>` mapped type (Effect canonical → Promise derived).
- [ ] Typing: `E`-channel preserved on `.fx`; `.fx` and the plain surface both infer.

**Gate:** workspace green; zero behavior change (nothing composes yet).

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
