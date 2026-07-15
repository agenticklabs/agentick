/**
 * Client receive sugar for the runtime signal family (ADR 64) —
 * `onLog` / `onProgress`.
 *
 * Pins: the sugar subscribes with the right cross-surface query, maps
 * each envelope to its payload + origin scope, and the returned
 * `Unsubscribe` closes the underlying stream.
 */

import { describe, expect, it } from "vitest";
import type {
  ClientState,
  ClientTransport,
  Cursor,
  EventFrame,
  EventQuery,
  ProgressStream,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  TransportCapabilities,
} from "@agentick/spec-next";
import { logEventName, progressEventName } from "@agentick/spec-next";

import { createClient } from "../client.js";
import { onLog, onProgress, type ReceivedLog, type ReceivedProgress } from "../signals.js";

type ClosableStream = SubscriptionStream & { closed: boolean };

/** A controllable subscription stream that replays a fixed frame list. */
function streamOf(frames: readonly EventFrame[]): ClosableStream {
  const stream: ClosableStream = {
    closed: false,
    subscriptionId: "sub-test",
    async *[Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      for (const f of frames) {
        if (stream.closed) return;
        yield f;
      }
    },
    async close(): Promise<void> {
      stream.closed = true;
    },
  };
  return stream;
}

function frame(envelope: Partial<ProtocolEvent>, cursorValue = 1): EventFrame {
  return {
    cursor: { value: cursorValue } as Cursor,
    envelope: {
      id: "e1",
      surface: "tool",
      name: "tool:signal:log",
      phase: "terminal",
      timestamp: 0,
      scope: {},
      ...envelope,
    } as ProtocolEvent,
  };
}

interface Captured {
  scope?: SubscriptionScope;
  query?: EventQuery;
  fromCursor?: Cursor;
}

function fakeClient(
  stream: SubscriptionStream,
  captured: Captured,
): {
  transport: {
    subscribe: (s: SubscriptionScope, q?: EventQuery, c?: Cursor) => SubscriptionStream;
  };
} {
  return {
    transport: {
      subscribe(scope, query, fromCursor) {
        captured.scope = scope;
        captured.query = query;
        captured.fromCursor = fromCursor;
        return stream;
      },
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("onLog (ADR 64)", () => {
  it("subscribes with the cross-surface log query and maps envelope → payload + scope", async () => {
    const stream = streamOf([
      frame({
        name: logEventName("tool"),
        scope: { sessionId: "s1", executionId: "e1" },
        payload: { level: "warning", data: { code: 7 }, logger: "lg" },
      }),
      frame({
        name: logEventName("mcp"),
        surface: "mcp",
        scope: { sessionId: "s1" },
        payload: { level: "info", data: "hi" },
      }),
    ]);
    const captured: Captured = {};
    const client = fakeClient(stream, captured);

    const got: ReceivedLog[] = [];
    onLog(client, { kind: "session", id: "s1" }, (e) => got.push(e));
    await tick();

    expect(captured.scope).toEqual({ kind: "session", id: "s1" });
    expect(captured.query).toEqual({ name: { wildcard: "*:signal:log" } });
    expect(got).toEqual([
      {
        level: "warning",
        data: { code: 7 },
        logger: "lg",
        scope: { sessionId: "s1", executionId: "e1" },
      },
      { level: "info", data: "hi", scope: { sessionId: "s1" } },
    ]);
  });

  it("returned Unsubscribe closes the underlying stream", async () => {
    const stream = streamOf([]);
    const client = fakeClient(stream, {});
    const unsub = onLog(client, { kind: "gateway" }, () => {});
    unsub();
    await tick();
    expect((stream as SubscriptionStream & { closed: boolean }).closed).toBe(true);
  });

  it("forwards fromCursor to the transport", async () => {
    const captured: Captured = {};
    const client = fakeClient(streamOf([]), captured);
    onLog(client, { kind: "gateway" }, () => {}, { fromCursor: { value: 42 } as Cursor });
    await tick();
    expect(captured.fromCursor).toEqual({ value: 42 });
  });
});

describe("onProgress (ADR 64)", () => {
  it("subscribes with the cross-surface progress query and maps payload + scope", async () => {
    const stream = streamOf([
      frame({
        name: progressEventName("tool"),
        scope: { executionId: "e1" },
        payload: { token: "tok-1", progress: 2, total: 10, message: "go" },
      }),
    ]);
    const captured: Captured = {};
    const client = fakeClient(stream, captured);

    const got: ReceivedProgress[] = [];
    onProgress(client, { kind: "session", id: "s1" }, (e) => got.push(e));
    await tick();

    expect(captured.query).toEqual({ name: { wildcard: "*:signal:progress" } });
    expect(got).toEqual([
      { token: "tok-1", progress: 2, total: 10, message: "go", scope: { executionId: "e1" } },
    ]);
  });
});

/**
 * `client.onLog` / `client.onProgress` — the instance-method sugar delegates to
 * the free functions (both take a client first-arg, so `this` threads through).
 * Same query + payload mapping as the free-function tests above, reached via the
 * real `createClient` client rather than the minimal fake.
 */
function subscribeOnlyTransport(stream: SubscriptionStream, captured: Captured): ClientTransport {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  return {
    id: "fake",
    capabilities: {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      binaryFrames: false,
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
    request: (async () => ({})) as ClientTransport["request"],
    subscribe(scope, query, fromCursor) {
      captured.scope = scope;
      captured.query = query;
      captured.fromCursor = fromCursor;
      return stream;
    },
    progress: (): ProgressStream => {
      throw new Error("progress not implemented in this fake");
    },
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
}

describe("client.onLog / client.onProgress instance methods", () => {
  it("client.onLog delegates to the free function (same query + mapping)", async () => {
    const stream = streamOf([
      frame({
        name: logEventName("tool"),
        scope: { executionId: "e1" },
        payload: { level: "info", data: "hi" },
      }),
    ]);
    const captured: Captured = {};
    const client = await createClient({ transport: subscribeOnlyTransport(stream, captured) });

    const got: ReceivedLog[] = [];
    const off = client.onLog({ kind: "session", id: "s1" }, (e) => got.push(e));
    await tick();

    expect(captured.query).toEqual({ name: { wildcard: "*:signal:log" } });
    expect(got).toEqual([{ level: "info", data: "hi", scope: { executionId: "e1" } }]);
    off();
    expect((stream as SubscriptionStream & { closed: boolean }).closed).toBe(true);
  });

  it("client.onProgress delegates to the free function", async () => {
    const stream = streamOf([
      frame({
        name: progressEventName("tool"),
        scope: { executionId: "e1" },
        payload: { token: "tok-1", progress: 2, total: 10, message: "go" },
      }),
    ]);
    const captured: Captured = {};
    const client = await createClient({ transport: subscribeOnlyTransport(stream, captured) });

    const got: ReceivedProgress[] = [];
    client.onProgress({ kind: "session", id: "s1" }, (e) => got.push(e));
    await tick();

    expect(captured.query).toEqual({ name: { wildcard: "*:signal:progress" } });
    expect(got).toEqual([
      { token: "tok-1", progress: 2, total: 10, message: "go", scope: { executionId: "e1" } },
    ]);
  });
});
