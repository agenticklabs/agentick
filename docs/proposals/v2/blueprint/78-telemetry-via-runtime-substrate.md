# ADR 78 — Telemetry via runtime-as-substrate (B), not a spine-mend (A)

**Status:** DRAFT 2026-07-10 — **A-vs-B resolution SUPERSEDED by ADR 79** (the cluster-orthogonality dig showed composing the spine does *not* hurt clustering, so A-on-the-spine wins; ADR 79 pins the distribution granularity that makes it safe). **Retained from this ADR:** brick #1 (the app-edge `ManagedRuntime`, built + committed) and the whitelabel `telemetryNamespace` (committed) — both valid under ADR 79. **Superseded:** brick #2 (per-harness runtime threading) — unnecessary once the spine composes to one root. **Supersedes the open question in** ADR 77 (the operation-spine A-vs-B fork). **Builds on:** ADR 31 (substrate threading), ADR 49 (planes), ADR 77 (why the fiber tree breaks at harness boundaries). **Governing principle:** [[feedback_capability_not_opinion]], and: *cross-harness context propagates explicitly — the same way local and clustered.*

## Decision

**Harnesses stay independent units. We do NOT mend one fiber tree across harness boundaries (ADR 77 Option A).** Instead:

- **The runtime is app/node-scoped substrate.** The app builds one `ManagedRuntime` from the `telemetry` Layer and threads it to harnesses like `bus`/`inbox`/`journal`. Each harness runs its own roots on it — `runtime.runPromise(eff)` — so every `Effect.withSpan` sees the configured tracer and exports.
- **Span nesting is explicit propagation** — carried on the op scope alongside `parentOpId`, and applied as `Effect.withSpan(name, { parent: op.scope.spanContext, attributes })`. This is *identical* to how traces stitch across nodes (W3C `traceparent` → `ExternalSpan` parent), so in-process and clustered use the **same** mechanism. Not throwaway.

### Why B over A (the fork, resolved)

| Axis | A (spine-mend) | **B (runtime-substrate)** |
| --- | --- | --- |
| Execution model | fiber-compose in-proc / message x-node — **two models** | message everywhere — **one model** |
| Interruption | structured in-proc / cooperative x-node — **two** | cooperative-at-boundaries — **one** |
| Context/trace | free-nested in-proc / explicit x-node | **explicit everywhere (uniform)** |
| Harness independence | coupled | **preserved (the framework's identity)** |
| Risk | big loop `Effect.gen` rewrite + location-transparency **forever** | additive threading, **no rewrite** |
| Reversibility | hard to un-mend | **keeps doors open — mend a hot spine later if needed** |

**Deciding axis (per Ryan):** telemetry is massively important, but explicit `parentOpId`-style propagation is acceptable, and no major refactor while the framework is usable. That is B. A's one real edge — *hard structured teardown of in-flight work on abort* — is not a current requirement; cooperative-at-tick-boundaries is adequate for the agent loop. If that ever becomes a hard requirement, mend that one spine then (B is reversible; A is not).

**A is not deleted — it is deferred**, per-spine, behind a concrete future requirement (hard structured cancellation).

## Implementation plan (spine-first, incremental, deferrable)

None of this is urgent; each step is additive and independently shippable.

1. **Real app runtime.** Replace the app's placeholder `runWithTelemetry` (currently a per-call `Effect.provide` — rebuilds the Layer every call, a latent bug) with `ManagedRuntime.make(telemetryLayer)` built once at construction, disposed in `onAppClose`. *One file (`app/harness.ts`); delivers app-level spans + fixes the rebuild bug.*
2. **Runtime as substrate.** Add `runtime` to the harness substrate (like `bus`/`inbox`/`journal`); `BaseHarness` gains `protected runProtocol(eff)` = run on the inherited runtime if present, else the current bare `runHarnessProtocol` (**behavior-preserving** when absent). Thread it from the app down.
3. **Spine-first swap.** Convert the harnesses whose spans matter most — **executor (model calls) first**, then loop, tool-executor — to run roots via `this.runProtocol`. Leaf harnesses (knobs/state) follow only if their spans matter. Partial coverage is graceful.
4. **Explicit span nesting.** Add `spanContext` (a serialized parent-span ref) to the propagated op scope beside `parentOpId`; `makeEvent`/`runOperation` apply it as the `withSpan` `parent`. Now spine spans nest into one trace tree — via the same channel that stitches across nodes.
5. **BYO Layer.** No `@effect/opentelemetry` dep is bundled; the adopter passes the Layer (`createApp(Agent, { telemetry: NodeSdkLive })`) — same BYO ethos as the client-side telemetry extension.

## What this retires from ADR 77

- The loop `Effect.gen` rewrite — **not needed** under B.
- `.fx` as an *internal composition* surface — demoted to an **edge convenience** for Effect users (`Runtime.runPromise(rt)` / `Stream.toAsyncIterableRuntime(rt)` are the mechanical projections). Still nice; no longer load-bearing.
- Location transparency — **dropped** (one message-based cross-harness model).

The loop **characterization suite** (ADR 77 S1, committed) is **kept** as valuable loop regression coverage regardless — it already caught two real subtleties (signal-abort outcome; hook-isolation locus).

## Confidence

- Decision (B): moderate-high — falls out of Ryan's stated constraints; A deferred, not deleted.
- Telemetry via B: HIGH — additive, no rewrite, uniform with the cluster story, Effect ships the runtime-scoped runners it needs.
