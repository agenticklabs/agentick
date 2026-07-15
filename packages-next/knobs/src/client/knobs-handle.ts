/**
 * `knobsHandle` — the client-side knobs resource handle (read + write).
 *
 * Completes the CQRS loop the read view (`knobsStateView`) opened: it
 * composes that live channel fold for the READ half (get/subscribe/onChange/
 * status/close) and adds `set(key, value)`, the WRITE command over `knobs/set`.
 *
 * The write is deliberately fire-and-observe: `set` issues the RPC and
 * resolves `void`. It does NOT hand-patch the local view — the write's
 * effect returns as a `knobs-state` delta on the same channel and re-folds
 * the view (CQRS: one write path, one read path, state flows through the
 * channel only).
 *
 * @verifiedBy packages-next/knobs/src/client/__tests__/knobs-handle.spec.ts
 */

import type { ChannelView, KnobPrimitive } from "@agentick/spec-next";

import { knobsStateView, type KnobsCommandClient, type KnobsState } from "./knobs-state-view.js";
import type { KnobsStateFrame } from "../channel.js";

/** The knobs resource handle: the read view plus the `set` command. */
export type KnobsHandleView = ChannelView<KnobsState, KnobsStateFrame> & {
  /**
   * Set a knob's value. Issues the `knobs/set` command and resolves once
   * the gateway accepts it; the resulting value lands on the view as a
   * `knobs-state` delta (CQRS — no local hand-patch).
   */
  set(key: string, value: KnobPrimitive): Promise<void>;
};

/**
 * A live read+write handle over `session`'s knob state. Read half opens with
 * the current snapshot and folds `knobs-state` deltas; write half issues
 * `knobs/set`.
 */
export function knobsHandle(client: KnobsCommandClient, sessionId: string): KnobsHandleView {
  const view = knobsStateView(client, sessionId);
  return {
    get: () => view.get(),
    subscribe: (listener) => view.subscribe(listener),
    onChange: (listener) => view.onChange(listener),
    get status() {
      return view.status;
    },
    close: () => view.close(),
    set: async (key, value) => {
      // Fire-and-observe: the effect returns as a channel delta and re-folds
      // the view (CQRS). Do not patch `view` here.
      await client.transport.request("knobs/set", { sessionId, key, value });
    },
  };
}
