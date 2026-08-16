/**
 * `sessionStatusView` — the client-side projection of one session's status.
 *
 * The far side of `session:channel:status`. It exists for the reload: a chat
 * panel that refreshes mid-turn has no way to learn the session is still
 * running, and renders a busy conversation as idle. The subscription opens with
 * the server's CURRENT status spliced in as frame one (the channel-snapshot /
 * K8s watch-list model), so there is no window between reading a seed and
 * starting to listen — which is exactly where a transition would be lost.
 *
 * `get()` folds to the bare {@link SessionStatus} (what a badge renders);
 * `onChange` hands over the whole {@link SessionStatusFrame}, which carries the
 * live `executionId` a client needs to correlate the turn it reattached to.
 *
 * @verifiedBy packages/client-core/src/__tests__/session-status-view.spec.ts
 */

import {
  SESSION_STATUS_CHANNEL,
  type SessionStatus,
  type SessionStatusFrame,
  type SubscriptionScope,
} from "@agentick/spec";

import { channelView, type ChannelView } from "./channel-view.js";
import type { ChannelClient } from "./channel-stream.js";

/** Live view of one session's status. `undefined` until the opening frame folds in. */
export type SessionStatusView = ChannelView<SessionStatus | undefined, SessionStatusFrame>;

export function sessionStatusView(client: ChannelClient, sessionId: string): SessionStatusView {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  return channelView<SessionStatus | undefined, SessionStatusFrame>(
    client,
    scope,
    SESSION_STATUS_CHANNEL,
    { initial: undefined, reduce: (_prev, frame) => frame.status },
  );
}
