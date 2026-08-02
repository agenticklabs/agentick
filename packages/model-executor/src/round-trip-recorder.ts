/**
 * The **round-trip recorder** — one artifact per model call, holding every seam
 * the call crossed, so a question about a model response is answered by reading
 * data instead of reading source.
 *
 * ## Why a recorder and not a logger
 *
 * The bug this was built for is a **splice**: text appearing in an assistant
 * message that the provider never sent. A splice is a *difference between two
 * seams*, so instrumenting any ONE seam cannot find it — you need both sides and
 * the diff. That is why the unit of capture is the whole round trip rather than
 * a stream of log lines.
 *
 * It matters because the timeline is fed back to the model: a message we corrupt
 * becomes an **exemplar the model imitates** on the next tick, so one splice that
 * persists teaches the model to reproduce it. See
 * `docs/proposals/v2/observability.md`.
 *
 * ## This is not a new mechanism
 *
 * Every tap is an EXISTING command seam. The recorder is a plain
 * {@link CommandHooks} bag — no executor change, no adapter change, no decorator,
 * and correlation comes free from the runtime's `opId` / `parentOpId` threading.
 *
 * ```
 *  ┌ model:generate_stream ──────────────────────────────────── op G ┐
 *  │  onBeforeModelGenerateStream ......... ① compiled input         │
 *  │  ┌ model:provider-request ─────────── op P, parentOpId = G ┐    │
 *  │  │  onBeforeModelProviderRequest ..... ② native request    │    │
 *  │  │  onModelProviderRequestChunk ...... ③ RAW provider chunk │    │
 *  │  └──────────────────────────────────────────────────────────┘    │
 *  │           ▲ mapChunk + adapterTransforms + customBlocks ▼         │
 *  │  onModelGenerateStreamChunk .......... ④ canonical AdapterDelta  │
 *  │  onAfterModelGenerateStream .......... emit the trip             │
 *  └──────────────────────────────────────────────────────────────────┘
 * ```
 *
 * **③ and ④ bracket the entire normalization pipeline** — ③ is the provider's
 * bytes PRE-`mapChunk`, ④ is the canonical delta POST-transform. Any splice
 * introduced by `mapChunk`, an `adapterTransform`, or `customBlockTransform`
 * lives between them, and both sides are now on record.
 *
 * ⑤ (what actually gets persisted) needs no tap of its own: the terminal
 * `message` delta IS the canonical assistant message, so it arrives inside ④.
 *
 * ## What can and cannot be asserted generically
 *
 * {@link verbatimViolations} checks the span it can check **provider-agnostically**
 * — the canonical deltas against the accumulator's own summaries. It catches a
 * dropped, injected, merged, or reordered block, which is the shape of every
 * accumulator/transform defect seen so far.
 *
 * It deliberately does NOT try to span ③→④: raw provider chunks are
 * provider-shaped, so extracting "the text the provider sent" from them requires
 * per-provider knowledge this module refuses to encode. That diff is done by
 * eye, against `trip.rawChunks`, which is exactly enough to answer *"did the
 * provider send this, or did we add it?"*.
 *
 * TODO(observability): closing ③→④ generically needs a tap on `mapChunk`'s
 * OUTPUT (canonical deltas, pre-transform). That is an adapter-level seam, not a
 * command seam, so it would need either a `model:map-chunk` command or an
 * adapter decorator — and a decorator cannot reach the runtime's correlation
 * ids, which is why it is not done here.
 *
 * @see docs/proposals/v2/observability.md
 */

import type { AdapterDelta, ExecuteInput, LanguageModelInput } from "@agentick/spec";
import type { CommandHooks, InterceptorCtx } from "@agentick/runtime";

/** The terminal `message` delta — the canonical assistant message. */
type MessageDelta = Extract<AdapterDelta, { type: "message" }>;

/** Correlation, lifted off the interceptor ctx so a trip is self-describing. */
export interface RoundTripScope {
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  /** The `model:generate[_stream]` operation — the trip's identity. */
  readonly opId?: string;
}

/** One model call, from compiled input to persisted message. */
export interface RoundTrip {
  readonly scope: RoundTripScope;
  /** ① The canonical input the compiler produced. */
  readonly compiled?: LanguageModelInput;
  /** ② The provider-native request, post-`prepareRequest` and post-`onBefore`. */
  readonly request?: unknown;
  /** ③ Raw provider chunks, PRE-`mapChunk`. Provider-shaped and opaque here. */
  readonly rawChunks: readonly unknown[];
  /** ④ Canonical deltas, POST-`mapChunk` and POST-transform. */
  readonly deltas: readonly AdapterDelta[];
  /** ⑤ The assistant message this call persists, if the stream reached one. */
  readonly message?: MessageDelta["message"];
  /**
   * What the caps discarded. Non-zero means this trip is INCOMPLETE — a
   * silently truncated capture reads as "I saw everything" when it did not.
   */
  readonly dropped: { readonly rawChunks: number; readonly deltas: number };
}

export interface RoundTripSink {
  /**
   * Receives each completed trip. Runs on the model call's terminal, so keep it
   * cheap — hand off rather than block.
   *
   * **The sink owns redaction.** A trip carries the full prompt and the full
   * response; nothing here decides what is safe to persist, because only the
   * caller knows where it is being written.
   */
  record(trip: RoundTrip): void;
}

export interface RoundTripRecorderOptions {
  readonly sink: RoundTripSink;
  /**
   * Per-trip cap on recorded raw chunks AND canonical deltas, so a long stream
   * cannot grow unbounded. Overflow is counted in {@link RoundTrip.dropped},
   * never dropped silently. Default 10_000.
   */
  readonly maxChunks?: number;
}

const DEFAULT_MAX_CHUNKS = 10_000;

/** Mutable accumulation state; frozen into a {@link RoundTrip} on emit. */
interface OpenTrip {
  scope: RoundTripScope;
  compiled?: LanguageModelInput;
  request?: unknown;
  readonly rawChunks: unknown[];
  readonly deltas: AdapterDelta[];
  message?: MessageDelta["message"];
  droppedRaw: number;
  droppedDeltas: number;
}

/**
 * Build the hooks bag that records every model round trip.
 *
 * ```ts
 * const app = createApp(Agent, {
 *   model,
 *   hooks: roundTripRecorder({ sink: jsonlSink((line) => fs.appendFileSync(path, line)) }),
 * });
 * ```
 *
 * Merge it with your own bag if you have one — the keys are the five model hooks
 * documented above, so a collision is visible at the spread.
 */
export function roundTripRecorder(options: RoundTripRecorderOptions): CommandHooks {
  const { sink } = options;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  /**
   * Open trips, keyed by the `model:generate[_stream]` op.
   *
   * The nested `model:provider-request` reaches the same entry through
   * `parentOpId`, which the executor threads for exactly this reason. A trip is
   * removed on its terminal, so a completed call leaves nothing behind; a call
   * that never terminates (interrupt, crash) leaks one entry, which is the
   * deliberate trade for not holding a timer per call in a diagnostic.
   */
  const open = new Map<string, OpenTrip>();

  const scopeOf = (ctx: InterceptorCtx, opId: string | undefined): RoundTripScope => ({
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}),
    ...(ctx.tickId !== undefined ? { tickId: ctx.tickId } : {}),
    ...(opId !== undefined ? { opId } : {}),
  });

  /** The generate op owns the trip; `model:generate[_stream]` hooks key on it. */
  const ownKey = (ctx: InterceptorCtx): string | undefined => ctx.opId;
  /** The nested provider-request reaches its parent generate op. */
  const parentKey = (ctx: InterceptorCtx): string | undefined => ctx.parentOpId ?? ctx.opId;

  const trip = (key: string | undefined, ctx: InterceptorCtx): OpenTrip | undefined => {
    if (key === undefined) return undefined;
    const existing = open.get(key);
    if (existing) return existing;
    const created: OpenTrip = {
      scope: scopeOf(ctx, key),
      rawChunks: [],
      deltas: [],
      droppedRaw: 0,
      droppedDeltas: 0,
    };
    open.set(key, created);
    return created;
  };

  const emit = (ctx: InterceptorCtx): void => {
    const key = ownKey(ctx);
    if (key === undefined) return;
    const t = open.get(key);
    if (!t) return;
    open.delete(key);
    sink.record({
      scope: t.scope,
      ...(t.compiled !== undefined ? { compiled: t.compiled } : {}),
      ...(t.request !== undefined ? { request: t.request } : {}),
      rawChunks: t.rawChunks,
      deltas: t.deltas,
      ...(t.message !== undefined ? { message: t.message } : {}),
      dropped: { rawChunks: t.droppedRaw, deltas: t.droppedDeltas },
    });
  };

  const openGenerate = (input: ExecuteInput<LanguageModelInput>, ctx: InterceptorCtx): void => {
    const t = trip(ownKey(ctx), ctx);
    if (t) t.compiled = input.targetInput;
  };

  const openRequest = (request: unknown, ctx: InterceptorCtx): void => {
    const t = trip(parentKey(ctx), ctx);
    if (t) t.request = request;
  };

  return {
    // ── ① compiled input — both the streaming and non-streaming entry points ──
    onBeforeModelGenerateStream: openGenerate,
    onBeforeModelGenerate: openGenerate,

    // ── ② the provider-native request, last-mile ──
    onBeforeModelProviderRequest: openRequest,

    // ── ③ RAW provider chunks, PRE-mapChunk ──
    onModelProviderRequestChunk: {
      observe: (chunk: unknown, ctx: InterceptorCtx): void => {
        const t = trip(parentKey(ctx), ctx);
        if (!t) return;
        if (t.rawChunks.length >= maxChunks) t.droppedRaw += 1;
        else t.rawChunks.push(chunk);
      },
    },

    // ── ④ canonical deltas, POST-transform (⑤ rides in as the `message` delta) ──
    onModelGenerateStreamChunk: {
      observe: (delta: AdapterDelta, ctx: InterceptorCtx): void => {
        const t = trip(ownKey(ctx), ctx);
        if (!t) return;
        if (delta.type === "message") t.message = delta.message;
        if (t.deltas.length >= maxChunks) t.droppedDeltas += 1;
        else t.deltas.push(delta);
      },
    },

    // ── terminal ──
    onAfterModelGenerateStream: (output: unknown, ctx: InterceptorCtx): void => {
      emit(ctx);
      return undefined;
    },
    onAfterModelGenerate: (output: unknown, ctx: InterceptorCtx): void => {
      emit(ctx);
      return undefined;
    },
  };
}

// ============================================================================
// Sinks
// ============================================================================

/** Collects trips in memory. For tests, and for a REPL poking at a live app. */
export function memorySink(): RoundTripSink & { readonly trips: readonly RoundTrip[] } {
  const trips: RoundTrip[] = [];
  return {
    trips,
    record: (trip) => {
      trips.push(trip);
    },
  };
}

/**
 * Serializes each trip to one JSON line and hands it to `write`.
 *
 * The writer is injected rather than opening a file, so this module stays
 * environment-free — a barrel that unions a Node surface with a browser one is
 * a barrel that breaks in one of them:
 *
 * ```ts
 * jsonlSink((line) => fs.appendFileSync("round-trips.jsonl", line));
 * ```
 */
export function jsonlSink(write: (line: string) => void): RoundTripSink {
  return {
    record: (trip) => {
      write(`${JSON.stringify(trip)}\n`);
    },
  };
}

// ============================================================================
// The verbatim invariant
// ============================================================================

export interface VerbatimViolation {
  readonly kind: "block-text-mismatch" | "message-text-mismatch";
  readonly blockIndex?: number;
  /** What the streamed deltas add up to. */
  readonly streamed: string;
  /** What the assembled artifact claims. */
  readonly assembled: string;
  readonly detail: string;
}

/**
 * Check the trip against the invariant: **what we assemble must be what we
 * streamed**.
 *
 * Two comparisons, both provider-agnostic:
 *
 *   1. **per block** — the concatenated `content-delta`s for block *i* must equal
 *      the `content` summary the accumulator emitted for block *i*.
 *   2. **the message** — the text blocks of the terminal `message`, in order,
 *      must equal those per-block summaries.
 *
 * A block-index collapse (two blocks merged onto one) fails (1), because the
 * surviving block's summary carries text its own deltas never contained. A
 * dropped or injected fragment fails (1) as well. A reorder fails (2).
 *
 * Returns an empty array when the trip is clean, so it reads as a guard:
 * `expect(verbatimViolations(trip)).toEqual([])`.
 */
export function verbatimViolations(trip: RoundTrip): readonly VerbatimViolation[] {
  const violations: VerbatimViolation[] = [];

  // 1. Streamed deltas vs the accumulator's per-block summary.
  const streamedByBlock = new Map<number, string>();
  const summaryByBlock = new Map<number, string>();
  for (const delta of trip.deltas) {
    if (delta.type === "content-delta") {
      streamedByBlock.set(
        delta.blockIndex,
        (streamedByBlock.get(delta.blockIndex) ?? "") + delta.delta,
      );
    } else if (delta.type === "content" && delta.content.type === "text") {
      summaryByBlock.set(delta.blockIndex, delta.content.text);
    }
  }

  for (const [blockIndex, summary] of [...summaryByBlock].sort((a, b) => a[0] - b[0])) {
    const streamed = streamedByBlock.get(blockIndex) ?? "";
    if (streamed !== summary) {
      violations.push({
        kind: "block-text-mismatch",
        blockIndex,
        streamed,
        assembled: summary,
        detail:
          `block ${blockIndex}: the accumulated summary is not what the deltas for ` +
          `that block add up to — text was injected, dropped, or merged in from another block`,
      });
    }
  }

  // 2. The per-block summaries vs the message that actually gets persisted.
  if (trip.message) {
    const messageText = trip.message.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text);
    const summaryText = [...summaryByBlock].sort((a, b) => a[0] - b[0]).map(([, text]) => text);

    if (messageText.join(" ") !== summaryText.join(" ")) {
      violations.push({
        kind: "message-text-mismatch",
        streamed: summaryText.join(" ⏎ "),
        assembled: messageText.join(" ⏎ "),
        detail:
          "the persisted message's text blocks are not the per-block summaries in order — " +
          "the message the model will read back differs from the one it streamed",
      });
    }
  }

  return violations;
}
