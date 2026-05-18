# Agentick v2 — Implementation Status

**Branch:** `feat/v2`
**Last updated:** 2026-05-15 (substrate flipped to Effect-native — Path A reversal)

This is the **running progress log** for v2 implementation. Update it
every session. New contributors / sessions read this first.

Related docs:
- [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md) — overall phasing,
  exit criteria, risk register
- [`blueprint/`](./blueprint/) — architectural contracts (~24 docs)
- [`blueprint/17-open-questions.md`](./blueprint/17-open-questions.md) —
  unresolved design decisions

## Current state

```
Phase 0  ■ in progress — workspace setup
  ✓ Spec + spec-conformance packages scaffolded (committed)
  ✓ Nomenclature rename pass (compiler→reconciler, renderer→formatter,
    CompiledStructure→RenderedTree, useContinuation→useLoopControl)
  ✗ Package renames (still pending decisions — defer to convenience)
  ✗ Website / typedoc updates (deferred to end of Phase 0)

Phase 1  ■ in progress — spec package type population
  ✓ Foundation-critical types (envelopes, outcomes, errors, policy)
  ✓ Substrate protocol interfaces (journal, bus, inbox)
  ✓ Reconciler-related wire types (RenderedTree, ContextSpec,
    MessageEntry, SectionEntry, ContentBlock, SemanticNode,
    FormatterRef, FormatInput/Result, RuntimeDeclarations, etc.)
    — landed 2026-05-15, unblocks Phase 3
  ✓ Executor wire types (ExecutionResult, ExecutorTerminal,
    LanguageModelExecutionResult, ExecutionTarget) — landed 2026-05-15
  ✗ Channels, Timeline, Knobs, ReconcilerSnapshot, SessionRecord
    (later phases)

Phase 2  ✓ in-memory substrate — MemoryJournal, LocalEventBus,
         LocalInbox, BaseHarness implemented in @agentick/runtime.
         Effect-native protocols (Effect<R,E,never> / Stream<E,F,never>);
         FiberRef-based RuntimeContext substrate; conformance suites
         populated for journal + bus + inbox; 4953 workspace tests green;
         full workspace typecheck clean.
Phase 3  ■ in progress — RECONCILER HARNESS
         ✓ 3.1 ReconcilerProtocol + I/O + errors + inbox messages
         ✓ 3.2 ReconcilerSnapshot + diagnostics
         ✓ 3.3 HookBridges (DataBridge no-Suspense contract)
         ✓ 3.4 @agentick/reconciler-react package scaffold
         ✓ 3.5 host layer (HostInstance / HostScope / Container)
         ✓ 3.6 host-config + react-reconciler init (React 19)
         ✓ 3.7 Contributor protocol + IRFragment + ContributorRegistry
         ✓ 3.8 Built-in contributors (section/message/tool/resource/
               output/mcp/model)
         ✓ 3.9 collect walker + foldFragments → RenderedTree
         ✓ 3.10a ReconcilerHarness BaseHarness subclass
         ✓ 3.10b InMemoryDataBridge + stub bridges
         ✓ 3.10c render-until-stable loop (no-Suspense useData async path)
         ✓ 3.11 BridgeContext + 5 hooks (useData/useKnob/useTimeline/
               useLoopControl/useSession)
         ✓ 3.12 Lifecycle hooks + tick-start catch-up (useOnTickStart/End,
               useOnExecutionStart/End, useOnError, useOnMount/Unmount)
         ✓ 3.13 Formatter scope providers (FormatScope + Markdown/XML/PlainText)
         ✓ 3.14 runReconcilerConformance + bridge conformance suites
         ✗ 3.15 Snapshot/restore concrete impls (hook state capture)
Phase 4  ■ in progress — REMAINING HARNESSES
         ✓ 4a.1 ToolExecutorProtocol + I/O + errors + inbox + lifecycle (spec)
         ✓ 4a.2 runToolExecutorConformance + FixtureToolSpec
         ✓ 4a.3 @agentick/tool-executor package scaffold
         ✓ 4a.4 Harness skeleton + registry + handler resolver + validators +
                dispatch happy path + abort + handler errors + timeout.
                53/53 tool-executor tests; 16/16 conformance pass against
                the reference impl. (Lifecycle event emission, confirmation
                flow, middleware are deferred to 4a.5+.)
         ✗ 4a.5 Confirmation flow + framework channel
         ✗ 4a.6 Middleware + lifecycle handler hooks
         ✗ 4a.7 Inbox dispatcher (abort + confirmation-response)
         ✗ 4a.8 v1 tool tests port + parity sweep
         ✓ 4b.1 ExecutorProtocol + LanguageModelExecutor spec types
         ✓ 4b.2 runExecutorConformance suite
         ✓ 4b.3 @agentick/executor package + MockLanguageModelExecutor
                reference impl (12/12 tests; 6 conformance + 6 impl-specific)
         ✓ 4b.4 example/v2 executor scenario — JSX → RenderedTree →
                executor.run → streaming deltas → ExecutionResult
         ✗ 4c   Provider adapters (OpenAI, Anthropic, Google, AI SDK)
         ✓ 4d.1 LoopExecutorProtocol + StateApplicator spec types
         ✓ 4d.2 runLoopExecutorConformance suite (5 scenarios:
                happy path, applyExecutorResult call count,
                tool-call round-trip, max ticks, abort no-op)
         ✓ 4d.3 @agentick/loop-executor package +
                LoopExecutorHarness + NoopStateApplicator
                (5/5 conformance tests pass against reference impl)
         ✓ 4d.4 example/v2 loop scenario — multi-tick agent loop:
                tick 1 returns tool_use → loop dispatches calculator
                → tick 2 returns final text → terminal "end". Streaming
                deltas observed on the bus. 2 ticks, 1 tool dispatch.
         ✗ 4e   Session harness
         ✗ 4f   App harness
Phase 5  □ Adapters, cluster, gateway
Phase 6  □ v1 sunset
```

## Known loose ends (track-but-not-blocking)

Captured 2026-05-15 so these don't fall off the radar while we move on.
Most are addressed later — none of them gate the next priority
(conformance suites, 3.14). Listed here so any later session can pick
up the right one.

### Stubs / placeholders to flesh out
- ~~renderToString / renderResource return spec-shaped empty payloads~~
  ✓ renderToString implemented 2026-05-15 with default markdown/xml/text
  serializer. renderResource dropped — over-specified; resource content
  resolution is the runtime/MCP layer's concern via `handlerRef`.
- **Snapshot/restore hook-state capture**. `ReconcilerSnapshot.hookStates`
  is always empty, `dataCache` always empty. Hibernate-and-resume is
  shape-conformant but doesn't preserve component state yet.
- ~~strictNoSuspense plumbing~~ DROPPED 2026-05-15. Suspense firing
  cannot be reliably detected via react-reconciler 0.33's host config
  callbacks. Tried fetch-count heuristic (false positives/negatives),
  static element-tree scan (misses dynamic Suspense), and
  outer-Suspense sentinel (detection works but inner user-Suspense's
  unwrap-on-resolve doesn't fire with LegacyRoot, leaving fallback
  stuck in IR). Removed from spec.
- ✓ **Suspense warning heuristic** added 2026-05-15.
  `ReconcilerHarness.maybeWarnSuspense` scans the input element tree
  for `React.Suspense` at mount + rerender; emits a one-shot
  `console.warn` per mount. Static scan — Suspense returned from a
  function component is still invisible. Catches the common case
  (user wraps their JSX in `<Suspense>`) and gives a clear pointer to
  the "no-Suspense DataBridge contract" rather than silently rendering
  fallbacks into the model context. Tests in
  `boundary-diagnostics.spec.tsx`.
- ✓ **ErrorBoundary detection** — `error-boundary-active` info
  diagnostic emits via host config `onCaughtError`. Landed 2026-05-15.
- ✓ **Custom lifecycle event dispatch** — `LifecycleStore.registerCustom`
  + `useOnLifecycleCustom(kind, handler)` hook land 2026-05-15. Dispatching
  a custom kind with no registered handler emits a one-shot
  `console.warn` per kind so typos surface instead of being silently
  dropped. Tests in `lifecycle.spec.tsx`.

### Spec gaps
- **`@agentick/spec/guards`** — directory exists, stubs only. Type guards
  for runtime validation (isTextBlock, isSection, isToolDeclaration, etc.)
- **`@agentick/spec-validator`** — referenced in pluggability charter
  for opt-in JSON-Schema runtime validation; package doesn't exist.
- **Phantom-type Operation inference (`__r`, `__e`)** — never validated.
- **Idempotency conflict semantics** — same opId, different input is
  currently silent first-wins. Charter says we'll add detection "if a
  real case demands it"; no diagnostic yet.

### Tests deferred
- **max-iterations diagnostic test** — TODO comment in hooks.spec.tsx.
  Need a controlled DataBridge fixture that fakes pending without
  actually throwing.
- **Concurrent features no-op verification** — useTransition /
  useDeferredValue documented as no-op; not tested.
- **Wire-compat round-trip** — pluggability charter rule #7 asserted in
  docstrings but not exercised. Add a smoke test that
  `JSON.parse(JSON.stringify(renderedTree))` recovers an equivalent
  value.
- **Hibernate/restore round-trip** — even with empty hookStates,
  snapshot → JSON → restore → renderTree should produce equivalent IR.
- **findOrphaned semantics for non-memory journals** — protocol doesn't
  specify index requirements; concrete durable impls will surface this.

### Integration gaps
- ✓ **react-devtools bridge** — ported to
  `@agentick/reconciler-react/react/devtools-bridge.ts`. Each
  `createReconciler()` auto-injects into DevTools via
  `injectIntoDevTools` (no per-mount opt-in). Call
  `enableReactDevTools({ host?, port? })` once at startup to connect to
  the standalone DevTools app — returns a typed outcome
  (`connected`/`already-connected`/`not-installed`/`failed`) instead of
  console-warning side effects. `react-devtools-core` is loaded via
  dynamic import (not a declared peer dep — install yourself when
  needed). Landed 2026-05-15.
- ✓ **Content-block intrinsics** — all 14 content-block contributors
  (`text`/`image`/`code`/`json`/`document`/`audio`/`video`/`reasoning`/
  `csv`/`html`/`xml`/`user_action`/`system_event`/`state_change`/
  `custom`) are registered in `createBuiltInRegistry()`.
  `messageContributor` folds them into `MessageEntry.content` via
  `ctx.collectContentBlocks()`; 15 tests in `content-blocks.spec.tsx`.
  Landed 2026-05-15 (the line that used to live here was stale).
- **Semantic HTML intrinsics** — `<strong>`, `<em>`, `<ul>`, etc. v1 has
  them; v2 design says they're a formatter concern (formatter harness
  consumes SemanticNode tree). Not wired.
- ✓ **`format` JSX intrinsic typing** — confirmed as intentional. The
  `format` intrinsic is INTERNAL; `<FormatScope>` / `<Markdown>` /
  `<XML>` / `<PlainText>` are the only typed entry points and they all
  funnel through one `internalIntrinsic()` helper that owns the unavoidable
  cast. Wider IntrinsicElements augmentation for `<section>` /
  `<message>` / `<text>` / etc. is a Phase-4-or-later concern — v2
  test code uses `React.createElement(...)` for intrinsics by design.
  Updated 2026-05-15.
- **Long-lived primitives** (`<Cron>` / `<Webhook>` / `<EventListener>`)
  — declared via SubscriptionIntent in the snapshot; no JSX components
  yet.

### Performance / observability

These are **gating items for Phase 4c (executor)** unless flagged
otherwise. Tracked in `blueprint/17-open-questions.md` §Substrate
scalability + observability.

- ~~**L5 — OTel exception recording without breaking error-reference
  identity.**~~ ✓ decided 2026-05-18. Restored standard `Effect.withSpan`
  (was side-channel). Empirical finding: only the *outer* failure
  wrapper loses `===` identity; inner `.cause` Error references survive,
  all structural data (`_tag`, prototype chain, properties, stack)
  matches, and the recommended matchers (`instanceof`, `_tag` checks,
  `expect.objectContaining`) all work as adopters would expect. The
  narrow loss is acceptable in exchange for full OTel span hierarchy
  + exception recording. Substrate `annotateOperationSpan` documents
  the contract; see `blueprint/17-open-questions.md` §L5 investigation
  for findings + adopter patterns.
- ~~**L6 — Bus publish hot-path benchmark.**~~ ✓ landed 2026-05-17.
  Numbers in `blueprint/17-open-questions.md` §Benchmark results.
  Headline: lazy emission no-subs at 0.5 μs (12× speedup vs eager),
  bus.publish 1-sub at 6.0 μs (20% over target — acceptable),
  runOperation empty body at 46.8 μs (target revised from 10 μs →
  50 μs after Effect framework overhead measured).
- **L7 — `MemoryJournal.appendedKeys` Set unbounded growth.**
  Idempotency keys accumulate forever. Long-lived sessions leak. Fix:
  TTL eviction matching the ring buffer's drop point. **Gates v2.0
  release** (not Phase 4).
- **L8 — Substrate self-instrumentation.** No metric surface for
  subscriberCount / journal size / inbox cache size / queue depth.
  How does a deployment know if the substrate is overloaded? Designed
  alongside L6.
- **Render-until-stable wallclock budget** — only iteration-bounded.
  A slow fetcher blocks the loop. We may want `awaitTimeoutMs` per
  iteration.

### Documentation gaps
- **Per-package API reference READMEs** — high-level pitch only. No
  user-facing component / hook reference for reconciler-react.
- **Flow diagrams in `15-flows/`** reference v1 vocabulary in places.

## Critical priority recalibration (2026-05-14)

**The reconciler is the most foundational piece of agentick.** Everything
connects to it; everything else is plumbing around it. Phase 3 in
`IMPLEMENTATION-PLAN.md` was originally the tool executor (chosen as
"simplest proof of substrate"). It is now the **reconciler harness**.

Rationale: if `BaseHarness` doesn't fit the foundational harness cleanly,
we need to know that before building six other harnesses on top. The
tool executor is peripheral; proving the substrate against it teaches
us little. Tool executor moves to Phase 4a.

This means Phase 3 lands more spec types in parallel (ContentBlock,
RenderedTree, MessageEntry, SemanticNode, FormatterRef, etc.) before
the reconciler harness can be implemented.

## What's done so far

### Architecture (locked)

- [`blueprint/`](./blueprint/) — 23 docs covering the five-surface
  harness model, foundation substrate (journal/bus/inbox/OTel),
  data model, every per-harness contract, flows, and packaging.
- Naming scheme locked: `compiler-*`, `client-*`, `server-*`,
  `executor-*`, `persistence-*`, `sandbox-*`.
- Foundation contract: `Operation`, `DiscreteEvent`, `ChannelEvent`,
  `MessageEnvelope`, `OperationJournal`, `EventBus`, `MessageInbox`,
  `BaseHarness` with five surfaces.

### Resolved open questions

From `17-open-questions.md`:
- **A10** `ReconcilerSnapshot` shape — locked 2026-05-08
- **A11** `StateApplicator` interface — locked 2026-05-08 (Pick of session)
- **F2** Handler verdict merge — locked 2026-05-08 (veto > replace > defer > proceed)
- **N5** Ingest mechanism — locked 2026-05-08 (hybrid: direct call +
  lifecycle handler chain)

### Code (Phase 0 morning, 2026-05-08, committed)

```
packages/spec/                                          ✓ scaffolded
  package.json                                          zero-dep, types-only
  tsconfig.json + tsconfig.build.json
  README.md
  src/version.ts                                        SPEC_VERSION
  src/index.ts
  src/data/                                             populated this session
  src/protocol/                                         populated this session
  src/guards/index.ts                                   stub

packages/spec-conformance/                              ✓ scaffolded (private: true)
  package.json                                          (same as before)
  src/{journal,inbox,harness,renderer}.ts               stubs (Phase 2+)

.changeset/config.json                                  ✓ @agentick/spec in fixed group
```

### Amendment — React feature semantics + notifyLifecycle (2026-05-15)

Pushback on the original Phase 3.1 framing landed two refinements:

1. **`notifyTickEnd` → `notifyLifecycle`.** Single command carrying a
   tagged `LifecycleEvent` union (`tick-start | tick-end |
   execution-start | execution-end | error` + a namespaced `custom`
   escape hatch). Direct method-based coupling (synchronous, ordered)
   coexists with parallel event-bus emission (async, fan-out) — they
   answer different questions. Future lifecycle kinds don't add
   protocol methods.

2. **React feature semantics.** "Forbidden" was too strong. Revised:
   - `<Suspense>` — fallbacks DO appear in the IR if a boundary
     fires. Default behavior: emit `suspense-boundary-active` warning
     diagnostic. `MountInput.strictNoSuspense = true` upgrades to a
     terminal `RenderFailed`. The reconciler's outer Promise catch
     means `useData` does NOT trigger Suspense boundaries — only
     things React itself intercepts (e.g., `React.lazy`).
   - `<ErrorBoundary>` — supported. Catching a render error and
     rendering a fallback is a *good* pattern (per-section
     resilience). Emits `error-boundary-active` info diagnostic.
   - `useTransition` / `useDeferredValue` — allowed; no effect in
     sync-render mode.

Diagnostic codes added: `suspense-boundary-active` (warning),
`error-boundary-active` (info).

Blueprint docs updated: `01-harness-principle.md`, `03-reconciler-harness.md`,
`05-loop-executor.md`, `08-session-harness.md`, `17-open-questions.md`,
`21-reconciler-implementation.md`, `IMPLEMENTATION-PLAN.md`.

Tests: 74/74 spec green (26 in reconciler-protocol.spec.ts with new
LifecycleEvent + strictNoSuspense + diagnostic coverage).
`pnpm -r typecheck` clean.

### Code (Phase 3.1–3.3 reconciler protocol contracts, 2026-05-15)

```
packages/spec/src/data/                                 ✓ snapshot + diagnostics
  reconciler-snapshot.ts  ReconcilerSnapshot, HookStateEntry,
                          DataCacheEntry, SubscriptionIntent,
                          ReconcileDiagnostic, ReconcileDiagnosticCode,
                          RenderToStringPayload

packages/spec/src/protocol/                             ✓ contracts
  hook-bridges.ts         HookBridges + DataBridge (no-Suspense),
                          KnobBridge, TimelineBridge, LoopBridge,
                          SessionBridge, Sandbox/MCP placeholders
  reconciler.ts           ReconcilerProtocol with mount/rerender/
                          renderTree/renderToString/renderResource/
                          notifyLifecycle/unmount/snapshot/restore.
                          notifyLifecycle carries tagged LifecycleEvent
                          union (tick-start | tick-end | execution-start |
                          execution-end | error). Direct-method coupling
                          coexists with bus-event fan-out — same moments,
                          different channels.
                          ReconcileError taxonomy (11 tags).
                          ReconcilerInboxMessage (recompile/unmount/
                          invalidate).

packages/spec/src/__tests__/
  reconciler-protocol.spec.ts                           23 new tests
                          - MountInput/Result, RenderTreeInput/Result
                          - RenderToString/Resource I/O
                          - Snapshot JSON round-trip
                          - ReconcileError taxonomy
                          - InboxMessage discrimination
                          - Diagnostic codes
                          - DataBridge no-Suspense semantics (cached
                            sync, pending throws Promise, failure
                            throws Error)
                          - Knob/Timeline/Loop/Session shapes
                          - ReconcilerProtocol method roster
```

**Design constraints baked into Phase 3.1:**

- **No Suspense.** `DataBridge.resolve` is the no-Suspense contract:
  cached value returns synchronously; pending throws an in-flight
  Promise (caught by the reconciler's render-until-stable loop, not
  by React `<Suspense>`); prior failure throws the underlying Error.
  `RenderedTree` never carries "loading" states.
- **JSON firewall.** `ReconcilerSnapshot` survives
  `JSON.parse(JSON.stringify(s))`. No functions, Dates, Maps, Sets.
- **Bridges, not globals.** Every runtime-supplied capability hook
  components need (timeline read, knob get/set, async data, loop
  control, session identity) goes through `HookBridges` passed at
  mount time. Module-level singletons are forbidden by contract.
- **`MountScopedInput` base.** Every operation that targets a mount
  carries `(mountId, opId?, correlationId?, parentOpId?)`. Phase
  contract + idempotency + causality come from `BaseHarness`.
- **Forward-compat strings.** `RenderPurpose`, `SessionStatus`,
  `HookType`, `ReconcileDiagnosticCode` are open string unions with
  named recognized values — new variants don't break older snapshots.

**Status check:**
- `pnpm vitest run packages/spec` — 71/71 green
- `pnpm -r typecheck` — all packages green
- Phase 3.4 (`@agentick/reconciler-react` scaffold) unblocked

### Code (Phase 2 in-memory substrate, 2026-05-15)

```
packages/runtime/                                       ✓ new package
  package.json                                          deps: @agentick/spec
                                                        devDeps: @agentick/spec-conformance
  tsconfig.json + tsconfig.build.json
  README.md
  src/index.ts                                          public exports
  src/substrate/
    ulid.ts                                             lex-sortable id gen
    query.ts                                            EventQuery matcher
                                                        (exact|prefix|segments|wildcard)
    memory-journal.ts                                   MemoryJournal
                                                        (ring buffer, idempotency map,
                                                         tail subscribers, findOrphaned,
                                                         bounded retention)
    local-event-bus.ts                                  LocalEventBus
                                                        (per-subscriber bounded buffer,
                                                         lazy fan-out, 3 overflow strategies)
    local-inbox.ts                                      LocalInbox
                                                        (address registry, messageId
                                                         idempotency cache w/ TTL,
                                                         tell + ask + timeout)
    base-harness.ts                                     BaseHarness, HandlerRegistry,
                                                        MiddlewareChain, mergeVerdict,
                                                        OperationOutcomeError
                                                        (5 surfaces wired; phase contract;
                                                         idempotent replay; verdict merge
                                                         veto > replace > defer > proceed;
                                                         JournalingPolicy honored;
                                                         override map with longest-prefix)
  src/__tests__/
    memory-journal.spec.ts                              conformance + capacity tests
    local-event-bus.spec.ts                             pub/sub + buffer + abort
    local-inbox.spec.ts                                 conformance
    base-harness.spec.ts                                phase contract, idempotency,
                                                        verdict merge, middleware
                                                        composition, inbox dispatch

packages/spec-conformance/                              ✓ bodies populated
  src/journal.ts                                        runJournalConformance
                                                        (append/read, idempotency, tail,
                                                         crash recovery)
  src/inbox.ts                                          runInboxConformance
                                                        (registration, tell, ask, timeout,
                                                         handler error, idempotency)
  src/harness.ts                                        DEFERRED to Phase 3
                                                        (needs a concrete harness driver)
  src/renderer.ts                                       DEFERRED to Phase 3
```

**Decisions baked in this session:**

- **Promise/AsyncIterable end-to-end.** No Effect in runtime yet. The
  blueprint reserves Effect for higher layers (Scope/Span integration);
  the in-memory substrate doesn't need it. If a real case demands
  cancellable Effects, we layer them in then.
  > **REVERSED 2026-05-15.** This decision contradicted `19-foundation.md`
  > as written and produced architectural drift. Substrate is now
  > Effect-native; see the dated entry above.
- **Idempotency dedup is per `(opId, phase)`, not per envelope id.** Same
  operation replaying the same phase is a no-op. Same opId in different
  phases is normal (requested → terminal).
- **`emit` returns Promise<void>** so concrete harnesses can await
  delivery. Discrete events still skip the `before` handler/middleware
  chain — they're light-path only.
- **`OperationOutcomeError`** is the runtime's signal for non-success
  terminals (failed | canceled | vetoed | deferred). `succeeded` and
  `replaced` return the result directly via the call.
- **Journaling override map** supports exact name OR longest-prefix
  matching. Lets harnesses tag noisy event families ("session:stream:")
  as `bus-only` without enumerating every leaf.
- **`runHarnessConformance` deferred to Phase 3.** It needs a concrete
  harness to drive; the runtime tests cover the BaseHarness contract in
  the meantime.

**Status check:**
- `pnpm vitest run packages/runtime packages/spec` — 82/82 green
  (24 prior spec + 23 phase-1c spec + 12 journal + 9 inbox + 4 bus + 9 base-harness + 1 version)
- `pnpm -r typecheck` — all packages green
- v1 packages unaffected

### Code (Phase 1c reconciler-facing wire types, 2026-05-15)

```
packages/spec/src/data/                                 ✓ wire types for Phase 3
  content-blocks.ts     ContentBlock taxonomy (21 variants), MediaSource,
                        role-scoped allow lists. `any` → `unknown`; enums
                        collapsed to string literal unions. Runtime helpers
                        stay in @agentick/shared.
  semantic.ts           SemanticNode (with rendererRef instead of function
                        ref), SemanticType, SemanticMetadata, FormattableBlock
  formatter.ts          FormatterRef, FormatterCapabilities, FormatInput,
                        FormatScope, FormatTrace, FormatDiagnostic,
                        FormatDiagnostics, FormattedContent, FormatResult
  entries.ts            CacheHint, MessageEntry, MessageMetadata,
                        SectionEntry, SectionMetadata, ContextEntry,
                        ContextSpec
  declarations.ts       ToolDeclaration, ToolExposure, ToolAnnotations,
                        ResourceDeclaration, OutputDeclaration,
                        MCPDeclaration, RuntimeDeclarations, JsonSchema
  rendered-tree.ts      RenderedTree, SpecConfig, ProviderOptions,
                        ResponseFormat, ModelSelection, SpecFeatureName
  execution-result.ts   UsageStats, ExecutionResult, ExecutorError,
                        ExecutorTerminal, LanguageModelStopReason,
                        ToolCall, LanguageModelExecutionResult,
                        ExecutorDelta
  execution-target.ts   ExecutionTarget, LanguageModelTarget,
                        TargetCapabilities
  index.ts              re-exports all of the above

packages/spec/src/__tests__/                            ✓ 48 tests passing
  rendered-tree.spec.ts (23 new tests: ContentBlock narrowing, SemanticNode,
                         Formatter protocol, ContextSpec entries,
                         RuntimeDeclarations, RenderedTree free-root,
                         ExecutorTerminal outcomes, ExecutionTarget)
```

**Decisions baked in this session:**

- **Function references can't cross the wire.** v1's
  `SemanticNode.formatter: Formatter` field becomes
  `rendererRef?: FormatterRef`. Formatter identity is data; behavior
  lives behind the formatter harness. `[V1-REPLACED]`.
- **Enums are runtime artifacts; spec is types-only.** v1's `BlockType`,
  `MessageRole`, `MediaSourceType`, MIME-type, and `CodeLanguage` enums
  collapse to string literal unions (with `(string & {})` escape hatch
  on open lists for ergonomics without losing literal autocomplete).
- **`readonly` everywhere on wire types.** The spec exposes shapes
  consumers MUST treat as immutable. Implementations construct fresh
  objects; downstream code reads.
- **`ExecutorTerminal` omits `deferred`.** `deferred` is a pre-execution
  handler verdict (the `before` phase), not a terminal outcome. The
  envelope carries the five values that actually terminate execution.
- **Runtime helpers stay in `@agentick/shared`.** Type guards
  (`isTextBlock`, `isToolUseBlock`, …) and base64 helpers depend on
  Node Buffer / browser fallbacks — those don't belong in zero-dep spec.

**Status check:**
- `pnpm -r typecheck` — all packages green
- `pnpm vitest run packages/spec` — 48/48 green (24 prior + 23 new + 1 version)
- v1 packages unaffected

### Code (Phase 1 foundation-critical types, 2026-05-11)

```
packages/spec/src/data/                                 ✓ all populated
  events.ts             EventEnvelope, ProtocolEvent, EventSurface,
                        EventPhase, EventScope, EventQuery, NameQuery
  outcomes.ts           CommandOutcome (6 values), HandlerVerdict,
                        TerminalEvent<R,E>, HandlerScope
  operations.ts         Operation<I,R,E>, DiscreteEvent, ChannelEvent<T>
  inbox.ts              MessageEnvelope<T>, MessageAck, MessageHandler
  errors.ts             JournalError, InboxError, MessageHandlerError
  journaling-policy.ts  JournalingPolicy + DEFAULT_JOURNALING_POLICY
  standard-schema.ts    Inlined StandardSchemaV1 (~30 LOC; zero-dep preserved)
  index.ts              re-exports all of the above

packages/spec/src/protocol/                             ✓ substrate protocols
  journal.ts            OperationJournal (append, appendBatch, read, tail,
                        lookupTerminal, findOrphaned)
                        + OrphanedOperation, OrphanQuery, JournalReadFrom,
                          Maybe<T> sentinel
  bus.ts                EventBus (publish, subscribe)
                        + SubscribeOptions, BufferOverflowError
  inbox.ts              MessageInbox (register, send, ask)
                        + AskOptions, Unsubscribe
  index.ts              re-exports

packages/spec/src/__tests__/                            ✓ 25 tests passing
  version.spec.ts       (1 test, SPEC_VERSION format)
  types.spec.ts         (24 tests, structural smoke for every new type)
```

**Decisions baked in this session:**

- **Async return type in spec is `Promise<T>` / `AsyncIterable<T>`.** Not
  `Effect<T, E, R>`. This preserves spec's zero-dep claim and matches
  the blueprint's own pattern (compiler-react is Effect-free; the
  runtime bridges to Effect at the BaseHarness boundary). Errors are
  thrown/rejected, typed via JSDoc `@throws`. Implementations using
  Effect convert at their protocol boundary via
  `Effect.runPromise` / `Effect.tryPromise`.
- **Streaming uses `AsyncIterable<T>`** (TS-native) rather than Effect's
  `Stream`. Implementations adapt.
- **No `Option<T>`.** `OperationJournal.lookupTerminal` returns a plain
  discriminated union `Maybe<T> = { some: true; value: T } | { some: false }`.
- **Error shape is `{ _tag: ...; ... }` tagged unions** for runtime
  pattern matching. No exception class hierarchy.
- **Phantom type fields on `Operation<I, R, E>`** (`__r`, `__e`) are
  inference-only; not runtime properties.

**Status check:**
- `pnpm typecheck` — 55/55 green
- `pnpm vitest run packages/spec/src` — 25/25 green
- v1 packages unaffected

## What's next

### Immediate

Two parallel work streams can proceed now:

1. **Foundation substrate (Phase 2)** is **unblocked** — spec has the
   types and protocol interfaces needed to implement `MemoryJournal`,
   `LocalInbox`, `LocalEventBus`, and `BaseHarness`.

2. **Reconciler spec types (Phase 1 continuation)** can start in
   parallel — these are needed for Phase 3 (reconciler harness):
   - `ContentBlock` taxonomy + `MediaSource` (promote from
     `packages/shared/src/blocks.ts`)
   - `SemanticNode`, `SemanticType`, `SemanticMetadata` (promote from
     `packages/core/src/renderers/base.ts`)
   - `FormatterRef`, `FormatInput`, `FormatResult`, `FormattedContent`,
     `FormatScope`, `FormatTrace`
   - `RenderedTree`, `ContextSpec`, `MessageEntry`, `SectionEntry`
   - `RuntimeDeclarations`, `ToolDeclaration`, `OutputDeclaration`,
     `ResourceDeclaration`
   - `ReconcilerSnapshot` (per `03-reconciler-harness.md` §Snapshot rules)
   - `Message`, `MessageRoles` (promote from
     `packages/shared/src/messages.ts`)
   - `TimelineEntry` (promote from `packages/shared/src/timeline.ts`)
   - `UsageStats` (promote from `packages/shared/src/models.ts`)

Recommended order:

1. **Commit current state** (nomenclature rename + priority reorder).
2. **Promote reconciler spec types** (Phase 1 continuation). Mostly
   mechanical — move + re-export from `@agentick/shared` for transient
   compat.
3. **Start Phase 2 substrate** (`MemoryJournal`, `LocalInbox`,
   `LocalEventBus`, `BaseHarness`) — can happen in parallel with #2.
4. **Phase 3 — Reconciler harness** in `@agentick/reconciler-react`.
   Port v1 reconciler + JSX runtime + components + hooks. Implement
   `ReconcilerProtocol`. Prove the substrate against the foundational
   harness.

### Deferred (do later when needed)

These spec types are NOT needed for foundation substrate (Phase 2) or
the first harness (Phase 3). Promote them when the consuming harness
gets implemented:

- **Phase 4 prereqs** (compiler-react, executor adapters):
  - `ContentBlock` taxonomy (from `packages/shared/src/blocks.ts`)
  - `Message`, `MessageRoles` (from `packages/shared/src/messages.ts`)
  - `TimelineEntry` (from `packages/shared/src/timeline.ts`)
  - `ToolCall`, `ToolResult` (from `packages/shared/src/tools.ts`)
  - `UsageStats`, `ResponseFormat` (from `packages/shared/src/models.ts`)
  - `RenderedTree`, `ContextSpec`, `MessageEntry`, `SectionEntry`
  - `RuntimeDeclarations`, `ToolDeclaration`, `OutputDeclaration`
  - `SemanticNode`, `SemanticType`, `SemanticMetadata`
  - `FormatterRef`, `FormatInput`, `FormatResult`, `FormatScope`
  - `ExecutionResult`, `ExecutorTerminal`, `LanguageModelExecutionResult`
  - `ExecutionTarget`, `LanguageModelTarget`
  - `ExecutorDelta`
  - `ReconcilerSnapshot`
  - `SessionRecord`
  - `FrameworkChannels` (concrete channel payloads)

- **Higher-layer protocol interfaces** (promote when implementing the
  corresponding harness):
  - `ReconcilerProtocol` (Phase 4b)
  - `FormatterProtocol` (Phase 4a)
  - `ExecutorProtocol`, `LanguageModelExecutor` (Phase 4c)
  - `ToolExecutorProtocol` (Phase 3)
  - `LoopExecutorProtocol` (Phase 4d)
  - `SessionHarnessProtocol` (Phase 4e)
  - `AppHarnessProtocol` (Phase 4f)

### Pending decisions (carried from 2026-05-08, not yet blocking)

The rename pass on existing v1 packages is still pending decisions —
but it can happen at any time and doesn't block substrate work. Defer
until convenient. The four open questions:

### Pending decisions (from session 2026-05-08)

1. **`@agentick/server`** exists today, described as "channel routing,
   session handling, transport adapters." Action:
   - (a) Rename to `@agentick/gateway` (current gateway pkg is something else?)
   - (b) Keep as `@agentick/server` (separate from gateway?)
   - (c) Fold into runtime

2. **`packages/adapters/` has 7 packages** vs the 3 in the original
   rename list:
   ```
   ai-sdk          → @agentick/executor-ai-sdk     (in plan)
   anthropic       → @agentick/executor-anthropic  (not in plan)
   apple           → @agentick/executor-apple      (??)
   bedrock         → @agentick/executor-bedrock    (??)
   google          → @agentick/executor-google     (in plan)
   huggingface     → @agentick/executor-huggingface (??)
   openai          → @agentick/executor-openai     (in plan)
   ```
   Rename all 7? Defer some?

3. **Other v1 packages** — angular, cli, client-multiplexer, connector*,
   guardrails, nestjs, scheduler, secrets, socket.io. Keep current
   names? Some renamed?

4. **`packages/agent/` and `packages/agentick/`** — which is the
   meta-package and what's the other?

## Environment quirks

### pnpm install requires explicit registry

Workspace has a Knowify CodeArtifact registry configured (`.npmrc`)
that intercepts unrelated package requests when its auth token is
expired. Two workarounds:

```bash
# Option 1: pass registry flag
pnpm install --registry=https://registry.npmjs.org/

# Option 2: refresh Knowify token
# (the team's standard token refresh procedure)
```

The `.npmrc` warning during pnpm runs about `${NPM_TOKEN}` failing to
replace is benign — comes from the workspace `.npmrc` template; not a
v2 concern.

### Vitest configuration is workspace-level

Don't add a per-package `"test": "vitest run"` script — vitest's
include glob `packages/*/src/**/*.spec.{ts,tsx}` is resolved relative
to the directory vitest is invoked from. Per-package `pnpm test` ends
up resolving to `packages/spec/packages/*/...` and finds nothing.

Run tests from workspace root:
```bash
pnpm vitest run packages/spec/src           # all spec tests
pnpm vitest run packages/spec/src/foo.spec.ts   # specific
```

### Day 1 morning fix applied

Originally `packages/spec/package.json` had `"test": "vitest run"` and
explicit `typescript` + `vitest` devDeps. Both removed:
- Test script removed (workspace runs tests from root)
- TypeScript + vitest provided by root devDeps

## Decision log

Running record of decisions made during execution (separate from the
blueprint's design decisions; this is execution-level).

### 2026-05-08

- **Day 1 morning approach:** do additive (new packages) safely first;
  pause before destructive renames until full package inventory was
  understood.
- **`@agentick/spec-conformance` not separate repo:** marked private
  in monorepo. The "private repo" idea was overengineered — conformance
  tests aren't a competitive moat.
- **Per-package test scripts:** removed; vitest runs from workspace root.

### 2026-05-11

- **STATUS.md created:** running progress + decision log to enable
  cross-session continuity.
- **Spec async return = Promise/AsyncIterable** (not Effect). Preserves
  zero-dep. Implementations bridge to Effect at the boundary.
- **Spec error shape = `{ _tag: ...; ... }` tagged union.** No class hierarchy.
- **`lookupTerminal` returns `Maybe<T>`** (plain discriminated union),
  not Effect's `Option<T>`.
- **Phantom type fields on `Operation<I, R, E>`** for inference; not
  runtime properties. Marked `@internal`.
- **`DEFAULT_JOURNALING_POLICY`** ships as a const in spec:
  `alwaysJournal: ["requested", "terminal"]`, `busOnly: ["before", "delta"]`,
  `overflow: "sliding"`, `queueCapacity: 4096`. Per-surface override at
  consumer.

### 2026-05-14

- **Nomenclature recalibration:** drop idiomatic naming where it
  conflicts with proper CS terms. Specifically:
  - `Compiler harness` → `Reconciler harness` (it reconciles a reactive
    program; it does not compile in the static-compilation sense).
  - `Renderer harness` (markdown/xml) → `Formatter harness` (it formats
    semantic content into output formats; "renderer" collides with
    React's own meaning).
  - `CompiledStructure` → `RenderedTree` (matches React's mental model:
    what the reconciler "renders" to).
  - `useContinuation` → `useLoopControl` (avoids overloading the existing
    "gate" concept; clearer semantic about what it does).
  - `CompileError` → `ReconcileError`.
  - `RenderError` (formatter) → `FormatError`.
  - `compileContext` command → `renderTree`.
  - `compile-until-stable` → `render-until-stable`.
  - Event prefixes: `compiler:*` → `reconciler:*`,
    `renderer:*` → `formatter:*`.
  - Surface enum: `"compiler"` → `"reconciler"`,
    `"renderer"` → `"formatter"`.
  - Package: `@agentick/compiler-react` → `@agentick/reconciler-react`.
  - Doc file: `03-compiler-harness.md` → `03-reconciler-harness.md`,
    `04-renderer-harness.md` → `04-formatter-harness.md`.
  - "Harness" stays — adds engineering-discipline specificity over
    bare "actor" (BaseHarness inheritance, five surfaces, journal
    durability). Documented as an addressable actor.

### 2026-05-17

- **L6 — substrate benchmark suite landed.** New
  `packages/runtime/src/__bench__/substrate.bench.ts` exercises every
  hot path (bus.publish ± subscribers, bus.publishLazy, journal.append
  ± dedup, inbox.send ± cache hit, runOperation ± idempotent replay,
  LocalChannelPublisher ± subscriber, streaming simulation 10 ops ×
  10 deltas eager vs lazy). Full table + decisions in
  `blueprint/17-open-questions.md` §Benchmark results.

  Key results:
  - **Lazy emission validated end-to-end.** `bus.publishLazy` no-subs
    at 0.5 μs is a **12× speedup** vs constructing-and-publishing
    (6.0 μs). The streaming sim shows 10 ops × 10 deltas: lazy at
    229 μs/iter beats eager at 289 μs/iter by ~20% when no
    subscriber. Construction-on-demand is the right call.
  - **`bus.publish` no-listeners hits target.** 0.5 μs < 1 μs.
  - **`bus.publish` 1-subscriber misses by 20%.** 6.0 μs vs 5 μs.
    Mostly Effect-runtime overhead (`Effect.all` + `Queue.offer`
    plumbing). Acceptable; micro-opt available.
  - **`journal.append` + `inbox.send` cache hit excellent.** ~1.4 μs
    fresh append, 0.6 μs dedup; 0.6 μs cache hit on inbox.
  - **`runOperation` empty body is 46.8 μs, 4.7× over original 10 μs
    target.** Decomposition: ~21 μs in three publishes, ~26 μs in
    Effect framework overhead (Effect.scoped + withContext + nested
    Effect.gen yields). **Target revised: < 50 μs.** Realistic
    given how much work the phase contract does. Substrate cost is
    0.5% of a 10 ms tool call, 0.05% of a 100 ms model call —
    real-world throughput is not substrate-limited at this number.

  Optimization opportunities deferred (not blocking Phase 4c):
  - Inline single-subscriber path in `bus.publish` to skip
    `Effect.all` overhead.
  - Flatten nested `Effect.gen` blocks in `runOperation`; skip
    `Effect.scoped` when no finalizers registered. ~15-20 μs
    recoverable.

### 2026-05-16

- **Substrate refinement pass — 8 critical items closed.** Audit of
  the substrate after the Effect-native migration surfaced eight gaps
  between the blueprint and the implementation. All eight closed in
  one pass:

  1. **`Effect.scoped` wrap around every command body.** `runOperation`
     now establishes a `Scope` for the operation's lifetime — any
     `Effect.acquireRelease` inside a body runs its finalizer when the
     operation terminates (success, failure, or interrupt). Unblocks
     adapters that hold per-operation resources (HttpClient, WebSocket,
     sandbox process handles).

  2. **Typed error channel.** `runOperation` now returns
     `Effect<R, E | SubstrateError, never>` instead of
     `Effect<R, unknown, never>`. New `SubstrateError` tagged union in
     `@agentick/spec` covers `OperationOutcomeError | JournalError |
     LifecycleHandlerError`. Callers regain compile-time signal about
     what failure modes to handle; subclass harnesses can pattern-match
     in `Effect.catchTag` / `Effect.catchTags`.

  3. **`parentOpId` auto-set from the FiberRef.** When `runOperation`
     starts and `op.parentOpId === undefined`, it reads the surrounding
     `RuntimeContextRef`'s `opId` and uses that. Nested operations
     compose into a causality tree without app code threading
     parentOpId. Every consumer of the journal/bus (devtools, OTel
     exporter, replay debugger) can reconstruct the operation tree.

  4. **OTel span integration — without breaking error-identity.**
     `runOperation` annotates each operation with `Effect.withSpan`
     via a private `annotateOperationSpan` helper that side-channels
     the span (success-typed `Effect.void.pipe(Effect.withSpan(...))`)
     so the failure value the caller sees is the same JS reference the
     body raised. Earlier attempt to use `Effect.withSpan` directly on
     the body's pipe lost error-reference identity (failures appeared
     as Errors with the same `.message` but different `.constructor`
     ref). Workaround preserves identity at the cost of the span not
     seeing the original error — for now, OTel sees only the span
     name + attributes; explicit `recordException` integration is a
     follow-up.

  5. **Lifecycle-handler failures flow through `SubstrateError`.** A
     `before`-handler's Effect failing now produces a typed
     `{ _tag: "LifecycleHandlerError", phase, cause }` instead of
     silently widening the operation's `E`. The substrate publishes
     `terminal:failed` for the operation and re-fails with the typed
     lifecycle error.

  6. **`runHarnessProtocol` extracted to `@agentick/runtime`.**
     Concrete harnesses (reconciler-react, tool-executor) used to
     duplicate this `FiberFailure → typed error` unwrap helper.
     Now exported once; both consumers import it.

  7. **`ToolHandler` accepts Effect, Promise, or sync.** The 90%-case
     Promise ergonomic (v1-compatible) keeps working. Effect-typed
     handlers see the harness's `RuntimeContextRef` directly via
     `getContext` (no `ctx` plumbing), participate in `Effect.scoped`
     finalizer chains, and cancel via `Effect.race` against an
     AbortSignal-driven failure. The dispatch body itself converted
     from Promise-shaped to Effect-shaped so the FiberRef propagates
     into Effect handlers without crossing the JS-async boundary.

  8. **`AbortSignal` ↔ Effect interrupt bridge.** Effect-typed tool
     handlers race the handler effect against an `Effect.async` that
     fails when the dispatch's AbortSignal fires. Promise handlers
     continue using the `AbortSignal` directly. The two abort
     primitives coexist without one dictating the other.

  **Status:** `pnpm -r typecheck` clean; 4953/4961 tests green across
  the workspace; example/v2 demonstrates both Promise and Effect
  handler paths end-to-end (the Effect `whoami` reads sessionId /
  executionId / tickId / opId via FiberRef without any parameter
  plumbing).

- **Components → reconciler-react.** Decision locked: user-facing
  component wrappers (`<Section>`, `<Message>`, `<H1>`, `<Tool>`, etc.)
  live in the matching reconciler package, not a separate
  `@agentick/components`. Rationale: components are coupled to the
  reconciler's intrinsics; future Solid / Vue reconcilers ship their
  own. example/v2 defines them locally as a stopgap; they graduate
  into `@agentick/reconciler-react` before Phase 4e so app authors can
  `import { Section, Tool } from "@agentick/reconciler-react"`.

- **Substrate scalability + observability — gates registered.** Four
  new entries in `blueprint/17-open-questions.md` §L (Observability):
  L5 (OTel exception recording without breaking error-reference
  identity), L6 (bus publish hot-path benchmark), L7 (`MemoryJournal.
  appendedKeys` Set unbounded growth), L8 (substrate self-instrumentation).
  L5 + L6 are **gating items for Phase 4c (executor harness)** —
  must land before adapter authors write code on top of the substrate.
  L7 gates v2.0 release. L8 lands alongside L6. See "Substrate
  scalability + observability (running notes)" in 17-open-questions.md
  for the benchmark plan and concrete concerns.

### 2026-05-15

- **Phase 3 priority reorder:** the reconciler harness, not the tool
  executor, is the proof harness. Reasoning: the reconciler IS the
  foundation; the substrate is plumbing for it. If substrate doesn't fit
  the foundational harness cleanly, we need to know that before building
  on top. Tool executor moves to Phase 4a.
- **Mechanical rename pass complete** across blueprint + plan + status.
  55/55 typecheck green; 25/25 spec tests green.
- **Path A — substrate flipped to Effect-native.** The earlier
  "Promise/AsyncIterable end-to-end. No Effect in runtime yet"
  decision is reversed. It contradicted `19-foundation.md` as written
  (`BaseHarness.runOperation` returns `Effect<R, E, Scope>`; journal /
  bus / inbox return `Effect` / `Stream`) and produced architectural
  drift — most visibly in an aborted attempt to bolt a `FiberRef + ALS
  mirror` `RuntimeContext` onto a Promise-typed substrate. The bolt-on
  was thrown out; the substrate itself is now Effect.

  Concretely:
  - `@agentick/spec` protocols flipped: `OperationJournal`,
    `EventBus`, `MessageInbox`, `MessageHandler` all return Effect /
    Stream. Tagged-union errors flow through the `E` channel.
  - `effect` is a direct dependency of `@agentick/spec`,
    `@agentick/spec-conformance`, `@agentick/runtime`,
    `@agentick/reconciler-react`, and `@agentick/tool-executor`.
  - `@agentick/runtime` rewrites: `MemoryJournal` (Stream-based read /
    tail, idempotency unchanged), `LocalEventBus` (Effect `Queue`
    backed — `Queue.sliding` for drop-oldest, `Queue.dropping` for
    drop-newest), `LocalInbox` (Fiber-memoized idempotency cache —
    same `messageId` joins the same Fiber), `BaseHarness` (Effect
    `runOperation` with `withContext` establishing
    `RuntimeContextRef` for the operation's lifetime; FiberRef
    propagates sessionId / executionId / tickId / opId / parentOpId /
    correlationId to every Effect launched inside the body).
  - New `runtime-context.ts`: `RuntimeContextRef: FiberRef<RuntimeContext>`,
    `getContext`, `withContext`. **No AsyncLocalStorage mirror** —
    the prior session's dual-surface attempt is the exact pattern we
    are refactoring v2 to escape (ALS is scoped to async-resource
    chains; actor identities outlive any single call stack).
  - `runEventBusConformance` added (charter rule #4 status table
    flagged it as missing).
  - Reference harnesses re-anchored: `ReconcilerHarness` and
    `ToolExecutorHarness` keep their Promise-typed `ReconcilerProtocol`
    / `ToolExecutorProtocol` public surfaces (the spec hasn't
    flipped those — Phase 4 concern) but wrap each command body
    with `Effect.runPromise` via a `runProtocol` bridge that
    unwraps `FiberFailure` → original typed error. FiberRef scope
    propagates within each command.
  - Workspace status: 4953/4961 tests green (3 skipped, 5 todo, 0
    failed); `pnpm -r typecheck` clean.

  Architectural payoff (now realized for every harness that
  inherits BaseHarness):
  - FiberRef propagation across command bodies — sessionId / opId /
    tickId visible to any downstream Effect via `getContext`. No
    parameter plumbing, no ALS scope leaks.
  - `Effect.withSpan` integration point ready in `runOperation` for
    the OTel projection (`19-foundation.md` §OTel). Spans align with
    `parentOpId` via FiberRef.
  - `Effect.scoped` finalizer chaining available for harness
    teardown / abort cleanup when the per-command scope closes.
  - `@effect/cluster` substitution path open — `ClusterJournal` /
    `ClusterInbox` will implement the same Effect-typed protocols
    that `MemoryJournal` / `LocalInbox` do, satisfying the same
    conformance suites.

  Cost: the migration was a one-day mechanical conversion. Test
  bodies cross at `Effect.runPromise` / `Stream.runCollect` at the
  vitest edge; impl bodies are `Effect.gen` / `Effect.sync` /
  `Effect.tryPromise` wrappers. Nothing fundamentally new is being
  built — we're aligning the substrate with the blueprint that
  already specified it. The longer this drift had run, the more
  expensive the conversion.

## Open architecture decisions (deferred from blueprint)

Top of the priority list from `17-open-questions.md`:

```
1. A19 — PersistenceBackend methods (Phase 5; defer)
2. A13 — ExecutorDelta shape (Phase 4c; defer)
3. C6 — Provider-side tool execution marker (Phase 4c; defer)
4. B5 — Handler ID validation mechanism (Phase 4b; defer)
5. A1 — features[] registry (Phase 1; address as types land)
6. E11 — Spec version migration on restore (Phase 5; defer)
7. Inbox idempotency cache size + TTL (Phase 2)
8. Per-harness inbox message catalogs (cross-validate during 4-9)
9. Cluster routing integration with @effect/cluster (Phase 5 spike)
```

None of these block immediate work.

## Quick-start for a new session

```
1. Read this file (STATUS.md).
2. Skim docs/proposals/v2/IMPLEMENTATION-PLAN.md for phasing.
3. Read blueprint/00-overview.md for the architecture map.
4. Read blueprint/01-harness-principle.md + blueprint/19-foundation.md
   for the foundational concepts.
5. Check "What's next" section above for the immediate work item.
6. Update this file when work completes.
```

## How to update this file

When finishing a session or work block:

1. Move items from "What's next" → "What's done" as appropriate.
2. Add a dated entry to "Decision log" for any non-obvious choices.
3. Update "Current state" phase markers.
4. Add new pending decisions if encountered.
5. Note any environment surprises.
6. Commit alongside the work it describes.
