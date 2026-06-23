# `@agentick/executor-anthropic-next` — Implementation Plan

**Status:** plan, awaiting review. No executor body implemented yet.
**Target:** close G8 (native Anthropic executor) in the v1→v2 parity tracker.
**SDK pinned:** `@anthropic-ai/sdk@^0.39.0` (current on-disk version under `node_modules/.pnpm/@anthropic-ai+sdk@0.39.0/`; matches the v1 adapter's dependency).
**Confidence:** high on translation tables (v1 adapter is the reference and the SDK shape is verified on disk). Moderate on extended-thinking edge cases (`redacted_thinking`, signature deltas) — flagged as open questions below.

---

## 1. Package metadata

```jsonc
{
  "name": "@agentick/executor-anthropic-next",
  "version": "0.0.0",
  "description": "Anthropic provider adapter for Agentick v2 — implements LanguageModelExecutor against the Anthropic Messages API.",
  "keywords": ["agent", "agentick", "ai", "anthropic", "claude", "executor", "harness"],
  "license": "MIT",
  "author": "Ryan Lindgren",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/agenticklabs/agentick.git",
    "directory": "packages/executor-anthropic",
  },
  "files": ["dist"],
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts", "default": "./src/index.ts" },
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "default": "./dist/index.js",
      },
    },
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.build.json --noEmit",
  },
  "dependencies": {
    "@agentick/runtime-next": "workspace:*",
    "@agentick/spec-next": "workspace:*",
    "@anthropic-ai/sdk": "^0.39.0",
    "effect": "^3.21.2",
  },
  "devDependencies": {
    "@agentick/spec-conformance-next": "workspace:*",
  },
}
```

**Departure from skill template:** the skill puts `@anthropic-ai/sdk` under `peerDependencies` + `devDependencies`. The shipped `executor-openai` puts `openai` under `dependencies` (regular dep) instead. I'm matching `executor-openai` since (a) it's the live reference, (b) provider SDKs aren't peers in this layout — the executor package is the integration point. (Skill bug; logged in §11.)

`tsconfig.json` and `tsconfig.build.json` are literal copies of `packages/executor-openai/`.

---

## 2. `AnthropicExecutorOptions`

```typescript
export interface AnthropicExecutorOptions {
  /** Default model id (e.g. "claude-3-5-sonnet-latest"). */
  readonly model?: string;
  /** API key. Falls back to ANTHROPIC_API_KEY env var. */
  readonly apiKey?: string;
  /** Custom base URL. Falls back to ANTHROPIC_BASE_URL env var. */
  readonly baseURL?: string;
  /** Default headers (e.g. for OAuth, custom auth proxies). */
  readonly headers?: Record<string, string>;
  /** Per-request timeout, ms. */
  readonly timeout?: number;
  /** Max retries on transient failures (SDK default: 2). */
  readonly maxRetries?: number;
  /** Default max_tokens (Anthropic requires this — defaults to 4096). */
  readonly maxTokens?: number;
  /**
   * Anthropic API version header (`anthropic-version`). The SDK sets a
   * default; this overrides for pre-release / beta features.
   */
  readonly anthropicVersion?: string;
  /**
   * Beta feature flags sent via `anthropic-beta` header. E.g.
   * `["prompt-caching-2024-07-31", "extended-cache-ttl-2025-04-11"]`.
   * Joined comma-separated by the SDK; we accept array for ergonomics.
   */
  readonly betas?: ReadonlyArray<string>;
  /** Inject a pre-built Anthropic client (testing / advanced setups). */
  readonly client?: import("@anthropic-ai/sdk").default;
  /** Stream every execute() by default. */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags from content blocks (G7).
   * Anthropic's native extended-thinking is preferred (it emits
   * `thinking` content blocks server-side); this option is for the
   * exotic case where an adopter pipes a non-thinking Claude through a
   * pre-prompt that elicits `<think>` tags in the text channel.
   */
  readonly parseThinkTags?: boolean;
  /** Adopter-declared XML-like tags to extract (G12). */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
  /** Override the self-described target (capabilities, modelId, etc.). */
  readonly target?: ExecutionTarget;
}
```

`CustomBlockDefinition` is re-exported from `@agentick/executor-openai-next` (same shared `StreamTagParser` primitive — see §6).

---

## 3. Capabilities — `target.capabilities`

Default target (when adopter doesn't override) advertises capabilities by **model family heuristic** keyed off the `model` string. Mapping:

| modelId prefix                | contextWindow | maxOutputTokens | supportsVision | supportsReasoning        |
| ----------------------------- | ------------- | --------------- | -------------- | ------------------------ |
| `claude-3-5-sonnet*`          | 200_000       | 8_192           | true           | false                    |
| `claude-3-5-haiku*`           | 200_000       | 8_192           | false          | false                    |
| `claude-3-7-sonnet*`          | 200_000       | 64_000          | true           | true (extended-thinking) |
| `claude-3-opus*`              | 200_000       | 4_096           | true           | false                    |
| `claude-3-sonnet*`            | 200_000       | 4_096           | true           | false                    |
| `claude-3-haiku*`             | 200_000       | 4_096           | true           | false                    |
| `claude-2.*`                  | 200_000       | 4_096           | false          | false                    |
| _fallback (unknown / future)_ | 200_000       | 4_096           | true           | false                    |

`supportsTools: true` and `supportsStreaming: true` are unconditional — every shipped Claude supports both.

These numbers come from public Anthropic documentation; verified against v1 adapter's `discoverModels`-equivalent comments. Confidence: high on Sonnet 3.5 / Haiku 3.5 / Opus 3, medium on 3.7 Sonnet's exact max-output ceiling (8K vs 64K varies by tier — flagged as open question §10).

---

## 4. `ProviderOptions` module augmentation

Right after imports in `anthropic-executor.ts`:

```typescript
declare module "@agentick/spec-next" {
  interface ProviderOptions {
    readonly anthropic?: {
      /** Anthropic API version override (header). */
      readonly anthropicVersion?: string;
      /** Beta flags merged into `anthropic-beta` header. */
      readonly betas?: ReadonlyArray<string>;
      /** Per-call metadata (Metadata.user_id for abuse detection). */
      readonly metadata?: { readonly user_id?: string };
      /** top_k sampling — Anthropic-only knob. */
      readonly top_k?: number;
      /** stop_sequences (also accepted on canonical params). */
      readonly stop_sequences?: ReadonlyArray<string>;
      /** Extended-thinking config: { type: "enabled", budget_tokens: number } | { type: "disabled" }. */
      readonly thinking?:
        | { readonly type: "enabled"; readonly budget_tokens: number }
        | { readonly type: "disabled" };
      /** Tool-choice override: { type: "auto" | "any" | "tool" | "none", name?, disable_parallel_tool_use? }. */
      readonly tool_choice?: {
        readonly type: "auto" | "any" | "tool" | "none";
        readonly name?: string;
        readonly disable_parallel_tool_use?: boolean;
      };
      /**
       * Cache-control strategy. Controls where the adapter stamps
       * `cache_control: { type: "ephemeral" }` markers. Anthropic caches
       * are stamped on individual content blocks; this option is a
       * convenience for common patterns.
       *
       * - "system": stamp the last system block (cache the system prompt).
       * - "tools": stamp the last tool definition (cache tool defs).
       * - "last-message": stamp the last user message's last text part.
       * - { manual: true }: don't stamp anywhere; adopter sets
       *   cache_control on individual blocks via raw providerOptions.
       *
       * Multiple strategies can compose: ["system", "tools"].
       */
      readonly cacheControl?:
        | ReadonlyArray<"system" | "tools" | "last-message">
        | { readonly manual: true };
      /**
       * Arbitrary additional request-body overrides spread last
       * (matches OpenAI adapter's escape hatch).
       */
      readonly [key: string]: unknown;
    };
  }
}
```

**Why these fields and not others:**

- `top_k`, `stop_sequences`, `metadata.user_id`, `thinking`, `tool_choice`: all live in `MessageCreateParamsBase` (verified at `node_modules/.pnpm/@anthropic-ai+sdk@0.39.0/.../resources/messages/messages.d.ts:704+`). They're per-request, not per-client.
- `anthropicVersion` + `betas`: per-call header overrides (rare; Anthropic typically pins these per-client). Included for completeness.
- `cacheControl`: this is the Anthropic-defining feature. v1 stamps `cache_control` on the last system text part by default — I'm exposing the same behavior as an explicit option, with `"manual"` to opt out. (v1 actually does NOT stamp by default — adopters set it via `providerOptions.anthropic`. v2 adopts the more explicit `cacheControl` array. Open question §10.)

---

## 5. Translation tables

### 5.1 `toAnthropicMessages(messages: ReadonlyArray<LanguageModelMessage>): { system, messages }`

**Preserve from v1 (`packages/adapters/anthropic/src/anthropic.ts:486-646`):**

- **System extraction:** v1 collects all `role: "system"` messages and joins their text into a single `system` string. v2 should match BUT prefer the array form (`Array<TextBlockParam>`) when there are multiple system parts OR when `cacheControl: ["system"]` is requested (so we can attach `cache_control` to the last block).
- **Role mapping:** `tool` role → `user` role with `tool_result` content block (Anthropic doesn't have a tool role).
- **Alternation coalescing:** v1 line 624-633 coalesces consecutive same-role messages. **Critical to preserve** — Anthropic API rejects non-alternating user/assistant sequences. Must carry over.
- **Content-block mapping** (per part type):
  - `text` → `{ type: "text", text }`
  - `image` → `{ type: "image", source: ... }` — Anthropic supports `base64` AND `url` source types (SDK types `Base64ImageSource | URLImageSource`). v1 line 517-535 handles both; v2 must too. The canonical `LanguageModelMessagePart` only carries `imageUrl: string`, so we parse: `data:...` → base64 source, anything else → URL source.
  - `tool_use` → `{ type: "tool_use", id, name, input }` (matches `ToolUseBlockParam` shape verified in SDK).
  - `tool_result` → `{ type: "tool_result", tool_use_id, content: [...] }`. Nested content recurses via `messagePartFromBlock` analog. Empty content → `[{ type: "text", text: "Done" }]` (v1 line 564 preserves this — Anthropic rejects empty tool_result content).

**v2-specific:** `LanguageModelMessagePart` is flatter than v1's `ContentBlock` (no `document`, no `reasoning` part at the executor boundary — those flatten before reaching the executor). So we drop the `document` / `reasoning` cases. **Open question §10:** does the projection lose extended-thinking signature data on tool-use round-trips? See §10.4.

### 5.2 `toAnthropicSystem`

Pulled out as its own helper because Anthropic's `system` parameter has two valid shapes:

- `string` (simple case)
- `Array<TextBlockParam>` (needed for `cache_control` stamping and multi-block system prompts)

Default: `string` form. When `cacheControl: ["system"]` is active, switch to array form and stamp `cache_control: { type: "ephemeral" }` on the **last** block (Anthropic's caching semantics — the marker applies to the cumulative content up to and including the marked block).

### 5.3 `toAnthropicTools(tools: ReadonlyArray<LanguageModelTool>): Array<Anthropic.Tool>`

```typescript
function toAnthropicTool(t: LanguageModelTool): Anthropic.Tool {
  const out: Anthropic.Tool = {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  };
  return out;
}
```

**G11 hook (Medium parity gap, not blocking):** when v2's `ToolDeclaration` gains `providerOptions.anthropic` (per G11), spread it onto the tool here. v1 does this at line 668-672. Plumbed in but no-op until spec adds the field.

**`cacheControl: ["tools"]`:** stamp `cache_control: { type: "ephemeral" }` on the last tool. Same semantics as system.

### 5.4 `toAnthropicParams(input, target, defaultModel, executorOptions): MessageCreateParams`

```typescript
function toAnthropicParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
  executorMaxTokens: number | undefined,
): MessageCreateParams {
  const { system, messages } = toAnthropicMessages(input.messages, target);
  const tools =
    input.tools && input.tools.length > 0 ? input.tools.map(toAnthropicTool) : undefined;

  const params: MessageCreateParams = {
    model: target.modelId ?? defaultModel ?? "claude-3-5-sonnet-latest",
    messages,
    // Anthropic REQUIRES max_tokens. Order of precedence:
    //   parameters.maxOutputTokens → executor option → 4096 fallback
    max_tokens: input.parameters?.maxOutputTokens ?? executorMaxTokens ?? 4096,
  };
  const p = input.parameters;
  if (system !== undefined) params.system = system;
  if (tools !== undefined) params.tools = tools;
  if (p?.temperature !== undefined) params.temperature = p.temperature;
  if (p?.topP !== undefined) params.top_p = p.topP;
  if (p?.stopSequences !== undefined) params.stop_sequences = [...p.stopSequences];

  // G5: spread provider-specific options last.
  const overrides = target.providerOptions?.anthropic;
  if (overrides && typeof overrides === "object") {
    // Strip cacheControl (consumed by toAnthropicMessages/toAnthropicTools).
    const { cacheControl: _cc, ...rest } = overrides;
    void _cc;
    Object.assign(params, rest);
  }
  return params;
}
```

**Gaps vs v1's `prepareInput`:**

- v1 special-cases `frequencyPenalty` / `presencePenalty` by dropping them silently (Anthropic doesn't support these). v2 should do the same: silently drop. Don't surface as an error — adopters writing portable prompts shouldn't get punished for setting them.
- v1 doesn't plumb `responseFormat`. Anthropic has no native JSON-schema mode (as of SDK 0.39.0). v2 will **silently drop `responseFormat`** with a comment explaining why — adopters wanting structured output through Claude use tool-use as the canonical mechanism. Open question §10.

### 5.5 `mapChunkToAdapterDeltas(event: RawMessageStreamEvent, state): AdapterDelta[]`

This is the largest piece. State carried across chunks:

```typescript
interface AnthropicStreamState {
  // Map of Anthropic block index → block-type + tracking metadata.
  blocks: Map<
    number,
    {
      type: "text" | "thinking" | "tool_use" | "redacted_thinking";
      callId?: string; // tool_use only — the block.id
      name?: string; // tool_use only — the block.name
      jsonBuffer: string; // tool_use only — input JSON delta accumulator
      textBuffer: string; // text/thinking — for end-summary emission
    }
  >;
  model?: string;
  messageStarted: boolean;
}
```

Mapping by event type:

| Anthropic event                           | AdapterDeltas emitted                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `message_start`                           | `message-start` (role: assistant, model). Optionally `usage` if input_tokens present.                         |
| `content_block_start (text)`              | `content-start { blockIndex, blockType: "text" }`. State: track index.                                        |
| `content_block_start (tool_use)`          | `tool-call-start { callId: block.id, name: block.name, blockIndex }`. State: track.                           |
| `content_block_start (thinking)`          | `reasoning-start { blockIndex }`. State: track.                                                               |
| `content_block_start (redacted_thinking)` | Skip emission (no AdapterDelta equivalent for opaque thinking). State: track. See §10.5.                      |
| `content_block_delta (text_delta)`        | `content-delta { blockIndex, delta: delta.text }`.                                                            |
| `content_block_delta (input_json_delta)`  | `tool-call-delta { callId: state.callId, delta: delta.partial_json }`. Append to state.jsonBuffer.            |
| `content_block_delta (thinking_delta)`    | `reasoning-delta { blockIndex, delta: delta.thinking }`.                                                      |
| `content_block_delta (signature_delta)`   | Skip — opaque signature data used only for tool-use round-tripping. See §10.4.                                |
| `content_block_delta (citations_delta)`   | Stash in state for `content-end` metadata. (Not in v1 — v2 improvement.)                                      |
| `content_block_stop (text)`               | `content-end { blockIndex }` then `content { blockIndex, content: { type: "text", text: state.textBuffer } }` |
| `content_block_stop (tool_use)`           | `tool-call-end { callId }` then `tool-call { callId, name, input: JSON.parse(jsonBuffer) }`                   |
| `content_block_stop (thinking)`           | `reasoning-end { blockIndex }` then `reasoning { blockIndex, reasoning: state.textBuffer }`                   |
| `message_delta`                           | Stash `stop_reason` and `usage.output_tokens` in state. (No AdapterDelta yet — held for `message_stop`.)      |
| `message_stop`                            | `message-end { stopReason, usage }` then `message { message: assembled, stopReason, usage }`                  |

**Critical preservation from v1's `mapAnthropicChunk` (anthropic.ts:57-186):**

- Per-block state map (v1 has it; necessary because Anthropic streams content blocks interleaved by index, and the deltas don't carry the block's metadata — you have to remember what `content_block_start` told you).
- `input_json_delta`'s `partial_json` is concatenated into a buffer and `JSON.parse`d at `content_block_stop`. v1 has this; v2 must.
- `thinking_delta.thinking` is the actual text (not `thinking_delta.text` — verified at SDK `messages.d.ts`).

**Reasoning shape (G3) — DIFFERENT from OpenAI:**

OpenAI duck-types `delta.reasoning_content` / `delta.reasoning` on the content delta. **Anthropic has FIRST-CLASS thinking blocks via `content_block_start { content_block: { type: "thinking" } }` + `content_block_delta { delta: { type: "thinking_delta" } }`.** v2's reasoning AdapterDelta family maps directly. No duck-typing needed. The skill's G3 guidance ("non-standard fields") is OpenAI-specific — Anthropic is the cleanest path.

### 5.6 `mapFinishReason(reason: string | null): LanguageModelStopReason`

```typescript
function mapFinishReason(r: string | null | undefined): LanguageModelStopReason {
  switch (r) {
    case "end_turn":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "end"; // canonical "end" — adopter sees in raw if needed
    case "tool_use":
      return "tool_use";
    default:
      return "end";
  }
}
```

Matches v1's `STOP_REASON_MAP` (types.ts:72-77).

### 5.7 `normalizeImpl(raw: Anthropic.Message): LanguageModelExecutionResult`

Non-streaming path. Iterates `raw.content[]`:

- `text` block → `{ type: "text", text }`
- `tool_use` block → `{ type: "tool_use", toolUseId: id, name, input }` + push to `toolCalls`
- `thinking` block → `{ type: "reasoning", text: thinking }`
- `redacted_thinking` block → emit a sentinel `{ type: "reasoning", text: "[redacted]" }` OR skip (decision in §10.5)

Usage mapping (G2):

```typescript
usage: {
  inputTokens: raw.usage?.input_tokens ?? 0,
  outputTokens: raw.usage?.output_tokens ?? 0,
  totalTokens: (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
  ...(raw.usage?.cache_read_input_tokens != null
    ? { cachedInputTokens: raw.usage.cache_read_input_tokens }
    : {}),
  ...(raw.usage?.cache_creation_input_tokens != null
    ? { cacheCreationTokens: raw.usage.cache_creation_input_tokens }
    : {}),
}
```

Verified: SDK's `Usage` interface (messages.d.ts:549-567) carries `cache_creation_input_tokens` and `cache_read_input_tokens` directly (no nesting under `prompt_tokens_details` like OpenAI). They're `number | null`, so we check `!= null` not `=== undefined`.

---

## 6. Cache tokens (G2)

**Source fields on Anthropic responses:**

- Non-streaming `Message.usage`: `cache_creation_input_tokens: number | null`, `cache_read_input_tokens: number | null`. (Verified at `messages.d.ts:549-567`.)
- Streaming: `message_start.message.usage` carries the full `Usage` (including cache tokens — they're known up-front since they reflect the request, not the response). `message_delta.usage` is a `MessageDeltaUsage` with only `output_tokens` (verified at `messages.d.ts:237-244`).

**Plumbing strategy:**

- On `message_start`, stash `cache_read_input_tokens` and `cache_creation_input_tokens` into stream state.
- On `message_stop`, fold into final `UsageStats`:
  - `cachedInputTokens ← cache_read_input_tokens` (when non-null)
  - `cacheCreationTokens ← cache_creation_input_tokens` (when non-null)
- Emit on `message-end` delta + the `message` summary delta.

**Cache MARKER plumbing (G2 send-side):** the `cacheControl` executor/providerOption controls where we stamp `cache_control: { type: "ephemeral" }` markers on outgoing blocks (system, last tool, last message). Default: no markers (matches v1). Adopters opt in via `target.providerOptions.anthropic.cacheControl`.

---

## 7. Reasoning extraction (G3) — Anthropic's first-class path

**OpenAI's path (for contrast):** duck-types `delta.reasoning_content` / `delta.reasoning` because vLLM and LM Studio expose chain-of-thought via non-standard SSE fields. The executor sniffs each chunk.

**Anthropic's path:** native. The model emits a `thinking` content block (or `redacted_thinking` for safety-policy-redacted thinking). Stream sequence:

```
content_block_start { content_block: { type: "thinking", thinking: "" } }
content_block_delta { delta: { type: "thinking_delta", thinking: "First, I..." } }
content_block_delta { delta: { type: "thinking_delta", thinking: " consider..." } }
content_block_stop  { index: N }
```

Maps directly to:

```
reasoning-start { blockIndex }
reasoning-delta { blockIndex, delta: "First, I..." }
reasoning-delta { blockIndex, delta: " consider..." }
reasoning-end   { blockIndex }
reasoning       { blockIndex, reasoning: <accumulated> }
```

**Cleaner than OpenAI's duck-typing.** No `parseThinkTags` fallback needed for Claude — extended thinking IS the native API. We still ship `parseThinkTags` as an executor option for completeness, but it's a niche use case for Claude (mainly: running Claude through an OpenAI-compatible proxy that strips the thinking block but leaves a textual `<think>` artifact).

**Open question §10.4 — signature deltas:** Anthropic's extended-thinking API sends `signature_delta` events that carry opaque per-block signatures the API expects echoed back on subsequent turns (when continuing a tool-use loop with a thinking-enabled model). v2's `LanguageModelMessagePart.tool_use` has no signature field. **This is a real gap.** Options:

1. Drop signatures (works for single-turn; breaks multi-turn extended-thinking with tools).
2. Stash signatures in `providerOptions`-style sidecars on the projected message (invasive — requires spec change).
3. Stash on the executor instance keyed by `callId`, replay on next `toAnthropicMessages` call.

Recommend option 3 for v2.0 — keeps spec clean; ugly but localized. **Decision deferred to implementation review.**

---

## 8. Streaming events table (complete)

| SDK event                                                             | What we do                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `message_start { message: { id, role, model, usage, ... } }`          | emit `message-start { role, model }`; stash usage cache-token fields in state         |
| `content_block_start { index, content_block: TextBlock }`             | emit `content-start { blockIndex: index, blockType: "text" }`                         |
| `content_block_start { index, content_block: ToolUseBlock }`          | emit `tool-call-start { callId: block.id, name: block.name, blockIndex: index }`      |
| `content_block_start { index, content_block: ThinkingBlock }`         | emit `reasoning-start { blockIndex: index }`                                          |
| `content_block_start { index, content_block: RedactedThinkingBlock }` | track in state; skip emission OR emit synthetic reasoning (§10.5)                     |
| `content_block_delta { delta: TextDelta }`                            | emit `content-delta { blockIndex, delta: delta.text }`; append to textBuffer          |
| `content_block_delta { delta: InputJSONDelta }`                       | emit `tool-call-delta { callId, delta: delta.partial_json }`; append to jsonBuffer    |
| `content_block_delta { delta: ThinkingDelta }`                        | emit `reasoning-delta { blockIndex, delta: delta.thinking }`; append to textBuffer    |
| `content_block_delta { delta: SignatureDelta }`                       | stash signature on state (for §10.4 multi-turn round-trip)                            |
| `content_block_delta { delta: CitationsDelta }`                       | stash citation on state's metadata; surfaced on `content-end` and `content`           |
| `content_block_stop { index }` (text)                                 | emit `content-end { blockIndex }`, then `content { blockIndex, content: TextBlock }`  |
| `content_block_stop { index }` (tool_use)                             | emit `tool-call-end { callId }`, then `tool-call { callId, name, input: JSON.parse }` |
| `content_block_stop { index }` (thinking)                             | emit `reasoning-end { blockIndex }`, then `reasoning { blockIndex, reasoning }`       |
| `message_delta { delta: { stop_reason }, usage }`                     | stash `stop_reason` + `output_tokens` in state                                        |
| `message_stop`                                                        | emit `message-end { stopReason, usage }`, then `message { message: assembled, ... }`  |

**Final assembled `Anthropic.Message` reconstruction** (for `.result` resolution) mirrors v1's `reconstructRaw` (anthropic.ts:360-421): build `content[]` from per-block buffers, set `stop_reason`, populate `usage` with cache fields.

---

## 9. Error mapping

```typescript
function mapExecuteError(cause: unknown): ExecuteError {
  if (cause instanceof Error) {
    const status = (cause as { status?: number }).status;
    const name = cause.name;
    // SDK exposes AnthropicError, APIError, APIUserAbortError.
    if (name === "APIUserAbortError" || /aborted/i.test(cause.message)) {
      return { _tag: "ProviderAborted", reason: cause.message };
    }
    if (typeof status === "number") {
      return { _tag: "ProviderRejected", status, cause };
    }
  }
  return { _tag: "StreamFailed", cause };
}
```

Mirrors OpenAI adapter (lines 1667-1680). Duck-typed on `status` because importing the SDK's error classes adds runtime weight for what's effectively an `instanceof` check we can do structurally.

---

## 10. Open questions / decisions to defer

### 10.1 `parseThinkTags` default

OpenAI defaults to `false`. For Anthropic, `parseThinkTags` is **even more niche** (the SDK already exposes thinking natively). Default `false`. Document as a fallback for OpenAI-compatible-proxy-of-Claude setups only.

### 10.2 `responseFormat` handling

Anthropic has no JSON-schema response mode. v1 silently drops; v2 should do the same with an inline comment pointing adopters at tool-use. **Confirm with user this is acceptable.**

### 10.3 `cacheControl` default

v1 does NOT stamp `cache_control` by default — adopters opt in via raw `providerOptions.anthropic`. v2 plan adopts the same default (no stamping) but offers `cacheControl: ["system", "tools"]` as ergonomic sugar. **Confirm with user this is the right default.**

### 10.4 Signature deltas on multi-turn extended-thinking + tools

When using Claude 3.7+ with extended thinking AND tool use, Anthropic emits `signature_delta` events carrying opaque per-block signatures. These must be echoed back on the next request (in the `tool_use` block's signature field) for the API to accept the continuation.

v2's `LanguageModelMessagePart.tool_use` shape doesn't carry a signature. Options:

1. Drop (breaks multi-turn thinking+tools).
2. Stash on executor instance keyed by `callId` and inject during next `toAnthropicMessages` (ugly but localized).
3. Extend spec (`LanguageModelMessagePart.tool_use` gains optional `providerData?: Record<string, unknown>`).

**Recommend option 2 for v2.0 (no spec change) with a TODO to revisit for 2.1.** Confirm with user.

### 10.5 `redacted_thinking` blocks

Anthropic returns these when the model's chain-of-thought contains content that violates safety policy (the API still returns a block but with `data: <opaque-bytes>` instead of plaintext thinking). Options:

1. Skip entirely (lose round-trip fidelity).
2. Emit synthetic `reasoning { reasoning: "[redacted]" }` (adopters see a placeholder).
3. Stash opaque data sidecar for round-trip; emit empty `reasoning` block to consumers.

**Recommend option 2 for adopter visibility, option 3 plumbed for round-trip.** Confirm with user.

### 10.6 Claude 3.7 Sonnet `maxOutputTokens`

The 64K output mode is tier-gated (requires `output-128k-2025-02-19` beta header) — without the beta, it's 8K. Default capability table should advertise 8K and document the beta. Confirm with user.

### 10.7 Strict input/assistant alternation when tool_use + tool_result interleave

v1's coalescing logic (anthropic.ts:624-633) handles consecutive same-role messages by merging content. But the canonical case (assistant tool_use → user tool_result → assistant continuation) already alternates correctly. The coalescing matters when the IR produces, e.g., two consecutive user messages (one with text, one with tool_result). Need a fixture-driven test to confirm v2's projection doesn't break this. Flagged for implementation review.

### 10.8 README presence in `executor-openai`

Skill instructs "Adopt the structure of `packages/executor-openai/README.md`" but **that file doesn't exist**. The skill is wrong; I'll write a fresh README based on the executor-openai source comments and the v1 anthropic README. Logged as skill bug §11.

---

## 11. Test plan

### 11.1 Universal conformance (`__tests__/conformance.spec.ts`)

Drives `runExecutorConformance` from `@agentick/spec-conformance-next`. Factory mirrors `executor-openai`'s pattern:

```typescript
runExecutorConformance(async ({ harnessId, scripted }) => {
  const stub = new StubAnthropicClient([
    { kind: "non-streaming", message: completionFor(scripted) },
    { kind: "streaming", events: streamingEventsFor(scripted) },
  ]);
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new AnthropicExecutor(harnessId, journal, bus, inbox, {
    client: asClient(stub),
    model: "claude-3-5-sonnet-latest",
  });
  await exec.ready;
  return { executor: exec, bus };
});
```

`completionFor` builds an `Anthropic.Message` from the scripted `LanguageModelExecutionResult`. `streamingEventsFor` produces a minimal valid event sequence: `message_start`, `content_block_start (text)`, `content_block_delta (text_delta)`, `content_block_stop`, `message_delta { stop_reason: "end_turn" }`, `message_stop`.

### 11.2 Provider-specific (`__tests__/anthropic-executor.spec.ts`)

Categories required by the skill + Anthropic-specific:

| Test category                            | What it asserts                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Non-streaming basics                     | `run` returns succeeded terminal; finish reason mapped; model threaded                                           |
| System message extraction                | `role: system` messages collapse to `system` param, not inline                                                   |
| User/assistant alternation coalescing    | Consecutive same-role messages merge content arrays                                                              |
| Tool-use round-trip                      | `tool_use` block → SDK call → `tool_result` echoes back correctly                                                |
| Streaming basics                         | Iterator yields valid AdapterDeltas; `.result` resolves with Message                                             |
| Streaming: content-block-state           | Interleaved text + tool_use blocks track correct blockIndex per stream                                           |
| Abort                                    | `abort()` flips next `run()` to `canceled`                                                                       |
| **Cache tokens (G2)**                    | `cache_read_input_tokens` / `cache_creation_input_tokens` → `cachedInputTokens` / `cacheCreationTokens` on usage |
| **Cache markers (G2 send-side)**         | `cacheControl: ["system"]` stamps `cache_control: { type: "ephemeral" }` on last system text block               |
| **Cache markers — tools**                | `cacheControl: ["tools"]` stamps marker on last tool                                                             |
| **Reasoning extraction (G3 — native)**   | Streamed `thinking` blocks → reasoning-start/delta/end/reasoning deltas + ReasoningBlock in normalize output     |
| **Reasoning extraction — non-streaming** | `Message.content` with `thinking` block → ReasoningBlock                                                         |
| **Base64 image (G4)**                    | `data:image/png;base64,...` projected → Anthropic base64 source param                                            |
| **URL image (G4)**                       | `https://...` projected → Anthropic url source param                                                             |
| Sampling params (G1)                     | `temperature`, `topP`, `stopSequences`, `maxOutputTokens` plumbed to SDK                                         |
| Sampling params dropped silently         | `frequencyPenalty` / `presencePenalty` do NOT appear in SDK params                                               |
| `max_tokens` required                    | Missing both `parameters.maxOutputTokens` AND `options.maxTokens` → 4096 fallback                                |
| providerOptions spread (G5)              | `target.providerOptions.anthropic.top_k = 40` appears in SDK params                                              |
| providerOptions: thinking config         | `{ thinking: { type: "enabled", budget_tokens: 2048 } }` plumbs through                                          |
| providerOptions: tool_choice             | `{ tool_choice: { type: "any" } }` plumbs through                                                                |
| Bus envelope mirror (G6)                 | Streaming path emits ≥1 envelope on bus's `executor:delta` channel                                               |
| Custom blocks (G12)                      | `customBlocks: { citation: {} }` extracts inline `<citation>...</citation>` from text                            |
| `parseThinkTags` (G7)                    | `parseThinkTags: true` routes `<think>...</think>` to reasoning deltas                                           |
| Journaled lifecycle                      | `run` produces `requested` + `terminal` envelopes on the journal                                                 |
| Env var fallbacks (G16)                  | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` honored when options omit them                                        |
| Stop reason mapping                      | `end_turn` → `end`, `max_tokens` → `max_tokens`, `tool_use` → `tool_use`, `stop_sequence` → `end`                |
| Streaming + non-streaming equivalence    | Both paths produce equivalent normalized result for the same scripted output                                     |

### 11.3 Factory (`__tests__/anthropic-factory.spec.ts`)

- `anthropic("claude-...", opts)` returns an `ExecutorFactory` with `executorFactory: true`.
- Factory called with substrate produces an `AnthropicExecutor` instance.
- Options merge (`model` from positional arg overrides `options.model` if both set).

### 11.4 Stub (`__tests__/stub-anthropic-client.ts`)

Mirrors `StubOpenAIClient` shape:

```typescript
export type CannedResponse =
  | { kind: "non-streaming"; message: Anthropic.Message }
  | { kind: "streaming"; events: ReadonlyArray<RawMessageStreamEvent> };

export class StubAnthropicClient {
  readonly calls: Array<{ params: MessageCreateParams; signal: AbortSignal | undefined }> = [];
  readonly messages = {
    create: (params, options) => { ... },  // dispatch by params.stream
    stream: (params, options) => { ... },  // for the .stream() path
  };
}
```

**Subtle:** v1 uses `client.messages.stream(...)` (the SDK's high-level helper), not `client.messages.create({ stream: true })`. **Decision: v2 should use `create({ stream: true })`** for parity with OpenAI executor (one code path, streaming dispatched by flag). The SDK's `.create()` overload accepts the streaming variant and returns `Stream<RawMessageStreamEvent>` (verified at `messages.d.ts:22`). The `.stream()` helper adds bells (event emitter, accumulated message) that we don't need at the executor layer.

This is a divergence from v1; the stub then only needs `messages.create`.

---

## 12. Verification checklist (post-implementation)

- [ ] `pnpm --filter @agentick/executor-anthropic-next typecheck` clean
- [ ] `pnpm exec vitest run packages/executor-anthropic` — conformance + provider-specific pass
- [ ] `pnpm typecheck` (full workspace) clean
- [ ] Walk through `V1-PARITY-TRACKER.md` Critical (G1–G6, G15) + High (G7, G12); each addressed or N/A noted
- [ ] `ProviderOptions` augmentation contributes typed `anthropic` slot
- [ ] `parseThinkTags` works (streaming `<think>...</think>` test passes)
- [ ] `customBlocks` works (streaming `<citation>...</citation>` test passes)
- [ ] `imageUrlFromSource`-equivalent: base64 source projects to `data:...` URL THEN converts to Anthropic base64 source (no `[binary]` placeholder)
- [ ] Streaming + non-streaming paths produce equivalent final results
- [ ] Bus envelopes fire on the streaming path (test subscribes to `{ surface: "executor", phase: "delta" }`)
- [ ] Env var fallbacks work (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
- [ ] Tool-use round-trip works end-to-end
- [ ] Cache tokens surface on `usage` (G2)
- [ ] Reasoning extraction surfaces ReasoningBlock (G3)
- [ ] V1-PARITY-TRACKER.md G8 status flipped `[ ]` → `[x]` with commit hash
- [ ] STATUS.md updated with delivery note
