/**
 * `knobsStateView` — the client-side reactive view of a session's knob state.
 *
 * The knobs façade (rung 1) over the generic `channelView` primitive: it hides
 * the channel name, the frame kinds, and the JSON-Patch fold. An adopter calls
 * `knobsStateView(client, sessionId)` and gets a live `Record<knobId, value>`
 * they can `get()` / `subscribe()` — knowing nothing about `session:channel:`,
 * snapshots, deltas, or RFC 6902.
 *
 * Read side of the knobs resource (CQRS query). The subscription opens with
 * the current snapshot (slice 2 server seam), then folds JSON-Patch deltas;
 * writes are a separate command (`set_knob` dispatch / a `knobs/set` method),
 * whose effect returns to this view as a delta on the same channel.
 *
 * @verifiedBy packages-next/knobs/src/client/__tests__/knobs-state-view.spec.ts
 */

import { channelView } from "@agentick/client-core-next";
import type {
  ChannelView,
  ClientMiddleware,
  ClientTransport,
  KnobPrimitive,
  SubscriptionScope,
  Unsubscribe,
} from "@agentick/spec-next";
import { applyJsonPatch } from "@agentick/utils-next";

import { KNOBS_STATE_CHANNEL, type KnobsStateFrame } from "../channel.js";

/** The reduced knob store: knob id → current primitive value. */
export type KnobsState = Readonly<Record<string, KnobPrimitive>>;

/**
 * Read surface for the knobs client façade: `knobsStateView` folds the
 * `knobs-state` channel and only needs `transport.subscribe`.
 */
export interface KnobsClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

/**
 * Command surface for the full knobs resource handle: `knobsHandle` folds
 * the channel (read) AND issues the `knobs/set` command, so it needs both
 * `subscribe` and `request`. A superset of {@link KnobsClient} — a command
 * client is a valid read client.
 */
export interface KnobsCommandClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
  /**
   * Register a client {@link ClientMiddleware} (B2 slice 4 §7). Present when the
   * handle is minted off a real client (`session.knobs`), so `session.knobs.use`
   * can scope a middleware to the `knobs/*` namespace; absent for bare-transport
   * test doubles, where per-handle `use` is an inert no-op.
   */
  readonly use?: (middleware: ClientMiddleware) => Unsubscribe;
}

/**
 * A live view of `session`'s knob state. Opens with the current snapshot,
 * then folds `knobs-state` deltas (JSON-Patch, one op per changed knob).
 */
export function knobsStateView(
  client: KnobsClient,
  sessionId: string,
): ChannelView<KnobsState, KnobsStateFrame> {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  return channelView<KnobsState, KnobsStateFrame>(client, scope, KNOBS_STATE_CHANNEL, {
    initial: {},
    // The snapshot frame seeds the whole store; a delta frame applies its
    // per-knob JSON-Patch ops (copy-on-write, so the reference changes for
    // the useSyncExternalStore contract).
    reduce: (state, frame) =>
      frame.kind === "snapshot" ? { ...frame.values } : applyJsonPatch(state, frame.ops),
  });
}
