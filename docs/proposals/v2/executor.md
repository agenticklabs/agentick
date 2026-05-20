# Executor Harness

## Status: Living Draft

Last updated: 2026-05-08

The executor harness is the target-family-aware boundary that turns the
Agentick input IR ([`CompiledStructure`](./compiled-spec.md)) into a target
system call and turns the target's output back into a normalized
`ExecutionResult`. It detects tool calls but does not own multi-tick
orchestration.

In v2, "executor" is a protocol family. The shipped v2 implementation is
`LanguageModelExecutor`, which targets language-model providers. Future
families (image generation, audio synthesis, retrieval, etc.) implement the
same protocol against different targets.

This document defines executor behavior independently from runtime topology.

## Naming and Protocol vs Implementation

- `Executor` — protocol. Family-neutral contract.
- `ExecutionResult` — protocol-level success payload produced by any executor.
- `ExecutorTerminal` — terminal outcome envelope returned by executor runs.
- `LanguageModelExecutor` — concrete v2 implementation targeting language
  model providers.
- `LanguageModelExecutionResult` — concrete v2 result type returned by
  `LanguageModelExecutor`.

Public protocol vocabulary stays unqualified. Family qualifiers attach to
shipped implementations and their concrete result types.

## Role in the Architecture

```
React runtime harness -> CompiledStructure -> Loop executor -> Executor harness
                                              |
                                              -> Tool Executor harness
```

The loop executor invokes executor commands; executor emits execution events and
typed errors.

## Design Principles

1. **Three explicit phases.** Project IR to target input, execute the target,
   normalize target output back to a result. These are observable, testable,
   replaceable steps, not a single opaque call.
2. **Family-aware, target-specific.** Each executor family understands one
   class of target. v2 ships language-model targets.
3. **IR in, terminal outcome out.** Inputs and outputs cross the spec firewall
   as JSON-shaped values; provider SDK objects do not leak past the harness.
4. **Streaming as events; terminal as outcome.** Incremental progress is
   emitted as `executor:delta` events. The terminal outcome is an
   `ExecutorTerminal` envelope that contains a consolidated result on success.
5. **Tool calls in both views.** Tool calls appear as content blocks in the
   canonical output stream and as a normalized `toolCalls` extraction for the
   loop executor's dispatch planning.
6. **Tool orchestration is loop-owned.** Tool dispatch sits in a tool-executor
   harness invoked by the loop executor, not mixed into provider projection
   code.
7. **Typed failure surfaces.** Projection, execution, and normalization errors
   are distinct and actionable.
8. **No topology assumptions.** Local and clustered runtimes consume the same
   executor contract.

## Executor Harness

### Commands in

- `project(compiled, target)`
- `execute(input, target)`
- `normalize(output, target)`
- `run(compiled, target)`
- `abort(executionId)`

`run` is the convenience command used by the loop executor. It is equivalent to
`project -> execute -> normalize`, with streaming events emitted throughout. It
returns `ExecutorTerminal`, not a bare result.

### Events out

Events follow the shared `EventEnvelope` shape with `surface: "executor"`.

- `executor:request:requested`
- `executor:request:before`
- `executor:project:terminal`
- `executor:provider:request`
- `executor:provider:response`
- `executor:delta` (repeated; streaming chunks)
- `executor:normalize:terminal`
- `executor:tool-call:detected`
- `executor:request:terminal`

### Interceptors

Interceptor responses follow the shared model: `proceed`, `defer`, `veto`,
`replace`. Replacement at any phase short-circuits subsequent phases for
that phase's output.

- `project`
- `provider-execute`
- `provider-stream`
- `normalize`

### Outcomes and failures

Terminal outcomes:

- `succeeded` — normalized result payload returned
- `failed` — typed executor error
- `canceled` — abort or signal triggered cancellation
- `vetoed` — interceptor halted execution
- `replaced` — interceptor substituted a result

Typed errors:

- `ProjectionError`
- `ProviderError`
- `NormalizationError`
- `NetworkError`
- `RateLimitError`
- `AuthError`
- `ExecutorTimeoutError`

## Three-Phase Contract

The executor protocol exposes three logical phases per successful execution:

```
project(IR, target)            -> target input
execute(target input, target)  -> target output stream/value
normalize(target output)       -> ExecutionResult
```

Implementations MAY collapse phases internally for performance. The harness
boundary preserves the phases as observable events and interceptor seams.

### Project

`project` transforms `CompiledStructure` into target input. This is where:

- `MessageEntry.role` (Agentick semantic role) is mapped to provider role
- `SectionEntry` content is projected into provider-appropriate structure
- `ToolDeclaration` entries with `model` exposure are projected to provider
  tool format
- `SpecConfig.responseFormat` is mapped to provider generation knobs
- `providerOptions` are merged into the target call

Projection MUST NOT mutate IR.

### Execute

`execute` issues the target call and produces target output. For language
models this is a streaming or non-streaming provider request. The executor
surfaces incremental progress as `executor:delta` events.

### Normalize

`normalize` transforms target output into `ExecutionResult`. This is where:

- Provider content shapes collapse to canonical `ContentBlock[]`
- Tool calls are extracted into a normalized `toolCalls[]` view
- Stop reason is mapped to the canonical taxonomy
- Usage is summed/normalized
- Provider-specific finish metadata is preserved in `finishMetadata`

Normalization MUST be deterministic for equivalent target output.

## Default Executor Family

v2 ships a first-class **language model executor**. This is the default
Agentick executor family and the one the first implementation should
optimize for. Other executor families may be added later but are not design
drivers for the initial protocol.

```ts
interface LanguageModelExecutor extends Executor {
  project(compiled: CompiledStructure, target: LanguageModelTarget): LanguageModelInput;

  execute(input: LanguageModelInput, target: LanguageModelTarget): AsyncIterable<ExecutorDelta>;

  normalize(output: unknown, target: LanguageModelTarget): LanguageModelExecutionResult;

  run(
    compiled: CompiledStructure,
    target: LanguageModelTarget,
  ): AsyncIterable<ExecutorDelta | ExecutorTerminal<LanguageModelExecutionResult>>;
}
```

This avoids pretending there is a universal model input while keeping the
projection seam reusable.

## Execution Target

Projection depends on the target.

```ts
interface ExecutionTarget {
  kind: "language-model" | string;
  provider?: string;
  modelId?: string;
  capabilities?: TargetCapabilities;
  providerOptions?: Record<string, unknown>;
}
```

For `ai-sdk`, the executor may not be able to infer complete provider/model
details. In that case it should:

- infer capabilities when possible
- accept explicit target/capability config
- project conservatively when capabilities are unknown
- preserve provider-specific options through namespaced `providerOptions`

## Tool Executor Harness

Tool execution is a separate harness consumed by the loop executor. It is
documented here because executor streams are where provider tool calls are
detected.

### Commands in

- `dispatch(name, input, context)`
- `abort(toolCallId)`

### Events out

- `tool-called`
- `tool-result`
- `tool-error`
- `tool-confirmation-required`

### Interceptors

- `before-dispatch`
- `after-dispatch`
- `on-confirmation-required`
- `on-tool-error`

### Outcomes and failures

- `ToolNotFoundError`
- `ToolValidationError`
- `ToolHandlerError`
- `ToolPermissionError`

## Execution Flow

```
1) loop executor submits (CompiledStructure, target) to executor
2) executor projects IR -> target/provider input
3) executor runs target/provider request and streams chunks
4) executor normalizes target/provider output -> ExecutionResult
5) executor returns ExecutorTerminal
6) loop executor consumes terminal outcome and coordinates continuation
7) if tool call appears, loop executor invokes tool executor
8) tool result feeds back into runtime session state
9) loop executor may invoke next tick execution
```

The loop executor owns multi-tick policy; executor owns single provider run
semantics.

## Adapter Model

Provider adapters are harness implementations behind executor protocols.

Expected adapter responsibilities:

- project `context.entries` to provider/model input mechanisms
- map provider chunks to normalized chunk/event types
- normalize provider/model output into Agentick execution result
- preserve provider-specific metadata through supported extension points
- classify and map provider failures to typed executor errors

Adapters should not own session lifecycle or persistence semantics.

## Caching and Provider Features

Executor applies provider-specific caching mechanics based on spec intent:

- context/declaration cache metadata
- model capabilities
- provider-specific options

Caching behavior is observable through executor events for diagnostics.

## Context Projection

Executor projection MUST preserve context entry order and entry boundaries
as far as the provider allows.

Projection rules:

- `context.entries` SHOULD be projected in order unless provider constraints
  require grouping or splitting.
- `MessageEntry.role` is an Agentick semantic role. Mapping to provider role
  (e.g., OpenAI `system`/`user`/`assistant`/`tool`, Anthropic
  `system`/`user`/`assistant`) is the executor's job.
- `MessageEntry` values SHOULD preserve role order and tool-call/result
  correlation for chat-style executors.
- `SectionEntry` values SHOULD preserve section identity (`id`, `title`) in
  the projected input when no native section mechanism exists.
- Chat LLM executors MAY project system-role messages toward
  system/developer/instruction channels and MAY wrap section content with
  provider-specific tag conventions when beneficial.
- Runtime declarations MUST NOT be projected as context text unless an
  authoring component explicitly rendered their content into
  `context.entries`.

## Result Normalization

Executor normalization converts target output into the shape the loop
executor and runtime understand.

### `ExecutionResult` (success payload)

```ts
interface ExecutionResult {
  specVersion: string;
  output: ContentBlock[];
  usage?: UsageStats;
  finishMetadata?: Record<string, unknown>;
}
```

`ExecutionResult` is the minimum successful result shape. Family-specific result
types extend it. Failed, canceled, vetoed, deferred, and replaced terminal states
are represented by `ExecutorTerminal`, not by optional fields on
`ExecutionResult`.

### `ExecutorTerminal`

```ts
type ExecutorTerminal<R extends ExecutionResult = ExecutionResult> =
  | { outcome: "succeeded"; result: R }
  | { outcome: "failed"; error: ExecutorError }
  | { outcome: "canceled"; reason?: unknown }
  | { outcome: "vetoed"; reason?: string }
  | { outcome: "replaced"; result: R; reason?: string };
```

Rules:

- `ExecutionResult` is success-only.
- `failed` carries typed executor failure.
- `canceled` carries cancellation reason when available.
- `vetoed` means an interceptor halted execution before target completion.
- `replaced` means an interceptor supplied a result without completing the
  normal phase.
- The terminal event payload MUST use this envelope shape.

### `LanguageModelExecutionResult`

```ts
interface LanguageModelExecutionResult extends ExecutionResult {
  toolCalls?: ToolCall[];
  stopReason: LanguageModelStopReason;
  raw?: unknown;
}

type LanguageModelStopReason =
  | "end"
  | "tool_use"
  | "max_tokens"
  | "content_filter"
  | "stop_sequence"
  | "other";

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  metadata?: Record<string, unknown>;
}
```

Field semantics:

- `output` is the canonical content stream for timeline ingestion. Tool
  calls appear here as `tool_use` content blocks.
- `toolCalls` is the extracted dispatch view for the loop executor. It
  duplicates the tool-call information from `output` in a form convenient
  for dispatch planning. Extraction MUST be consistent with the `tool_use`
  blocks in `output`.
- `stopReason` is the normalized stop signal. Provider-specific stop
  reasons collapse to this taxonomy. Provider-specific detail belongs in
  `finishMetadata`.
- `usage` is normalized token/cost accounting where available.
- `finishMetadata` is a free-form bag for provider-specific finish data
  (e.g., `cache_creation_input_tokens`, `system_fingerprint`).
- `raw` is an optional pass-through of the underlying provider response for
  debugging or advanced inspection. SHOULD NOT be relied on by core runtime
  logic.

Normalization rules:

- Tool call identifiers MUST be preserved for later tool result
  correlation.
- Provider-specific metadata needed on later turns MUST round-trip through
  `finishMetadata` or block-level metadata.
- Empty or malformed provider responses MUST become `ExecutorTerminal {
outcome: "failed" }`, not ad-hoc thrown strings.
- The loop executor MUST NOT inspect provider-native output directly.

## Streaming Model

`executeStream` emits incremental progress as `executor:delta` events with
phase `delta`. The terminal event has phase `terminal` and carries
`ExecutorTerminal` as payload.

Delta event payloads SHOULD carry one normalized chunk-shaped object per
event so consumers can render progressively without re-parsing provider
text.

On success, the terminal result MUST be self-contained: a consumer that ignores
all deltas and only reads the terminal event SHOULD obtain a complete, correct
`ExecutionResult` from `payload.result`.

## Tool Call Boundary

The executor harness extracts tool calls but does not execute them. Tool
execution is the loop executor's responsibility (via the tool executor
harness) when runtime policy requires Agentick-managed dispatch.

Some provider features (e.g., provider-side function execution) return
already-resolved tool results. In that case the executor SHOULD return
those results inside `output` as `tool_result` content blocks and SHOULD
omit the corresponding `toolCalls` entries. This keeps the loop executor's
dispatch loop honest: anything in `toolCalls` is a request for Agentick to
dispatch.

The executor output contract MUST mark provider-side tool execution
explicitly so the loop executor does not double-dispatch. The marker shape
is finalized via Open Question 7.

## Testing Strategy

Executor tests should include:

- projection correctness fixtures
- streaming chunk mapping fixtures
- error mapping fixtures
- tool-call detection and handoff behavior
- abort/cancellation semantics

Tool executor tests should include:

- schema validation behavior
- dependency/context injection behavior
- confirmation flow behavior
- error classification behavior

## Open Questions

1. **Chunk normalization envelope.** What is the minimum universal chunk
   shape for `ExecutorDelta`?
2. **Tool call detection timing.** Immediate stream-time vs buffered
   detection?
3. **Parallel tool dispatch policy.** Runtime policy only or executor
   option?
4. **Provider retry policy boundaries.** Which retries belong to adapter vs
   runtime?
5. **Structured output behavior.** How should output schema mismatches map
   into typed errors?
6. **ExecutionTarget strictness.** How much target/capability information is
   required before projection may run?
7. **Provider-side tool execution marker.** Exact shape of the `toolCalls`
   opt-out signal when the provider has already executed tools.
8. **`raw` payload policy.** Always include? Opt-in? Opt-out for memory
   reasons in long sessions?
9. **Cross-family base events.** Are `executor:project`,
   `executor:normalize` events meaningful for non-LM families, or should
   they be LM-specific?

## Decision Log

- **Executor is a protocol family; v2 ships `LanguageModelExecutor`.**
  (2026-05-08) Reason: keep architecture open to non-LM targets without
  dragging "language model" into core vocabulary.
- **Executor exposes three phases: project, execute, normalize.**
  (2026-05-08) Reason: makes the IR-to-target transformation observable,
  testable, and interceptable.
- **`ExecutionResult` is the protocol base; family-specific result types
  extend it.** (2026-05-08) Reason: cross-family symmetry without forcing
  LM-specific fields into all results.
- **`ExecutionResult` is success-only; `ExecutorTerminal` carries terminal
  outcome.** (2026-05-08) Reason: keep executor failures, cancellation, veto,
  and replacement in the protocol outcome channel rather than as optional
  fields on result payloads.
- **Result `output` is `ContentBlock[]`, not `ContextEntry[]`.**
  (2026-05-08) Reason: result is for timeline ingestion and runtime state;
  IR entry shape belongs to the input side only.
- **Tool calls live in both `output` and `toolCalls`.** (2026-05-08) Reason:
  `output` is canonical for timeline ingestion; `toolCalls` is the dispatch
  view for the loop executor; duplication avoids forcing the loop executor
  to re-parse content blocks.
- **Streaming deltas are events; terminal outcome is consolidated.**
  (2026-05-08) Reason: clean separation between progressive UI and
  authoritative terminal state; terminal-only consumers get correctness without
  delta handling.
- **Provider-side tool execution returns results in `output`, not
  `toolCalls`.** (2026-05-08) Reason: prevents the loop executor from
  double-dispatching tools the provider already ran.
- **Executor and tool execution are separate harnesses.** (2026-05-08)
- **Runtime/loop executor owns multi-tick orchestration; executor owns
  single provider run.** (2026-05-08)
- **Projection mechanics are adapter-owned and observable.** (2026-05-08)
- **Normalization mechanics are adapter-owned and observable.**
  (2026-05-08)
- **Default v2 executor family targets language models.** (2026-05-08)
- **Topology concerns are out of executor core contract.** (2026-05-08)
