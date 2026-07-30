/**
 * `handle.executionId` on a client send handle — known DURING the execution, not
 * only after it.
 *
 * The handle assigns `executionId` in the `session/send` response handler, and
 * that response does not arrive until the turn is over. So for the entire life of
 * the execution the getter returned `""`, which is exactly the window in which a
 * consumer needs it: an id is how a UI decides whether a committed timeline entry
 * belongs to the turn it is currently streaming. Comparing every entry against an
 * empty string answers "not mine" for all of them, and the turn renders twice —
 * once from the live stream, once from the timeline — with the same words under two
 * row ids.
 *
 * Every `StreamEventBase` carries `executionId`, so the id is available on the
 * first frame. The handle now takes it there.
 */

import { describe, expect, it } from "vitest";
import { WIRE_PROTOCOL_VERSION } from "@agentick/spec";
import type {
  ClientState,
  ClientTransport,
  ProgressFrame,
  ProgressStream,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
} from "@agentick/spec";

import { createClient } from "../client.js";

/** A progress stream a test pushes frames onto after the handle opens. */
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

  /** Push one execution StreamEvent, shaped as the gateway delivers it. */
  const emit = (executionId: string): void => {
    const frame = {
      token,
      envelope: {
        name: "session:execution:event",
        phase: "notification",
        payload: {
          id: "ev-1",
          sequence: 1,
          tick: 1,
          timestamp: new Date(0).toISOString(),
          sessionId: "s1",
          executionId,
          type: "execution-start",
        },
      },
    } as unknown as ProgressFrame;
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value: frame });
    else buffer.push(frame);
  };

  return { stream, emit };
}

/**
 * A transport whose `session/send` NEVER resolves for the duration of the test —
 * the state a real client is in while a turn runs, and the state the old getter
 * could say nothing about.
 */
function pendingSendTransport() {
  // Shaped after `subscribeOnlyTransport` in `handle-subscriptions.spec.ts` — the
  // fake in this package that connects without a full handshake.
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
    // Pending forever on a send — the point of the fixture: the state a real
    // client is in for the whole of a running turn.
    request: (async (method: WireMethod) => {
      if (method === "session/send") return new Promise<never>(() => {});
      if (method === "initialize") {
        return {
          // The wire's one version. A fixture claiming anything else now fails
          // the client's handshake check (#252) — which is how this typo was
          // found: `"1.0"` was never a version this protocol had.
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
  return { transport, emit: progress.emit };
}

describe("client send handle — executionId during the execution", () => {
  it("takes the id from the first event, while the send is still pending", async () => {
    const { transport, emit } = pendingSendTransport();
    const client = await createClient({ transport });
    await client.connect();

    const handle = client.session("s1").send({ messages: [{ role: "user", content: "hi" }] });

    // Before any frame: the honest empty. Nothing has named the execution yet.
    expect(handle.executionId).toBe("");

    // Consume the stream the way a fold does, one event deep.
    const events = handle.events()[Symbol.asyncIterator]();
    const first = events.next();
    emit("exec:01ABCDEF");
    const got = await first;

    expect((got.value as { executionId: string }).executionId).toBe("exec:01ABCDEF");
    // THE CLAIM: known now — with `.result` still pending, which is where every
    // consumer that needs the id actually lives.
    expect(handle.executionId).toBe("exec:01ABCDEF");
    expect(handle.status).toBe("running");
  });

  it("keeps the FIRST id — a later event cannot relabel the execution", async () => {
    const { transport, emit } = pendingSendTransport();
    const client = await createClient({ transport });
    await client.connect();
    const handle = client.session("s1").send({ messages: [{ role: "user", content: "hi" }] });

    const events = handle.events()[Symbol.asyncIterator]();
    const firstRead = events.next();
    emit("exec:FIRST");
    await firstRead;
    const secondRead = events.next();
    emit("exec:SECOND");
    await secondRead;

    // One handle is one execution. A consumer keying a fold on this must never see
    // it move underneath them mid-turn.
    expect(handle.executionId).toBe("exec:FIRST");
  });
});
