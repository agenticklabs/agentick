/**
 * `timelineHandle` — the B2 `ClientHandle` conformance suite (core + Enumerable +
 * the durable read verbs). The timeline handle is the window exemplar: `list()`
 * is the folded conversation window, seeded from server-hydrated history (the
 * pre-connection state), grown by local splices and the live tail.
 *
 * @see docs/proposals/v2/client-handles.md §4
 */

import { runClientHandleConformance, spyClientTransport } from "@agentick/client-core/testing";
import type { TimelineEntry } from "@agentick/spec";

import { timelineHandle, type TimelineHandle } from "../timeline-handle.js";

const entry = (id: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
});

runClientHandleConformance<TimelineHandle, TimelineEntry, string>({
  label: "timelineHandle",
  setup() {
    const spy = spyClientTransport();
    const handle = timelineHandle(spy, "sess_1");
    let n = 0;
    return {
      // Each change appends a unique entry so list() grows (coherence).
      handle,
      change: () => handle.append([entry(`m_${++n}`)]),
      teardown: () => spy.endStream(),
    };
  },
  enumerable: {
    // A client hydrating from server history: `initial` IS the pre-connection
    // window; list() must reflect it before any live frame.
    connectAfterSeed: async () => {
      const spy = spyClientTransport();
      const handle = timelineHandle(spy, "sess_1", { initial: [entry("hydrated")] });
      return { handle, id: "hydrated", teardown: () => spy.endStream() };
    },
    absentId: "never-seen",
  },
  writeVerbs: [
    {
      verb: "history",
      method: "timeline/history",
      run: async () => {
        const spy = spyClientTransport();
        const handle = timelineHandle(spy, "sess_1");
        await handle.history({ limit: 50 });
        const r = spy.lastRequest()!;
        return { method: r.method, params: r.params };
      },
      boundAddress: { sessionId: "sess_1" },
    },
    {
      verb: "loadOlder",
      method: "timeline/history",
      run: async () => {
        const spy = spyClientTransport();
        const handle = timelineHandle(spy, "sess_1");
        await handle.loadOlder(50);
        const r = spy.lastRequest()!;
        return { method: r.method, params: r.params };
      },
      boundAddress: { sessionId: "sess_1" },
    },
  ],
});
