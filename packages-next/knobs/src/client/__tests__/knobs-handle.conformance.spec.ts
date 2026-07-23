/**
 * `knobsHandle` — the B2 `ClientHandle` conformance suite (core + Enumerable +
 * the `set` write verb). The knobs handle is the exemplar of a keyed
 * replace-fold read view: `list()` returns descriptors+values, seeded from the
 * `knobs-state` snapshot the server sends on connect (the mid-ask shape), then
 * folded forward by deltas.
 *
 * @see docs/proposals/v2/client-handles.md §4
 */

import { runClientHandleConformance, spyClientTransport } from "@agentick/client-core-next/testing";

import { knobsHandle, type KnobsHandle } from "../knobs-handle.js";
import { KNOBS_STATE_CHANNEL, type WireKnobDescriptor } from "../../channel.js";

runClientHandleConformance<KnobsHandle, WireKnobDescriptor, string>({
  label: "knobsHandle",
  setup() {
    const spy = spyClientTransport();
    const handle = knobsHandle(spy, "sess_1");
    let n = 0;
    return {
      handle,
      // Each change ADDS a unique knob via a delta so list() grows (coherence).
      change: () =>
        spy.emit(KNOBS_STATE_CHANNEL, {
          kind: "delta",
          version: ++n + 1,
          ops: [{ op: "add", path: `/knob_${n}`, value: n }],
        }),
      teardown: () => spy.endStream(),
    };
  },
  enumerable: {
    // Model a client connecting mid-state: the server's opening snapshot frame
    // (descriptors+values) IS the pre-connection state; list() must reflect it.
    connectAfterSeed: async () => {
      const spy = spyClientTransport();
      const handle = knobsHandle(spy, "sess_1");
      spy.emit(KNOBS_STATE_CHANNEL, {
        kind: "snapshot",
        version: 1,
        values: { depth: 5 },
        descriptors: [{ id: "depth", value: 5, valueType: "number", min: 0, max: 10 }],
      });
      return { handle, id: "depth", teardown: () => spy.endStream() };
    },
    absentId: "never-seen",
  },
  writeVerbs: [
    {
      verb: "set",
      method: "knobs/set",
      run: async () => {
        const spy = spyClientTransport();
        const handle = knobsHandle(spy, "sess_1");
        await handle.set("depth", 5);
        const r = spy.lastRequest()!;
        return { method: r.method, params: r.params };
      },
      boundAddress: { sessionId: "sess_1", id: "depth" },
    },
  ],
});
