/**
 * `StreamAccumulator` — generic streaming-state accumulator for
 * `BaseLanguageModelExecutor`.
 *
 * The base owns ONE accumulator per stream and feeds it from every
 * `AdapterDelta` flowing through the transform pipeline (after
 * provider-specific `mapChunk` + adapter / customBlock / user
 * transforms). Provider `reconstructRaw(accumulator)` reads the final
 * state to synthesize the canonical provider response.
 *
 * Generic enough for all four shipped providers (OpenAI, Anthropic,
 * Google, AI SDK). The accumulator does NOT emit events — emission is
 * the base's job; the accumulator is read-only-from-outside until
 * `reconstructRaw` consumes it.
 *
 * Provider-specific state (Anthropic's per-block `cache_control`,
 * Google's `thoughtSignature` round-trip, OpenAI's `reasoning_content`
 * vs reasoning field) attaches to the per-call's `extra` slot at
 * `recordToolCall` time (via the delta's `providerMetadata`) and is
 * read by `reconstructRaw`.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type {
  AdapterDelta,
  ContentBlock,
  LanguageModelStopReason,
  UsageStats,
} from "@agentick/spec";

/**
 * Per-tool-call accumulating state. JSON arguments arrive as deltas
 * during streaming; the final summary `tool-call` delta carries the
 * parsed input object (or the buffer can be parsed on-demand).
 */
export interface AccumToolCall {
  /** Stable id assigned by the provider (OpenAI tc.id, Anthropic tool_use.id, etc.) */
  readonly callId: string;
  /** Tool name (the model selected which tool to call). */
  readonly name: string;
  /** Block index inside the assistant message (for symmetric tool-call-start/end). */
  readonly blockIndex: number;
  /** Accumulated JSON-encoded argument fragments (from tool-call-delta deltas). */
  argsBuffer: string;
  /** Parsed input — set when the final `tool-call` delta arrives. */
  input?: Readonly<Record<string, unknown>>;
  /** Per-call provider metadata (e.g. Google's thoughtSignature). */
  providerMetadata?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Generic streaming accumulator. The base creates one per stream and
 * mutates it as deltas flow through the transform pipeline.
 *
 * Provider `reconstructRaw` reads the final state to assemble the
 * canonical provider response.
 */
export class StreamAccumulator {
  /** Block-indexed text buffers. Keyed by `blockIndex`. */
  readonly textByBlock = new Map<number, string>();
  /** Reasoning buffers (one per reasoning block). Keyed by `blockIndex`. */
  readonly reasoningByBlock = new Map<number, string>();
  /** Tool calls in arrival order, keyed by `callId`. */
  readonly toolCalls = new Map<string, AccumToolCall>();

  /** Final stop reason. Defaults to `"end"` until a `message-end` delta arrives. */
  stopReason: LanguageModelStopReason = "end";
  /** Usage stats. Zeroed until a `message-end` (or chunk-carried usage). */
  usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  /** Whether `message-start` has been observed. */
  messageStarted = false;
  /** Whether `message-end` has been observed. */
  messageEnded = false;
  /** Model id observed from the provider (when chunk-carried). */
  modelSeen: string | undefined = undefined;

  /** Currently open content blocks (block index → kind). */
  readonly openBlocks = new Map<number, "text" | "reasoning">();
  /** Block-index high-water mark — providers without server-provided indices use this to allocate. */
  highWaterBlockIndex = -1;

  /**
   * Provider-private state slot. Providers stash data here (e.g.
   * OpenAI's `id` / `created` / `finish_reason` from `ChatCompletionChunk`;
   * Anthropic's per-block `cache_control`) inside `mapChunk` and read
   * it back in `reconstructRaw`. The base never touches this slot.
   *
   * Use a typed reader/writer per provider to keep this safe:
   *   const extra = accum.providerExtra as MyProviderState ?? (accum.providerExtra = { ... } as MyProviderState);
   */
  providerExtra: unknown = undefined;

  /**
   * Apply a single `AdapterDelta` to the accumulator. Called by the base
   * for every delta AFTER the transform pipeline runs. Idempotent for
   * the symmetric summary events (`content`, `tool-call`, `message`)
   * — they confirm rather than rewrite.
   */
  apply(delta: AdapterDelta): void {
    switch (delta.type) {
      case "message-start":
        this.messageStarted = true;
        if (delta.model) this.modelSeen = delta.model;
        break;
      case "message-end":
        this.messageEnded = true;
        this.stopReason = delta.stopReason;
        this.usage = delta.usage;
        break;
      case "content-start":
        this.openBlocks.set(delta.blockIndex, "text");
        if (!this.textByBlock.has(delta.blockIndex)) {
          this.textByBlock.set(delta.blockIndex, "");
        }
        if (delta.blockIndex > this.highWaterBlockIndex) {
          this.highWaterBlockIndex = delta.blockIndex;
        }
        break;
      case "content-delta": {
        const prev = this.textByBlock.get(delta.blockIndex) ?? "";
        this.textByBlock.set(delta.blockIndex, prev + delta.delta);
        break;
      }
      case "content-end":
        this.openBlocks.delete(delta.blockIndex);
        break;
      case "content":
        // Summary event — confirm the block's text.
        if (delta.content.type === "text") {
          this.textByBlock.set(delta.blockIndex, delta.content.text);
        }
        if (delta.blockIndex > this.highWaterBlockIndex) {
          this.highWaterBlockIndex = delta.blockIndex;
        }
        break;
      case "reasoning-start":
        this.openBlocks.set(delta.blockIndex, "reasoning");
        if (!this.reasoningByBlock.has(delta.blockIndex)) {
          this.reasoningByBlock.set(delta.blockIndex, "");
        }
        if (delta.blockIndex > this.highWaterBlockIndex) {
          this.highWaterBlockIndex = delta.blockIndex;
        }
        break;
      case "reasoning-delta": {
        const prev = this.reasoningByBlock.get(delta.blockIndex) ?? "";
        this.reasoningByBlock.set(delta.blockIndex, prev + delta.delta);
        break;
      }
      case "reasoning-end":
        this.openBlocks.delete(delta.blockIndex);
        break;
      case "reasoning":
        this.reasoningByBlock.set(delta.blockIndex, delta.reasoning);
        if (delta.blockIndex > this.highWaterBlockIndex) {
          this.highWaterBlockIndex = delta.blockIndex;
        }
        break;
      case "tool-call-start": {
        const blockIndex = delta.blockIndex ?? this.highWaterBlockIndex + 1;
        this.highWaterBlockIndex = Math.max(this.highWaterBlockIndex, blockIndex);
        if (!this.toolCalls.has(delta.callId)) {
          this.toolCalls.set(delta.callId, {
            callId: delta.callId,
            name: delta.name,
            blockIndex,
            argsBuffer: "",
          });
        }
        break;
      }
      case "tool-call-delta": {
        const entry = this.toolCalls.get(delta.callId);
        if (entry) entry.argsBuffer += delta.delta;
        break;
      }
      case "tool-call-end":
        // Symmetric close; no state change beyond completion of buffer.
        break;
      case "tool-call": {
        let entry = this.toolCalls.get(delta.callId);
        if (!entry) {
          const blockIndex = this.highWaterBlockIndex + 1;
          this.highWaterBlockIndex = blockIndex;
          entry = {
            callId: delta.callId,
            name: delta.name,
            blockIndex,
            argsBuffer: "",
          };
          this.toolCalls.set(delta.callId, entry);
        }
        entry.input = delta.input;
        // Tool-call deltas may carry per-call `providerMetadata` (e.g. Google's
        // `thoughtSignature`) — not in the spec union but providers emit it.
        const pm = (delta as { providerMetadata?: unknown }).providerMetadata;
        if (pm && typeof pm === "object") {
          entry.providerMetadata = pm as AccumToolCall["providerMetadata"];
        }
        break;
      }
      case "message":
        // Summary event — confirms the full assistant message.
        if (delta.message.model) this.modelSeen = delta.message.model;
        break;
      case "usage":
        // Standalone usage delta (some providers emit a trailer chunk
        // before any message-end). Update accumulator so reconstruct/
        // finalize see the final numbers.
        this.usage = delta.usage;
        break;
      case "custom-block-start":
      case "custom-block-delta":
      case "custom-block-end":
      case "custom-block":
      case "error":
        // Side channels — base routes them but accumulator doesn't
        // mutate generic state. Provider extracts via `mapChunk` /
        // `reconstructRaw` if needed.
        break;
    }
  }

  /**
   * Helper: total text concatenated across all text blocks in
   * block-index order (the canonical assistant message text).
   */
  totalText(): string {
    const indices = Array.from(this.textByBlock.keys()).sort((a, b) => a - b);
    return indices.map((i) => this.textByBlock.get(i) ?? "").join("");
  }

  /**
   * Helper: total reasoning concatenated across all reasoning blocks
   * in block-index order.
   */
  totalReasoning(): string {
    const indices = Array.from(this.reasoningByBlock.keys()).sort((a, b) => a - b);
    return indices.map((i) => this.reasoningByBlock.get(i) ?? "").join("");
  }

  /**
   * Helper: parsed input for a tool call. Returns `entry.input` when
   * the `tool-call` summary set it; otherwise tries to parse
   * `argsBuffer` as JSON; falls back to `{}` on parse failure.
   */
  toolCallInput(callId: string): Readonly<Record<string, unknown>> {
    const entry = this.toolCalls.get(callId);
    if (!entry) return {};
    if (entry.input !== undefined) return entry.input;
    try {
      return JSON.parse(entry.argsBuffer || "{}") as Readonly<Record<string, unknown>>;
    } catch {
      return {};
    }
  }

  /**
   * Helper: assemble the canonical assistant-message `ContentBlock[]`
   * from accumulator state. Used by providers to synthesize the
   * `message` summary event during `reconstructRaw`.
   *
   * **One block per block index, in block-index order.** The provider already
   * told us where the seams are — `content-start` / `reasoning-start` open a
   * block and carry its index — and this is the function that either preserves
   * that structure or throws it away. It used to throw it away three times over:
   *
   * 1. **Reasoning was dropped entirely.** Adapters route thinking to the
   *    reasoning channel (Gemini's `part.thought`, Anthropic's thinking blocks,
   *    OpenAI's reasoning), `defaultFinalizeStream` emits `reasoning` summaries,
   *    and then this function discarded every one — so no reasoning block was
   *    ever assembled, stored, or sent. That is not "the client hides internals";
   *    the client never received them. **Delivery is not visibility:** what to
   *    show is the renderer's call, and it cannot make that call about data it
   *    does not have.
   *
   * 2. **All text was concatenated into one block** via `totalText()`. A model
   *    that emits prose, calls a tool, then emits more prose produced a single
   *    text blob with the tool call after it — the order in which any of it
   *    happened, unrecoverable. Anything reconstructing a turn then has to guess
   *    at seams the provider had already marked.
   *
   * 3. **Tool calls were appended last**, after text, regardless of their own
   *    `blockIndex`. So even the coarse ordering was wrong whenever a call came
   *    before the text that explained it.
   *
   * `totalText()` / `totalReasoning()` remain for callers that genuinely want
   * the flattened string; they are the wrong default for content assembly.
   */
  toContentBlocks(): ContentBlock[] {
    // Every index the provider opened, from any channel, walked in order — the
    // same shape `reconstructRaw` uses to rebuild a provider-native response.
    const byIndex = new Map<number, ContentBlock>();

    for (const [blockIndex, text] of this.textByBlock) {
      if (text.length > 0) byIndex.set(blockIndex, { type: "text", text });
    }

    // `ReasoningBlock.text`, not `.reasoning` — the DELTA channel is named
    // `reasoning`, the BLOCK field is `text` (same as a text block, so a renderer
    // reads any prose block the same way and only the `type` decides treatment).
    for (const [blockIndex, text] of this.reasoningByBlock) {
      if (text.length > 0) byIndex.set(blockIndex, { type: "reasoning", text });
    }

    for (const entry of this.toolCalls.values()) {
      byIndex.set(entry.blockIndex, {
        type: "tool_use",
        toolUseId: entry.callId,
        name: entry.name,
        input: this.toolCallInput(entry.callId),
        ...(entry.providerMetadata ? { providerMetadata: entry.providerMetadata } : {}),
      });
    }

    return [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!);
  }
}
