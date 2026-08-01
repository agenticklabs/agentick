/**
 * `progressView` — the fold that turns `progress` signal frames into render-ready
 * state, one entry per correlation token: {@link eventView} pinned to
 * `progressEventQuery()`.
 *
 * Where {@link onProgress} hands an app every frame, this holds the LATEST state
 * per token, already classified. A component reads `state.kind` and knows which
 * control to draw — `"determinate"` a bar at `fraction`, `"indeterminate"` a
 * spinner — with no per-token bookkeeping of its own.
 *
 * **Late joiners work.** Because every frame classifies alone (law 1 on
 * `ProgressUpdate`), a client that connects mid-flight renders correctly from
 * the first frame it sees; it never has to have witnessed the opening frame.
 *
 * **It distrusts its input.** `createProgressReporter` makes first-party
 * emitters correct by construction, but this fold also receives frames from
 * emitters nobody here controls — a third-party MCP server bridged onto the bus.
 * So it VALIDATES rather than assumes: a frame that goes backwards, or that
 * shrinks / drops / changes a `total` already established, is dropped rather
 * than rendered. Dropping is the honest failure: a bar that jumps backwards or
 * silently rescales misinforms, where a bar that ignores an illegal frame just
 * stops updating.
 *
 * A UI that wants "hold at 99% until the work actually settles" implements that
 * itself, from the operation lifecycle it is already watching. Law 4 — the frame
 * carries no terminal flag, and this fold invents none.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 * @verifiedBy packages/client-core/src/__tests__/progress-view.spec.ts
 */

import type {
  Cursor,
  ProgressEventPayload,
  ProgressToken,
  SubscriptionScope,
  ChannelView,
} from "@agentick/spec";
import { progressEventQuery } from "@agentick/spec";

import { eventView } from "./event-view.js";
import type { EventClient } from "./event-stream.js";

/**
 * One token's progress, classified. The discriminant IS the render decision —
 * `kind` answers "bar or spinner" without a second look at the data.
 */
export type ProgressState =
  | {
      readonly kind: "determinate";
      /** `progress / total`, clamped to `[0, 1]` — the width of the bar. */
      readonly fraction: number;
      readonly progress: number;
      readonly total: number;
      readonly message?: string;
    }
  | {
      readonly kind: "indeterminate";
      /** Counts up with no denominator — show it as a raw count, never a percentage. */
      readonly progress: number;
      readonly message?: string;
    };

/** Every in-flight token's latest state, keyed by correlation token. */
export type ProgressStates = ReadonlyMap<ProgressToken, ProgressState>;

/**
 * Fold ONE frame onto the held states — exported because it is the whole
 * semantic, and adopters folding progress from somewhere else (a replayed
 * journal, a test) should get the identical classification and the identical
 * defenses. Returns the state UNCHANGED when the frame is malformed or illegal.
 */
export function foldProgress(states: ProgressStates, frame: ProgressEventPayload): ProgressStates {
  if (frame === null || typeof frame !== "object") return states;
  const { token, progress, total, message } = frame;
  if (typeof token !== "string" && typeof token !== "number") return states;
  if (!Number.isFinite(progress) || progress < 0) return states;
  if (total !== undefined && (!Number.isFinite(total) || total <= 0)) return states;

  const prior = states.get(token);
  if (prior !== undefined) {
    if (progress < prior.progress) return states; // law 3 — never backwards
    const priorTotal = prior.kind === "determinate" ? prior.total : undefined;
    // Law 2 — the ratchet is one-way. An upgrade (undefined → a total) is the
    // one legal move; dropping it or changing it is not.
    if (priorTotal !== undefined && total !== priorTotal) return states;
  }

  const next = new Map(states);
  next.set(
    token,
    total === undefined
      ? { kind: "indeterminate", progress, ...(message !== undefined ? { message } : {}) }
      : {
          kind: "determinate",
          fraction: Math.min(1, Math.max(0, progress / total)),
          progress,
          total,
          ...(message !== undefined ? { message } : {}),
        },
  );
  return next;
}

/**
 * Fold `progress` signal frames on `scope` into live {@link ProgressStates}.
 * Same shape as {@link channelView} — `subscribe` for the state feed,
 * `onChange` for each frame, `close()` to tear down — so it composes into
 * `useSyncExternalStore` the same way.
 *
 * ```ts
 * const bars = progressView(client, { sessionId });
 * bars.subscribe((states) => {
 *   const s = states.get(toolCallId);
 *   if (s?.kind === "determinate") setWidth(s.fraction);
 * });
 * ```
 */
export function progressView(
  client: EventClient,
  scope: SubscriptionScope,
  opts?: { readonly fromCursor?: Cursor },
): ChannelView<ProgressStates, ProgressEventPayload> {
  return eventView<ProgressStates, ProgressEventPayload>(client, scope, progressEventQuery(), {
    initial: new Map(),
    reduce: foldProgress,
    ...(opts?.fromCursor !== undefined ? { fromCursor: opts.fromCursor } : {}),
  });
}
