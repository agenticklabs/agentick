/**
 * Canonical wire channel for outbound elicitation requests.
 *
 * The harness publishes on `session:channel:elicitation` via
 * `BaseHarness.request()` (which prefixes `session:channel:`). The
 * constant lives in this package — not in spec — because the channel
 * name is an implementation detail of WHERE this harness publishes,
 * not part of the cross-package protocol shape.
 *
 * Transport adapters, devtools, and MCP hosts that need to subscribe
 * import this value verbatim.
 */
export const ELICITATION_CHANNEL = "elicitation" as const;
export type ElicitationChannelName = typeof ELICITATION_CHANNEL;

/** Fully-qualified channel name as it appears on the bus envelope. */
export const ELICITATION_CHANNEL_FQN = "session:channel:elicitation" as const;

/**
 * The elicit OPERATION's event name. Subscribe to its `requested`/`terminal`
 * pair — not the channel — to count asks OUTSTANDING: the channel publishes
 * the ask and nothing else, because the answer comes back over the inbox. The
 * op pair is balanced on every exit, an answer, a timeout, an abort and a
 * harness close alike.
 */
export const ELICITATION_ELICIT_COMMAND = "elicitation:command:elicit" as const;

/**
 * One outstanding elicitation ask, as it appears in the channel's opening
 * SNAPSHOT frame (§6.1 — the Design-B watch-list). Carries the exact fields a
 * subscriber lifts off a LIVE request delta (`metadata.correlationId` /
 * `.replyTo`, plus the wire `payload`), so a client seeding from the snapshot
 * reconstructs a pending ask identical to one it observed live. `payload` is
 * the elicitation wire payload (form/url) — kept opaque here (floors, not
 * ceilings; the payload shape is owned by the harness, mirrored on the wire).
 */
export interface PendingElicitation {
  readonly correlationId: string;
  readonly replyTo: string;
  readonly payload: unknown;
}

/**
 * Opening frame of the `elicitation` request channel (§6.1 / the K8s
 * watch-list model, twin of `TaskStatusSnapshotFrame`). A fresh subscriber
 * receives this FIRST — every ask currently awaiting a response — before any
 * live delta, so a client that connects mid-ask renders the outstanding
 * prompt instead of only asks raised after it joined (the live-only defect
 * fix). Discriminated by `kind: "snapshot"` and, unlike a live request delta,
 * carries NO `metadata.requestType: "request"` — so today's request-only
 * client fold skips it untouched (additive wire shape; slice-3 consumes it).
 */
export interface ElicitationSnapshotFrame {
  readonly kind: "snapshot";
  readonly requests: readonly PendingElicitation[];
}
