# 18 — Traceability Map

**Status:** Synthesized

This doc maps every blueprint section back to its source proposal. It
also collects every `[GAP]`, `[PLACEHOLDER]`, and `[PROPOSAL]` marker so
the punch list of unresolved items is enumerable in one place.

## Source proposal index

```
docs/proposals/v2/
  harness-principle.md          → 01, foundation for everything
  compiled-spec.md              → 02 (data side)
  spec-package.md               → 02 (package layout), 13
  compiler-harness.md           → 03, 04
  renderer-harness.md           → 04
  loop-executor.md              → 05
  executor.md                   → 06, 07 (tool executor sub-section)
  runtime.md                    → 08, 09, 14 (storage),
                                  parts of 11 (when not yet split out)
  cluster.md                    → 11
  gateway.md                    → 12
```

## Blueprint section → source map

| Blueprint section | Primary source(s) | Secondary source(s) |
| --- | --- | --- |
| `00-overview.md` | (synthesis) | all source docs |
| `01-harness-principle.md` | `harness-principle.md` | runtime.md §Unified Event/Interceptor Engine |
| `02-data-model.md` §RenderedTree | `compiled-spec.md §Core Shape, §Required Invariants` | spec-package.md §Data Contracts |
| `02` §ContextSpec / Entries | `compiled-spec.md §Context Entries, §Sections` | — |
| `02` §RuntimeDeclarations | `compiled-spec.md §Runtime Declarations` | — |
| `02` §Content blocks | `[V1-INHERITED]` `packages/shared/src/blocks.ts` | spec-package.md §V1 Type Sources |
| `02` §SemanticNode | `[V1-INHERITED]` `packages/core/src/renderers/base.ts` | renderer-harness.md §Protocol Types |
| `02` §Renderer types | `renderer-harness.md §Protocol Types` | compiler-harness.md §Formatter harness contract |
| `02` §SpecConfig / ProviderOptions | `compiled-spec.md §Config and Provider Options` | — |
| `02` §ExecutionResult / ExecutorTerminal | `executor.md §Result Normalization` | spec-package.md §Protocol vs implementation naming |
| `02` §LanguageModelExecutionResult | `executor.md §LanguageModelExecutionResult` | — |
| `02` §EventEnvelope / ProtocolEvent | `harness-principle.md §Canonical event envelope` | spec-package.md §Shared event integration contracts |
| `02` §Channel types | `[V1-INHERITED]` `packages/shared/src/protocol.ts` | spec-package.md §Channel types |
| `02` §Standard Schema interface | `spec-package.md §Validation Strategy` | (decided: inline) |
| `03-reconciler-harness.md` §Commands | `compiler-harness.md §React Harness Contract / Commands in` | — |
| `03` §Pipeline | `compiler-harness.md §Compile Pipeline` | — |
| `03` §Hooks model | `compiler-harness.md §Hooks Model` | runtime.md (earlier draft) §Hooks |
| `03` §Async components | `compiler-harness.md §Async Components` | — |
| `03` §Long-lived primitives | `compiler-harness.md §Long-Lived Primitives` | runtime.md §Long-lived JSX primitives |
| `03` §Snapshot shape (`[PROPOSAL]`) | (synthesized) | compiler-harness.md §Compile-Until-Stable |
| `04-formatters.md` | `renderer-harness.md` (entire) — downgraded to pure functions per ADR 22 | compiler-harness.md §Formatter Harness |
| `05-loop-executor.md` | `loop-executor.md` (entire) | runtime.md §Tick Loop |
| `05` §State applicator (`[PLACEHOLDER]`) | (synthesized) | loop-executor.md §commands (referenced) |
| `06-executor-harness.md` | `executor.md` §Executor Harness | — |
| `06` §Three phases | `executor.md §Three-Phase Contract` | — |
| `06` §LanguageModelExecutor | `executor.md §Default Executor Family` | — |
| `06` §Tool call boundary | `executor.md §Tool Call Boundary` | loop-executor.md §Relationship to Tool Executor |
| `07-tool-executor.md` | `executor.md §Tool Executor Harness` | (synthesized two-doors mapping from runtime.md) |
| `07` §`use:` deps capture | `[V1-INHERITED]` `CLAUDE.md §Context Injection Pattern` | — |
| `07` §Stateful tool render | `[V1-INHERITED]` `CLAUDE.md §Stateful Tool Pattern` | — |
| `08-session-harness.md` §Commands | `runtime.md §Session Harness` | — |
| `08` §Lifecycle states | (synthesized) | runtime.md §Session Lifecycle States (earlier draft) |
| `08` §SessionSnapshot | (synthesized) | `[V1-REPLACED]` `packages/core/src/app/types.ts:849` |
| `08` §pause/resume/inject/recover (`[PROPOSAL]`s) | (gap) | — |
| `09-app-harness.md` | `runtime.md §App Harness` | — |
| `09` §AppOptions | `[V1-INHERITED]` `packages/core/src/app/types.ts:458` | — |
| `09` §Telemetry | `runtime.md §Observability` | (earlier draft §Telemetry) |
| `10-events-and-interceptors.md` | `harness-principle.md` (entire) | runtime.md §Unified Event/Interceptor Engine |
| `10` §Per-surface event catalog | (synthesis) | every per-harness doc |
| `10` §v1 → v2 event mapping | `[V1-INHERITED]` `packages/shared/src/streaming.ts` | — |
| `10` §Backpressure (`[PROPOSAL]`) | (gap) | runtime.md §Headless |
| `11-cluster.md` | `cluster.md` (entire) | runtime.md (earlier draft §Effect Cluster mapping) |
| `11` §App Supervisor | `cluster.md §App Supervisor as singleton entity` | runtime.md (earlier) |
| `11` §Two-stage subscription | `cluster.md §Two-stage subscription registration` | compiler-harness.md §Long-Lived Primitives |
| `12-gateway.md` | `gateway.md` (entire) | — |
| `12` §Resume semantics | `gateway.md` + runtime.md (earlier) §Open Q 16 | — |
| `12` §Framework channels | `[V1-INHERITED]` `packages/shared/src/protocol.ts` | — |
| `13-package-graph.md` | `spec-package.md §Package Layout` | runtime.md §Runtime Scope |
| `13` §v1 → v2 migration | (synthesis) | spec-package.md §Migration |
| `14-state-tiers.md` §Tiers | (synthesis) | runtime.md §Session Lifecycle States |
| `14` §Persistence | `runtime.md §Persistence and Lifecycle` | (earlier draft §Persistence) |
| `14` §Compiler snapshot (`[PROPOSAL]`) | (synthesis) | spec-package.md §ReconcilerSnapshot opaque |
| `15-flows/a-cold-start-and-mount.md` | (synthesis) | 03, 08, 11 |
| `15-flows/b-tick-and-tool-loop.md` | (synthesis) | 03, 05, 06, 07, 08 |
| `15-flows/c-hibernate-and-restore.md` | (synthesis) | 03, 08, 11, 14 |
| `15-flows/d-streaming-and-terminal.md` | (synthesis) | 06, 10, 12 |
| `15-flows/e-resource-render-no-loop.md` | (synthesis) | 03, 04 |
| `16-glossary.md` | (consolidation) | — |
| `17-open-questions.md` | (consolidation across source proposals) | — |
| `18-traceability.md` | (this doc) | — |

## v1 source citations used

```
packages/shared/src/blocks.ts                    (ContentBlock taxonomy)
packages/shared/src/block-types.ts               (BlockType, MessageRole, MediaSourceType, mime types, code lang)
packages/shared/src/streaming.ts                 (event taxonomy ~43 variants, StopReason, UsageStats)
packages/shared/src/protocol.ts                  (ChannelEvent, FrameworkChannels, EphemeralPosition, payloads)
packages/shared/src/messages.ts                  (Message, MessageRoles, message helpers)
packages/shared/src/tools.ts                     (ToolExecutionType, ToolExecutor, ToolIntent, ToolDefinition,
                                                  ClientToolDefinition, ToolCall, ToolResult)
packages/shared/src/timeline.ts                  (TimelineEntry base)
packages/shared/src/models.ts                    (UsageStats, ResponseFormat)
packages/core/src/compiler/types.ts              (v1 RenderedTree, CompiledTimelineEntry,
                                                  CompiledSection, CompiledEphemeral, CompileResult)
packages/core/src/com/types.ts                   (COMInput, COMTimelineEntry, COMSection, EngineInput,
                                                  EphemeralEntry — all replaced by RenderedTree in v2)
packages/core/src/com/object-model.ts            (the COM mutation API — REMOVED in v2)
packages/core/src/app/session.ts                 (executeTick, lifecycle, persistence — split into harnesses)
packages/core/src/app/types.ts                   (AppOptions, SessionOptions, ExecutionRunner,
                                                  LifecycleCallbacks, SessionSnapshot, Session interface,
                                                  SendInput, SendResult, SessionExecutionHandle)
packages/core/src/renderers/base.ts              (Renderer abstract class, Formatter, SemanticNode,
                                                  SemanticType, SemanticContentBlock — split between
                                                  FormatterRef wire shape and Renderer impls)
packages/core/src/renderers/markdown.ts          (MarkdownRenderer impl)
packages/core/src/renderers/xml.ts               (XMLRenderer impl)
CLAUDE.md                                        (Stateful Tool Pattern, Context Injection Pattern,
                                                  package architecture, two-doors framing)
```

## All `[GAP]` markers in the blueprint

These are places where the source proposals leave the design undefined.
Listed by section.

| Where | What | Tracked in `17` as |
| --- | --- | --- |
| 02 §`features[]` | enumeration not in source | A1 |
| 02 §`MCPDeclaration` | shape not in source | A4 |
| 02 §`ModelSelection` | shape not in source | A5 |
| 02 §`TargetCapabilities` | not enumerated | A7 |
| 02 §`KnobState` etc. | shapes synthesized | A8 |
| 02 §`ExecutorDelta` | minimum shape open | A13 |
| 03 §commands input/output | full types not in source | (synthesized inline) |
| 03 §Hook bridges | exact surface not in source | A17 |
| 03 §Compile-until-stable cap | not specified | B1 |
| 03 §Equality strategy | not specified | B3 |
| 03 §Async hibernate | open | B4 |
| 03 §Handler resolution | not designed | B5 |
| 03 §useResolved Layer 1 | not named | B9 |
| 04 §Renderer impls package | open | B12 |
| 04 §`renderToText` separation | open | B11 |
| 04 §Streaming renderers | open | B10 |
| 04 §Renderer options schema | open | A14 |
| 05 §State applicator shape | not specified | A11 |
| 05 §Continuation policy shape | not specified | A12 |
| 05 §Parallel tool dispatch | open | C2 |
| 05 §Provider-side tool marker | open | C6 |
| 06 §`ExecutionTarget` strictness | open | C5 |
| 06 §`raw` payload policy | open | C7 |
| 06 §Cross-family base events | open | C8 |
| 06 §Section projection format | open | B13 |
| 07 §`ToolHandlerCtx` shape | not specified | A15 |
| 07 §`ToolRegistry` interface | not specified | A16 |
| 07 §OutputDeclaration ↔ Tool | open | J1 |
| 07 §Client tool registration | open | J3 |
| 07 §`session.shell` no-sandbox | open | E4 |
| 08 §pause/resume/inject/recover | not designed | E1, E2, E3 |
| 08 §`KnobState` etc. | placeholders | A8 |
| 08 §SessionSnapshot vs v1 | replaced; details open | A9 |
| 09 §Multi-tenant rate limiter | open | H8 |
| 09 §Metric names/units | not specified | L2 |
| 09 §SessionRegistry shape | not specified | A20 |
| 10 §Cross-surface re-emission | open convention | F4 |
| 10 §Default channel retention | not specified | F11 |
| 10 §Backpressure semantics | contradicting in source | F9 |
| 10 §Cluster-wide event id | open format | F13 |
| 10 §`next()` typing | open | F12 |
| 11 §Routing substrate | open | H1 |
| 11 §Migration overhead | open | H6 |
| 11 §Supervisor failover | open | H7 |
| 11 §App-level interceptor replication | open | H10 |
| 12 §`GatewayProtocol` shape | not specified | A18 |
| 12 §Server-side resume buffer defaults | open | I6 |
| 13 §`@agentick/react-hooks` separate | open | (lean: separate) |
| 14 §`ReconcilerSnapshot` shape | open (most consequential) | A10 |
| 14 §Default timeline window | open | E9 |
| 14 §Persistence backend interface | partial | A19 |
| 14 §`useResolved` layers | naming open | B9 |
| 14 §Persistent spawn opt-in | open | E5 |
| 14 §Large content threshold | open | K3 |

## All `[PROPOSAL]` markers (positions taken pending sign-off)

| Where | Proposal | Tracked in `17` as |
| --- | --- | --- |
| 01 §Surface set | `app|session|loop|react|renderer|executor|tool` (+cluster|gateway when wrapping) | F4 / G5 |
| 01 §Interceptor merge rules | veto > replace > defer > proceed | F2 |
| 02 §`features[]` registry | 8-name list | A1 |
| 02 §`SemanticNode.formatter` rename | `formatter` → `rendererRef` | (gap) |
| 02 §`MCPDeclaration` shape | id + serverName + transport + config + exposes | A4 |
| 03 §Compile cap | 16 iterations | B1 |
| 03 §Equality | hash-on-emit (canonicalized JSON) | B3 |
| 03 §`forcedStable` policy | warn-only in dev, warn+metric in prod | B2 |
| 03 §Async hibernate | cancel + re-run on restore; doc `useData` | B4 |
| 03 §Handler resolution | registry rebuilt per render | B5 |
| 03 §`useResolved` Layer 1 | persistent (Tier 2) | B9 |
| 03 §`ReconcilerSnapshot` shape | small structured payload | A10 |
| 04 §`renderToText` | separate command | B11 |
| 04 §Streaming renderers | ship surface, no v2 built-in | B10 |
| 04 §Renderer options | per-renderer Standard Schema | A14 |
| 04 §Renderer impl home | `@agentick/react` | B12 |
| 05 §`StateApplicator` shape | placeholder interface | A11 |
| 05 §`ContinuationPolicy` shape | function + interceptor combo | A12 |
| 05 §Parallel tool dispatch | per-call hint via interceptor | C2 |
| 06 §`ExecutorDelta` | 6-kind union | A13 |
| 06 §Provider-side tool marker | absence-from-toolCalls | C6 |
| 06 §`raw` payload | opt-in via `RunInput.includeRaw` | C7 |
| 06 §Section projection | XML-tag wrapping (Anthropic/Google), developer-msg with prefix (OpenAI) | B13 |
| 06 §`ExecutionTarget` strictness | best-effort | C5 |
| 07 §`ToolHandlerCtx` | inherited from v1 stateful pattern | A15 |
| 07 §`OutputDeclaration` ↔ Tool | synthetic handler | J1 |
| 07 §Client tools | gateway bridge handler | J3 |
| 07 §`session.shell` no-sandbox | `ToolNotFoundError` | E4 |
| 08 §pause/resume table | lean policy | E1 |
| 08 §inject semantics | placeholder | E2 |
| 08 §recover taxonomy | 4 strategies | E3 |
| 09 §Multi-tenant limiter | backend-managed | H8 |
| 09 §Metric names | listed | L2 |
| 10 §Backpressure | lazy fan-out + per-subscriber buffer | F9 |
| 10 §Default channel retention | 256 entries OR 30 min | F11 |
| 11 §Routing substrate | `@effect/cluster` | H1 |
| 11 §Cluster bus default | Redis Streams (small/med), NATS (high) | H9 |
| 12 §Default transports | HTTP+SSE, WS, in-process | I1 |
| 12 §Server-side resume buffer | 256 events / 5 min | I6 |
| 14 §Hibernation defaults | 15 min idle, LRU cap | E6 |
| 14 §Forced abort timeout | 5s | E8 |
| 14 §Compiler snapshot shape | structured | A10 |
| 14 §Persistent spawn | `{ persist: true }` | E5 |

## All `[PLACEHOLDER]` markers (synthesized types from v1 shape)

| Where | What | Tracked in `17` as |
| --- | --- | --- |
| 02 §`ToolAnnotations` | inherited from v1 ToolDefinition | A3 |
| 02 §`MCPDeclaration` | inherited from v1 `<MCP>` component | A4 |
| 02 §`ModelSelection` | new | A5 |
| 02 §`TargetCapabilities` | from v1 `ContextUpdateEvent` | A7 |
| 02 §`ExecutorDelta` | placeholder | A13 |
| 03 §`HookBridges` | placeholder | A17 |
| 04 §`FormatterRegistry` | placeholder | (lean) |
| 05 §`StateApplicator` | placeholder | A11 |
| 05 §`ContinuationPolicy` | placeholder | A12 |
| 07 §`ToolHandlerCtx` | from v1 stateful pattern | A15 |
| 07 §`ToolRegistry` | placeholder | A16 |
| 08 §`KnobState`, `ChannelState`, etc. | placeholders | A8 |
| 09 §`SessionRegistry` | placeholder | A20 |
| 12 §`GatewayProtocol` | placeholder | A18 |
| 14 §`PersistenceBackend` methods | placeholder | A19 |
| 14 §`SessionRecord` | placeholder | A9 |
| 14 §`ReconcilerSnapshot` | placeholder | A10 |

## All `[V1-INHERITED]` callouts

Things v2 keeps directly from v1 (sometimes promoted across packages):

```
ContentBlock taxonomy                  packages/shared/src/blocks.ts
BlockType / MessageRole / MediaSourceType  packages/shared/src/block-types.ts
ToolCall / ToolResult                  packages/shared/src/tools.ts
ToolExecutor enum                      packages/shared/src/tools.ts
UsageStats                             packages/shared/src/models.ts
ResponseFormat                         packages/shared/src/models.ts
TimelineEntry base                     packages/shared/src/timeline.ts
Message / MessageRoles                 packages/shared/src/messages.ts
ChannelEvent / FrameworkChannels       packages/shared/src/protocol.ts
ToolConfirmationRequest/Response       packages/shared/src/protocol.ts
DiffPreviewMetadata                    packages/shared/src/streaming.ts
Stream sequence numbers                packages/shared/src/streaming.ts (StreamEventBase)
spawnPath                              packages/shared/src/streaming.ts
SemanticNode / SemanticType            packages/core/src/renderers/base.ts
MarkdownRenderer / XMLRenderer         packages/core/src/renderers/
Two-doors model                        v1 architecture
Stateful tool render() pattern         CLAUDE.md
use: deps capture                      CLAUDE.md
session.append, session.shell          v1 Session
useResolved (Layer 1)                  v1 hooks
Recording mode taxonomy                v1 SessionOptions
```

## All `[V1-REPLACED]` callouts

Things v2 explicitly replaces:

```
COM (1268 LOC mutation API)                 → React fiber tree + session state
RenderedTree (Map-based, with refs)    → RenderedTree (JSON-shaped)
COMInput (model adapter input)              → RenderedTree
EngineInput                                 → RenderedTree
Tool.audience                               → ToolDeclaration.exposure
SectionEntry.intent (closed enum)           → dropped
EphemeralEntry / EphemeralPosition          → compile/runtime transient input only
StructureRenderer (mixed responsibilities)  → formatter harness + executor projection (split)
Formatter (function on SemanticNode)        → FormatterRef
ExecutionRunner.transformCompiled           → loop interceptor on `compile` (replace)
ExecutionRunner.executeToolCall             → tool executor interceptor on `dispatch`
ExecutionRunner.onSessionInit/onPersist/    → session interceptors on lifecycle commands
  onRestore/onDestroy
LifecycleCallbacks                          → observers on `*:terminal` events
EventEmitter on session                     → session-scoped PubSub
ToolExecutionType.OUTPUT                    → OutputDeclaration + Tool
EngineModel.fromEngineState/toEngineState   → executor project / normalize phases
EngineModel.stream/generate                 → executor execute phase
v1 SessionSnapshot (timeline embedded)      → SessionRecord + separate timeline storage
~17-value StopReason enum                   → 6-value LanguageModelStopReason
Distributed-by-default (early v2 draft)     → library-first; cluster optional
Session = sharded entity (early v2)         → library object; cluster wraps
v1 Compiler `system`/`timelineEntries`/     → ContextEntry (MessageEntry|SectionEntry)
  `sections` separate fields
Channel "ephemeral broadcast"               → channel with retention=short
DevTools events in main stream              → separate DevTools bus
```

## How to use this map

- **Reviewing the blueprint:** open the relevant blueprint section, then
  the source proposal section it points to, to see what was synthesized
  vs what was already decided.
- **Implementing v2:** the `17-open-questions.md` priority list (items
  1–10) blocks substantial portions of the codebase; everything else
  can proceed with placeholders flagged.
- **Updating the blueprint:** when a source proposal changes, update
  this traceability map and re-flag any consequent blueprint sections.

## End of blueprint

The blueprint contains:

```
00-overview.md
01-harness-principle.md
02-data-model.md
03-reconciler-harness.md
04-formatters.md
05-loop-executor.md
06-executor-harness.md
07-tool-executor.md
08-session-harness.md
09-app-harness.md
10-events-and-interceptors.md
11-cluster.md
12-gateway.md
13-package-graph.md
14-state-tiers.md
15-flows/a-cold-start-and-mount.md
15-flows/b-tick-and-tool-loop.md
15-flows/c-hibernate-and-restore.md
15-flows/d-streaming-and-terminal.md
15-flows/e-resource-render-no-loop.md
16-glossary.md
17-open-questions.md
18-traceability.md  (this file)
```

23 docs, ~25K words synthesized from the 9 source proposals plus
selective v1 source-code grounding. Ready for review.
