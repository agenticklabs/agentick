# Agentick v2 — Implementation Plan

**Status:** Active · last updated 2026-05-18
**Branch:** `feat/v2`
**Reference:** [`blueprint/`](./blueprint/) — architectural contract docs
**Progress log:** [`STATUS.md`](./STATUS.md) — what actually shipped

This is the execution plan for the v2 rewrite. It assumes the blueprint
is the contract; this doc is sequencing.

## ▶ Current ordering (2026-05-18, supersedes Phase-4-onward sections)

Phase 4 is functionally complete — all six harnesses (reconciler →
tool-executor → executor → loop → session → app) shipped with the
substrate L1/L2/L3/L4 + L5 (OTel) + L6 (benchmarks) + L7 (idempotency
bound) closed. Phase 5+ proceeds as below, in this exact order:

```
1. ERGONOMIC FACADE (~3–4 days) — single cohesive PR.
   Drops a layer between the user and BaseHarness so the 90% case is
   three lines, not ten.
   ────────────────────────────────────────────────────────────────
   ✓ L7              MemoryJournal idempotency state bounded
   ✓ FAÇADE.1        LanguageModelExecutor.target as a property
   ✓ FAÇADE.2        AppHarnessOptions.target → optional override
   ✓ FAÇADE.3        Executor slot: instance | ExecutorFactory.
                     AppHarness invokes factories with its own substrate,
                     closing the app.events() observability footgun by
                     default. ExecutorFactory marker + isExecutorFactory
                     guard in @agentick/spec.
   ✓ FAÇADE.4        openai(modelId, options?) factory — returns an
                     ExecutorFactory ready to plug into createApp.
   ✓ FAÇADE.5        SendInput.executor / SendInput.target per-call
                     override threaded through SessionHarness.sendBody.
   ◐ FAÇADE.6        defineExecutor + defineApp shipped.
                     defineSession / defineLoop / defineReconciler /
                     defineToolExecutor deferred — lower demand,
                     follow up when a real use case lands.
                     (defineApp / defineSession / defineLoop /
                     defineReconciler / defineToolExecutor /
                     defineExecutor). Same five-surface contract,
                     callback-style entry point — no BaseHarness
                     subclassing for the common case.

2. CONFORMANCE COMPLETION (~2 days)
   ────────────────────────────────────────────────────────────────
   ✓ 4e.2            runSessionConformance suite shipped — 13 cases
                     covering send happy path, timeline writes, snapshot
                     freezing, state applicator (appendEntry /
                     applyExecutorResult / applyToolResults), close
                     idempotency + post-close rejection, notifyLifecycle,
                     execution handle dual-shape. Run against
                     @agentick/session.

                     Suite caught two real bugs in SessionHarness:
                       • send wrapped tagged SessionErrors in generic
                         ExecutionFailed (masked cause from callers)
                       • snapshot returned live timeline array by
                         reference (snapshots weren't frozen)

3. PHASE 5 — PROVIDER ADAPTER ROW (~1 week)
   ────────────────────────────────────────────────────────────────
   ✓ Phase5.3        @agentick/executor-ai-sdk — aisdk({ model })
                     bridge. Wraps Vercel AI SDK as our executor;
                     translates LanguageModelInput → ModelMessage[],
                     calls generateText, maps finishReason +
                     toolCalls back. ExecutorFactory marker; works
                     with createApp({ executor: aisdk({ model }) }).
                     Unlocks Anthropic, Google, etc. via the AI SDK
                     provider universe. 14/14 tests + conformance
                     against MockLanguageModelV2.
                     Tool extraction from aisdk({ tools }) deferred —
                     JSX-declared tools work today.
   □ Phase5.1        @agentick/executor-anthropic — native
                     anthropic("claude-...") factory (alternative to
                     going through aisdk wrapper; tighter envelope
                     fidelity, no AI SDK dep).
   □ Phase5.2        @agentick/executor-google — native
                     google("gemini-...") factory.

4. PHASE 5 — PRODUCTION SUBSTRATE (~2 weeks)
   ────────────────────────────────────────────────────────────────
   □ Phase5.4        @agentick/persistence-sqlite implements
                     OperationJournal (pass runJournalConformance)
   □ Phase5.5        @agentick/persistence-postgres impl + conformance
   □ Phase5.6        Gateway / server adapter port from v1
   □ Phase5.7        @agentick/cluster — defer if time-constrained
                     (v2.1 candidate)

5. PHASE 4 LOOSE ENDS (~3 days, parallel-safe)
   ────────────────────────────────────────────────────────────────
   ✓ 4a.5+4a.7       Tool confirmation flow + inbox dispatcher
   ✓ Session.spawn / dispatch / queue / append / observe
   ✓ Session.channel(name) / knob(name) handles
   ✓ Request/response primitive — RequestResponseRegistry
                     bookkeeping in @agentick/runtime; BaseHarness.request
                     + auto-interception of request-response inbox
                     messages; ChannelHandle.request + onRequest for
                     in-process responder pattern. Tool confirmation
                     refactored onto it (net code reduction). The
                     primitive every future MCP elicitation/sampling
                     impl will use.
   ☐ session.pause / resume — deferred per direction (hibernate/
                     restore likely sufficient).
   ☐ session.skill — pending architectural reconsideration (likely
                     a higher-order utility built on spawn, not a
                     peer primitive).
   ☐ session.shell — explicitly deferred.
   ✓ 4a.6            Tool middleware + onBeforeDispatch hook.
                     `use()` moved to BaseHarness (universal); only
                     typed subclass hooks (e.g., onBeforeDispatch)
                     remain per-harness.
   ✓ 4a.8            Tool v1 parity sweep — audit-only; substrate
                     parity confirmed, feature gaps (createTool, use(),
                     prop overrides) are separate user-surface work.
                     See docs/proposals/v2/notes/4a.8-tool-v1-parity.md
   ✓ 4f.6b           α design shipped: dropped AppIntegration bundle;
                     added services registry +
                     onSessionCreate/onSessionClose/onAppClose hooks.
                     `app.use(middleware)` is inherited BaseHarness
                     primitive (note: AppHarness commands don't yet
                     route through runOperation so middleware on those
                     is silently no-op — requires command refactor).
   ✓ 4f.7            telemetry?: Layer slot accepted (forward compat).
                     Persistence-through-journal-slot documented.
                     Actual Layer-application requires runtime refactor
                     in runHarnessProtocol (deferred).
   □ L8              Substrate self-instrumentation (defer until
                     production deployment exercises it)

6. PHASE 6 — V1 SUNSET (~1–2 weeks)
   ────────────────────────────────────────────────────────────────
   □ Migration guides per package
   □ v1 → v2 mapping doc per blueprint section
   □ Cut v2.0 from feat/v2 → main
```

The detailed legacy phasing below remains as historical reference for
the foundation work. Items 1–6 above are authoritative for new work.

---

## Strategic approach

**Substrate-first, conformance-driven, package-by-package.**

1. Build the foundation (Layers 1–4 of `19-foundation.md`) before any
   user-facing harness.
2. Use v1 tests as the regression suite — most survive, repointed at the
   v2 runtime once it exists.
3. Don't ship v2 until it's complete. Keep `main` on v1 stable; cut v2
   from `feat/v2` only when done.
4. Each phase has a green-test exit criterion. Don't move to the next
   phase before the current is locked.
5. Document v1 → v2 mapping per package as we go.

## Package roster (v2 final)

Per `13-package-graph.md`. Locking the names here for reference:

```
NEW:
  @agentick/spec                        contract types + protocol interfaces
  @agentick/runtime                     app/session/loop/tool harnesses, BaseHarness, MemoryJournal
  @agentick/reconciler-react              JSX reconciler harness implementation
  @agentick/cluster                     optional distributed wrapper
  @agentick/persistence-memory          OperationJournal: in-memory
  @agentick/persistence-sqlite          OperationJournal: SQLite
  @agentick/persistence-postgres        OperationJournal: Postgres
  @agentick/persistence-redis           OperationJournal: Redis Streams
  @agentick/executor-mock               LanguageModelExecutor: mock for tests
  @agentick/server-fastify              optional (deferred unless needed)
  @agentick/server-grpc                 optional (deferred)

RENAMED:
  @agentick/react           → @agentick/client-react
  @agentick/express         → @agentick/server-express
  @agentick/tui             → @agentick/client-tui
  @agentick/devtools        → @agentick/client-devtools
  @agentick/openai          → @agentick/executor-openai
  @agentick/google          → @agentick/executor-google
  @agentick/ai-sdk          → @agentick/executor-ai-sdk

UNCHANGED:
  @agentick/shared          (slimmed; wire types moved to spec)
  @agentick/gateway
  @agentick/sandbox
  @agentick/sandbox-local
  @agentick/sandbox-docker
  @agentick/sandbox-bwrap
  @agentick/sandbox-remote
  @agentick/mcp

REMOVED at v2 cut:
  @agentick/core
  @agentick/kernel          (folded into runtime + shared)

PRIVATE (not published):
  @agentick/spec-conformance   conformance test fixtures
```

## Phasing

### Phase 0 — Workspace setup (1–2 days)

**Goal:** branch ready to receive v2 code; all renames done atomically;
v1 tests still green.

```
Tasks:
  □ Create packages/spec/ (zero-dep, types-only)
  □ Create packages/spec-conformance/ (private: true)
  □ Update pnpm-workspace.yaml: add spec, spec-conformance,
    runtime, reconciler-react, persistence-{memory,sqlite,postgres,redis},
    cluster, executor-mock
  □ Update .changeset/config.json linked array with new packages
  □ Update website/typedoc.json entryPoints
  □ Update website/.vitepress/config.mts PACKAGE_GROUPS

  □ Atomic rename pass on existing packages:
    □ @agentick/react → @agentick/client-react
    □ @agentick/express → @agentick/server-express
    □ @agentick/tui → @agentick/client-tui
    □ @agentick/devtools → @agentick/client-devtools
    □ @agentick/openai → @agentick/executor-openai
    □ @agentick/google → @agentick/executor-google
    □ @agentick/ai-sdk → @agentick/executor-ai-sdk
  □ Update all package.json deps that reference renamed packages
  □ Update all imports across the monorepo (find/replace)
  □ Verify pnpm install + pnpm test + pnpm build all green
  □ Single commit: "chore: rename packages per v2 naming pattern"

  □ Add CI matrix for v2 packages (initially empty; ready to populate)
```

**Exit criteria:** `pnpm install && pnpm typecheck && pnpm test` green.
Renames are atomic in one commit.

**Risk:** import paths in user-facing examples and docs. Mitigation: do
the rename in a single mechanical commit; tooling-driven; reviewers
verify CI.

### Phase 1 — Spec package (Layer 1) (~1 week)

**Goal:** `@agentick/spec` compiles and exports the full contract.

```
Tasks:
  □ Promote v1 wire types from @agentick/shared:
    □ ContentBlock taxonomy (blocks.ts, block-types.ts)
    □ Message, MessageRoles (messages.ts)
    □ ChannelEvent, FrameworkChannels (protocol.ts channel parts)
    □ TimelineEntry (timeline.ts)
    □ ToolCall, ToolResult, ToolExecutor enum (tools.ts)
    □ UsageStats, ResponseFormat (models.ts)
    □ StopReason → LanguageModelStopReason taxonomy

  □ Add v2 envelope types:
    □ Operation<I, R, E>
    □ DiscreteEvent
    □ ChannelEvent<T>
    □ MessageEnvelope, MessageAck
    □ EventEnvelope, ProtocolEvent
    □ TerminalEvent payload table
    □ HandlerVerdict, CommandOutcome
    □ EventQuery, NameQuery
    □ EventSurface, EventScope, EventPhase

  □ Add v2 IR types:
    □ RenderedTree, ContextSpec
    □ MessageEntry, SectionEntry
    □ RuntimeDeclarations, ToolDeclaration, OutputDeclaration,
      ResourceDeclaration, MCPDeclaration
    □ SemanticNode, SemanticType, SemanticMetadata (promoted from
      @agentick/core/renderers/base.ts)
    □ FormatterRef, FormatInput, FormatResult, FormattableContent,
      FormatScope, FormatTrace, FormatDiagnostic
    □ ExecutionResult, ExecutorTerminal
    □ LanguageModelExecutionResult, LanguageModelStopReason
    □ ExecutionTarget, LanguageModelTarget, TargetCapabilities
    □ ExecutorDelta
    □ ReconcilerSnapshot (per 03-reconciler-harness.md §Snapshot rules)
    □ SessionRecord shape

  □ Add protocol interfaces:
    □ ReconcilerProtocol (spec/protocol/reconciler.ts)
    □ FormatterProtocol
    □ LoopExecutorProtocol
    □ ExecutorProtocol, LanguageModelExecutor
    □ ToolExecutorProtocol
    □ SessionHarnessProtocol
    □ AppHarnessProtocol
    □ OperationJournal
    □ EventBus
    □ MessageInbox
    □ JournalingPolicy

  □ Add type guards (guards/)

  □ Inline StandardSchemaV1 (~10 LOC; preserves zero-dep)

  □ Add SPEC_VERSION constant

  □ JSON Schema generation pipeline (ts-json-schema-generator):
    □ Configure tool
    □ Generate schemas for RenderedTree, EventEnvelope,
      MessageEnvelope, ContentBlock, ToolDeclaration
    □ Commit generated artifacts; CI verifies determinism

  □ Conformance fixture stubs in packages/spec-conformance/:
    □ runJournalConformance(j) — signature only, body TODO
    □ runInboxConformance(i) — signature only
    □ runHarnessConformance(h) — signature only
    □ runRendererConformance(r) — signature only

  □ Port v1 wire-format tests to spec package tests:
    □ ContentBlock taxonomy tests
    □ Message helpers tests
    □ Channel event tests
    □ Timeline entry tests

  □ Update @agentick/shared to re-export wire types from spec for
    transient compat; mark with @deprecated comment
```

**Exit criteria:**
- `pnpm --filter @agentick/spec build` green
- `pnpm --filter @agentick/spec test` green
- All wire-format tests ported and green
- v1 packages compile against spec (via shared re-exports)

**Deliverable:** the contract is published-ready. Anyone can implement
against it.

### Phase 2 — In-memory substrate (Layers 2–3) (~2 weeks)

**Goal:** `@agentick/runtime` has `MemoryJournal`, `LocalInbox`,
`LocalEventBus`, and `BaseHarness` working. Conformance tests pass.

```
Tasks:
  □ MemoryJournal:
    □ Ring buffer with EventQuery indexing
    □ Bounded retention
    □ idempotency lookup (in-memory map)
    □ findOrphaned implementation
    □ Pass runJournalConformance

  □ LocalEventBus:
    □ PubSub<ProtocolEvent>
    □ Bounded subscriber buffer per query
    □ Lazy fan-out (no publish if no subscribers)
    □ Stream backpressure

  □ LocalInbox:
    □ Map<address, MessageHandler> registry
    □ send / ask methods
    □ messageId idempotency cache (TTL/LRU)
    □ Pass runInboxConformance

  □ BaseHarness abstract class:
    □ Constructor takes (surface, scopeId, journal, bus, inbox, policy)
    □ runOperation method (heavy path)
      □ idempotency check
      □ phase emission (requested → before → terminal)
      □ middleware chain composition
      □ lifecycle handler registry dispatch
      □ Effect.withSpan wrapping
      □ failure → terminal:failed mapping
    □ emit method (light discrete path)
    □ emitDelta helper
    □ Bounded journal-write Queue + drain worker
    □ JournalingPolicy lookup per envelope
    □ Inbox dispatch: handleMessage abstract

  □ HandlerRegistry + MiddlewareChain helpers

  □ Verdict merge rules (veto > replace > defer > proceed)

  □ Conformance fixture bodies:
    □ runJournalConformance: append/read invariants, idempotency,
      backpressure, recovery, concurrency
    □ runInboxConformance: address routing, idempotency,
      tell/ask semantics
    □ runHarnessConformance: phase contract, handler ordering,
      middleware composition, span emission

  □ Tests:
    □ All conformance tests pass against memory implementations
    □ Property-based tests where applicable (@effect/vitest)
```

**Exit criteria:**
- All conformance tests green for memory implementations
- BaseHarness pseudocode from `19-foundation.md` works end-to-end with
  mock concrete harness in tests
- 90%+ test coverage on substrate code

**Deliverable:** substrate is real. Concrete harnesses can be built on
top.

### Phase 3 — Reconciler harness (Layer 4) (~2–3 weeks)

**Goal:** `ReconcilerHarness` (`@agentick/reconciler-react`) works
end-to-end. Proves the substrate AND lands the most foundational piece
of agentick.

**Why this is Phase 3, not tool executor:** the reconciler IS what
agentick is. The substrate (journal/inbox/bus/BaseHarness) is plumbing
*for* the reconciler. Proving the substrate against a peripheral
harness (tool executor) teaches us little about whether `BaseHarness`
fits the foundational one. If the substrate doesn't fit the reconciler
cleanly, we need to know that before building six other harnesses on
top.

```
Spec deliverables (lands first; can happen in parallel with Phase 2 tail):
  □ Promote v1 wire types needed by the reconciler:
    □ SemanticNode, SemanticType, SemanticMetadata (from
      packages/core/src/renderers/base.ts)
    □ FormatterRef, FormatInput, FormatResult, FormattedContent,
      FormatScope, FormatTrace, FormatDiagnostic, FormattableContent,
      FormattableBlock, FormatSourceRef
    □ ContentBlock taxonomy + MediaSource (from
      packages/shared/src/blocks.ts)
    □ RenderedTree, ContextSpec, MessageEntry, SectionEntry
    □ RuntimeDeclarations, ToolDeclaration, OutputDeclaration,
      ResourceDeclaration
    □ ReconcilerSnapshot (per 03-reconciler-harness.md §Snapshot rules)
  □ ReconcilerProtocol in spec/protocol/reconciler.ts
  □ FormatterProtocol in spec/protocol/formatter.ts

Reconciler harness implementation (in @agentick/reconciler-react,
which is Effect-free and depends only on @agentick/spec):
  □ Move v1 jsx-runtime to @agentick/reconciler-react
  □ Move v1 reconciler (react-reconciler host config) to
    @agentick/reconciler-react
  □ Move v1 components + hooks to @agentick/reconciler-react
  □ Implement ReconcilerProtocol commands:
    □ mount, rerender, unmount
    □ renderTree (compile-until-stable; hash equality; returns
      RenderedTree)
    □ renderToString, renderResource
    □ snapshot, restore
    □ notifyLifecycle
  □ Implement inbox: recompile, unmount messages
  □ Lifecycle handlers: onAsyncResolved, onCompileForcedStable,
    onRuntimeError
  □ aroundCompile, aroundRender middleware
  □ HookBridges interface for runtime to inject
  □ Handler registry for long-lived primitives (handler ID resolution)
  □ ReactiveCellState capture/restore (CompilerSnapshot.cells)
  □ useDataCache (Layer 2)

Formatter harness (small; tightly bound to the reconciler in v2):
  □ FormatterHarness extends BaseHarness<"formatter">
  □ Built-in formatters: markdown, xml, text, json
    (port v1 MarkdownRenderer + XMLRenderer to reconciler-react)
  □ Formatter registry
  □ FormatScope nested resolution
  □ aroundFormat middleware
  □ runFormatterConformance passes

Tests:
  □ Port v1 reconciler tests
  □ Port v1 compiler tests (RenderedTree shape changed; substantial
    rework expected)
  □ Port v1 renderer tests (markdown/xml)
  □ Compile-until-stable convergence
  □ Async component resolution
  □ Snapshot/restore round-trip
  □ notifyLifecycle fires useOnTickEnd / useLoopControl hooks correctly
  □ All five surfaces verified end-to-end
  □ OTel exporter integration: spans appear with correct attributes
  □ Backpressure verified
```

**Exit criteria:**
- Reconciler harness ships in `@agentick/reconciler-react`
- Formatter harness ships (built-in markdown/xml)
- All v1 reconciler + compiler + renderer tests pass against v2
- Substrate properties (durability, idempotency, observability) prove
  out for the foundational harness
- This is the **"architecture is real"** milestone — the JSX/React
  reconciler is now properly harnessed with the v2 substrate

**Deliverable:** the reconciler is harnessed. Every subsequent harness
(executor, tool, loop, session, app) builds on this proof. Going
forward, the rest is mostly mechanical extension.

### Phase 4 — Remaining harnesses (~2–3 weeks)

**Goal:** all remaining harnesses implemented and tested. Order matters
because of dependencies. Tool executor moves here (was Phase 3) because
the reconciler took its place as the proof harness.

#### 4a. Tool executor (~1 week)

```
Tasks:
  □ ToolExecutorHarness extends BaseHarness<"tool">
  □ Implement dispatch command (① Commands)
    □ Validate input against tool inputSchema (Standard Schema)
    □ Run before-dispatch lifecycle handlers
    □ Run aroundDispatch middleware
    □ Confirmation flow (when requiresConfirmation)
    □ Resolve use: deps
    □ Invoke handler
    □ Emit events per phase
  □ Implement abort + confirmation-response inbox messages (② Inbox)
  □ Implement onConfirmationRequired, onValidationError,
    onHandlerError lifecycle handlers (③)
  □ Expose aroundDispatch middleware (④)
  □ Emit tool:* events per taxonomy in 10-events-handlers-inbox.md

Tests:
  □ Port v1 tool execution tests
  □ All five surfaces verified
```

#### 4b. Executor harness (~1 week)

```
Tasks:
  □ Base ExecutorHarness extends BaseHarness<"executor">
  □ LanguageModelExecutor base class (project/execute/normalize phases)
  □ ExecutorTerminal envelope + outcome handling
  □ Streaming with ExecutorDelta events
  □ Tool call detection
  □ Inbox: abort
  □ Lifecycle handlers: onProviderRequest, onProviderResponse,
    onToolCallDetected, onProviderError
  □ aroundProject, aroundExecute, aroundNormalize middleware

  □ Port v1 adapter packages to v2 contracts:
    □ @agentick/executor-anthropic
    □ @agentick/executor-openai (port from v1 @agentick/openai)
    □ @agentick/executor-google (port from v1 @agentick/google)
    □ @agentick/executor-ai-sdk (port from v1 @agentick/ai-sdk)
    □ @agentick/executor-mock (new; for tests)

Tests:
  □ Port v1 adapter tests
  □ Streaming delta + terminal correctness
  □ Tool call extraction
  □ Provider-side tool execution (tool_result in output, omit from toolCalls)
  □ Per-provider projection fixtures
```

#### 4c. Loop executor (~3 days)

```
Tasks:
  □ LoopExecutorHarness extends BaseHarness<"loop">
  □ Tick algorithm per 05-loop-executor.md
  □ runExecution command
  □ Inbox: halt, pause
  □ Lifecycle handlers: onExecutionStart, onTickStart, onTickEnd,
    onExecutionEnd
  □ aroundExecution, aroundTick middleware
  □ Default continuation policy (from-stop-reason)

Tests:
  □ Single tick success
  □ Multi-tick tool loop
  □ Max ticks termination
  □ Cancellation at each phase
  □ Tick-end forwarding through onTickEnd handler
```

#### 4d. Session harness (~1 week)

```
Tasks:
  □ SessionHarness extends BaseHarness<"session">
  □ All commands per 08-session-harness.md
  □ apply* commands (timeline writes)
  □ notifyLifecycle command
  □ Inbox: send, dispatch, abort, pause, resume, hibernate, restore,
    inject-input, recover, close
  □ Lifecycle handlers: onMount, onHibernateBefore, onSpawn, etc.
  □ Cross-harness wiring at construction:
    □ loop.onTickEnd → session.notifyLifecycle → react.notifyLifecycle
    □ loop.onExecutorTerminal → session.applyExecutorResult
    □ loop.onToolResults → session.applyToolResults
  □ Lifecycle states (idle | running | paused | hibernating | hibernated | restoring | closed)
  □ Per-session command lock (Effect Semaphore)
  □ Persistence integration (writes session record on lifecycle transitions)

Tests:
  □ Port v1 session lifecycle tests
  □ Send → execution → result round-trip
  □ Mid-execution interaction (queueMessage, abort)
  □ Spawn child sessions
  □ Hibernate / restore round-trip
```

#### 4e. App harness (~3 days)

```
Tasks:
  □ AppHarness extends BaseHarness<"app">
  □ createSession, runOnce, getSession, listSessions, closeApp
  □ Inbox: create-session, close-app, list-sessions
  □ Lifecycle handlers: onSessionCreate, onSessionClose, onAppClose
  □ Session registry (in-memory; cluster wrapper replaces in Phase 5)
  □ App-level service installation (renderers, executors, persistence,
    telemetry)
  □ createApp public API; AppOptions shape

Tests:
  □ Port v1 app integration tests
  □ runOnce ephemeral session
  □ Multiple session orchestration
  □ Telemetry attached
```

**Phase 4 Exit criteria:**
- All harnesses implemented
- All v1 tests pass against v2 (or explicitly retired with documented
  reason)
- Integration tests for full agent runs end-to-end
- v2 example app (Hello World agent) runs

### Phase 5 — Adapters and wrappers (~2–3 weeks)

**Goal:** production-ready substrates.

```
Persistence:
  □ @agentick/persistence-sqlite implements OperationJournal
    □ Schema migrations
    □ Pass runJournalConformance
  □ @agentick/persistence-postgres implements OperationJournal
    □ Schema migrations
    □ Pass runJournalConformance
    □ Query optimization for timeline reads
  □ @agentick/persistence-redis (channel storage variant)

Cluster (optional for v2.0; defer to v2.1 if time-constrained):
  □ @agentick/cluster wraps with @effect/cluster
    □ SessionEntity (sharded)
    □ SupervisorEntity (singleton)
    □ Inbox routing across nodes
    □ Pass conformance suites against distributed substrate
    □ Two-stage subscription registration

Gateway (optional for v2.0):
  □ @agentick/gateway core (refined from v1)
  □ @agentick/server-express (renamed)
  □ @agentick/server-fastify (new; if needed)
  □ Resume buffer + sequence-based replay

Conformance verification:
  □ All persistence backends pass runJournalConformance
  □ Cluster mode passes runJournalConformance + runInboxConformance
  □ Gateway transport tests
```

**Exit criteria:** production-ready stack. Conformance suite green for
all backends.

### Phase 6 — Migration and v1 sunset (~1–2 weeks)

```
Tasks:
  □ Port all v1 example apps to v2:
    □ example/express → v2 with @agentick/server-express
    □ Other examples
  □ Port @agentick/mcp to v2 substrate (if not already done in Phase 4)
  □ Port @agentick/sandbox-* to v2 substrate
  □ Update @agentick/client-tui to use v2 client
  □ Update @agentick/client-devtools to use v2 event streams

  □ Remove v1 packages:
    □ @agentick/core
    □ @agentick/kernel
    □ @agentick/shared compat re-exports

  □ Update all docs:
    □ Top-level README
    □ Per-package READMEs
    □ Website (typedoc, vitepress)
    □ Migration guide for v1 → v2 users

  □ Cut v2.0 release:
    □ Final changeset
    □ Linked-version bump to 2.0.0
    □ Tag main
    □ Publish all @agentick/* packages
    □ GitHub release notes
```

**Exit criteria:** v2.0 published. v1 retired. Migration guide live.

## v1 test triage

Categorize and act per category. Most tests survive.

### Wire-format tests → port to spec

```
packages/shared/src/__tests__/blocks.spec.ts            → @agentick/spec
packages/shared/src/__tests__/messages.spec.ts          → @agentick/spec
packages/shared/src/__tests__/timeline.spec.ts          → @agentick/spec
packages/shared/src/__tests__/protocol.spec.ts          → @agentick/spec
packages/shared/src/__tests__/tools.spec.ts             → @agentick/spec
```

Mostly intact; just import from spec instead of shared.

### Streaming/event tests → update for envelope wrapping

```
packages/shared/src/__tests__/streaming.spec.ts
```

Update for `EventEnvelope` shape; behavioral assertions preserved.

### Session/integration tests → repoint at v2 runtime in Phase 4e

```
packages/core/src/__tests__/session*.spec.ts
packages/core/src/__tests__/integration.spec.ts
```

These test high-level behaviors (session.send, session.dispatch). They
become integration tests for the v2 runtime. Substantial value
preserved.

### COM tests → DELETE

```
packages/core/src/com/__tests__/*
```

The COM is gone. These tests are obsolete.

### Compiler tests → substantial rework in Phase 4b

```
packages/core/src/compiler/__tests__/*
packages/core/src/com/types.spec.ts
```

`RenderedTree` shape changed. Tests need updating but the
behaviors (render-until-stable, async resolution, snapshot/restore)
still apply.

### Reconciler tests → port to reconciler-react in Phase 4b

```
packages/core/src/reconciler/__tests__/*
patches/ink@5.2.1.patch tests
```

Mostly portable — reconciler internals don't change much.

### Tool tests → port to tool executor in Phase 3

```
packages/core/src/tool/__tests__/*
```

Port early; this is the proof harness.

### Adapter tests → port to executor packages in Phase 4c

```
packages/openai/__tests__/*    → @agentick/executor-openai
packages/google/__tests__/*    → @agentick/executor-google
packages/ai-sdk/__tests__/*    → @agentick/executor-ai-sdk
```

Update imports + provider call shapes; behavioral fixtures preserved.

### Procedure / kernel tests → mostly retire or fold

```
packages/kernel/src/*.spec.ts
```

Procedure system is replaced by BaseHarness. Most tests obsolete.
Some (telemetry, FiberRef helpers) might survive as runtime tests.

## Day 1 task list

Concrete, executable today:

```
Morning:
  □ git checkout feat/v2 (branch already exists)
  □ Pull latest
  □ Create packages/spec/ folder structure:
      packages/spec/package.json    ({ name, private: false, deps: {} })
      packages/spec/tsconfig.json   (extends root)
      packages/spec/tsconfig.build.json
      packages/spec/README.md       (basic; expand later)
      packages/spec/src/index.ts    (empty exports)
  □ Create packages/ folder
  □ Create packages/spec-conformance/ folder structure:
      packages/spec-conformance/package.json    ({ private: true })
      packages/spec-conformance/tsconfig.json
      packages/spec-conformance/src/index.ts
  □ Update pnpm-workspace.yaml:
      packages:
        - 'packages/*'
        - 'packages/*'
  □ Update .changeset/config.json: add new packages to linked array
      (only @agentick/spec for now; others added per phase)
  □ pnpm install (verify workspace)
  □ pnpm typecheck (should be green; no behavior change)

Afternoon:
  □ Begin Phase 0 atomic rename:
      □ git mv packages/react packages/client-react
      □ Update packages/client-react/package.json name field
      □ Find/replace @agentick/react → @agentick/client-react in all
        package.json files and source imports
      □ Repeat for express → server-express, tui → client-tui,
        devtools → client-devtools, openai → executor-openai,
        google → executor-google, ai-sdk → executor-ai-sdk
  □ pnpm install (verify)
  □ pnpm test (verify v1 tests still green)
  □ Commit: "chore(v2): rename packages per substrate-aware naming pattern"

EOD checkpoint:
  □ Workspace has new spec + spec-conformance packages
  □ All v1 packages renamed atomically
  □ v1 tests still green
  □ Ready to begin Phase 1 type promotion Day 2
```

## Definition of done per phase

| Phase | Done = |
| --- | --- |
| 0 | renames atomic, v1 tests green, new packages skeletoned |
| 1 | spec compiles + exports all contract types; ported wire-format tests green |
| 2 | conformance tests green for memory substrate |
| 3 | tool executor end-to-end passes all v1 tool tests |
| 4 | all harnesses pass conformance + ported v1 tests; Hello World agent runs |
| 5 | persistence backends + (optionally) cluster + gateway pass conformance |
| 6 | v1 retired, docs updated, v2.0 published |

## Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Substrate proves wrong shape | 2–3 | Phase 3 is the test; if it doesn't fit, halt and rethink before building all harnesses |
| Conformance suite is too lax (catches less than expected) | 2–3 | Property-based tests + explicit invariant fixtures; tighten as we discover edge cases |
| `@effect/cluster` integration fails | 5 | Spike early in Phase 5; can defer cluster to v2.1 if needed |
| Schema evolution breaks production | 6+ | Spec versioning enforced; conformance fixtures cross-version |
| `ReconcilerSnapshot` shape doesn't survive non-React substrate | future | Spec types are extensible; first non-React reconciler will inform refinement |
| Browser bundle Effect leak | 4b/5 | Build inspection on every release; trim transitive deps |
| Provider adapter regressions | 4c | v1 adapter tests are the regression suite; keep them green |
| v1 → v2 migration breaks user code | 6 | No backwards compat per CLAUDE.md, but write a migration guide; major version bump |

## Pull-back-and-replan criteria

Halt and rethink if:

- **Phase 3 conformance tests reveal substrate-level bugs** (e.g.,
  idempotency replay returns wrong result, lifecycle handler ordering
  is not deterministic). Don't paper over; fix the substrate before
  proceeding.
- **A harness can't be expressed in the BaseHarness pattern** without
  awkward workarounds. The pattern should fit; if it doesn't, the
  pattern is wrong.
- **Performance issue in Phase 4** (e.g., per-tick overhead
  unacceptable). Profile, identify substrate cause, fix.
- **`@effect/cluster` integration unavoidably leaks abstractions** into
  the runtime API. May need to refine the cluster wrapper boundary.

In each case: stop forward progress, write up the issue, propose a
correction in the blueprint, get sign-off, then continue.

## Open questions deferred to implementation

These were noted in `17-open-questions.md` and are not gating but will
need answers during implementation:

- Persistence backend method shapes (A19)
- ExecutorDelta wire shape (A13)
- Provider-side tool execution marker (C6)
- Handler ID validation mechanism (B5)
- features[] registry (A1)
- Spec version migration on restore (E11)
- Inbox idempotency cache size + TTL
- Per-harness inbox message catalogs (cross-validation across docs)
- Cluster routing layer integration with @effect/cluster (spike)

These will be resolved in Phases 1–5 as we hit them, captured in
follow-up blueprint updates.

## Communication

- Phase boundaries are commit milestones. Tag the repo:
  `v2-phase-1-complete`, `v2-phase-2-complete`, etc.
- Update `17-open-questions.md` whenever a question is resolved.
- Update this plan if scope or sequencing changes.
- Each phase's exit criteria are commit-blocking — don't merge to
  `feat/v2` HEAD without green tests for that phase's deliverables.

## Status tracking

**Running execution state lives in [`STATUS.md`](./STATUS.md).** Update
that file (not this one) at the end of every work block. This plan
contains phasing and exit criteria; STATUS.md tracks what's actually
been done, what's blocked, what decisions were made during execution,
and environment quirks.

Quick state at-a-glance (high-level only; details in STATUS.md):

```
Phase 0  ■ in progress    (started 2026-05-08; spec scaffolds done,
                           renames pending decisions)
Phase 1  □ blocked on Phase 0
Phase 2  □ blocked on Phase 1
Phase 3  □ blocked on Phase 2
Phase 4  □ blocked on Phase 3
Phase 5  □ blocked on Phase 4
Phase 6  □ blocked on Phase 5
```

---

**Next:** execute Day 1 task list. Day 2 begins Phase 1 type promotion
once the workspace is ready.
