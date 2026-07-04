/**
 * `LanguageModelAdapter` — the provider-normalization PART (ADR 52).
 *
 * The split: the executor (`LanguageModelExecutor`) is the harness —
 * orchestration, opinion tier, owns everything Effect (the streaming
 * pipeline, backpressure, abort, operations). Provider normalization is
 * a **Promise/AsyncIterable-shaped object** implementing exactly the
 * hooks the old subclass contract demanded. No harness, no substrate,
 * no Effect — standalone-usable (the v1 adapter, reborn with the v2
 * currencies), swappable per ADR 48's harness-instance-vs-backing-
 * resource rule (BYOK = per-principal adapter instances).
 *
 * **Currencies (the no-double-normalization guardrail):**
 * `LanguageModelInput`, `AdapterDelta`, and
 * `LanguageModelExecutionResult` are the ONLY shapes between adapter
 * and executor. The adapter normalizes provider shapes into them; the
 * executor consumes them raw.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import type {
  AdapterDelta,
  ContentBlock,
  ExecuteErrorChannel,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelStopReason,
  ProjectInput,
  UsageStats,
} from "@agentick/spec-next";
import type { DeltaTransform } from "./delta-transform.js";
import type { CustomBlockDefinition } from "./tag-transforms.js";
import type { AccumToolCall } from "./stream-accumulator.js";

/**
 * The accumulator surface adapters may touch (ADR 52, resolved by
 * audit 2026-07-03): **read-only accumulation state plus two sanctioned
 * finalization fields plus the provider-owned scratch slot.**
 *
 *   - Readonly: the block buffers, tool-call map, lifecycle flags,
 *     `modelSeen`, and the synthesis helpers. The EXECUTOR feeds the
 *     accumulator (via `apply`) — adapters never do.
 *   - `stopReason` / `usage` are writable for late finalization
 *     (providers that learn the finish reason / usage only at
 *     `reconstructRaw` time map it directly).
 *   - `providerExtra` is the provider-owned mutable scratch: stash
 *     parser state in `mapChunk`, read it back in `reconstructRaw`.
 *     The executor never touches this slot.
 */
export interface StreamAccumulatorView {
  readonly textByBlock: ReadonlyMap<number, string>;
  readonly reasoningByBlock: ReadonlyMap<number, string>;
  readonly toolCalls: ReadonlyMap<string, AccumToolCall>;
  readonly openBlocks: ReadonlyMap<number, "text" | "reasoning">;
  readonly messageStarted: boolean;
  readonly messageEnded: boolean;
  readonly modelSeen: string | undefined;
  readonly highWaterBlockIndex: number;

  /** Writable — late finalization (e.g. finish-reason mapped in reconstructRaw). */
  stopReason: LanguageModelStopReason;
  /** Writable — trailer usage finalization. */
  usage: UsageStats;
  /** Provider-owned mutable scratch. The executor never touches it. */
  providerExtra: unknown;

  totalText(): string;
  totalReasoning(): string;
  toolCallInput(callId: string): Readonly<Record<string, unknown>>;
  toContentBlocks(): ContentBlock[];
}

/**
 * The provider-normalization part. Implement this — a plain object or
 * class, Promise/AsyncIterable-shaped, zero Effect — to bring a
 * provider to agentick. Certified by `runModelAdapterConformance`.
 *
 * Required members are the round trip; optional members are provider
 * quirks with executor-supplied defaults (identical to the defaults
 * the old subclass contract shipped).
 *
 * Certification (ADR 52 amendment 2026-07-03): each adapter is certified
 * by running `runExecutorConformance` against the real
 * `LanguageModelExecutor` + the adapter + a stubbed provider client (see
 * `model-openai/src/__tests__/conformance.spec.ts`). The contract itself
 * is zero-Effect — an author can write and unit-test an adapter with
 * `generate()` alone — but the shared conformance runs through the executor.
 */
export interface LanguageModelAdapter<TRaw = unknown, TChunk = unknown> {
  /** Observability identity — "openai", "google", "ai-sdk", ... */
  readonly provider: string;
  /**
   * Self-described execution target (provider + modelId +
   * capabilities). The executor advertises this as its own `target`;
   * apps read it for capability-based defaults.
   */
  readonly target: ExecutionTarget;
  /**
   * Whether `execute()` (the non-iterating entry point) should still
   * drive the streaming provider call internally (bus-level delta
   * envelopes). Default: false.
   */
  readonly streamByDefault?: boolean;
  /**
   * Whether the streaming codepath exists at all (AI SDK's
   * `streamText` is a separate surface from `generateText`).
   * Default: true.
   */
  readonly supportsStreaming?: boolean;
  /**
   * Adopter XML-tag custom-block extraction, compiled into the delta
   * pipeline by the executor. Default: none.
   */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;

  // ── Required — the round trip ──

  /** Canonical `LanguageModelInput` → provider request shape. Pure. */
  buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown;
  /** Non-streaming provider call. */
  call(params: unknown, signal: AbortSignal | undefined): Promise<TRaw>;
  /** Streaming provider call — the provider SDK's chunk iterable (Promise-wrapped OK). */
  openStream(
    params: unknown,
    signal: AbortSignal | undefined,
  ): AsyncIterable<TChunk> | Promise<AsyncIterable<TChunk>>;
  /** Provider chunk → canonical deltas. Sync; may stash in `accum.providerExtra`. */
  mapChunk(chunk: TChunk, accum: StreamAccumulatorView): readonly AdapterDelta[];
  /** Synthesize the canonical provider response from final stream state. */
  reconstructRaw(accum: StreamAccumulatorView, modelSeen: string | undefined): TRaw;
  /** Provider response → canonical execution result. */
  normalize(raw: TRaw): LanguageModelExecutionResult;

  // ── Optional — provider quirks (executor supplies defaults) ──

  /** Override canonical projection (e.g. Anthropic per-section cache_control). */
  project?(input: ProjectInput): LanguageModelInput;
  /** Provider-specific delta transforms (e.g. think-tag extraction). */
  adapterTransforms?(): readonly DeltaTransform[];
  /** Mutate the reconstructed raw before `normalize` (tag-router hooks). */
  postProcessForNormalize?(raw: TRaw): TRaw;
  /** Provider-specific metadata surfaced on the execution result. */
  extractMetadata?(raw: TRaw): Readonly<Record<string, unknown>> | undefined;
  /** Provider-specific abort detection (SDK error classes). */
  isAbortError?(cause: unknown): boolean;
  /** Provider error → typed `ExecuteErrorChannel`. */
  mapProviderError?(cause: unknown): ExecuteErrorChannel;
  /** Close open blocks / emit summaries at stream end. */
  finalizeStream?(accum: StreamAccumulatorView): readonly AdapterDelta[];
}

/**
 * Structural guard — used by app-level slots that accept
 * `LanguageModelExecutor | ExecutorFactory | LanguageModelAdapter`
 * (an adapter has the round trip but no `run`/`execute` protocol
 * surface and no `family`).
 */
export function isLanguageModelAdapter(value: unknown): value is LanguageModelAdapter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["buildParams"] === "function" &&
    typeof v["normalize"] === "function" &&
    typeof v["call"] === "function" &&
    typeof v["provider"] === "string" &&
    typeof v["execute"] !== "function" &&
    typeof v["run"] !== "function"
  );
}

/**
 * The executor's default end-of-stream finalization — exported as an
 * executable value so adapters overriding `finalizeStream` can compose
 * with it instead of re-rolling (mutate the view, then delegate):
 *
 * ```ts
 * finalizeStream(accum) {
 *   if (lateReason) accum.stopReason = mapReason(lateReason);
 *   return defaultFinalizeStream(accum);
 * }
 * ```
 *
 * Closes open blocks (+ per-block summaries), closes tool calls that
 * never saw an explicit end, emits `message-end` (if not observed
 * in-stream) and the canonical `message` summary.
 */
export function defaultFinalizeStream(accum: StreamAccumulatorView): readonly AdapterDelta[] {
  const out: AdapterDelta[] = [];

  // 1. Close any blocks still open + emit per-block summary.
  const openSorted = Array.from(accum.openBlocks.entries()).sort((a, b) => a[0] - b[0]);
  for (const [blockIndex, kind] of openSorted) {
    if (kind === "text") {
      out.push({ type: "content-end", blockIndex });
      const text = accum.textByBlock.get(blockIndex) ?? "";
      out.push({
        type: "content",
        blockIndex,
        content: { type: "text", text },
      });
    } else {
      out.push({ type: "reasoning-end", blockIndex });
      const reasoning = accum.reasoningByBlock.get(blockIndex) ?? "";
      out.push({ type: "reasoning", blockIndex, reasoning });
    }
  }

  // 2. Close any tool calls without a tool-call summary yet (OpenAI/
  //    AI SDK don't emit explicit tool-call-end events).
  for (const entry of accum.toolCalls.values()) {
    if (entry.input !== undefined) continue;
    let parsed: Readonly<Record<string, unknown>> = {};
    try {
      parsed = JSON.parse(entry.argsBuffer || "{}") as Readonly<Record<string, unknown>>;
    } catch {
      parsed = {};
    }
    out.push({ type: "tool-call-end", callId: entry.callId });
    const tc: AdapterDelta = {
      type: "tool-call",
      callId: entry.callId,
      name: entry.name,
      input: parsed,
      ...(entry.providerMetadata
        ? ({ providerMetadata: entry.providerMetadata } as Record<string, unknown>)
        : {}),
    } as AdapterDelta;
    out.push(tc);
  }

  // 3. message-end (if not already observed in-stream).
  if (!accum.messageEnded) {
    out.push({
      type: "message-end",
      stopReason: accum.stopReason,
      usage: accum.usage,
    });
  }

  // 4. message summary — always emit (single canonical assistant
  //    message synthesized from accumulator state).
  out.push({
    type: "message",
    message: {
      role: "assistant",
      content: accum.toContentBlocks(),
      ...(accum.modelSeen ? { model: accum.modelSeen } : {}),
    },
    stopReason: accum.stopReason,
    usage: accum.usage,
  });

  return out;
}
