# 06 — Executor Harness

**Status:** Synthesized with placeholders
`[SOURCE: executor.md, compiled-spec.md, harness-principle.md]`

The executor harness is the target-family-aware boundary that turns the
Agentick IR (`RenderedTree`) into a target system call and the
target's output back into a normalized `ExecutionResult`.

In v2, "executor" is a **protocol family**. The shipped v2 implementation
is `LanguageModelExecutor`; future families (image generation, audio,
retrieval) implement the same protocol against different targets.

```
                ┌───────────────────────────────────┐
                │         Executor harness          │
                │                                   │
   commands ──► │  project · execute · normalize    │  ──► events
                │  run · abort                      │
   interceptors◄┤                                   │  ──► outcomes
                │   provider adapter                │
                │   (Anthropic, OpenAI, Google,     │
                │    AI SDK, mock, …)               │
                └───────────────────────────────────┘
```

`[V1-REPLACED]` of v1's:

- `EngineModel.fromEngineState` (model-side projection of `COMInput`)
- `EngineModel.toEngineState` (model output normalization)
- `EngineModel.stream` / `EngineModel.generate`
- The DevTools fields like `_providerInput` smuggled in modelOutput

v2 makes these explicit phases on a typed harness, with structured
streaming and a typed terminal envelope.

## What this harness manages

- IR → target/provider input projection.
- Target/provider request execution.
- Streamed output normalization.
- Tool call detection and extraction.
- Stop-reason normalization.
- Provider error classification.
- Per-tick provider-specific options (caching, reasoning, etc.).

It does NOT manage:

- Multi-tick orchestration (loop executor).
- Tool handler execution (tool executor harness).
- Compiled structure production (React harness).
- Session timeline (session harness).

## Naming and protocol vs implementation

```
Public protocol vocab        Concrete v2 shipped impl
─────────────────────        ────────────────────────
Executor                     LanguageModelExecutor
ExecutionResult              LanguageModelExecutionResult
ExecutorTerminal             (envelope, family-neutral)
ExecutionTarget              LanguageModelTarget
```

Future families (sign-off pending) might be:

```
ImageGenExecutor             ImageGenExecutionResult
AudioSynthExecutor           AudioSynthExecutionResult
RetrievalExecutor            RetrievalExecutionResult
```

These are aspirational; the v2 protocol is shaped to allow them without
forcing them.

## Three explicit phases

The executor exposes three logical phases per successful execution:

```
project(IR, target)            -> target input
execute(target input, target)  -> target output stream / value
normalize(target output)       -> ExecutionResult
```

Implementations MAY collapse phases internally for performance. The
**harness boundary preserves the phases as observable events and
interceptor seams**. This is what enables:

- Replacing projection in tests without touching execute.
- Recording provider input for replay debugging.
- Enforcing a normalization invariant via interceptor.

### Project

`project(RenderedTree, target) → TargetInput`

This is where:

- `MessageEntry.role` (Agentick semantic) → provider role.
- `SectionEntry.content` → provider-appropriate structure (system block,
  tagged user content, tool definitions, cached content reference, etc.).
- `ToolDeclaration` entries with `model` exposure → provider tool format.
- `SpecConfig.responseFormat` → provider generation knobs.
- `providerOptions[provider]` → merged into the target call.
- `CacheHint` → provider cache mechanics.

Projection MUST NOT mutate the IR. Returns a new target input value.

### Execute

`execute(targetInput, target) → AsyncIterable<ExecutorDelta> | TargetOutput`

Issues the target call. For language models this is a streaming or
non-streaming provider request. The harness surfaces incremental progress
as `executor:delta` events. The result is opaque target output that
normalize will consume.

### Normalize

`normalize(targetOutput, target) → ExecutionResult`

Where:

- Provider content shapes collapse to canonical `ContentBlock[]`.
- Tool calls are extracted into a normalized `toolCalls[]` view.
- Stop reasons map to the canonical taxonomy.
- Usage is summed/normalized.
- Provider-specific finish metadata is preserved in `finishMetadata`.
- `raw` is an opt-in passthrough.

Normalization MUST be deterministic for equivalent target output.

## Commands in

```ts
interface ExecutorProtocol {
  project(input: ProjectInput):
    Effect<TargetInput, ProjectionError, ExecutorEnv>;

  execute(input: ExecuteInput):
    Effect<TargetOutput, ExecuteError, ExecutorEnv>;

  normalize(input: NormalizeInput):
    Effect<ExecutionResult, NormalizeError, ExecutorEnv>;

  run(input: RunInput):
    Effect<ExecutorTerminal, ExecutorError, ExecutorEnv>;

  abort(executionId: string):
    Effect<void, never, ExecutorEnv>;
}

interface ProjectInput {
  compiled: RenderedTree;
  target: ExecutionTarget;
}

interface ExecuteInput {
  targetInput: TargetInput;
  target: ExecutionTarget;
  signal?: AbortSignal;
}

interface NormalizeInput {
  targetOutput: TargetOutput;
  target: ExecutionTarget;
}

interface RunInput {
  compiled: RenderedTree;
  target: ExecutionTarget;
  signal?: AbortSignal;
}
```

`run` is the convenience command used by the loop executor. Equivalent to
`project → execute → normalize`, with delta events emitted throughout. It
returns `ExecutorTerminal`.

`TargetInput` and `TargetOutput` are family-specific generic types; for
`LanguageModelExecutor` they are `LanguageModelInput` and the underlying
provider response shape (kept opaque to the rest of the system).

## Events out

```
executor:request:requested           executor:request:before
executor:project:terminal            (project phase done)
executor:provider:request            (about to call provider)
executor:provider:response           (raw provider response, devtools)
executor:delta                       (per chunk)
executor:normalize:terminal          (normalize done)
executor:tool-call:detected          (per tool call extracted)
executor:request:terminal            (overall, with ExecutorTerminal payload)
```

`[V1-REPLACED]` of v1's `compiled`, `model_request`, `provider_request`,
`model_response` DevTools events. Same information, but now properly
phased and cleanly attributable to the executor surface.

## Lifecycle handlers + middleware

Per the five-surface model:

```ts
// Lifecycle handlers (.onX)
executor.onProviderRequest(handler: (input: TargetInput) => void | Promise<void>)
executor.onProviderResponse(handler: (output: unknown) => void | Promise<void>)
executor.onToolCallDetected(handler: (call: ToolCall) => void)
executor.onProviderError(handler: (err: ProviderError) => void)

// Middleware (.use, around-style)
executor.use({
  aroundProject: (input, next) => { ... },         // wrap projection
  aroundExecute: (input, next) => { ... },         // wrap provider call
  aroundNormalize: (input, next) => { ... },       // wrap normalization
});
```

Common uses:

| Surface | Use case |
| --- | --- |
| `aroundProject` replace | Substitute target input (test fixture) |
| `aroundExecute` veto | Refuse on rate-limit-hit or quota-exhausted |
| `onProviderResponse` | Tap response for analytics, recording |
| `aroundNormalize` replace | Force a stop reason for testing |

## Inbox messages

The executor harness accepts inbound messages at address
`executor:{executionId}`:

| Message type | Payload | Effect |
| --- | --- | --- |
| `abort` | `{ reason?: string }` | Aborts the in-flight provider call. |

## Outcomes and failures

```
succeeded   ExecutorTerminal { outcome: "succeeded", result: ExecutionResult }
failed      ExecutorTerminal { outcome: "failed", error: ExecutorError }
canceled    ExecutorTerminal { outcome: "canceled", reason? }
vetoed      ExecutorTerminal { outcome: "vetoed", reason? }
replaced    ExecutorTerminal { outcome: "replaced", result, reason? }
```

```ts
type ExecutorError =
  | ProjectionError
  | ProviderError
  | NormalizationError
  | NetworkError
  | RateLimitError
  | AuthError
  | ExecutorTimeoutError;

interface ProjectionError {
  _tag: "ProjectionError";
  reason: string;
  feature?: string;                // unsupported feature in target
}

interface ProviderError {
  _tag: "ProviderError";
  provider?: string;
  status?: number;
  cause: unknown;
}

interface NormalizationError {
  _tag: "NormalizationError";
  reason: string;
  cause?: unknown;
}

interface NetworkError {
  _tag: "NetworkError";
  cause: unknown;
}

interface RateLimitError {
  _tag: "RateLimitError";
  retryAfterMs?: number;
}

interface AuthError {
  _tag: "AuthError";
  reason: string;
}

interface ExecutorTimeoutError {
  _tag: "ExecutorTimeoutError";
  ms: number;
}
```

## LanguageModelExecutor — the v2 default family

```ts
interface LanguageModelExecutor extends ExecutorProtocol {
  project(input: ProjectInput<LanguageModelTarget>):
    Effect<LanguageModelInput, ProjectionError, ExecutorEnv>;

  execute(input: ExecuteInput<LanguageModelTarget, LanguageModelInput>):
    Effect<AsyncIterable<ProviderChunk>, ExecuteError, ExecutorEnv>;

  normalize(input: NormalizeInput<LanguageModelTarget, ProviderResponse>):
    Effect<LanguageModelExecutionResult, NormalizeError, ExecutorEnv>;

  run(input: RunInput<LanguageModelTarget>):
    Effect<ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError, ExecutorEnv>;
}

interface LanguageModelInput {
  // [PLACEHOLDER] — provider-shaped input;
  // each adapter defines its own concrete shape
  provider: string;
  modelId: string;
  data: unknown;
}
```

Provider adapters specialize:

```ts
class AnthropicLanguageModelExecutor implements LanguageModelExecutor { ... }
class OpenAILanguageModelExecutor    implements LanguageModelExecutor { ... }
class GoogleLanguageModelExecutor    implements LanguageModelExecutor { ... }
class AISDKLanguageModelExecutor     implements LanguageModelExecutor { ... }
class MockLanguageModelExecutor      implements LanguageModelExecutor { ... }
```

Each is a separate package. `13-package-graph.md` shows the layout.

## ExecutionTarget

```ts
interface ExecutionTarget {
  kind: "language-model" | string;
  provider?: string;
  modelId?: string;
  capabilities?: TargetCapabilities;
  providerOptions?: Record<string, unknown>;
}

interface LanguageModelTarget extends ExecutionTarget {
  kind: "language-model";
}
```

For `ai-sdk`, the executor may not be able to infer complete provider/model
details. Per `[SOURCE: executor.md §Execution Target]`:

- Infer capabilities when possible.
- Accept explicit target/capability config.
- Project conservatively when capabilities are unknown.
- Preserve provider-specific options through namespaced `providerOptions`.

`[GAP]` `[SOURCE: executor.md §Open Question 6]` — required strictness of
target metadata before projection runs. Blueprint position `[PROPOSAL]`:
projection MAY proceed with a missing `modelId` only if `provider` is
known and the executor's adapter declares `bestEffort` capabilities.
Sign-off needed.

## Streaming and terminal consistency

Per `[SOURCE: executor.md §Streaming Model]`:

> Delta event payloads SHOULD carry one normalized chunk-shaped object per
> event so consumers can render progressively without re-parsing provider
> text.
>
> On success, the terminal result MUST be self-contained: a consumer that
> ignores all deltas and only reads the terminal event SHOULD obtain a
> complete, correct `ExecutionResult` from `payload.result`.

This is the **terminal-correctness invariant**. Subscribers can choose
delta granularity; correctness is guaranteed on terminal alone.

`[GAP]` `[SOURCE: executor.md §Open Question 1]` — minimum universal chunk
shape for `ExecutorDelta`. Blueprint position `[PROPOSAL]`:

```ts
interface ExecutorDelta {
  kind: "content-delta" | "tool-call-delta" | "reasoning-delta" |
        "content-block" | "usage" | "stop";
  blockIndex?: number;
  delta?: string;                   // for *-delta kinds
  block?: ContentBlock;             // for "content-block" kind
  toolCallId?: string;              // for tool-call-delta
  toolName?: string;
  usage?: Partial<UsageStats>;      // for "usage" kind
  stopReason?: LanguageModelStopReason; // for "stop" kind
  metadata?: Record<string, unknown>;
}
```

Sign-off needed.

## Tool call boundary

The executor extracts tool calls but does not execute them. Two paths:

```
1) Agentick-managed dispatch
   provider response includes tool_use blocks
   ── normalize:
     output: [..., tool_use block, ...]
     toolCalls: [{ id, name, input, ... }, ...]
   ── loop executor dispatches via toolExecutor

2) Provider-side execution
   provider already executed the tool (e.g., Google grounding)
   ── normalize:
     output: [..., tool_use block, tool_result block, ...]
     toolCalls: []                  // omitted to prevent double-dispatch
   ── loop executor sees no toolCalls, ingests output as-is
```

`[GAP]` `[SOURCE: executor.md §Open Question 7]` — explicit shape of the
"provider already executed" marker is open. Blueprint position
`[PROPOSAL]`: the convention is "if `output` contains a `tool_result`
block AND `toolCalls` does NOT contain a matching entry, treat it as
provider-executed." A future explicit marker (e.g., `executedBy:"provider"`
on `tool_use`) is fine, but the absence-from-toolCalls is the contract.
Sign-off needed.

## Provider-specific options namespacing

```
spec.providerOptions = {
  openai: { ... },
  anthropic: { ... },
  google: { ... },
  "ai-sdk": { ... },
}
```

Adapters read their namespace and merge into their internal request. They
SHOULD NOT read another adapter's namespace.

## Caching

The executor maps `CacheHint` on entries/declarations to provider mechanics:

| Provider | Mechanism |
| --- | --- |
| Anthropic | `cache_control` on content blocks (4 marker max per request) |
| OpenAI | Automatic prefix caching; optional `prompt_cache_key` |
| Google | `cachedContents` API (out-of-band upload, then reference) |
| AI SDK | Adapter-specific |

Compiler MUST NOT reorder context for caching. Author intent is preserved.
The executor reports cache behavior via `executor:provider:request` and
`executor:provider:response` events for diagnostics.

## Context projection rules

Per `[SOURCE: executor.md §Context Projection]`:

- `context.entries` SHOULD be projected in order unless provider
  constraints require grouping or splitting.
- `MessageEntry.role` is mapped per executor's role-mapping config.
- `MessageEntry` values SHOULD preserve role order and tool-call/result
  correlation.
- `SectionEntry` values SHOULD preserve section identity (`id`, `title`)
  in projected input when no native section mechanism exists.
- Chat LLM executors MAY project system-role messages toward
  system/developer/instruction channels and MAY wrap section content with
  provider-specific tag conventions.
- Runtime declarations MUST NOT be projected as context text unless an
  authoring component explicitly rendered their content into
  `context.entries`.

`[GAP]` `[SOURCE: compiled-spec.md §Open Question 5]` — minimum formatting
that executors must preserve for sections. Blueprint position
`[PROPOSAL]`:

- Anthropic adapter: wrap section content in
  `<section id="..." title="...">...</section>` XML tags within the
  system message (or the appropriate channel for the section's role).
- OpenAI Responses adapter: emit each section as a developer-role message
  with `[Section: title (id)] ...` prefix, OR include a `<section>` block.
- Google adapter: include section content within `system_instruction.parts`
  with the same XML wrapping as Anthropic.

Sign-off needed.

## OpenAI Responses tool-call factoring

The IR embeds `tool_use` blocks inside assistant `MessageEntry.content`
(Anthropic-style factoring). OpenAI Responses uses separate top-level
items in `input[]`. The OpenAI adapter splits on projection:

```
MessageEntry { role: "assistant", content: [text, tool_use_a, tool_use_b] }
  ──projects to──►
[
  { type: "message", role: "assistant", content: [text] },
  { type: "tool_call", id: "a", name: ..., input: ... },
  { type: "tool_call", id: "b", name: ..., input: ... }
]
```

Executor implementations are free to do this. The IR stays canonical;
the projection is target-specific.

## Adapter responsibilities

Per `[SOURCE: executor.md §Adapter Model]`:

- Project `context.entries` to provider/model input mechanisms.
- Map provider chunks to normalized `ExecutorDelta` events.
- Normalize provider/model output into `ExecutionResult`.
- Preserve provider-specific metadata through supported extension points.
- Classify and map provider failures to typed executor errors.

Adapters do NOT own:

- Session lifecycle (session harness).
- Persistence semantics (runtime).
- Multi-tick continuation (loop executor).
- Tool handler execution (tool executor).

## `raw` payload policy

`[GAP]` `[SOURCE: executor.md §Open Question 8]` — always include? Opt-in?
Opt-out for memory reasons in long sessions?

Blueprint position `[PROPOSAL]`: opt-in via `RunInput.includeRaw?: boolean`,
default `false`. DevTools subscribers MAY enable globally; production
sessions default off to keep memory bounded. Sign-off needed.

## Cross-family events

`[GAP]` `[SOURCE: executor.md §Open Question 9]` — are
`executor:project:terminal` etc. meaningful for non-LM families.

Blueprint position `[PROPOSAL]`: the three-phase events are universal
(every executor family has projection / execution / normalization). Tool
call events (`executor:tool-call:detected`) are LM-family-specific and
emit only from `LanguageModelExecutor`-conforming implementations.
Sign-off needed.

## Composition

```
Loop executor
   │
   ▼
Executor harness (LanguageModelExecutor)
   ├── project ──────────────────────────────►  TargetInput
   ├── execute ──────────────────────────────►  TargetOutput (streamed)
   │     emits executor:delta
   ├── normalize ────────────────────────────►  ExecutionResult
   └── run = project + execute + normalize ──►  ExecutorTerminal
```

## Decisions captured

- Executor is a protocol family; v2 ships `LanguageModelExecutor`.
- Three explicit phases: project, execute, normalize.
- `ExecutionResult` is success-only; `ExecutorTerminal` carries terminal
  outcome.
- Result `output` is `ContentBlock[]`, not `ContextEntry[]`.
- Tool calls live in both `output` and `toolCalls`.
- Streaming deltas are events; terminal outcome is self-contained.
- Provider-side tool execution returns results in `output`, omits
  `toolCalls`.
- Executor and tool executor are separate harnesses.
- Loop executor owns multi-tick orchestration; executor owns single
  provider run.
- Projection mechanics are adapter-owned and observable.
- Default v2 executor family targets language models.
- Topology concerns are out of executor core contract.

## Open questions (deferred)

- Minimum universal chunk shape for `ExecutorDelta` (lean: 6-kind union).
- Tool call detection timing (immediate vs buffered).
- Parallel tool dispatch policy (lean: per-call hint via interceptor).
- Provider retry policy boundaries.
- Structured output schema mismatch error mapping.
- `ExecutionTarget` strictness before projection.
- Provider-side tool execution opt-out marker shape.
- `raw` payload policy.
- Cross-family base events vs LM-specific.
