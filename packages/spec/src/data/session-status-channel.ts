/**
 * The session-status channel — `session:channel:status`.
 *
 * `SessionRecord.status` is already ENUMERABLE (it rides every `list_sessions`
 * row); this is the NOTIFY half of that pair, so a thread list and an attached
 * chat panel both learn "this one is running" without polling.
 *
 * It lives in spec rather than `@agentick/session` because both ends need the
 * name and the frame shape, and the client cannot depend on the server harness.
 */

import type { EventQuery } from "./events.js";
import { channelEventQuery } from "./channels.js";
import type { SessionStatus } from "../protocol/hook-bridges.js";

/** Channel name — `session:channel:status` once qualified. */
export const SESSION_STATUS_CHANNEL = "status";

/**
 * How a run ENDED. Deliberately not folded into {@link SessionStatus}: a run
 * that failed leaves a perfectly usable session, so the ending is a property of
 * the transition, never of the state the session comes to rest in.
 */
export type SessionRunOutcome = "succeeded" | "failed" | "aborted";

/**
 * One frame of {@link SESSION_STATUS_CHANNEL}: the session's status AFTER the
 * transition. Also the channel's SNAPSHOT frame — the current status is the
 * whole state, so a late subscriber's opening frame and a live delta share one
 * shape and need no discriminant.
 */
export interface SessionStatusFrame {
  /** Self-describing, so a multi-session fold needs only the payload. */
  readonly sessionId: string;
  readonly status: SessionStatus;
  /** The execution in flight, when there is one. */
  readonly executionId?: string;
  /**
   * Present ONLY on the transition that ends a run, which is what makes a
   * toast possible: "that turn failed" is an event, and the idle session it
   * leaves behind is not. Absent on the snapshot frame, which describes a
   * state and has no ending to report.
   */
  readonly outcome?: SessionRunOutcome;
}

/**
 * Subscriber query for the status channel. Pair it with a `SubscriptionScope`:
 * `{ kind: "session", id }` for one thread (which also splices the snapshot in
 * front), `{ kind: "app", id }` / `{ kind: "gateway" }` for a thread list that
 * holds no session handles at all.
 */
export function sessionStatusEventQuery(): EventQuery {
  return channelEventQuery(SESSION_STATUS_CHANNEL);
}
