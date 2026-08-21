/**
 * `readable()` / `pipeTo()` on the CLIENT send handle — the web-streams twin of
 * `events()`, identical surface to the server `SessionExecutionHandle`. A client
 * consumer (browser UI) drains the same live progress stream through the
 * WHATWG-streams ecosystem instead of a bare async iterator.
 */

import { describe, expect, it } from "vitest";
import { WIRE_PROTOCOL_VERSION } from "@agentick/spec";
import type {
  ClientState,
  ClientTransport,
  ProgressFrame,
  ProgressStream,
  StreamEvent,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
} from "@agentick/spec";

import { createClient } from "../client.js";

function pushProgress(token: string) {
  const buffer: ProgressFrame[] = [];
  const waiters: Array<(r: IteratorResult<ProgressFrame>) => void> = [];
  let closed = false;

  const stream: ProgressStream = {
    progressToken: token,
    async close() {
      closed = true;
      for (const w of waiters.splice(0)) w({ done: true, value: undefined });
    },
    [Symbol.asyncIterator](): AsyncIterator<ProgressFrame> {
      return {
        next(): Promise<IteratorResult<ProgressFrame>> {
          const queued = buffer.shift();
          if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  const emit = (delta: string, sequence: number): void => {
    const frame = {
      token,
      envelope: {
        name: "session:execution:event",
        phase: "notification",
        payload: {
          id: `ev-${sequence}`,
          sequence,
          tick: 1,
          timestamp: new Date(0).toISOString(),
          sessionId: "s1",
          executionId: "exec:01ABCDEF",
          type: "content-delta",
          blockIndex: 0,
          delta,
        },
      },
    } as unknown as ProgressFrame;
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value: frame });
    else buffer.push(frame);
  };

  return { stream, emit, close: () => stream.close() };
}

function pendingSendTransport() {
  const progress = pushProgress("p-1");
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const transport: ClientTransport = {
    id: "fake",
    capabilities: {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      binaryFrames: false,
      media: false,
    } satisfies TransportCapabilities,
    get state() {
      return state;
    },
    async connect() {
      state = "open";
      for (const l of listeners) l(state);
    },
    async close() {
      state = "closed";
    },
    request: (async (method: WireMethod) => {
      if (method === "session/send") return new Promise<never>(() => {});
      if (method === "initialize") {
        return {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: "fake", version: "0" },
        };
      }
      if (method === "_extensions/list") return { extensions: [] };
      return {};
    }) as ClientTransport["request"],
    subscribe(): SubscriptionStream {
      throw new Error("subscribe not used by this fixture");
    },
    progress: (): ProgressStream => progress.stream,
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
  return { transport, emit: progress.emit, close: progress.close };
}

async function drain(stream: ReadableStream<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("client send handle — readable() / pipeTo()", () => {
  it("readable() yields the live execution events, in order, then completes on stream close", async () => {
    const { transport, emit, close } = pendingSendTransport();
    const client = await createClient({ transport });
    await client.connect();
    const handle = client.session("s1").send({ messages: [{ role: "user", content: "hi" }] });

    const collected = drain(handle.readable());
    emit("he", 1);
    emit("llo", 2);
    await close();

    const events = await collected;
    expect(events.map((e) => (e as { delta: string }).delta)).toEqual(["he", "llo"]);
    expect(events.every((e) => e.executionId === "exec:01ABCDEF")).toBe(true);
  });

  it("pipeTo() drains every event to a WritableStream and closes it", async () => {
    const { transport, emit, close } = pendingSendTransport();
    const client = await createClient({ transport });
    await client.connect();
    const handle = client.session("s1").send({ messages: [{ role: "user", content: "hi" }] });

    const written: StreamEvent[] = [];
    let closed = false;
    const sink = new WritableStream<StreamEvent>({
      write: (chunk) => void written.push(chunk),
      close: () => void (closed = true),
    });

    const piped = handle.pipeTo(sink);
    emit("a", 1);
    emit("b", 2);
    await close();
    await piped;

    expect(written.map((e) => (e as { delta: string }).delta)).toEqual(["a", "b"]);
    expect(closed).toBe(true);
  });
});
