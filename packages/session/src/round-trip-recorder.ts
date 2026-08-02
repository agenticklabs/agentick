/**
 * The **round-trip recorder** — one artifact per TICK, holding every seam the
 * tick crossed, so a question about a model response is answered by reading data
 * instead of reading source.
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
 * persists teaches the model to reproduce it. That also makes this inherently
 * MULTI-TICK — one trip per tick, in order, is what shows corruption compounding.
 *
 * ## Why this lives in `@agentick/session`
 *
 * The span crosses compiler, model, and timeline. `CommandRegistry` is
 * spec-SEEDED but harness-AUGMENTED, so a package can only NAME hook keys whose
 * augmenting module is in its compilation — a recorder in `@agentick/model-executor`
 * literally cannot write `onAfterCompilerRenderTree`. `@agentick/session` depends
 * on every harness it integrates, which is exactly why CLAUDE.md puts
 * cross-harness work here. Nothing about the built-ins is privileged (ADR 27);
 * this is a dependency-graph fact, not a special case.
 *
 * ## This is not a new mechanism
 *
 * Every tap is an EXISTING command seam. The recorder is a plain
 * {@link CommandHooks} bag — no harness change, no adapter change, no decorator —
 * and correlation comes free from the runtime's scope threading.
 *
 * ```
 *  ┌ loop:tick ─────────────────────────────────────────── tickId T ┐
 *  │  onAfterCompilerRenderTree ........... ⓪ the tree JSX produced │
 *  │  ┌ model:generate_stream ─────────────────────────── op G ┐    │
 *  │  │  onBeforeModelGenerateStream ...... ① compiled input   │    │
 *  │  │  ┌ model:provider-request ──── op P, parentOpId = G ┐  │    │
 *  │  │  │  onBeforeModelProviderRequest .. ② native request │  │    │
 *  │  │  │  onModelProviderRequestChunk ... ③ RAW chunk      │  │    │
 *  │  │  └───────────────────────────────────────────────────┘  │    │
 *  │  │         ▲ mapChunk + adapterTransforms + customBlocks ▼  │    │
 *  │  │  onModelGenerateStreamChunk ....... ④ canonical delta  │    │
 *  │  └─────────────────────────────────────────────────────────┘    │
 *  │  onBeforeTimelineAppend .............. ⑤ what is PERSISTED     │
 *  │  onAfterLoopTick ..................... emit the trip           │
 *  └────────────────────────────────────────────────────────────────┘
 * ```
 *
 * **③ and ④ bracket the entire normalization pipeline** — ③ is the provider's
 * bytes PRE-`mapChunk`, ④ is the canonical delta POST-transform. Any splice
 * introduced by `mapChunk`, an `adapterTransform`, or `customBlockTransform`
 * lives between them, and both sides are on record.
 *
 * **⑤ is the real terminus.** The terminal `message` delta only proves the
 * accumulator was honest with itself; `timeline:append` proves the PERSISTED
 * message is what the provider sent — and the persisted one is what feeds back.
 *
 * ## Correlation: why `tickId`
 *
 * Compiler, model, and timeline are SIBLINGS under a tick, not parent and child,
 * so no `parentOpId` chain connects them — `tickId` is the only shared key.
 * Within the model call, `parentOpId` still threads the nested
 * `model:provider-request` to its parent generate op, which is how ②/③ find the
 * trip their generate op opened.
 *
 * A model call with no tick (a direct executor drive, no loop) falls back to
 * keying on the generate op and emits at the model terminal — so the recorder
 * still works outside a session, with ⓪ and ⑤ simply absent.
 *
 * ## What can and cannot be asserted generically
 *
 * {@link verbatimViolations} checks the span it can check **provider-agnostically**
 * — the canonical deltas against the accumulator's own summaries, and those
 * against the message that is actually persisted. It catches a dropped,
 * injected, merged, or reordered block, which is the shape of every
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

import type {
  AdapterDelta,
  ContentBlock,
  ExecuteInput,
  LanguageModelInput,
  RenderedTree,
  TimelineAppendInput,
} from "@agentick/spec";
import type { CommandHooks, InterceptorCtx } from "@agentick/runtime";

// `CommandRegistry` is spec-SEEDED but harness-AUGMENTED, so a hook key only
// EXISTS in a compilation that has loaded the augmenting module. This file names
// keys from three harnesses, and a downstream package that compiles this source
// without them in its graph would see `onAfterCompilerRenderTree` as an unknown
// property. These type-only imports pull the augmentations in explicitly, which
// is honest: the bag genuinely depends on them.
/* eslint-disable-next-line import/no-empty-named-blocks -- the empty block IS
   the point: these load module augmentations, they import no bindings. */
import type {} from "@agentick/compiler";
/* eslint-disable-next-line import/no-empty-named-blocks */
import type {} from "@agentick/timeline";
/* eslint-disable-next-line import/no-empty-named-blocks */
import type {} from "@agentick/loop-executor";
/* eslint-disable-next-line import/no-empty-named-blocks */
import type {} from "@agentick/model-executor";

/** The terminal `message` delta — the canonical assistant message. */
type MessageDelta = Extract<AdapterDelta, { type: "message" }>;

/** The message shape `timeline:append` persists — what tap ⑤ records. */
export type PersistedEntry = Extract<
  TimelineAppendInput["entries"][number],
  { kind: "message" }
>["message"];

/** Correlation, lifted off the interceptor ctx so a trip is self-describing. */
export interface RoundTripScope {
  readonly sessionId?: string;
  readonly executionId?: string;
  /** The tick this trip covers — the key that joins compiler, model, timeline. */
  readonly tickId?: string;
  /** The `model:generate[_stream]` operation, when one ran. */
  readonly opId?: string;
}

/** One tick, from rendered tree to persisted message. */
export interface RoundTrip {
  readonly scope: RoundTripScope;
  /** ⓪ The tree the JSX produced this tick. */
  readonly tree?: RenderedTree;
  /** ① The canonical input the compiler produced. */
  readonly compiled?: LanguageModelInput;
  /** ② The provider-native request, post-`prepareRequest` and post-`onBefore`. */
  readonly request?: unknown;
  /** ③ Raw provider chunks, PRE-`mapChunk`. Provider-shaped and opaque here. */
  readonly rawChunks: readonly unknown[];
  /** ④ Canonical deltas, POST-`mapChunk` and POST-transform. */
  readonly deltas: readonly AdapterDelta[];
  /** The assistant message the stream assembled, if it reached one. */
  readonly message?: MessageDelta["message"];
  /** ⑤ What was actually appended to the timeline — the terminus. */
  readonly persisted: readonly PersistedEntry[];
  /**
   * What the caps discarded. Non-zero means this trip is INCOMPLETE — a
   * silently truncated capture reads as "I saw everything" when it did not.
   */
  readonly dropped: { readonly rawChunks: number; readonly deltas: number };
}

export interface RoundTripSink {
  /**
   * Receives each completed trip. Runs on the tick's terminal, so keep it
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
  tree?: RenderedTree;
  compiled?: LanguageModelInput;
  request?: unknown;
  readonly rawChunks: unknown[];
  readonly deltas: AdapterDelta[];
  message?: MessageDelta["message"];
  readonly persisted: PersistedEntry[];
  droppedRaw: number;
  droppedDeltas: number;
}

/**
 * Build the hooks bag that records every round trip.
 *
 * ```ts
 * const app = createApp(Agent, {
 *   model,
 *   hooks: roundTripRecorder({ sink: jsonlSink((line) => fs.appendFileSync(path, line)) }),
 * });
 * ```
 *
 * Merge it with your own bag if you have one — the keys are the eight hooks
 * documented above, so a collision is visible at the spread.
 */
export function roundTripRecorder(options: RoundTripRecorderOptions): CommandHooks {
  const { sink } = options;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  /**
   * Open trips, keyed by `tickId` (or by the generate op when there is no tick).
   *
   * A trip is removed on its terminal, so a completed tick leaves nothing
   * behind; a tick that never terminates (interrupt, crash) leaks one entry,
   * which is the deliberate trade for not holding a timer per tick in a
   * diagnostic.
   */
  const open = new Map<string, OpenTrip>();

  /**
   * The trip key. `tickId` joins the sibling harnesses; the generate op is the
   * fallback for a model call driven outside a loop.
   *
   * `parentOpId` is preferred over `opId` for the op fallback so the nested
   * `model:provider-request` resolves to the generate op that opened the trip
   * rather than minting a second one.
   */
  const keyOf = (ctx: InterceptorCtx): string | undefined =>
    ctx.tickId ?? ctx.parentOpId ?? ctx.opId;

  const trip = (ctx: InterceptorCtx): OpenTrip | undefined => {
    const key = keyOf(ctx);
    if (key === undefined) return undefined;
    const existing = open.get(key);
    if (existing) {
      // The generate op is only known once the model call starts — backfill it
      // onto a trip the compiler already opened.
      if (existing.scope.opId === undefined && ctx.opId !== undefined && ctx.tickId !== undefined) {
        existing.scope = { ...existing.scope, opId: ctx.opId };
      }
      return existing;
    }
    const created: OpenTrip = {
      scope: {
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}),
        ...(ctx.tickId !== undefined ? { tickId: ctx.tickId } : {}),
        ...(ctx.opId !== undefined ? { opId: ctx.opId } : {}),
      },
      rawChunks: [],
      deltas: [],
      persisted: [],
      droppedRaw: 0,
      droppedDeltas: 0,
    };
    open.set(key, created);
    return created;
  };

  const emit = (key: string | undefined): void => {
    if (key === undefined) return;
    const t = open.get(key);
    if (!t) return;
    open.delete(key);
    sink.record({
      scope: t.scope,
      ...(t.tree !== undefined ? { tree: t.tree } : {}),
      ...(t.compiled !== undefined ? { compiled: t.compiled } : {}),
      ...(t.request !== undefined ? { request: t.request } : {}),
      rawChunks: t.rawChunks,
      deltas: t.deltas,
      ...(t.message !== undefined ? { message: t.message } : {}),
      persisted: t.persisted,
      dropped: { rawChunks: t.droppedRaw, deltas: t.droppedDeltas },
    });
  };

  const openGenerate = (input: ExecuteInput<LanguageModelInput>, ctx: InterceptorCtx): void => {
    const t = trip(ctx);
    if (t) t.compiled = input.targetInput;
  };

  /**
   * A model call INSIDE a tick is emitted by `onAfterLoopTick` (so ⑤ lands
   * first); one outside a tick has no such bracket and terminates here.
   */
  const closeGenerate = (_output: unknown, ctx: InterceptorCtx): void => {
    if (ctx.tickId === undefined) emit(keyOf(ctx));
  };

  return {
    // ── ⓪ the tree JSX produced this tick ──
    onAfterCompilerRenderTree: (output: { readonly tree?: RenderedTree }, ctx: InterceptorCtx) => {
      const t = trip(ctx);
      if (t && output?.tree !== undefined) t.tree = output.tree;
      return undefined;
    },

    // ── ① compiled input — both the streaming and non-streaming entry points ──
    onBeforeModelGenerateStream: openGenerate,
    onBeforeModelGenerate: openGenerate,

    // ── ② the provider-native request, last-mile ──
    onBeforeModelProviderRequest: (request: unknown, ctx: InterceptorCtx) => {
      const t = trip(ctx);
      if (t) t.request = request;
    },

    // ── ③ RAW provider chunks, PRE-mapChunk ──
    onModelProviderRequestChunk: {
      observe: (chunk: unknown, ctx: InterceptorCtx): void => {
        const t = trip(ctx);
        if (!t) return;
        if (t.rawChunks.length >= maxChunks) t.droppedRaw += 1;
        else t.rawChunks.push(chunk);
      },
    },

    // ── ④ canonical deltas, POST-transform ──
    onModelGenerateStreamChunk: {
      observe: (delta: AdapterDelta, ctx: InterceptorCtx): void => {
        const t = trip(ctx);
        if (!t) return;
        if (delta.type === "message") t.message = delta.message;
        if (t.deltas.length >= maxChunks) t.droppedDeltas += 1;
        else t.deltas.push(delta);
      },
    },

    // ── ⑤ what actually lands in the timeline — the terminus ──
    onBeforeTimelineAppend: (input: TimelineAppendInput, ctx: InterceptorCtx) => {
      const t = trip(ctx);
      if (!t) return undefined;
      for (const entry of input.entries) {
        // Only message entries carry model output; boundaries and the rest are
        // timeline bookkeeping with no bearing on the verbatim invariant.
        if (entry.kind === "message") t.persisted.push(entry.message);
      }
      return undefined;
    },

    // ── terminal ──
    onAfterLoopTick: (_output: unknown, ctx: InterceptorCtx) => {
      emit(keyOf(ctx));
      return undefined;
    },
    onAfterModelGenerateStream: closeGenerate,
    onAfterModelGenerate: closeGenerate,
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
  readonly kind: "block-text-mismatch" | "message-text-mismatch" | "persisted-text-mismatch";
  readonly blockIndex?: number;
  /** What the streamed deltas add up to. */
  readonly streamed: string;
  /** What the assembled artifact claims. */
  readonly assembled: string;
  readonly detail: string;
}

/** Concatenate a content list's text blocks, in order. */
const textOf = (content: readonly ContentBlock[] | undefined): string[] =>
  (content ?? [])
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text);

/**
 * Check the trip against the invariant: **what gets persisted must be what the
 * provider streamed**.
 *
 * Three comparisons, all provider-agnostic:
 *
 *   1. **per block** — the concatenated `content-delta`s for block *i* must equal
 *      the `content` summary the accumulator emitted for block *i*.
 *   2. **the message** — the text blocks of the terminal `message`, in order,
 *      must equal those per-block summaries.
 *   3. **the timeline** — the assistant entries actually appended must carry
 *      that same text.
 *
 * A block-index collapse (two blocks merged onto one) fails (1), because the
 * surviving block's summary carries text its own deltas never contained. A
 * dropped or injected fragment fails (1) as well. A reorder fails (2). A splice
 * introduced between assembly and persistence — the one that actually feeds
 * back into the next tick — fails only (3), which is why (3) exists.
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

  const summaryText = [...summaryByBlock].sort((a, b) => a[0] - b[0]).map(([, text]) => text);

  // 2. The per-block summaries vs the message the accumulator assembled.
  if (trip.message) {
    const messageText = textOf(trip.message.content);
    if (messageText.join(" ") !== summaryText.join(" ")) {
      violations.push({
        kind: "message-text-mismatch",
        streamed: summaryText.join(" ⏎ "),
        assembled: messageText.join(" ⏎ "),
        detail:
          "the assembled message's text blocks are not the per-block summaries in order — " +
          "the accumulator did not reproduce what it streamed",
      });
    }
  }

  // 3. …vs what was actually PERSISTED. This is the one that feeds back.
  const persistedAssistant = trip.persisted.filter((entry) => entry.role === "assistant");
  if (persistedAssistant.length > 0 && summaryText.length > 0) {
    const persistedText = persistedAssistant.flatMap((entry) => textOf(entry.content));
    if (persistedText.join(" ") !== summaryText.join(" ")) {
      violations.push({
        kind: "persisted-text-mismatch",
        streamed: summaryText.join(" ⏎ "),
        assembled: persistedText.join(" ⏎ "),
        detail:
          "the message written to the timeline is not what the provider streamed — " +
          "the next tick will read this back and imitate it",
      });
    }
  }

  return violations;
}
