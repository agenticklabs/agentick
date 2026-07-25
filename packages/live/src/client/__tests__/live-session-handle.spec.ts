/**
 * `liveSessionHandle` + `sessionLive` — the client-side live surface (ADR 88).
 *
 * FAKE transport (both the command client AND a `MediaTransport`). Proven here:
 * `sendFrame` issues the uplink `send`; `onFrame` fires from the downlink;
 * `uplink`/`downlink` stream projections are EQUIVALENT to the callback surface;
 * the control commands (`interrupt`/`stop`/`abort`) issue the right `live/*`
 * wire calls; and `session.live.start()` auto-binds `(sessionId, streamId)`.
 *
 * Mirrors the `fakeCommandClient` / `pushStream` style of
 * `tasks/src/client/__tests__/tasks-handle.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  MediaFrame,
  MediaTransport,
  ProtocolEvent,
  SubscriptionStream,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec";
import type { ClientTransport } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { liveSessionHandle } from "../live-session-handle.js";
import { sessionLive } from "../session-live.js";
import type { LiveStateFrame, LiveTranscriptFrame } from "../../channel.js";

// ── media frame helper ──
function frame(seq: number, byte: number): MediaFrame {
  return {
    kind: "audio",
    envelope: { format: "audio/pcm", sampleRate: 16000, timestamp: seq, seq },
    payload: new Uint8Array([byte]),
  };
}

// ── a push-driven channel subscription stream ──
function pushStream(): SubscriptionStream & { emit(payload: unknown): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(payload: unknown): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: "session:channel:live",
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {},
  };
}

/**
 * A fake transport that is BOTH the command client (request + subscribe) AND a
 * `MediaTransport` (openUplink/openDownlink) — mirrors reality, where one
 * transport carries both planes.
 */
function fakeTransport(opts: { media?: boolean } = {}) {
  const captured: Array<{ method: WireMethod; params: unknown }> = [];
  const sent: MediaFrame[] = [];
  const subs: Array<ReturnType<typeof pushStream>> = [];
  let downlinkCb: ((f: MediaFrame) => void) | undefined;

  const transport = {
    capabilities: {
      media: opts.media ?? true,
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      binaryFrames: false,
    },
    async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<WireResult<M>> {
      captured.push({ method, params });
      if (method === "live/start") {
        const p = params as { sessionId: string; streamId?: string };
        return {
          sessionId: p.sessionId,
          streamId: p.streamId ?? "minted",
        } as unknown as WireResult<M>;
      }
      return null as unknown as WireResult<M>;
    },
    subscribe() {
      const s = pushStream();
      subs.push(s);
      return s;
    },
    openUplink() {
      return { send: async (f: MediaFrame) => void sent.push(f), close: async () => {} };
    },
    openDownlink() {
      return {
        onFrame: (cb: (f: MediaFrame) => void) => {
          downlinkCb = cb;
          return () => {
            downlinkCb = undefined;
          };
        },
        close: async () => {},
      };
    },
  };

  return {
    transport: transport as unknown as ClientTransport,
    media: transport as unknown as MediaTransport,
    captured,
    sent,
    subs,
    emitDownlink: (f: MediaFrame): void => downlinkCb?.(f),
  };
}

const REF = { sessionId: "s1", streamId: "mic" };

describe("liveSessionHandle — media plane", () => {
  it("sendFrame issues the uplink send", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    await handle.sendFrame(frame(1, 5));

    expect(t.sent).toEqual([frame(1, 5)]);
  });

  it("onFrame fires when the downlink delivers a frame", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    const received: MediaFrame[] = [];
    handle.onFrame((f) => received.push(f));
    t.emitDownlink(frame(1, 9));

    expect(received).toEqual([frame(1, 9)]);
  });

  it("uplink WritableStream projection is equivalent to sendFrame", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    const writer = handle.uplink.getWriter();
    await writer.write(frame(2, 3));

    expect(t.sent).toEqual([frame(2, 3)]);
  });

  it("downlink ReadableStream projection is equivalent to onFrame", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    const reader = handle.downlink.getReader();
    t.emitDownlink(frame(3, 7));
    const read = await reader.read();

    expect(read.done).toBe(false);
    expect(read.value).toEqual(frame(3, 7));
  });
});

describe("liveSessionHandle — control plane", () => {
  it("interrupt issues live/interrupt with the played offset", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    await handle.interrupt(1500);

    expect(t.captured).toEqual([
      { method: "live/interrupt", params: { sessionId: "s1", streamId: "mic", playedMs: 1500 } },
    ]);
  });

  it("stop issues live/stop; abort issues live/stop with hard+reason", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    await handle.stop();
    await handle.abort("kill");

    expect(t.captured).toEqual([
      { method: "live/stop", params: { sessionId: "s1", streamId: "mic" } },
      {
        method: "live/stop",
        params: { sessionId: "s1", streamId: "mic", hard: true, reason: "kill" },
      },
    ]);
  });
});

describe("liveSessionHandle — control channels", () => {
  it("onState folds state frames (filtered by streamId) and updates status", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    const states: string[] = [];
    handle.onState((s) => states.push(s));

    // The state view opens eagerly at construction (subs[0]).
    const stateFrame: LiveStateFrame = { streamId: "mic", state: "speaking" };
    t.subs[0]!.emit(stateFrame);
    await waitFor(() => states.length > 0);

    expect(states).toEqual(["speaking"]);
    expect(handle.status).toBe("speaking");

    // A frame for a DIFFERENT stream is ignored.
    t.subs[0]!.emit({ streamId: "other", state: "idle" } satisfies LiveStateFrame);
    await tick();
    expect(handle.status).toBe("speaking");
  });

  it("onTranscript folds transcript frames (opens a lazy subscription)", async () => {
    const t = fakeTransport();
    const handle = liveSessionHandle({
      client: { transport: t.transport },
      media: t.media,
      ref: REF,
    });

    const texts: string[] = [];
    handle.onTranscript((tr) => texts.push(tr.text));

    // Transcript view opens on first onTranscript → the second subscribe (subs[1]).
    const trFrame: LiveTranscriptFrame = {
      streamId: "mic",
      transcript: { role: "user", text: "hello", final: true },
    };
    t.subs[1]!.emit(trFrame);
    await waitFor(() => texts.length > 0);

    expect(texts).toEqual(["hello"]);
  });
});

describe("session.live.start() — facet", () => {
  it("auto-binds (sessionId, streamId) and issues live/start", async () => {
    const t = fakeTransport();
    const facet = sessionLive({ transport: t.transport }, "s1");

    const handle = await facet.start("mic");

    expect(handle.ref).toEqual({ sessionId: "s1", streamId: "mic" });
    expect(t.captured[0]).toEqual({
      method: "live/start",
      params: { sessionId: "s1", streamId: "mic" },
    });
    expect(facet.active).toContain(handle);
  });

  it("mints a streamId when omitted and binds to the server-returned ref", async () => {
    const t = fakeTransport();
    const facet = sessionLive({ transport: t.transport }, "s1");

    const handle = await facet.start();

    const startCall = t.captured[0]!;
    expect(startCall.method).toBe("live/start");
    expect((startCall.params as { streamId: string }).streamId).toMatch(/^live:/);
    // The handle binds to whatever the server returned (echoed here).
    expect(handle.ref.streamId).toBe((startCall.params as { streamId: string }).streamId);
  });

  it("throws when the transport has no media capability", async () => {
    const t = fakeTransport({ media: false });
    const facet = sessionLive({ transport: t.transport }, "s1");

    await expect(facet.start("mic")).rejects.toThrow(/no media capability/);
  });
});

// ── microtask flush (for the "ignored frame leaves status unchanged" assertion) ──
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
