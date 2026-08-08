/**
 * SSE resumability — the bundled `inMemoryEventStore` and its wiring into
 * both HTTP transport shapes.
 *
 * The store's contract is what the SDK calls during a resumed GET: look
 * the anchor id up, replay everything AFTER it on the SAME stream, report
 * which stream that was. Exercised directly here — driving a real dropped
 * SSE reconnect would test the SDK, not this store.
 *
 * Pins:
 *  - Replay emits the events after the anchor, in order, from that stream
 *    only, and returns the stream id.
 *  - An unknown / aged-out anchor replays nothing and claims no stream, so
 *    the SDK answers `400` and the client opens a fresh stream.
 *  - The bound holds: the oldest events are dropped past `maxEvents`.
 *  - The transport's `eventStore` option reaches the SDK: over real
 *    loopback HTTP, the SAME resumption request is answered differently
 *    by a server configured with a store and one without — and without
 *    one is the DEFAULT (resumability opt-in, no silent memory growth).
 */

import type { EventId, EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";

import { McpServerHarness } from "../../index.js";
import { DEFAULT_MAX_EVENTS, inMemoryEventStore } from "../event-store.js";
import { httpTransport } from "../http.js";

function message(id: number): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method: "notifications/progress", params: { n: id } };
}

/** Collect a replay's `send` calls in order. */
async function replay(
  store: ReturnType<typeof inMemoryEventStore>,
  anchor: EventId,
): Promise<{ streamId: string; sent: readonly (readonly [EventId, JSONRPCMessage])[] }> {
  const sent: (readonly [EventId, JSONRPCMessage])[] = [];
  const streamId = await store.replayEventsAfter(anchor, {
    send: async (eventId, msg) => {
      sent.push([eventId, msg]);
    },
  });
  return { streamId, sent };
}

describe("inMemoryEventStore — replay contract", () => {
  it("replays the events after the anchor, in order, and reports the stream", async () => {
    const store = inMemoryEventStore();
    const first = await store.storeEvent("stream-a", message(1));
    const second = await store.storeEvent("stream-a", message(2));
    const third = await store.storeEvent("stream-a", message(3));

    const { streamId, sent } = await replay(store, first);
    expect(streamId).toBe("stream-a");
    expect(sent.map(([id]) => id)).toEqual([second, third]);
    expect(sent.map(([, m]) => (m as unknown as { params: { n: number } }).params.n)).toEqual([
      2, 3,
    ]);
  });

  it("never replays another stream's events", async () => {
    const store = inMemoryEventStore();
    const anchor = await store.storeEvent("stream-a", message(1));
    await store.storeEvent("stream-b", message(99));
    const onA = await store.storeEvent("stream-a", message(2));

    const { streamId, sent } = await replay(store, anchor);
    expect(streamId).toBe("stream-a");
    expect(sent.map(([id]) => id)).toEqual([onA]);
  });

  it("maps an event id back to its stream, and an unknown id to undefined", async () => {
    const store = inMemoryEventStore();
    const eventId = await store.storeEvent("stream-a", message(1));
    expect(await store.getStreamIdForEventId?.(eventId)).toBe("stream-a");
    expect(await store.getStreamIdForEventId?.("stream-a:000000000042")).toBeUndefined();
  });

  it("claims no stream for an unknown anchor", async () => {
    const store = inMemoryEventStore();
    await store.storeEvent("stream-a", message(1));
    const { streamId, sent } = await replay(store, "bogus");
    expect(streamId).toBe("");
    expect(sent).toEqual([]);
  });

  it("drops the oldest events past the bound", async () => {
    const store = inMemoryEventStore({ maxEvents: 3 });
    const evicted = await store.storeEvent("stream-a", message(1));
    const kept = [
      await store.storeEvent("stream-a", message(2)),
      await store.storeEvent("stream-a", message(3)),
      await store.storeEvent("stream-a", message(4)),
    ];

    // The evicted anchor is gone — a client reconnecting past the window
    // is told the id is unknown rather than being handed a partial stream.
    expect(await store.getStreamIdForEventId?.(evicted)).toBeUndefined();
    expect(await store.getStreamIdForEventId?.(kept[0]!)).toBe("stream-a");

    const { sent } = await replay(store, kept[0]!);
    expect(sent.map(([id]) => id)).toEqual([kept[1], kept[2]]);
  });

  it("defaults to a documented, finite bound", async () => {
    expect(DEFAULT_MAX_EVENTS).toBe(1000);
    const store = inMemoryEventStore();
    const first = await store.storeEvent("s", message(0));
    for (let i = 1; i <= DEFAULT_MAX_EVENTS; i += 1) {
      await store.storeEvent("s", message(i));
    }
    expect(await store.getStreamIdForEventId?.(first)).toBeUndefined();
  });
});

// ============================================================================
// The option reaches the SDK — proven over real loopback HTTP
// ============================================================================

const INITIALIZE = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "resumption-test", version: "0.0.0" },
  },
};

/** A listening server, optionally configured for resumability. */
async function serveHttp(eventStore?: EventStore): Promise<{
  readonly url: string;
  readonly stop: () => Promise<void>;
}> {
  const transport = httpTransport(eventStore ? { port: 0, eventStore } : { port: 0 });
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 256 }),
    new LocalEventBus(),
    new LocalInbox(),
    { name: "resumption-test", transports: [transport] },
  );
  await harness.ready;
  await harness.start();
  const addr = transport.address();
  if (addr === null) throw new Error("httpTransport did not bind a port");
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    stop: async (): Promise<void> => {
      await harness.close();
      await transport.close();
    },
  };
}

/**
 * Open a session, then ask to RESUME an event stream — the one request
 * whose answer depends on whether an event store is configured. Reads the
 * body only for a terminated response; an SSE stream never ends.
 */
async function resumeAfterInitialize(
  eventStore?: EventStore,
): Promise<{ status: number; contentType: string; body: string }> {
  const server = await serveHttp(eventStore);
  try {
    const init = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE),
    });
    // Drain the initialize response so its SSE stream closes.
    await init.text();
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const resumed = await fetch(server.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "mcp-session-id": sessionId ?? "",
        "mcp-protocol-version": INITIALIZE.params.protocolVersion,
        "last-event-id": "stream-that-never-existed:000000000001",
      },
    });
    const contentType = resumed.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await resumed.body?.cancel();
      return { status: resumed.status, contentType, body: "" };
    }
    return { status: resumed.status, contentType, body: await resumed.text() };
  } finally {
    await server.stop();
  }
}

describe("httpTransport — the eventStore option reaches the SDK", () => {
  it("without a store (the default), a resumption becomes a plain new stream", async () => {
    // The SDK only consults `Last-Event-ID` when it HAS a store. With none
    // configured — today's default — the header is ignored and the client
    // silently gets a fresh stream: every message sent during the gap is
    // lost. This is the hole `eventStore` closes, pinned as behavior.
    const { status, contentType } = await resumeAfterInitialize();
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
  });

  it("with a store, the SDK consults it — and rejects the id it never issued", async () => {
    const { status, body } = await resumeAfterInitialize(inMemoryEventStore());
    expect(status).toBe(400);
    // `getStreamIdForEventId` answered `undefined`, so the SDK refuses the
    // resume instead of opening a stream — proof the store was passed through.
    expect(body).toContain("Invalid event ID");
  });
});
