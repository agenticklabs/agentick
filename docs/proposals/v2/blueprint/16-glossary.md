# 16 — Glossary

**Status:** Synthesized

Every v2 term in one place, with v1 cross-references where helpful. When
the same word is overloaded across layers, both meanings are listed.

## Core architecture

**Harness**
A self-contained component with a four-surface integration boundary
(commands, events, interceptors, outcomes). v2's load-bearing
abstraction. See `01-harness-principle.md`.

**Spec firewall**
The rule that anything crossing a harness boundary is JSON-shaped data
defined in `@agentick/spec`. No Effect refs, React fibers, SDK clients,
renderer instances, or closures cross.

**Library-first**
Default deployment: in-process, no cluster, no gateway. Cluster and
gateway wrap the same harnesses without changing semantics.

**The four protocol surfaces**
Commands (in), events (out), interceptors (around), outcomes
(termination).

**Surface (event surface)**
The `EventEnvelope.surface` field. Identifies the harness emitting the
event: `app | session | loop | react | renderer | executor | tool`
(plus optional `cluster | gateway`).

**Phase**
Lifecycle stage of a command. One of: `requested | before | delta |
terminal`. Every command emits a strict, symmetric sequence.

**Outcome**
Terminal verdict for a command. One of: `succeeded | failed | canceled |
vetoed | replaced | deferred`.

**EventEnvelope / ProtocolEvent**
The canonical shape for every event in v2. See `02-data-model.md`.

**EventQuery**
The single matcher used by both observers and interceptors. See
`10-events-and-interceptors.md`.

**Hierarchical event name**
`<surface>:<domain>:<action>` with optional `:<phase>:<outcome>` in
display contexts.

## State tiers

**Reactive tree (Tier 1)**
React fiber tree owned by the reconciler harness. Holds `useState`,
`useSignal`, `useData` cache. v2's analog of the browser DOM. See
`14-state-tiers.md`.

**Session-side state (Tier 2)**
Owned by the session harness. Timeline, knobs, channels, subscription
intents, resolveCache. Persists across hibernate. v2's analog of
localStorage/cookies/history.

**Active resources (Tier 3)**
Scope-bound resources: sandbox connections, MCP clients, in-flight
streams, per-session PubSub. Released on hibernate; recreated on
restore.

**Persistent state (Tier 4)**
Survives crash, migration, redeploy. Session record, timeline entries,
channel events, large content blobs.

**SessionRecord**
Small structured row written on session lifecycle transitions. Includes
session metadata, status, currentTick, knobs, subscriptionIntents,
resolveCache, channelPointers, compilerSnapshot, usage.

**ReconcilerSnapshot**
React-harness-private state captured at hibernate. Small, structured
(`[PROPOSAL]` shape in `03-reconciler-harness.md`). Embedded in SessionRecord.

**TimelineEntry**
One persisted entry in the conversation history. Indexed by
`(sessionId, sequence)`. Inserted incrementally during execution.

## Compiled IR

**RenderedTree**
The single canonical IR produced by the reconciler harness's `renderTree`
command. Replaces v1's `RenderedTree` and `COMInput`. See
`02-data-model.md`.

**ContextSpec / ContextEntry**
Inside `RenderedTree.context`. Ordered list of model-input entries.
`ContextEntry` is `MessageEntry | SectionEntry`.

**MessageEntry**
Role-bearing entry in `context.entries`. `role` is an Agentick semantic
role (user/assistant/tool/system/event), not a provider role.

**SectionEntry**
Structured non-message entry in `context.entries` with stable `id`.
Replaces v1's `Map<string, CompiledSection>`.

**RuntimeDeclarations**
Inside `RenderedTree.declarations`. Tools, resources, outputs,
MCP declarations.

**ToolDeclaration**
Wire-safe tool registration with `id`, `name`, `description`,
`inputSchema`, `exposure` (model | dispatch | runtime), `handlerRef`.
`[V1-REPLACED]` of v1's `audience` field.

**OutputDeclaration**
Named output the application wants to extract from the result. Distinct
from `SpecConfig.responseFormat`.

**ResourceDeclaration**
Addressable runtime material (MCP resource, generated resource, etc.).

**MCPDeclaration**
MCP server registration. `[PLACEHOLDER]` shape.

**ContentBlock**
Atomic unit of content. ~21 variants discriminated by `type`.
`[V1-INHERITED]` from `packages/shared/src/blocks.ts`.

**FormattableContent / FormattableBlock / FormatScope**
Formatter harness input types. `FormattableBlock = ContentBlock +
optional SemanticNode/SemanticMetadata`. `FormatScope` represents nested
renderer providers.

**SemanticNode / SemanticType / SemanticMetadata**
`[V1-INHERITED]` from `packages/core/src/renderers/base.ts`. Carry
formatting hints (heading level, link href, etc.) for renderers.

**FormatterRef**
JSON-safe identifier for a renderer ({ id, format?, version? }).
Renderer instances are reduced to `FormatterRef` before crossing the
spec firewall.

**FormatTrace**
Optional renderer-provenance tree carried in `RenderedTree`.
Records nested renderer composition for debugging.

**FormattedContent**
Formatter harness output: `{ content, text?, mimeType?, renderedWith,
renderTrace?, diagnostics?, metadata? }`.

**SpecConfig**
Cross-provider normalized knobs (`responseFormat`, `maxOutputTokens`,
`temperature`, etc.).

**ProviderOptions**
Provider-namespaced escape hatch (`{ openai, anthropic, google,
"ai-sdk" }`).

**CacheHint**
Caching intent on entries/declarations. Adapters map to provider
mechanics. Compiler MUST NOT reorder for caching.

## Execution and adapters

**ExecutionTarget**
Family-aware target descriptor. v2 ships `LanguageModelTarget`.

**LanguageModelTarget**
`ExecutionTarget` with `kind: "language-model"`. Carries provider, modelId,
capabilities.

**ExecutionResult**
Family-neutral protocol success payload (`output: ContentBlock[]`,
`usage?`, `finishMetadata?`).

**LanguageModelExecutionResult**
Extends `ExecutionResult` with `toolCalls?`, `stopReason`, `raw?`.

**ExecutorTerminal**
Terminal envelope for executor runs (`succeeded | failed | canceled |
vetoed | replaced`). Carries `result` on succeeded/replaced.

**ExecutorDelta**
Streaming chunk shape emitted via `executor:delta`. `[PROPOSAL]`
6-kind union. See `02-data-model.md`.

**LanguageModelStopReason**
Canonical stop reason taxonomy: `end | tool_use | max_tokens |
content_filter | stop_sequence | other`. Replaces v1's ~17-value
`StopReason` enum.

**ToolCall / ToolResult**
Normalized dispatch view (`ToolCall`) and execution result (`ToolResult`).
`[V1-INHERITED]`.

**Project / Execute / Normalize**
Three explicit phases of the executor harness. Project = IR → provider
input. Execute = issue provider request, stream. Normalize = provider
output → `ExecutionResult`.

## Harnesses (per-layer)

**App harness**
Outermost runtime boundary. Owns the agent definition, session
registry, cross-session bus, shared services. See `09-app-harness.md`.

**Session harness**
Per-session boundary. Owns identity, mounted React tree (mountId),
timeline, knobs, channels, subscription intents. See `08-session-harness.md`.

**Loop executor**
Per-execution orchestration harness. Drives tick mechanics, calls React
+ executor + tool executor. **Internal contract, not public API in v2.**
See `05-loop-executor.md`.

**reconciler harness**
Producer-side harness. Maintains a mounted React JSX tree as a living
application. Emits `RenderedTree`, rendered string, rendered
resource, snapshots. `[V1-REPLACED]` of v1's
`@agentick/core/jsx + reconciler + compiler + COM`.
See `03-reconciler-harness.md`.

**Formatter**
Pure function `(SemanticContentBlock[]) → ContentBlock[]` that turns
semantic content into wire-ready content (markdown, XML, text, JSON).
Invoked by the reconciler's collect fold pass; downstream consumers
see wire-shape only. Not a harness — see ADR 22 + `04-formatters.md`.

**Executor harness**
Family-aware boundary that turns IR into target system calls and
results. v2 ships `LanguageModelExecutor`. See `06-executor-harness.md`.

**Tool executor harness**
Boundary for tool dispatch (validation, confirmation, handler
invocation). Used by the loop (model door) and by `session.dispatch`
(host door). See `07-tool-executor.md`.

## Optional wrappers

**Cluster wrapper (`@agentick/cluster`)**
Optional distributed deployment layer over the runtime. Wraps app +
session harnesses for cross-node routing, activation, migration.
`[PROPOSAL]` substrate: `@effect/cluster`. See `11-cluster.md`.

**Gateway wrapper (`@agentick/gateway`)**
Optional ingress layer. Stateless front door that maps client transport
messages to harness commands. Multiple gateways can front one runtime.
See `12-gateway.md`.

**App Supervisor**
Singleton entity in cluster mode. Owns long-lived external concerns
(webhooks, cron timers, MQ subscriptions, cross-session bus, session
registry). Distinct from per-session entities.

## Data flow vocabulary

**Mount / Mount ID**
The reconciler harness's command to instantiate a JSX tree as a living
application. `mountId` identifies the mounted instance. Lives for the
session's active lifetime (NOT per execution).

**Compile-until-stable**
The reconciler harness's iterative reconciliation that converges before
emitting `RenderedTree`. Triggered by async resolves, signal
updates, etc.

**Forced-stable**
A compile that hit the iteration cap without converging. Emits a
diagnostic but still produces output. Default cap `[PROPOSAL]`: 16.

**Rerender**
The reconciler harness's command to re-render the tree against new state
(e.g., after the loop applied executor results to session state). Does
NOT produce compiled output; the next `renderTree` call sees the
updated tree.

**Two doors**
Pattern preserved from v1: every capability has a model door (LLM
invokes tool_use) and a host door (`session.dispatch(name, input)`).
Both converge on the tool executor harness.

**Two-stage subscription registration**
Long-lived primitives (`<Subscription>`, `<Cron>`, `<Webhook>`,
`<EventListener>`) compile to declarative `SubscriptionIntent`. The
supervisor materializes external connections; intents persist.

**StateApplicator**
Loop executor's collaborator that applies normalized executor results
and tool results to session state (timeline appends, knob updates).
`[PLACEHOLDER]` shape.

**Continuation policy**
The loop executor's decision function for "continue or stop" after each
tick. Default policy described in `05-loop-executor.md`.

**Use: deps**
Render-time hook capture for tool handlers (`createTool({ use: () => ({
sandbox: useSandbox() }) })`). The reconciler harness captures these at
compile time and passes to the tool executor at dispatch.

## Hooks

**useSignal**
Reactive cell hook. Backed by compiler-private state.

**useKnob**
Model-visible reactive value. Exposes a `set_knob`-style mechanism to
the model.

**useTimeline**
Read/write the session's timeline; windowed read by default.

**useChannel**
Read/write a named channel; offset semantics on read.

**useData**
Async data resolution that participates in render-until-stable.
Layer 2 cache (compile-time).

**useResolved**
Read previously-resolved data on session restore. Layer 1 cache
(persisted via session record).

**useSandbox / useMCP**
Read tree-scoped Context provided by `<Sandbox>` / `<MCP>` ancestors.

**useOnEntry / useOnEvent / useOnMount / useOnUnmount**
Lifecycle hooks for components.

## Persistence

**PersistenceBackend**
The interface implemented by storage adapters (Postgres, Redis, SQLite,
memory). Methods for session record, timeline (incremental), channel
events, large content. `[PLACEHOLDER]` exact shape.

**PersistenceLayer**
A user-facing Effect Layer that satisfies `PersistenceBackend`.
Composable: one Layer can handle all concerns or different concerns can
have different Layers.

**Incremental persistence**
v2 lesson from v1: timeline writes happen incrementally (one row per
entry) during execution. Hibernation writes only the small session
record.

## Channels and events

**Channel**
Named, per-session, persistent stream. Configurable retention. Distinct
from event bus. `[V1-INHERITED]` from `packages/shared/src/protocol.ts`.

**Framework channels**
The seven built-in session channels: `session:messages`, `session:events`,
`session:control`, `session:result`, `session:tool_confirmation`,
`session:context`, plus app-wide.

**Cross-session bus**
App-level PubSub. Per-session events fan up here when subscribers exist.
Cluster-distributed via cluster bus when remote subscribers exist.

**DevTools bus**
Separate event bus for DevTools-class events (`compiler:compile` with raw
compiled, `executor:provider:request/response`, etc.). Same envelope
shape, different stream.

**Lazy fan-out**
Events are not constructed if no subscribers exist. Cost when no one is
listening: zero.

## v1 → v2 cross-reference

| v1 concept | v2 placement |
| --- | --- |
| COM (`packages/core/src/com/`) | GONE — replaced by React fiber tree + session state |
| `RenderedTree` (Map-based, with live refs) | `RenderedTree` (JSON-shaped, with `FormatterRef` and `handlerRef`) |
| `COMInput` (model input) | folded into `RenderedTree` |
| `EngineInput` | folded into `RenderedTree` |
| `ExecutionRunner.transformCompiled` | loop interceptor on `compile` (replace) |
| `ExecutionRunner.executeToolCall` | tool executor interceptor on `dispatch` |
| `ExecutionRunner.onSessionInit/onPersist/onRestore/onDestroy` | session interceptors on lifecycle commands |
| `LifecycleCallbacks` | observers on `*:terminal` events |
| `EventEmitter` on session | session-scoped PubSub |
| `Tool.audience` | `ToolDeclaration.exposure` |
| `SectionEntry.intent` | dropped (id + title sufficient) |
| `EphemeralEntry` / `EphemeralPosition` | compile/runtime-only transient render input |
| `EngineModel.fromEngineState` / `toEngineState` | executor `project` / `normalize` phases |
| `EngineModel.stream` / `generate` | executor `execute` phase |
| `StructureRenderer` | formatter harness + executor projection (split) |
| `Formatter` (function on `SemanticNode`) | `FormatterRef` (JSON-safe ref, function lives behind harness) |
| `ToolExecutionType.OUTPUT` | `OutputDeclaration` + Tool with same id |
| `_providerInput` smuggled in modelOutput | `executor:provider:request` event |
| ~43 raw stream event types | wrapped in `EventEnvelope` (same names, new shape) |
| StopReason enum (~17 values) | `LanguageModelStopReason` (6 values; provider-specific in `finishMetadata`) |
| Session = sharded entity (early v2) | Session = library object first; cluster wraps |
| Distributed-by-default (early v2) | Library-first; cluster optional |

## Annotation conventions in this blueprint

| Marker | Meaning |
| --- | --- |
| `[V1-INHERITED]` | v2 keeps the v1 shape (sometimes promoted/refined) |
| `[V1-REPLACED]` | v2 replaces a v1 concept |
| `[V1-REFINED]` | v2 keeps the v1 shape but tightens it |
| `[GAP]` | source proposals leave undefined |
| `[PLACEHOLDER]` | blueprint synthesizes a placeholder, sign-off needed |
| `[PROPOSAL]` | blueprint takes a position on an open question, sign-off needed |
| `[SOURCE: doc.md §X]` | direct citation to a v2 source proposal |
