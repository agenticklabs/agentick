/**
 * Pre-scoped handle subscriptions — `client.session(id).onLog(cb)` /
 * `.onProgress(cb)` / `.channelView(channel)` (and the app / gateway
 * twins). Pins that each handle bakes ITS scope into the underlying free
 * function, so the transport sees `{ kind, id }` without the caller
 * repeating it — plus the zero-config `channelView` last-frame-wins fold.
 *
 * Also covers the client-LOCAL `createClient({ onStateChange,
 * onCapabilitiesChange })` observers registered at construction.
 */

import { describe, expect, it } from "vitest";
import type {
  ClientState,
  ClientTransport,
  Cursor,
  EventFrame,
  EventQuery,
  InitializeResult,
  ProgressStream,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { channelEventName, logEventName, progressEventName } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { createClient } from "../client.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// A push-driven subscription stream a test can `emit` onto after open.
// ---------------------------------------------------------------------------

interface PushStream extends SubscriptionStream {
  emit(name: string, payload: unknown, scope?: Record<string, unknown>): void;
  readonly isClosed: boolean;
}

function pushStream(): PushStream {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let closed = false;
  let n = 0;

  const stream: PushStream = {
    subscriptionId: "sub-test",
    get isClosed() {
      return closed;
    },
    emit(
      name: string,
      payload: unknown,
      scope: Record<string, unknown> = { sessionId: "s1" },
    ): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name,
          phase: "delta",
          timestamp: 0,
          scope,
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
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      const w = waiters.shift();
      if (w) w({ value: undefined as never, done: true });
    },
  };
  return stream;
}

interface Captured {
  scope?: SubscriptionScope;
  query?: EventQuery;
}

/** Subscribe-capable transport that records the scope + query, returns `stream`. */
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
    subscribe(scope, query): SubscriptionStream {
      captured.scope = scope;
      captured.query = query;
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

// ---------------------------------------------------------------------------
// onLog / onProgress — scope is baked in per handle
// ---------------------------------------------------------------------------

describe("pre-scoped handle onLog / onProgress", () => {
  it("client.session(id).onLog subscribes with the session scope + log query", async () => {
    const stream = pushStream();
    const captured: Captured = {};
    const client = await createClient({ transport: subscribeOnlyTransport(stream, captured) });

    const got: unknown[] = [];
    const off = client.session("s1").onLog((e) => got.push(e));
    stream.emit(logEventName("tool"), { level: "info", data: "hi" }, { executionId: "e1" });
    await waitFor(() => got.length === 1);

    expect(captured.scope).toEqual({ kind: "session", id: "s1" });
    expect(captured.query).toEqual({ name: { wildcard: "*:signal:log" } });
    expect(got).toEqual([{ level: "info", data: "hi", scope: { executionId: "e1" } }]);

    off();
    await tick();
    expect((stream as PushStream).isClosed).toBe(true);
  });

  it("client.app(id).onLog subscribes with the app scope", async () => {
    const captured: Captured = {};
    const client = await createClient({
      transport: subscribeOnlyTransport(pushStream(), captured),
    });
    client.app("app-7").onLog(() => {});
    await tick();
    expect(captured.scope).toEqual({ kind: "app", id: "app-7" });
    expect(captured.query).toEqual({ name: { wildcard: "*:signal:log" } });
  });

  it("client.gateway().onProgress subscribes with the gateway scope + progress query", async () => {
    const captured: Captured = {};
    const client = await createClient({
      transport: subscribeOnlyTransport(pushStream(), captured),
    });
    client.gateway().onProgress(() => {});
    await tick();
    expect(captured.scope).toEqual({ kind: "gateway" });
    expect(captured.query).toEqual({ name: { wildcard: "*:signal:progress" } });
  });

  it("client.session(id).onProgress maps payload + origin scope", async () => {
    const stream = pushStream();
    const captured: Captured = {};
    const client = await createClient({ transport: subscribeOnlyTransport(stream, captured) });

    const got: unknown[] = [];
    client.session("s1").onProgress((e) => got.push(e));
    stream.emit(
      progressEventName("tool"),
      { token: "tok-1", progress: 2, total: 10, message: "go" },
      { executionId: "e1" },
    );
    await waitFor(() => got.length === 1);
    expect(captured.scope).toEqual({ kind: "session", id: "s1" });
    expect(got).toEqual([
      { token: "tok-1", progress: 2, total: 10, message: "go", scope: { executionId: "e1" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// channelView — pre-scoped + zero-config last-frame-wins
// ---------------------------------------------------------------------------

describe("pre-scoped handle channelView (zero-config)", () => {
  it("client.session(id).channelView(channel) — no config, last-frame-payload-wins", async () => {
    const stream = pushStream();
    const captured: Captured = {};
    const client = await createClient({ transport: subscribeOnlyTransport(stream, captured) });

    const view = client.session("s1").channelView("task-status");

    // Subscribed to THIS channel under the session scope; no config needed.
    expect(captured.scope).toEqual({ kind: "session", id: "s1" });
    expect(captured.query).toEqual({
      surface: "session",
      name: { exact: "session:channel:task-status" },
    });
    expect(view.get()).toBeUndefined(); // undefined before the first frame

    stream.emit(channelEventName("task-status"), { id: "t1", status: "running" });
    await waitFor(() => view.get() !== undefined);
    expect(view.get()).toEqual({ id: "t1", status: "running" });

    // Each frame REPLACES held state (full-object-per-frame semantics).
    stream.emit(channelEventName("task-status"), { id: "t1", status: "completed" });
    await waitFor(() => (view.get() as { status: string }).status === "completed");
    expect(view.get()).toEqual({ id: "t1", status: "completed" });

    view.close();
    expect(view.status).toBe("closed");
    expect((stream as PushStream).isClosed).toBe(true);
  });

  it("client.app(id).channelView bakes the app scope", async () => {
    const captured: Captured = {};
    const client = await createClient({
      transport: subscribeOnlyTransport(pushStream(), captured),
    });
    client.app("app-9").channelView("whatever");
    await tick();
    expect(captured.scope).toEqual({ kind: "app", id: "app-9" });
  });
});

// ---------------------------------------------------------------------------
// createClient client-LOCAL observers
// ---------------------------------------------------------------------------

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/** Fake transport whose connect() drives idle → open; request handled by `handler`. */
function handshakeTransport(handler: Handler): ClientTransport {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const notify = (s: ClientState): void => {
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
  };
}

function initResult(): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: { subscriptions: true, progress: true, cursorResume: true, cancellation: true },
    serverInfo: { name: "@test/gateway", version: "1.0.0" },
    connectionId: "conn-1",
  };
}

describe("createClient client-LOCAL observers", () => {
  it("onStateChange fires on transport state transitions", async () => {
    const handler = (async (method: WireMethod) => {
      if (method === "initialize") return initResult();
      if (method === "_extensions/list") return { extensions: [] };
      return {};
    }) as Handler;

    const states: ClientState[] = [];
    const client = await createClient({
      transport: handshakeTransport(handler),
      onStateChange: (s) => states.push(s),
    });
    await client.connect();
    expect(states).toContain("connecting");
    expect(states).toContain("open");
  });

  it("onCapabilitiesChange fires with the fresh snapshot after the handshake", async () => {
    const handler = (async (method: WireMethod) => {
      if (method === "initialize") return initResult();
      if (method === "_extensions/list") return { extensions: [] };
      return {};
    }) as Handler;

    let snapshots = 0;
    let sawSubscriptions = false;
    const client = await createClient({
      transport: handshakeTransport(handler),
      onCapabilitiesChange: (caps) => {
        snapshots++;
        if (caps.framework.subscriptions === true) sawSubscriptions = true;
      },
    });
    await client.connect();
    expect(snapshots).toBeGreaterThan(0);
    expect(sawSubscriptions).toBe(true);
  });
});
