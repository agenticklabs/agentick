# 02 — Data Model

**Status:** Synthesized with placeholders
`[SOURCE: compiled-spec.md, spec-package.md, executor.md, renderer-harness.md, harness-principle.md]`

This doc consolidates every type that crosses a harness boundary in v2:
the wire shapes that live in `@agentick/spec-next`. Anything that crosses a
boundary is JSON-serializable. Anything else (renderer instances, tool
handlers, React fibers, Effect refs, provider SDK clients) stays inside
the harness implementation.

```
                          @agentick/spec-next
                          ──────────────
            ┌────────────────────────────────────────┐
            │ data/                                  │
            │   compiled-structure.ts   ← this doc   │
            │   entries.ts              ← this doc   │
            │   declarations.ts         ← this doc   │
            │   content-blocks.ts       ← this doc   │
            │   execution-result.ts     ← this doc   │
            │   execution-target.ts     ← this doc   │
            │   events.ts               ← this doc   │
            │   outcomes.ts             ← this doc   │
            │ protocol/                              │
            │   react-harness.ts        ← 03         │
            │   renderer-harness.ts     ← 04         │
            │   loop-executor.ts        ← 05         │
            │   executor.ts             ← 06         │
            │   tool-executor.ts        ← 07         │
            │   session-harness.ts      ← 08         │
            │   app-harness.ts          ← 09         │
            └────────────────────────────────────────┘
```

`13-package-graph.md` covers package boundaries; this doc covers shapes.

## RenderedTree (the IR)

The producer-side artifact emitted by the reconciler harness's `renderTree`
command. The single canonical IR — replaces v1's
`RenderedTree` (`packages/core/src/compiler/types.ts`) **and** v1's
`COMInput` (`packages/core/src/com/types.ts`).

### Top-level shape

```ts
interface RenderedTree {
  specVersion: string; // date version, e.g. "2026-05-01"
  features?: string[]; // [PLACEHOLDER] — see below
  context: ContextSpec;
  declarations?: RuntimeDeclarations;
  config?: SpecConfig;
  providerOptions?: ProviderOptions;

  // Free root rendering channels (non-execution use cases)
  content?: ContentBlock[];
  text?: string;
  mimeType?: string;
  renderedWith?: FormatterRef;
  renderTrace?: FormatTrace[];

  diagnostics?: FormatDiagnostics;
  metadata?: Record<string, unknown>;
}
```

### What's deliberately absent

```
[V1-REPLACED]
  v1 field                              v2 representation
  ──────────────────────────────────────────────────────────────────
  systemEntries: CompiledTimelineEntry[] ContextEntry with role: "system"
  timelineEntries (excluding system)     ContextEntry with role
  sections: Map<string, CompiledSection> ContextEntry of kind "section"
  ephemeral: CompiledEphemeral[]         compile/runtime transient only
  position (on sections)                 tree order in context.entries
  audience (on sections / tools)         declaration.exposure[]
  intent (on sections)                   gone (id + title sufficient)
  Renderer reference (live instance)     FormatterRef + renderTrace
  ExecutableTool[] (with handlers)       ToolDeclaration with handlerRef
  metadata.totalTokens                   moved to runtime concern
```

### `features[]` `[PLACEHOLDER]`

The source proposals (`compiled-spec.md` §Open Question 4,
`spec-package.md` §Open Questions) leave the feature registry undecided.
The example shows `["sections", "tool-declarations"]` and one feature
appears as `"caching"`.

**Proposed initial registry** (sign-off pending; tracked in `17-open-questions.md`):

```ts
type SpecFeatureName =
  | "sections" // SectionEntry is used
  | "tool-declarations" // ToolDeclaration is used
  | "caching" // cache hints on entries/declarations
  | "provider-options" // providerOptions present
  | "free-root-content" // content/text at top level
  | "render-trace" // renderTrace present
  | "outputs" // OutputDeclaration present
  | "mcp-declarations"; // MCPDeclaration present
```

Implementations include only the features they used. Adapters reject
unsupported required features (`[SOURCE: compiled-spec.md §Compatibility and Evolution]`).

## ContextSpec — model-input context

```ts
interface ContextSpec {
  entries: ContextEntry[];
}

type ContextEntry = MessageEntry | SectionEntry;
```

Tree order is canonical. There is no `position` field; ordering is implicit
in array order. Both subkinds are discriminated by `kind`.

### MessageEntry — role-bearing entries

```ts
interface MessageEntry {
  kind: "message";
  role: string; // Agentick semantic role
  content: ContentBlock[];
  renderedWith?: FormatterRef;
  renderTrace?: FormatTrace[];
  id?: string;
  metadata?: MessageMetadata;
}

interface MessageMetadata {
  cache?: CacheHint;
  providerMetadata?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
```

`role` is an **Agentick semantic role**, not a provider role. Mapping to
provider role vocabulary (OpenAI `system`/`user`/`assistant`/`tool`,
Anthropic `system`/`user`/`assistant`, Gemini `model`/`user`) is the
executor's job during projection.

Canonical roles SHOULD include:

```
user · assistant · tool · system · event
```

Last one inherited from v1 (`packages/shared/src/block-types.ts`
`MessageRole.EVENT`); `[V1-INHERITED]`. Open string, but executors map
canonical roles without configuration.

### SectionEntry — structured context

```ts
interface SectionEntry {
  kind: "section";
  id: string; // stable identity across recompiles
  title?: string; // optional human label
  content: ContentBlock[];
  renderedWith?: FormatterRef;
  renderTrace?: FormatTrace[];
  metadata?: SectionMetadata;
}

interface SectionMetadata {
  priority?: number; // hint to executors that may reorder
  cache?: CacheHint;
  providerMetadata?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
```

Sections are first-class context entries — not a separate map and not
authoring-only. They are not `audience: "user"` content; everything in
`context` is model-facing.

`[V1-REPLACED]` of v1's `Map<string, CompiledSection>` and `COMSection`
(which carried `audience`, `visibility`, `formattedContent`, formatter
references). The v2 shape has none of those:

- `audience`/`visibility` removed (context is model-facing).
- `intent` removed (closed enum, overlapped role semantics).
- `position` removed (tree order is canonical).
- `formattedContent` / `formatter` removed (rendering produces `content`
  during renderTree; renderer instances do not appear in IR).

### CacheHint — caching intent

```ts
interface CacheHint {
  ttl?: "5m" | "1h" | string; // cross-provider hint
  scope?: "prefix" | "block"; // [PLACEHOLDER]
  [key: string]: unknown;
}
```

The compiler MUST NOT reorder context for caching. The executor maps the
hint to provider mechanics (Anthropic `cache_control`, OpenAI prefix
caching, Gemini `cachedContents`). `[GAP]` — exact mapping policy across
providers stays in the executor proposal and is not re-specified here.

## RuntimeDeclarations — runtime registrations

```ts
interface RuntimeDeclarations {
  tools?: ToolDeclaration[];
  resources?: ResourceDeclaration[];
  outputs?: OutputDeclaration[];
  mcp?: MCPDeclaration[];
}
```

These are not model-input context. They are runtime registrations the
runtime can materialize, route, or invoke.

### ToolDeclaration

```ts
interface ToolDeclaration {
  id: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  exposure: ToolExposure[];
  handlerRef?: string; // resolved by runtime/tool executor
  annotations?: ToolAnnotations;
  metadata?: Record<string, unknown>;
}

type ToolExposure = "model" | "dispatch" | "runtime";
```

| Exposure   | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `model`    | Executor MAY expose this tool to the model provider.                        |
| `dispatch` | Runtime MAY invoke via direct command (`session.dispatch`, slash commands). |
| `runtime`  | Internal runtime use; not model- or dispatch-visible.                       |

Replaces v1's `audience: "model" | "user" | "all"` (`packages/shared/src/tools.ts`).
The `["model", "dispatch"]` combination is the new "all"; `"user"` becomes
`"dispatch"` (clearer about who actually invokes).

`handlerRef` is an identifier resolved by the runtime/tool executor — never
executable code. Tool handlers live behind the firewall, named.

`[PLACEHOLDER]` `ToolAnnotations` — v1 had `intent` (RENDER/ACTION/COMPUTE),
`requiresResponse`, `timeout`, `defaultResult`, `ui.resourceUri`. The v2
proposals don't enumerate `ToolAnnotations`. Inheriting v1's shape as the
starting point:

```ts
interface ToolAnnotations {
  intent?: "render" | "action" | "compute"; // [V1-INHERITED]
  requiresResponse?: boolean; // [V1-INHERITED]
  timeout?: number; // [V1-INHERITED]
  defaultResult?: ContentBlock[]; // [V1-INHERITED]
  ui?: {
    // [V1-INHERITED] MCP Apps
    resourceUri?: string;
    visibility?: Array<"model" | "app">;
  };
  cache?: CacheHint;
  providerMetadata?: Record<string, Record<string, unknown>>;
}
```

Sign-off needed.

### ResourceDeclaration

```ts
interface ResourceDeclaration {
  id: string;
  uri?: string;
  name?: string;
  description?: string;
  mimeType?: string;
  handlerRef?: string;
  metadata?: Record<string, unknown>;
}
```

MCP resources, local resources, generated resources. Reading a resource is
a runtime command, not model-input context, unless a component renders the
contents into `context.entries`.

### OutputDeclaration

```ts
interface OutputDeclaration {
  id: string;
  schema?: JsonSchema;
  mode?: "text" | "json" | "json_schema";
  metadata?: Record<string, unknown>;
}
```

Distinct from `SpecConfig.responseFormat`:

| Concept                     | Purpose                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SpecConfig.responseFormat` | Generation-time directive on the model call ("respond as JSON conforming to this schema"). Provider knob territory. |
| `OutputDeclaration`         | Runtime registration of named outputs the application wants to extract from the result. Binding territory.          |

Both can coexist: `responseFormat` requests structured generation; one or
more `OutputDeclaration` entries describe how the runtime extracts and
routes the result.

### MCPDeclaration `[PLACEHOLDER]`

The source proposals reference `mcp?: MCPDeclaration[]` but don't define
the shape. Inheriting from v1's `<MCP>` component:

```ts
interface MCPDeclaration {
  id: string;
  serverName: string;
  transport: "stdio" | "http" | "sse" | "streamable-http";
  config: Record<string, unknown>; // transport-specific
  exposes?: Array<"tools" | "resources" | "prompts">;
  metadata?: Record<string, unknown>;
}
```

Sign-off needed; tracked in `17-open-questions.md`.

## Content blocks `[V1-INHERITED]`

The content block taxonomy is promoted from
`packages/shared/src/blocks.ts` (~21 variants) into `@agentick/spec-next`. The
shape is unchanged but `any` bags are tightened to `unknown` where
possible (`[SOURCE: spec-package.md §V1 Type Sources]`).

### Block types

```
Textual:  text · reasoning · code · json · xml · csv · html
Media:    image · document · audio · video
Tool:     tool_use · tool_result
AI-gen:   generated_image · generated_file · executable_code ·
          code_execution_result
Event:    user_action · system_event · state_change
Custom:   custom (StreamTagParser tags)
```

`type` is the discriminator. Allowed-block restrictions per role
(v1's `SystemAllowedBlock`, `UserAllowedBlock`, etc.) are preserved.

### MediaSource

Five source types, also inherited:

```
url · base64 · reference (file id) · s3 · gcs
```

Buffer ↔ base64 helpers move to `@agentick/shared` (Node `Buffer`-aware,
not zero-dep). The pure type definitions stay in `@agentick/spec-next`.

### Renderable block extension `[V1-INHERITED, REFINED]`

The formatter harness extends `ContentBlock` with semantic metadata:

```ts
type FormattableBlock = ContentBlock & {
  semanticNode?: SemanticNode;
  semantic?: SemanticMetadata;
};
```

Both `SemanticNode` and `SemanticMetadata` already exist in v1
(`packages/core/src/renderers/base.ts` lines 37–113). Recap:

```ts
type SemanticNode = {
  text?: string;
  semantic?: SemanticType;
  props?: Record<string, unknown>;
  children?: SemanticNode[];
  formatter?: Formatter; // [V1-REPLACED] — promoted to FormatterRef
};

type SemanticType =
  | "strong"
  | "em"
  | "mark"
  | "underline"
  | "strikethrough"
  | "subscript"
  | "superscript"
  | "small"
  | "code"
  | "heading"
  | "list"
  | "table"
  | "paragraph"
  | "blockquote"
  | "line-break"
  | "horizontal-rule"
  | "image"
  | "audio"
  | "video"
  | "link"
  | "quote"
  | "citation"
  | "keyboard"
  | "variable"
  | "list-item"
  | "custom"
  | "preformatted";

interface SemanticMetadata {
  type: SemanticType;
  level?: number; // headings 1–6
  structure?: unknown; // tables, lists, etc.
  href?: string; // links
  rendererTag?: string; // 'timestamp', 'custom-tag', etc.
  rendererAttrs?: Record<string, unknown>;
  preformatted?: boolean;
}
```

The v1 `formatter?: Formatter` field on `SemanticNode` becomes a
`rendererRef?: FormatterRef` for portability across the wire — function
references cannot cross the spec firewall. **`[PROPOSAL]`** rename
`formatter` → `rendererRef` on the v2 `SemanticNode`. Function-shaped
formatters live behind the formatter harness, not in the IR.

## Renderer protocol types

Used by the reconciler harness during compilation and by the formatter harness
directly.

```ts
interface FormatterRef {
  id: string;
  format?: "markdown" | "xml" | "text" | "json" | string;
  version?: string;
}

interface FormatterCapabilities {
  contentTypes?: string[];
  semanticTypes?: SemanticType[];
  outputFormats?: string[];
  streaming?: boolean;
}

interface FormatInput {
  content: FormattableContent[];
  purpose: "context" | "message" | "section" | "free-root" | "resource" | "output";
  source?: FormatSourceRef;
  options?: Record<string, unknown>;
}

type FormattableContent = FormattableBlock | FormatScope;

interface FormatScope {
  kind: "renderer-scope";
  renderer: FormatterRef;
  content: FormattableContent[];
  source?: FormatSourceRef;
  options?: Record<string, unknown>;
}

interface FormatSourceRef {
  kind: "message" | "section" | "free-root" | "resource" | "output";
  id?: string;
}

interface FormatResult {
  content: ContentBlock[];
  text?: string;
  mimeType?: string;
  renderedWith: FormatterRef;
  renderTrace?: FormatTrace[];
  diagnostics?: FormatDiagnostic[];
  metadata?: Record<string, unknown>;
}

interface FormatTrace {
  renderer: FormatterRef;
  source?: FormatSourceRef;
  children?: FormatTrace[];
  metadata?: Record<string, unknown>;
}

interface FormatDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

interface FormattedContent {
  content: ContentBlock[];
  text?: string;
  mimeType?: string;
  renderedWith: FormatterRef;
  renderTrace?: FormatTrace[];
  diagnostics?: FormatDiagnostic[];
  metadata?: Record<string, unknown>;
}
```

`FormattedContent` is the formatter harness's direct output. Inside
`RenderedTree`, the renderer's contribution is unpacked:

- `MessageEntry.content` ← `FormattedContent.content`
- `SectionEntry.content` ← `FormattedContent.content`
- top-level `content` / `text` / `mimeType` / `renderedWith` ← `FormattedContent`
  (for free-root rendering)

Renderer instances, formatter functions, callback closures, and runtime
service handles MUST NOT appear in `RenderedTree`. **Renderer identity
is data** (`FormatterRef`); behavior lives in the harness.

## SpecConfig and ProviderOptions

```ts
interface SpecConfig {
  model?: ModelSelection;
  responseFormat?: ResponseFormat;
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

type ProviderOptions = Record<string, Record<string, unknown>>;
```

Rules:

- Cross-provider semantics SHOULD live in `config`.
- Provider-specific escapes SHOULD live in `providerOptions`.
- Provider option keys SHOULD be provider namespaces: `openai`,
  `anthropic`, `google`, `ai-sdk`.

`[PLACEHOLDER]` `ModelSelection` and `ResponseFormat` — `ResponseFormat`
already exists in v1 (`packages/shared/src/models.ts`), `[V1-INHERITED]`.
`ModelSelection` is new and not enumerated; lean:

```ts
type ModelSelection = { kind: "by-id"; id: string } | { kind: "by-ref"; ref: string }; // resolved against registry
```

Sign-off needed.

## Execution result types

Produced by the executor harness, consumed by the loop executor and
session.

### ExecutionResult — protocol success payload

```ts
interface ExecutionResult {
  specVersion: string;
  output: ContentBlock[];
  usage?: UsageStats;
  finishMetadata?: Record<string, unknown>;
}
```

`ExecutionResult` is the minimum success shape across all executor
families. Family-specific results extend it.

`UsageStats` `[V1-INHERITED]` from `packages/shared/src/models.ts`.

### ExecutorTerminal — terminal envelope

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
- `canceled` carries a cancellation reason when available.
- `vetoed` means an interceptor halted before target completion.
- `replaced` means an interceptor supplied a result without normal phase
  completion.
- The terminal event payload uses this envelope.

### LanguageModelExecutionResult — v2 shipped family

```ts
interface LanguageModelExecutionResult extends ExecutionResult {
  toolCalls?: ToolCall[];
  stopReason: LanguageModelStopReason;
  raw?: unknown; // pass-through; debug only
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

`output` is canonical for timeline ingestion and includes `tool_use`
content blocks. `toolCalls[]` is the duplicated dispatch view for the
loop executor — extraction MUST be consistent with the `tool_use` blocks
in `output`.

`[V1-REPLACED]` of v1's `StopReason` enum (`packages/shared/src/streaming.ts`
which had ~17 values). v2 collapses to 6 canonical values; provider-specific
variants live in `finishMetadata`.

### ExecutorDelta — streaming chunk

```ts
interface ExecutorDelta {
  // [PLACEHOLDER] — chunk normalization is open question 1 in executor.md
  kind: string; // e.g., "content_delta", "tool_call_delta"
  blockIndex?: number;
  delta?: string;
  block?: ContentBlock; // when a full block emerges
  metadata?: Record<string, unknown>;
}
```

`[GAP]` — the source proposal explicitly leaves the minimum universal
chunk shape open (`executor.md` §Open Question 1). The placeholder above
inherits the v1 streaming.ts taxonomy structure.

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

interface TargetCapabilities {
  // [PLACEHOLDER] — proposals don't enumerate
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsStreaming?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;
}
```

`TargetCapabilities` synthesized from v1's `ContextUpdateEvent` fields
(`packages/shared/src/streaming.ts` lines ~688–700). Sign-off needed.

## Event types — wire shape

The protocol-level event envelope lives at the harness boundary:

```ts
interface EventEnvelope {
  /* see 01-harness-principle.md */
}
type ProtocolEvent = EventEnvelope & { payload?: unknown };
```

The v1 event taxonomy (`packages/shared/src/streaming.ts`, ~43 variants
across `MODEL_EVENT_TYPES`, `ORCHESTRATION_EVENT_TYPES`, `RESULT_EVENT_TYPES`)
is mapped to v2 envelope `name` values. See `10-events-and-interceptors.md`
for the full mapping.

`[V1-REPLACED]` of v1's three-union shape (`ModelStreamEvent |
OrchestrationStreamEvent | ResultStreamEvent`). v2 wraps them all as
`ProtocolEvent` envelopes.

DevTools events (`compiled`, `model_request`, `provider_request`,
`model_response`, `entry_committed`) split into a separate
`DevToolsStreamEvent` union per
`[SOURCE: spec-package.md §Event types]`. Same envelope, separate stream
to keep public stream cadence small.

## Outcome and lifecycle handler verdict types

```ts
type CommandOutcome = "succeeded" | "failed" | "canceled" | "vetoed" | "replaced" | "deferred";

/**
 * Lifecycle handler verdict. Returned from a handler registered via
 * harness.onX(fn) when the handler is positioned at a `before` boundary
 * and may influence execution.
 */
type HandlerVerdict<R = unknown> =
  | { kind: "proceed" }
  | { kind: "defer"; retryAfter?: number }
  | { kind: "veto"; reason?: string }
  | { kind: "replace"; result: R; reason?: string };

interface HandlerScope {
  scope: "global" | "app" | "session";
  scopeId?: string;
}
```

`HandlerVerdict` replaces what earlier drafts called `InterceptorResponse`.
Per the five-surface model in `01-harness-principle.md`, lifecycle
handlers (③) and middleware (④) are direct fn refs that participate in
execution; events (⑤) are pure observation. The verdict shape is
specifically for handlers/middleware at `before`-phase boundaries.

## Inbox / Message envelope types

The inbox is the addressable inbound command channel — the actor's
mailbox. Wire-safe by construction; routes locally or across the cluster.
See `19-foundation.md` for the substrate contract.

```ts
/**
 * Wire-safe envelope for inbound messages addressed to a harness.
 * JSON-serializable. Same shape across local and cluster dispatch.
 */
interface MessageEnvelope {
  /** Recipient address — `{surface}:{scopeId}`. */
  addressedTo: string;

  /** Discriminator within the recipient's accepted message set. */
  type: string;

  /** Optional sender address for response/ack. */
  from?: string;

  /** Idempotency key. Caller-supplied; defaults to system ULID. */
  messageId: string;

  /** Causality chain. */
  parentOpId?: string;
  correlationId?: string;

  /** Typed payload by message type. */
  payload?: unknown;

  /** ISO timestamp at send. */
  timestamp: number;
}

/**
 * Acknowledgment shape for `tell`-style sends (fire-and-forget with ack).
 */
interface MessageAck {
  messageId: string;
  receivedAt: number;
}

/**
 * Inbox-level errors (routing-side; distinct from handler-side errors).
 */
type InboxError =
  | { _tag: "AddressNotFound"; address: string }
  | { _tag: "RoutingFailed"; cause: unknown }
  | { _tag: "InboxClosed" }
  | { _tag: "AskTimeout"; timeoutMs: number };

/**
 * Handler-side errors (handler ran, but threw or returned a typed error).
 */
type MessageHandlerError =
  | { _tag: "HandlerError"; cause: unknown }
  | { _tag: "InvalidPayload"; reason: string };
```

### Address convention

```
{surface}:{scopeId}

Examples:
  loop:execution-abc-123
  session:user-42
  compiler:mount-xyz
  supervisor:main         ← singleton; bare-surface address
  app:my-app              ← singleton (per app)
```

Addresses are stable for the lifetime of the addressed entity. They
survive hibernation (the entity reactivates at the same address).

### Tell vs ask vocabulary

```ts
/** Fire-and-forget. Returns ack only. */
inbox.send(address, message): Effect<MessageAck, InboxError>

/** Send + await typed response. RPC-shaped; has timeout. */
inbox.ask<R>(address, message, opts?): Effect<R, InboxError | MessageHandlerError>
```

Most messages are `tell`. Use `ask` sparingly — RPC shape, timeouts
required, failure modes inherit from the network when remote.

### Idempotency on messages

`messageId` is the idempotency key. Same `messageId` arriving twice
returns the cached result (for ask) or ack-only (for tell), with the
handler running exactly once. Eviction: 10-minute TTL or LRU bound.

### Per-harness inbox messages

Each concrete harness defines its accepted message types alongside its
commands. See per-harness docs (03–09) for the canonical inbox messages.

## Channel types — runtime IPC `[V1-INHERITED, KEPT]`

`ChannelEvent`, `ChannelEventMetadata`, `FrameworkChannels`, framework
channel payloads from `packages/shared/src/protocol.ts` are promoted to
`@agentick/spec-next`. The seven framework channels are unchanged:

```
session:messages          → SessionMessagePayload
session:events            → ProtocolEvent
session:control           → SessionRenderPayload | SessionAbortPayload
session:result            → SessionResultPayload
session:tool_confirmation → ToolConfirmationRequest | ToolConfirmationResponse
session:context           → SessionContextPayload
```

These are wire shapes between the gateway and a connected client — not
internal harness events. Different abstraction layer; same package.

## Standard Schema interface (for tool input schemas)

```ts
// Inlined from @standard-schema/spec to keep @agentick/spec-next zero-dep.
interface StandardSchemaV1<Input = unknown, Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { input: Input; output: Output };
  };
}
type StandardSchemaResult<Output> =
  | { value: Output; issues?: undefined }
  | { issues: readonly StandardSchemaIssue[]; value?: undefined };
interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}
```

Tool authors provide any Standard-Schema-compliant validator (Zod,
Valibot, ArkType, Effect Schema). The runtime calls `validate()` at
dispatch time. The compiler converts to `JsonSchema` for the IR.
`[GAP]` — exact conversion pipeline (Zod → JSON Schema) is not specified
in v2 proposals; deferred to `17-open-questions.md`.

## Forward compatibility rules

- Additive object fields are preferred.
- Unknown fields MUST be preserved on round-trip when feasible.
- Removing or changing field semantics requires a major spec version.
- Optional features SHOULD be represented in `features[]`.
- Vendor extensions use `x-*` prefix `[PROPOSAL]` (`[SOURCE: spec-package.md §Open Question 1]`).

## Validation strategy `[V1-INHERITED]` from spec-package decision log

```
Type guards (zero runtime cost) ──► ship in @agentick/spec-next
JSON Schema validation (ajv)   ──► @agentick/spec-validator (separate)
```

Most consumers use type guards. Strict JSON-Schema validation is opt-in.

## Cross-references

| Type                                           | Used by                                                       | Doc        |
| ---------------------------------------------- | ------------------------------------------------------------- | ---------- |
| `RenderedTree`                                 | reconciler harness produces; loop executor + executor consume | 03, 05, 06 |
| `ContextEntry`, `MessageEntry`, `SectionEntry` | Same                                                          | 03, 06     |
| `ToolDeclaration`, `OutputDeclaration`         | reconciler harness produces; tool executor + runtime consume  | 03, 07     |
| `FormatterRef`, `FormatInput`, `FormatResult`  | Formatter harness                                             | 04         |
| `ExecutionResult`, `ExecutorTerminal`          | Executor harness produces; loop executor consumes             | 06         |
| `ExecutionTarget`                              | Loop executor passes to executor                              | 05, 06     |
| `EventEnvelope`, `ProtocolEvent`               | Every harness emits                                           | 10         |
| `ChannelEvent`, framework channels             | Gateway ↔ client                                              | 12         |
