/**
 * Built-in {@link CompactStrategy} factories — the timeline `/strategies`
 * subpath, parallel to `@agentick/skills/hydrators`.
 *
 * **Naming: these are strategy-value factories, NOT `withX`
 * session-extension factories.** `withX` is reserved house vocabulary for
 * things that install a harness (`withTimeline`, `withSkills`). A strategy
 * factory returns a plain configured `CompactStrategy` VALUE — portable
 * across call altitudes (host slot, component prop, app logic) exactly like
 * a loader's `fromUrl({...})`. They live under `/strategies` so an adopter
 * never confuses `compact: rollingSummary({...})` with an extension install.
 *
 * The dependency direction that held `rollingSummary` back is settled: a
 * strategy that needs a model receives one as `ctx.generate`, bound by whoever
 * can see both. This package still depends on no executor.
 *
 * Adopters can write their own — anything returning a {@link CompactStrategy}.
 */

import type { CompactRun, CompactStrategy, ContentBlock, TimelineEntry } from "@agentick/spec";
import { omitUndefined, ulid } from "@agentick/utils";

export interface FromHandlerOptions {
  readonly handler: CompactRun;
  readonly source?: "persisted" | "projection";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * The raw, lowest-level strategy: wrap a pure async function over entries
 * into a {@link CompactStrategy} value. The harness reads the source
 * (default "persisted"), passes the entries to `handler`, and uses the
 * handler's return as the new projection.
 */
export function fromHandler(options: FromHandlerOptions): CompactStrategy {
  return {
    source: options.source ?? "persisted",
    run: options.handler,
    ...omitUndefined({ metadata: options.metadata }),
  };
}

// ─── rollingSummary ───

/** A number, or a function of the facts available where the number is needed. */
export type Sized<TCtx> = number | ((ctx: TCtx) => number);

export interface RollingSummaryOptions {
  /**
   * Ceiling on the summary itself. A summary allowed 100k tokens is not a
   * summary, and an uncapped one is unbounded cost on a large fold. The cap is
   * also the progress bar's denominator — pass `undefined` for neither.
   *
   * Default 8192.
   */
  readonly maxOutputTokens?: Sized<{ readonly entries: readonly TimelineEntry[] }> | undefined;
  /**
   * Token ceiling that makes {@link CompactStrategy.shouldCompact} true.
   * A fraction of the context window measures the wrong thing on a model that
   * reports a million — what you are managing is per-turn cost, not running out
   * of room.
   *
   * Default 120_000.
   */
  readonly threshold?: Sized<{ readonly usedTokens: number; readonly contextWindow?: number }>;
  /** Recent entries that survive verbatim. Default 6. */
  readonly keepVerbatim?: number;
  /**
   * How many summary events the PROJECTION may hold. Below the bound a fold
   * leaves earlier summaries alone and appends a new one; at the bound it
   * folds the prefix back into one so nothing leaves context unaccounted for.
   *
   * Every summary ever produced stays in the durable log either way — a fold
   * writes a view, and `compact` appends what it produced. So the bound windows
   * what the model carries, it does not decide what is kept.
   *
   * Default 1. Raise it to stop the oldest material being re-compressed on
   * every pass: a summary of a summary loses exactly the ids and figures the
   * instructions ask for, because the second pass cannot tell which still
   * matter.
   */
  readonly keepSummaries?: number;
  /** Standing rules, ahead of any per-call instructions. */
  readonly instructions?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_THRESHOLD = 120_000;
const DEFAULT_KEEP_VERBATIM = 6;
const DEFAULT_KEEP_SUMMARIES = 1;

const isSummary = (e: TimelineEntry): boolean =>
  e.kind === "message" &&
  e.message.role === "event" &&
  e.message.content.some((b) => b.type === "system_event" && b.event === "compaction");

const summariesIn = (entries: readonly TimelineEntry[]) => entries.filter(isSummary);

/** Summaries sit at the front — they are the oldest material. A fold is a prefix. */
function afterLastSummary(entries: readonly TimelineEntry[]): number {
  let i = 0;
  while (i < entries.length && isSummary(entries[i]!)) i++;
  return i;
}

export const DEFAULT_SUMMARY_INSTRUCTIONS = `Summarize the conversation so far, for your own use as context going forward.

Capture both of these — a summary with only one of them is useless:

1. THE SHAPE. What the user is trying to accomplish, what has been decided and
   why, what approach is in play, and where things currently stand.
2. THE ANCHORS. Specific identifiers, names, numbers, file paths, URLs, ids,
   exact values, error messages, and open questions. These are what make the
   summary navigable rather than merely descriptive — a detail dropped here is
   one that cannot be looked up again.

Preserve every open thread and anything asked for that is not yet done. Write it
as notes to yourself, not as a report for a reader.`;

function resolve<TCtx>(sized: Sized<TCtx> | undefined, fallback: number, ctx: TCtx): number {
  if (sized === undefined) return fallback;
  return typeof sized === "function" ? sized(ctx) : sized;
}

function joinInstructions(
  standing: string,
  perCall: string | readonly ContentBlock[] | undefined,
): string | readonly ContentBlock[] {
  if (perCall === undefined) return standing;
  if (typeof perCall === "string") return `${standing}\n\n${perCall}`;
  return [{ type: "text", text: standing } as ContentBlock, ...perCall];
}

/**
 * Fold everything but the last `keepVerbatim` entries into one summary event,
 * produced by the model bound as `ctx.generate`.
 *
 * The summary lands as a `system_event` block rather than prose so the fact and
 * its payload travel together, and so replay renders it the same way a fresh
 * one renders.
 *
 * Binding `generate` is the caller's job — the timeline package reaches no
 * model, and W36 wants the SAME model over the SAME context, which only the
 * session can supply.
 */
export function rollingSummary(options: RollingSummaryOptions = {}): CompactStrategy {
  const keepVerbatim = options.keepVerbatim ?? DEFAULT_KEEP_VERBATIM;
  const keepSummaries = options.keepSummaries ?? DEFAULT_KEEP_SUMMARIES;
  const standing = options.instructions ?? DEFAULT_SUMMARY_INSTRUCTIONS;

  const run: CompactRun = async ({ entries, instructions, generate, progress }) => {
    if (!generate) {
      throw new Error(
        "rollingSummary needs a model: nothing bound `generate` on the compaction context.",
      );
    }
    const older = entries.slice(0, Math.max(0, entries.length - keepVerbatim));
    const keep = entries.slice(older.length);
    const foldFrom = summariesIn(older).length >= keepSummaries ? 0 : afterLastSummary(older);
    const survivors = older.slice(0, foldFrom);
    const fold = older.slice(foldFrom);
    if (fold.length === 0) return entries;

    const budget = resolve(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, { entries: fold });
    const result = await generate({
      entries: fold,
      instructions: joinInstructions(standing, instructions),
      ...omitUndefined({ maxOutputTokens: budget }),
      onDelta: progress
        ? ({ outputTokens }) => progress({ progress: outputTokens, total: budget })
        : undefined,
    });

    // A truncated summary is cut mid-thought, and folding it would make the
    // model's own damaged notes the exemplar it reads next tick. Leaving the
    // timeline alone is recoverable; persisting this is not.
    if (result.truncated) return entries;

    return [
      ...survivors,
      summaryEntry(result.text, fold.length, keep.length, instructions),
      ...keep,
    ];
  };

  return {
    source: "projection",
    run,
    shouldCompact: (ctx) => ctx.usedTokens >= resolve(options.threshold, DEFAULT_THRESHOLD, ctx),
    ...omitUndefined({ metadata: options.metadata }),
  };
}

function summaryEntry(
  summary: string,
  entriesBefore: number,
  entriesAfter: number,
  instructions: string | readonly ContentBlock[] | undefined,
): TimelineEntry {
  const steer = typeof instructions === "string" ? instructions : undefined;
  return {
    kind: "message",
    message: {
      id: ulid(),
      ts: Date.now(),
      role: "event",
      content: [
        {
          type: "system_event",
          event: "compaction",
          source: "timeline",
          data: {
            summary,
            entriesBefore,
            entriesAfter,
            ...omitUndefined({ instructions: steer }),
          },
        },
      ],
    },
  };
}
