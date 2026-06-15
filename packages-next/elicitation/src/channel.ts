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
