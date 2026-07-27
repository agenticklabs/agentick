/**
 * `client.events()` — live client-event stream tests.
 *
 * Verifies the dedicated `LocalPubSub<ClientEvent>` emitter surfaces
 * connection-lifecycle events as a live `AsyncIterable<ClientEvent>`
 * with surface/phase filtering, a monotonic cursor, clean `close()`,
 * and independent concurrent iterators. Uses a hand-rolled fake
 * transport (no in-process compiler) so the test isolates the
 * event-stream plumbing from execution semantics.
 *
 * The emitter is live-only (no replay buffer), so every test starts
 * iterating and lets the subscription attach (a short settle, mirroring
 * `@agentick/pubsub`'s own `local-pubsub.spec.ts`) BEFORE driving the
 * transport transition that publishes.
 */

import { describe, expect, it } from "vitest";
import { waitFor, waitForStable } from "@agentick/utils/testing";
import type {
  ClientConnectionEvent,
  ClientEvent,
  ClientState,
  ClientTransport,
  ProgressStream,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec";

import { createClient } from "../client.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/**
 * Fake transport — identical shape to capabilities.spec's fake, plus a
 * `setState` escape hatch to drive transitions by hand. `connect()`
 * fires `connecting` then `open`.
 */
function fakeTransport(handler: Handler): ClientTransport & {
  setState(s: ClientState): void;
} {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const notify = (s: ClientState) => {
    state = s;
    for (const l of listeners) l(s);
  };

  return {
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
      notify("connecting");
      notify("open");
    },
    async close() {
      notify("closed");
    },
    request: handler as ClientTransport["request"],
    subscribe: (): SubscriptionStream => {
      throw new Error("subscribe not implemented in this fake");
    },
    progress: (): ProgressStream => {
      throw new Error("progress not implemented in this fake");
    },
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    setState: notify,
  };
}

/** Minimal handler that satisfies the connect handshake. */
const okHandler: Handler = (async (method: string) => {
  if (method === "initialize") {
    return {
      protocolVersion: "v1",
      capabilities: {},
      serverInfo: { name: "@test/gw", version: "0.0.0" },
    };
  }
  if (method === "_extensions/list") return { extensions: [] };
  return {};
}) as Handler;

/**
 * Start draining a stream into an array in the background. The pump's
 * first pull attaches the pubsub subscription; the returned settle
 * promise resolves after a short delay so callers can publish AFTER the
 * subscription is live (the emitter is live-only — see file header).
 */
function pump(stream: AsyncIterable<ClientEvent>): {
  received: ClientEvent[];
  settled: Promise<void>;
} {
  const received: ClientEvent[] = [];
  void (async () => {
    for await (const event of stream) received.push(event);
  })();
  const settled = new Promise<void>((resolve) => setTimeout(resolve, 20));
  return { received, settled };
}

describe("client.events() — live client-event stream", () => {
  it("yields a connection event (phase 'transition') when the transport connects", async () => {
    const client = await createClient({ transport: fakeTransport(okHandler) });
    const transport = client.transport as ReturnType<typeof fakeTransport>;

    const stream = client.events({ surface: "connection" });
    const { received, settled } = pump(stream);
    await settled;

    transport.setState("open");

    await waitFor(() => received.length >= 1, { description: "a connection event" });
    const event = received[0] as ClientConnectionEvent;
    expect(event.surface).toBe("connection");
    expect(event.phase).toBe("transition");
    expect(event.to).toBe("open");
    expect(event.clientId).toBe(client.id);
    expect(typeof event.timestamp).toBe("number");

    await stream.close();
    await client.close();
  });

  it("filters by surface — a non-matching surface filter excludes connection events", async () => {
    const client = await createClient({ transport: fakeTransport(okHandler) });
    const transport = client.transport as ReturnType<typeof fakeTransport>;

    const connStream = client.events({ surface: "connection" });
    const authStream = client.events({ surface: "auth" });
    const conn = pump(connStream);
    const auth = pump(authStream);
    await Promise.all([conn.settled, auth.settled]);

    transport.setState("open");
    transport.setState("closed");

    await waitFor(() => conn.received.length >= 2, { description: "two connection events" });
    // The auth-filtered stream must never see connection events.
    await waitForStable(() => auth.received.length, { stableMs: 30 });
    expect(auth.received).toHaveLength(0);
    expect(conn.received.every((e) => e.surface === "connection")).toBe(true);

    await connStream.close();
    await authStream.close();
    await client.close();
  });

  it("close() ends the iterator and unsubscribes", async () => {
    const client = await createClient({ transport: fakeTransport(okHandler) });
    const transport = client.transport as ReturnType<typeof fakeTransport>;

    const stream = client.events();
    let done = false;
    const drained = (async () => {
      for await (const _event of stream) {
        /* drain */
      }
      done = true;
    })();

    await new Promise((r) => setTimeout(r, 20));
    transport.setState("open");
    await waitFor(() => stream.cursor.value >= 1, { description: "one event observed" });

    await stream.close();
    await drained; // resolves only if the for-await completed
    expect(done).toBe(true);

    await client.close();
  });

  it("supports multiple independent concurrent iterators", async () => {
    const client = await createClient({ transport: fakeTransport(okHandler) });
    const transport = client.transport as ReturnType<typeof fakeTransport>;

    const a = client.events();
    const b = client.events();
    const pa = pump(a);
    const pb = pump(b);
    await Promise.all([pa.settled, pb.settled]);

    transport.setState("open");

    await waitFor(() => pa.received.length >= 1 && pb.received.length >= 1, {
      description: "both iterators receive the event",
    });
    expect(pa.received[0]?.surface).toBe("connection");
    expect(pb.received[0]?.surface).toBe("connection");

    await a.close();
    await b.close();
    await client.close();
  });

  it("stamps a monotonic client-scoped cursor; fromCursor is live-only (documented-ignored)", async () => {
    const client = await createClient({ transport: fakeTransport(okHandler) });
    const transport = client.transport as ReturnType<typeof fakeTransport>;

    const stream = client.events({ surface: "connection" });
    const { received, settled } = pump(stream);
    await settled;

    expect(stream.cursor.value).toBe(0); // no event yielded yet

    transport.setState("open");
    await waitFor(() => received.length >= 1);
    const firstCursor = stream.cursor.value;
    expect(firstCursor).toBeGreaterThan(0);

    transport.setState("closed");
    await waitFor(() => received.length >= 2);
    // Monotonic: the cursor strictly advances with each yielded event.
    expect(stream.cursor.value).toBeGreaterThan(firstCursor);

    // fromCursor is accepted but IGNORED (no replay buffer). A stream
    // opened with a past cursor still starts live — it observes nothing
    // published before it attached.
    const resumed = client.events({ surface: "connection" }, { value: 0 });
    const late = pump(resumed);
    await late.settled;
    // No new transitions fired → the "resumed" stream replays nothing.
    await waitForStable(() => late.received.length, { stableMs: 30 });
    expect(late.received).toHaveLength(0);

    await stream.close();
    await resumed.close();
    await client.close();
  });
});
