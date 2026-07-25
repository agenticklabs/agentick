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
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelStopReason,
  ProjectInput,
  Source,
  UsageStats,
} from "@agentick/spec";
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
export interface LanguageModelAdapter<TRaw = unknown, TChunk = unknown, TRequest = unknown> {
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
   * Default: true. {@link defineLanguageModelAdapter} derives it from
   * `openStream` presence when omitted.
   */
  readonly supportsStreaming?: boolean;
  /**
   * Adopter XML-tag custom-block extraction, compiled into the delta
   * pipeline by the executor. Default: none.
   */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;

  // ── Required — the round trip ──

  /**
   * Canonical projected input → **provider-native request** (the
   * SDK-shaped params object). Pure. Split out from the SDK call (ADR 52
   * amendment 2026-07-22) so the executor can wrap the native request in
   * the `model:provider-request` command: the last-mile
   * `onBeforeModelProviderRequest` hook transforms the value THIS returns
   * before it reaches {@link send} / {@link openStream}. Takes the full
   * {@link ExecuteInput} (not just `LanguageModelInput` + `target`) so
   * request assembly can read scope-derived fields uniformly.
   */
  prepareRequest(input: ExecuteInput<LanguageModelInput>): TRequest;
  /** Non-streaming provider call over the prepared native request. */
  send(request: TRequest, signal: AbortSignal | undefined): Promise<TRaw>;
  /**
   * Streaming provider call over the prepared native request — the
   * provider SDK's chunk iterable (Promise-wrapped OK). Optional: an
   * adapter that omits it declares `supportsStreaming: false` (the
   * executor's streaming path fails fast with a typed error).
   */
  openStream?(
    request: TRequest,
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
 * The provider-specific parts an adapter author supplies to
 * {@link defineLanguageModelAdapter} — structurally the
 * {@link LanguageModelAdapter} contract itself. The factory is the
 * blessed constructor: it fills the `supportsStreaming` default (derived
 * from `openStream` presence) and freezes the result. There is NO
 * separate hook/interceptor seam here — interception lives exclusively on
 * the executor's command system (`model:generate` + the nested
 * `model:provider-request`). The definition is SHAPE, not hooks.
 */
export type LanguageModelAdapterDefinition<
  TRaw = unknown,
  TChunk = unknown,
  TRequest = unknown,
> = LanguageModelAdapter<TRaw, TChunk, TRequest>;

/**
 * The blessed constructor for a {@link LanguageModelAdapter} (ADR 52
 * amendment 2026-07-22) — the single composition point every shipped
 * provider adapter (`openai`, `anthropic`, `google`, `aisdk`) is built
 * on. It takes the provider-specific pure parts (`prepareRequest` /
 * `send` / `openStream` / `mapChunk` / `reconstructRaw` / `normalize` +
 * quirks) and returns the adapter object the executor consumes,
 * normalizing two things:
 *
 *   - `supportsStreaming` defaults to whether `openStream` was supplied
 *     (an adapter with no streaming surface declares it by omission), and
 *   - the returned object is frozen (adapters are immutable parts).
 *
 * The factory deliberately owns NO pipeline and NO hooks: the mapChunk
 * fold → reconstruct → normalize pipeline is the executor's, and the ONE
 * interceptor path is the command system. This is why a hand-written
 * object that satisfies {@link LanguageModelAdapter} directly (a BYO
 * adapter) works identically through the executor — the factory is sugar
 * over the contract, not a privileged path.
 */
export function defineLanguageModelAdapter<TRaw = unknown, TChunk = unknown, TRequest = unknown>(
  definition: LanguageModelAdapterDefinition<TRaw, TChunk, TRequest>,
): LanguageModelAdapter<TRaw, TChunk, TRequest> {
  return Object.freeze({
    ...definition,
    supportsStreaming: definition.supportsStreaming ?? definition.openStream !== undefined,
  });
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
    typeof v["prepareRequest"] === "function" &&
    typeof v["normalize"] === "function" &&
    typeof v["send"] === "function" &&
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
  //    message synthesized from accumulator state). Roll the turn's consulted
  //    SET up from every block's `sources` (deduped by id) onto the message —
  //    the "Sources" footer surface; block-level `sources` stay for
  //    self-contained per-block resolution.
  const content = accum.toContentBlocks();
  const sources = collectMessageSources(content);
  out.push({
    type: "message",
    message: {
      role: "assistant",
      content,
      ...(accum.modelSeen ? { model: accum.modelSeen } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    },
    stopReason: accum.stopReason,
    usage: accum.usage,
  });

  return out;
}

/**
 * Roll the turn's consulted set up from block-level {@link
 * ContentBlock.sources}: dedupe every block's sources by turn-stable
 * {@link Source.id} (first occurrence wins). The result is the message-level
 * aggregate ({@link import("@agentick/spec").AssistantMessage.sources}) —
 * the numbered "Sources" surface. Orphan sources (consulted but cited on no
 * block) are contributed by adapters directly and are out of scope for this
 * block roll-up.
 */
function collectMessageSources(blocks: readonly ContentBlock[]): readonly Source[] {
  const byId = new Map<string, Source>();
  for (const block of blocks) {
    for (const source of block.sources ?? []) {
      if (!byId.has(source.id)) byId.set(source.id, source);
    }
  }
  return [...byId.values()];
}
