/**
 * Full-stack live media round-trip — the increment-2 proof that frames actually
 * flow (ADR 88). Exercises the whole plane through a REAL GatewayHarness +
 * `inProcessTransport` composed with `inProcessLiveMedia`:
 *
 *   1. `client.session(id).live.start()` issues `live/start` → the harness opens
 *      a stream and fires `onStream` (captured).
 *   2. `handle.sendFrame(frame)` → the client uplink → `inProcessLiveMedia` →
 *      `harness.push(ref, frame)` → the server stream's `onFrame`. (client → server)
 *   3. `stream.sendFrame(frame)` → `harness.onDownlink` egress → `inProcessLiveMedia`
 *      openDownlink → the client handle's `onFrame`. (server → client)
 *
 * The control transport stays generic (it merely exposes the `MediaTransport` it
 * was handed); the live-aware routing lives in `inProcessLiveMedia`.
 */

import "../augment.js"; // server: types session.live
import "../client/register.js"; // client: registers the session.live slot

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { createGateway } from "@agentick/gateway-next";
import { fakeReconciler } from "@agentick/reconciler-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, LiveStream, MediaFrame } from "@agentick/spec-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";

import { liveWireExtension } from "../wire.js";
import { withLive } from "../extension.js";
import { inProcessLiveMedia } from "../testing/in-process-media.js";

function frame(seq: number, text: string): MediaFrame {
  return {
    kind: "audio",
    envelope: { format: "audio/pcm", sampleRate: 16000, channels: 1, timestamp: seq, seq },
    payload: new TextEncoder().encode(text),
  };
}

const decode = (f: MediaFrame): string => new TextDecoder().decode(f.payload);

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-live-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  let stream: LiveStream | undefined;
  const gateway = await createGateway({ wireExtensions: [liveWireExtension] });
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "live-app",
    rootElement: null,
    options: {
      executor,
      reconciler: fakeReconciler(),
      extensions: [
        withLive({
          onStream: (s) => {
            stream = s;
          },
        }),
      ],
    },
  });
  const session = await app.createSession({ sessionId: "live-session" });

  const client = await createClient({
    transport: inProcessTransport({ gateway, media: inProcessLiveMedia(gateway) }),
  });
  await client.connect();

  return {
    client,
    sessionId: session.id,
    getStream: (): LiveStream | undefined => stream,
    cleanup: async (): Promise<void> => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("live media end-to-end — client ↔ inProcessLiveMedia ↔ LiveHarness", () => {
  it("start() opens a server stream auto-bound to (sessionId, streamId)", async () => {
    const { client, sessionId, getStream, cleanup } = await makeStack();

    const handle = await client.session(sessionId).live.start();
    const stream = getStream();

    expect(stream).toBeDefined();
    expect(handle.ref.sessionId).toBe(sessionId);
    expect(stream!.ref.streamId).toBe(handle.ref.streamId);

    await cleanup();
  });

  it("uplink: a client sendFrame reaches the server stream's onFrame", async () => {
    const { client, sessionId, getStream, cleanup } = await makeStack();

    const handle = await client.session(sessionId).live.start();
    const received: MediaFrame[] = [];
    getStream()!.onFrame((f) => received.push(f));

    await handle.sendFrame(frame(1, "hello"));
    await handle.sendFrame(frame(2, "world"));

    expect(received.map(decode)).toEqual(["hello", "world"]);

    await cleanup();
  });

  it("downlink: a server sendFrame reaches the client handle's onFrame", async () => {
    const { client, sessionId, getStream, cleanup } = await makeStack();

    const handle = await client.session(sessionId).live.start();
    const down: MediaFrame[] = [];
    handle.onFrame((f) => down.push(f));

    await getStream()!.sendFrame(frame(3, "reply"));

    expect(down.map(decode)).toEqual(["reply"]);

    await cleanup();
  });

  it("routes by streamId — two concurrent streams don't cross", async () => {
    const { client, sessionId, getStream, cleanup } = await makeStack();

    const mic = await client.session(sessionId).live.start();
    const micStream = getStream()!;
    const screen = await client.session(sessionId).live.start();
    const screenStream = getStream()!;
    expect(micStream.ref.streamId).not.toBe(screenStream.ref.streamId);

    const micRx: MediaFrame[] = [];
    const screenRx: MediaFrame[] = [];
    micStream.onFrame((f) => micRx.push(f));
    screenStream.onFrame((f) => screenRx.push(f));

    await mic.sendFrame(frame(1, "audio"));
    await screen.sendFrame(frame(1, "video"));

    expect(micRx.map(decode)).toEqual(["audio"]);
    expect(screenRx.map(decode)).toEqual(["video"]);

    await cleanup();
  });
});
