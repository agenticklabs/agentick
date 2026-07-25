/**
 * `elicitationsHandle` — the B2 `ClientHandle` conformance suite (core +
 * Enumerable + Respondable, plus the listed-item round-trip). Elicitations are
 * the exemplar of a REQUEST-SHAPED Enumerable: `list()` yields ITEM handles
 * (data + `.accept`/`.decline`/`.cancel`), seeded snapshot-first so a client
 * connecting mid-ask sees the pending prompt.
 *
 * The suite drives the handle through the channel's SNAPSHOT frame (the
 * pre-connection pending set) — the spy transport models the opening frame; the
 * item handle is built by the SAME constructor a live delta would use.
 *
 * @see docs/proposals/v2/client-handles.md §4
 */

import { runClientHandleConformance, spyClientTransport } from "@agentick/client-core/testing";

import { elicitationsHandle, type ElicitationsHandle } from "../elicitations.js";
import { ELICITATION_CHANNEL, type PendingElicitation } from "../../channel.js";

const pendingAsk = (correlationId: string): PendingElicitation => ({
  correlationId,
  replyTo: `reply:${correlationId}`,
  payload: { mode: "form", message: "approve?" },
});

const snapshot = (...requests: PendingElicitation[]) => ({ kind: "snapshot", requests }) as const;

/** Spy of the replies routed to the server, projected to `{ id }`. */
function repliesOf(spy: ReturnType<typeof spyClientTransport>) {
  return () =>
    spy
      .requests()
      .filter((r) => r.method === "session/respond_to_elicitation")
      .map((r) => ({ id: (r.params as { correlationId: string }).correlationId }));
}

runClientHandleConformance<ElicitationsHandle, unknown, string, { outcome: "accepted" }>({
  label: "elicitationsHandle",
  setup() {
    const spy = spyClientTransport();
    const handle = elicitationsHandle(spy, "sess_1");
    let n = 0;
    const asks: PendingElicitation[] = [];
    return {
      handle,
      // Each change re-seeds a CUMULATIVE snapshot with one more pending ask so
      // list() grows (coherence).
      change: () => {
        asks.push(pendingAsk(`corr_${++n}`));
        spy.emit(ELICITATION_CHANNEL, snapshot(...asks));
      },
      teardown: () => spy.endStream(),
    };
  },
  respondable: {
    withPendingRequest: async () => {
      const spy = spyClientTransport();
      const handle = elicitationsHandle(spy, "sess_1");
      spy.emit(ELICITATION_CHANNEL, snapshot(pendingAsk("corr_1")));
      return { handle, id: "corr_1", responded: repliesOf(spy), teardown: () => spy.endStream() };
    },
    sampleInput: { outcome: "accepted" },
    unknownId: "corr_never",
    // The acceptance case — connect mid-ask, the LISTED item's verb round-trips.
    listedItemRoundTrip: {
      connect: async () => {
        const spy = spyClientTransport();
        const handle = elicitationsHandle(spy, "sess_1");
        spy.emit(ELICITATION_CHANNEL, snapshot(pendingAsk("corr_1")));
        return { handle, id: "corr_1", responded: repliesOf(spy), teardown: () => spy.endStream() };
      },
      invoke: (item) => (item as { accept(v: unknown): Promise<void> }).accept({ approved: true }),
    },
  },
  enumerable: {
    connectAfterSeed: async () => {
      const spy = spyClientTransport();
      const handle = elicitationsHandle(spy, "sess_1");
      spy.emit(ELICITATION_CHANNEL, snapshot(pendingAsk("corr_1")));
      return { handle, id: "corr_1", teardown: () => spy.endStream() };
    },
    absentId: "corr_never",
  },
});
