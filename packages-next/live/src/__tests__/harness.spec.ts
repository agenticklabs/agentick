/**
 * LiveHarness — v0 routing core (ADR 88 Verified-by).
 *
 * Proves the pipes: `(sessionId, streamId)` routing to the right `onStream`
 * context, `sendFrame`/`onFrame` ↔ `uplink`/`downlink` projection equivalence,
 * the interrupt signal landing on `onInterrupt`, and lifecycle cleanup on
 * `stop`. FAKE substrate (no real transport) — the media-transport halves are a
 * deferred concern, so uplink is driven via `push` and downlink via an injected
 * sink recorder.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  LiveStream,
  MediaFrame,
  MediaSessionRef,
  SessionHarnessProtocol,
} from "@agentick/spec-next";

import { LiveHarness, type LiveHarnessOptions } from "../harness.js";

const SESSION_ID = "sess-1";

function frame(seq: number, byte: number): MediaFrame {
  return {
    kind: "audio",
    envelope: { format: "audio/pcm", sampleRate: 16000, timestamp: seq, seq },
    payload: new Uint8Array([byte]),
  };
}

async function makeHarness(
  options: LiveHarnessOptions = {},
): Promise<{ harness: LiveHarness; downlink: Array<{ ref: MediaSessionRef; frame: MediaFrame }> }> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const downlink: Array<{ ref: MediaSessionRef; frame: MediaFrame }> = [];
  const harness = new LiveHarness(SESSION_ID, journal, bus, inbox, {
    downlinkSink: (ref, f) => {
      downlink.push({ ref, frame: f });
    },
    ...options,
  });
  await harness.ready;
  return { harness, downlink };
}

describe("start + onStream routing", () => {
  it("fires onStream with a stream auto-bound to (sessionId, streamId)", async () => {
    const streams: LiveStream[] = [];
    const { harness } = await makeHarness({ onStream: (s) => streams.push(s) });

    const ref = harness.start("s7");

    expect(ref).toEqual({ sessionId: SESSION_ID, streamId: "s7" });
    expect(streams).toHaveLength(1);
    expect(streams[0]!.ref).toEqual(ref);
  });

  it("mints a streamId when omitted", async () => {
    const { harness } = await makeHarness();
    const ref = harness.start();
    expect(ref.sessionId).toBe(SESSION_ID);
    expect(ref.streamId).toMatch(/^live:/);
  });

  it("is idempotent per streamId (no duplicate onStream)", async () => {
    const streams: LiveStream[] = [];
    const { harness } = await makeHarness({ onStream: (s) => streams.push(s) });
    harness.start("s7");
    harness.start("s7");
    expect(streams).toHaveLength(1);
  });
});

describe("uplink routing", () => {
  it("push(ref, frame) reaches the matching stream's onFrame listeners", async () => {
    let stream!: LiveStream;
    const { harness } = await makeHarness({ onStream: (s) => (stream = s) });
    const ref = harness.start("s7");

    const received: MediaFrame[] = [];
    stream.onFrame((f) => received.push(f));
    harness.push(ref, frame(1, 42));

    expect(received).toEqual([frame(1, 42)]);
  });

  it("routes frames to the correct stream by streamId (two concurrent streams)", async () => {
    const byStream = new Map<string, MediaFrame[]>();
    const { harness } = await makeHarness({
      onStream: (s) => {
        const list: MediaFrame[] = [];
        byStream.set(s.ref.streamId, list);
        s.onFrame((f) => list.push(f));
      },
    });
    const a = harness.start("mic");
    const b = harness.start("screen");

    harness.push(a, frame(1, 1));
    harness.push(b, frame(1, 2));
    harness.push(a, frame(2, 3));

    expect(byStream.get("mic")).toEqual([frame(1, 1), frame(2, 3)]);
    expect(byStream.get("screen")).toEqual([frame(1, 2)]);
  });

  it("uplink ReadableStream projection is equivalent to onFrame", async () => {
    let stream!: LiveStream;
    const { harness } = await makeHarness({ onStream: (s) => (stream = s) });
    const ref = harness.start("s7");

    const reader = stream.uplink.getReader();
    harness.push(ref, frame(1, 7));
    const read = await reader.read();

    expect(read.done).toBe(false);
    expect(read.value).toEqual(frame(1, 7));
  });
});

describe("downlink", () => {
  it("sendFrame delivers to the injected downlink sink", async () => {
    let stream!: LiveStream;
    const { harness, downlink } = await makeHarness({ onStream: (s) => (stream = s) });
    const ref = harness.start("s7");

    await stream.sendFrame(frame(1, 9));

    expect(downlink).toEqual([{ ref, frame: frame(1, 9) }]);
  });

  it("downlink WritableStream projection is equivalent to sendFrame", async () => {
    let stream!: LiveStream;
    const { harness, downlink } = await makeHarness({ onStream: (s) => (stream = s) });
    harness.start("s7");

    const writer = stream.downlink.getWriter();
    await writer.write(frame(2, 11));

    expect(downlink.map((d) => d.frame)).toEqual([frame(2, 11)]);
  });
});

describe("interrupt", () => {
  it("delivers the played-audio offset to onInterrupt", async () => {
    let stream!: LiveStream;
    const { harness } = await makeHarness({ onStream: (s) => (stream = s) });
    harness.start("s7");

    const offsets: Array<number | undefined> = [];
    stream.onInterrupt((ms) => offsets.push(ms));
    harness.interrupt("s7", 1500);

    expect(offsets).toEqual([1500]);
  });
});

describe("stop / cleanup", () => {
  it("drops the stream so subsequent push is a no-op", async () => {
    let stream!: LiveStream;
    const { harness } = await makeHarness({ onStream: (s) => (stream = s) });
    const ref = harness.start("s7");
    const received: MediaFrame[] = [];
    stream.onFrame((f) => received.push(f));

    await harness.stop("s7");
    harness.push(ref, frame(1, 1));

    expect(received).toEqual([]);
  });

  it("stop is idempotent", async () => {
    const { harness } = await makeHarness();
    harness.start("s7");
    await harness.stop("s7");
    await expect(harness.stop("s7")).resolves.toBeUndefined();
  });

  it("close() stops every open stream", async () => {
    const { harness } = await makeHarness();
    const a = harness.start("a");
    harness.start("b");
    await harness.close();
    harness.push(a, frame(1, 1)); // no throw, no-op
  });
});

describe("stream.session resolver", () => {
  it("resolves the owning session via the thunk", async () => {
    const session = { id: SESSION_ID } as unknown as SessionHarnessProtocol;
    let stream!: LiveStream;
    const { harness } = await makeHarness({
      onStream: (s) => (stream = s),
      session: () => session,
    });
    harness.start("s7");
    expect(stream.session).toBe(session);
  });

  it("throws when no session resolver is wired", async () => {
    let stream!: LiveStream;
    const { harness } = await makeHarness({ onStream: (s) => (stream = s) });
    harness.start("s7");
    expect(() => stream.session).toThrow(/session is unavailable/);
  });
});
