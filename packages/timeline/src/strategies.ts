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

import type {
  CompactGenerateResult,
  CompactRun,
  CompactStrategy,
  ContentBlock,
  TimelineEntry,
} from "@agentick/spec";
import { toolSpanEnd } from "@agentick/spec";
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
  /**
   * Ask the fold to name the questions this stretch answers, recorded on the
   * event's `metadata.questions`. Default true.
   *
   * Dense retrieval matches a query against stored text, and queries are
   * questions while summaries are statements — so they sit in different regions
   * of the embedding space and the match is weaker than it looks. The usual fix
   * is a later pass that rewrites the document into query shape; this asks the
   * model that JUST READ the conversation, which knows what it was about in a
   * way a cold reader has to guess.
   *
   * On by default because the moment does not come back: a summary written
   * without keys cannot be given them later except by a worse process, and the
   * cost is a few tokens on a call that already spent thousands.
   */
  readonly questions?: boolean;
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

/**
 * Ranges are entry IDs, not `seq`. A strategy has ids and never sees a `seq` —
 * entries carry none until `history()` wraps them in `SeqTagged`. Seq ranges
 * would range-query better and are blocked behind `TODO(store-ctx-key-name)`.
 */
export function entryId(entry: TimelineEntry | undefined): string | undefined {
  return entry?.kind === "message" ? entry.message.id : undefined;
}

/**
 * A turn opens with something the HUMAN said. A `tool_result` also rides a
 * `user` message — it is the transport for a tool's reply, not a new turn — so
 * role alone cuts in exactly the place this rule exists to avoid.
 */
const isUserTurn = (e: TimelineEntry): boolean =>
  e.kind === "message" &&
  e.message.role === "user" &&
  !e.message.content.some((b) => b.type === "tool_result");

const contentOf = (e: TimelineEntry): readonly ContentBlock[] =>
  e.kind === "message" ? e.message.content : [];

/**
 * Indices INTERIOR to an open tool span — the positions where the model has
 * asked and not yet heard back.
 *
 * A cut at `i` folds `[0, i)` into a summary and keeps `[i, …)` verbatim, so it
 * lands inside span `x` exactly when `open(x) < i <= close(x)`. Cutting there
 * summarises the call and keeps the result, which Anthropic and Google both
 * reject outright.
 *
 * A span missing an end is skipped — a timeline that arrived already broken must
 * not be uncompactable forever. Stored as the interior rather than its
 * complement because the interior is tiny (spans are normally one entry long)
 * while the complement is the whole conversation.
 */
function insideOpenSpan(entries: readonly TimelineEntry[]): ReadonlySet<number> {
  const openedAt = new Map<string, number>();
  const closedAt = new Map<string, number>();
  for (const [i, entry] of entries.entries()) {
    for (const block of contentOf(entry)) {
      const span = toolSpanEnd(block);
      if (span === undefined) continue;
      const at = span.end === "open" ? openedAt : closedAt;
      if (!at.has(span.toolUseId)) at.set(span.toolUseId, i);
    }
  }
  const interior = new Set<number>();
  for (const [id, open] of openedAt) {
    const close = closedAt.get(id);
    if (close === undefined) continue;
    for (let i = open + 1; i <= close; i++) interior.add(i);
  }
  return interior;
}

/** The index nearest `target` satisfying `ok`, or -1. A tie goes forward — it folds more. */
function nearest(
  entries: readonly TimelineEntry[],
  target: number,
  ok: (index: number) => boolean,
): number {
  let back = -1;
  for (let i = target; i > 0; i--) {
    if (ok(i)) {
      back = i;
      break;
    }
  }
  let forward = -1;
  for (let i = target + 1; i < entries.length; i++) {
    if (ok(i)) {
      forward = i;
      break;
    }
  }
  if (back < 0) return forward;
  if (forward < 0) return back;
  return target - back < forward - target ? back : forward;
}

/**
 * Where to cut so the fold keeps close to `keepVerbatim` entries.
 *
 * Two rules, and the older version of this function conflated them because a
 * user-turn start happens to satisfy both:
 *
 *   - **Legality.** A cut must not separate a call from its result. Not
 *     negotiable — the request is refused.
 *   - **Coherence.** A turn BEGINS with a user message, so cutting elsewhere
 *     keeps a fragment: an assistant reply with no visible prompt.
 *
 * Coherence is a preference, and treating it as a constraint is what let ONE
 * long turn defeat compaction: an agentic tail of tool calls contains no user
 * turn, so the search found nothing in either direction, returned 0, and the
 * fold ran on nothing at all. So a turn start is preferred, and when none is
 * reachable the cut falls back to the nearest legal index — a worse-looking
 * window beats a conversation that can never be compacted.
 *
 * `keepVerbatim` is a target, not a guarantee — the boundary decides.
 */
function nearestTurnStart(entries: readonly TimelineEntry[], index: number): number {
  // Fewer entries than the tail asked for — the target clamps to 0 and there is
  // nothing older to fold. Searching forward from here would cut INTO the tail.
  if (index <= 0) return 0;
  const target = Math.min(index, entries.length - 1);
  const midSpan = insideOpenSpan(entries);
  const settled = (i: number): boolean => !midSpan.has(i);

  const turn = nearest(entries, target, (i) => isUserTurn(entries[i]!) && settled(i));
  if (turn >= 0) return turn;
  const nearestSettled = nearest(entries, target, settled);
  return nearestSettled < 0 ? 0 : nearestSettled;
}

/**
 * The id range a fold covers, skipping entries that carry no id.
 *
 * A `boundary` entry has none, and one sitting at either edge of the fold used
 * to make `coversThrough` undefined — which silently breaks the rebuild, because
 * `projectLog` needs both ends to know what a summary stands in for. A
 * materialized view whose range does not resolve is not a materialized view.
 */
function coveredRange(fold: readonly TimelineEntry[]): {
  readonly coversFrom?: string;
  readonly coversThrough?: string;
} {
  const ids = fold.map(entryId).filter((id): id is string => id !== undefined);
  return omitUndefined({ coversFrom: ids[0], coversThrough: ids[ids.length - 1] });
}

/** Summaries sit at the front — they are the oldest material. A fold is a prefix. */
function afterLastSummary(entries: readonly TimelineEntry[]): number {
  let i = 0;
  while (i < entries.length && isSummary(entries[i]!)) i++;
  return i;
}

/**
 * Appended AFTER whatever rules the adopter set, because it is asked of every
 * fold — an adopter replacing `instructions` is naming what to capture, not
 * opting out of being findable.
 */
export const QUESTIONS_INSTRUCTION = `First, list the questions this stretch of conversation answers — the ones a
future search would arrive with. Phrase each as a person would ask it, and
prefer the general form over the specific instance. Wrap the list in
<questions> tags, one per line, each starting with "- ".

Then write the summary. Do not mention the questions in it.`;

/**
 * Pull the retrieval keys out of the reply.
 *
 * The block is stripped from the summary: it is a key for finding this later,
 * not part of the conversation, and leaving it in would put a list of unanswered
 * questions in front of a model that will try to answer them.
 *
 * A reply without the block is not an error — the summary is the artifact that
 * matters and a missing key costs findability, not correctness.
 */
function parseQuestions(text: string): {
  readonly questions: readonly string[];
  readonly summary: string;
} {
  const match = /<questions>([\s\S]*?)<\/questions>/i.exec(text);
  if (!match) return { questions: [], summary: text.trim() };
  const questions = match[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0);
  return { questions, summary: text.replace(match[0], "").trim() };
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
  trailing: string | undefined,
): string | readonly ContentBlock[] {
  const parts = [standing, ...(typeof perCall === "string" ? [perCall] : []), trailing].filter(
    (p): p is string => p !== undefined,
  );
  if (perCall === undefined || typeof perCall === "string") return parts.join("\n\n");
  return [
    { type: "text", text: standing } as ContentBlock,
    ...perCall,
    ...(trailing ? [{ type: "text", text: trailing } as ContentBlock] : []),
  ];
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
  const questionsInstruction = options.questions === false ? undefined : QUESTIONS_INSTRUCTION;

  const run: CompactRun = async ({ entries, instructions, generate, progress }) => {
    if (!generate) {
      throw new Error(
        "rollingSummary needs a model: nothing bound `generate` on the compaction context.",
      );
    }
    const cut = nearestTurnStart(entries, Math.max(0, entries.length - keepVerbatim));
    const older = entries.slice(0, cut);
    const keep = entries.slice(cut);
    const foldFrom = summariesIn(older).length >= keepSummaries ? 0 : afterLastSummary(older);
    const survivors = older.slice(0, foldFrom);
    const fold = older.slice(foldFrom);
    if (fold.length === 0) return entries;
    // Nothing but summaries to fold means nothing NEW to compress. Running
    // anyway costs a model call to turn a summary into a worse summary — the
    // second pass cannot tell which ids and figures still matter — and reports
    // success while the context is exactly the size it was.
    if (fold.every(isSummary)) return entries;

    const budget = resolve(options.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, { entries: fold });
    const result = await generate({
      entries: fold,
      instructions: joinInstructions(standing, instructions, questionsInstruction),
      ...omitUndefined({ maxOutputTokens: budget }),
      // The message says what is being folded, which is the one thing a bar
      // cannot: 8% of 8192 tokens means nothing, "folding 274 entries" is the
      // work. Derived from the fold, so it cannot drift from what ran.
      onDelta: progress
        ? ({ outputTokens }) =>
            progress({
              progress: outputTokens,
              total: budget,
              message: `Folding ${fold.length} ${fold.length === 1 ? "entry" : "entries"}`,
            })
        : undefined,
    });

    // A truncated summary is cut mid-thought, and folding it would make the
    // model's own damaged notes the exemplar it reads next tick. Leaving the
    // timeline alone is recoverable; persisting this is not.
    if (result.truncated) return entries;

    return [...survivors, summaryEntry(result, fold, keep.length, instructions), ...keep];
  };

  return {
    source: "projection",
    run,
    shouldCompact: (ctx) => ctx.usedTokens >= resolve(options.threshold, DEFAULT_THRESHOLD, ctx),
    ...omitUndefined({ metadata: options.metadata }),
  };
}

function summaryEntry(
  result: CompactGenerateResult,
  fold: readonly TimelineEntry[],
  entriesAfter: number,
  instructions: string | readonly ContentBlock[] | undefined,
): TimelineEntry {
  const steer = typeof instructions === "string" ? instructions : undefined;
  const { questions, summary } = parseQuestions(result.text);
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
          // `data` is RENDERED — every key of it reaches the model as a child
          // element of the event. Only what belongs in the conversation goes
          // here; bookkeeping goes on `metadata`, which the formatters do not
          // read.
          //
          // TODO(event-payload-split): the range and the counts are bookkeeping
          // too, and the model currently reads a pair of ULIDs. Moving them
          // means moving `projectLog`'s `coverageIn` with them, and summaries
          // already written carry them under `data` — a read-both migration,
          // not a rename.
          data: {
            summary,
            // The RANGE this summary stands in for. Its own position in the log
            // records when it was written, which is not what it covers — without
            // this, rebuilding the projection needs state the log does not hold,
            // and a materialized view that needs outside state is not one.
            ...coveredRange(fold),
            entriesBefore: fold.length,
            entriesAfter,
            ...omitUndefined({ instructions: steer }),
          },
          ...(questions.length > 0 || result.usage !== undefined
            ? {
                metadata: omitUndefined({
                  questions: questions.length > 0 ? questions : undefined,
                  usage: result.usage,
                }),
              }
            : {}),
        },
      ],
    },
  };
}
