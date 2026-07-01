/**
 * `client.capabilities` — post-connect handshake tests.
 *
 * Verifies the client issues `initialize` + `_extensions/list` and
 * populates `client.capabilities` + `client.serverInfo`. Uses a
 * hand-rolled fake transport (no in-process reconciler needed) so the
 * test isolates capability plumbing from execution semantics.
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  isClientStateOpen,
  type ClientState,
  type ClientTransport,
  type InitializeResult,
  type ExtensionsListResult,
  type ProgressStream,
  type SubscriptionStream,
  type TransportCapabilities,
  type WireMethod,
  type WireParams,
  type WireResult,
} from "@agentick/spec-next";

import { createClient } from "../client.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/**
 * Fake transport — hands off `request` to a caller-supplied handler.
 * Handles the state machine: idle → connecting → open on connect().
 */
function fakeTransport(handler: Handler): ClientTransport & {
  setState(s: ClientState): void;
  emitNotification(method: string, params?: unknown): void;
} {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const notifListeners = new Map<string, Set<(params: unknown) => void>>();
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
    onNotification(method, listener) {
      let set = notifListeners.get(method);
      if (!set) {
        set = new Set();
        notifListeners.set(method, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) notifListeners.delete(method);
      };
    },
    setState: notify,
    // Test seam — simulate the gateway pushing a notification frame.
    emitNotification(method, params) {
      const set = notifListeners.get(method);
      if (!set) return;
      for (const l of set) l(params);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildInitializeResult(overrides?: Partial<InitializeResult>): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: {
      cursorResume: true,
      subscriptions: true,
      progress: true,
      cancellation: true,
    },
    serverInfo: { name: "@test/gateway", version: "1.2.3" },
    connectionId: "conn-42",
    ...overrides,
  };
}

function buildExtensionsList(): ExtensionsListResult {
  return {
    extensions: [
      {
        name: "@agentick/gateway-next#session",
        namespace: "session",
        version: "1.0.0",
        methods: ["session/send", "session/dispatch", "session/close"],
        notifications: [],
      },
      {
        name: "@my-org/crm",
        namespace: "crm",
        version: "0.5.0",
        methods: ["crm/listContacts", "crm/updateContact"],
        notifications: ["crm/contact-changed"],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("client capabilities", () => {
  it("populates capabilities + serverInfo after connect", async () => {
    const initResult = buildInitializeResult();
    const listResult = buildExtensionsList();

    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return initResult as never;
      if (method === "_extensions/list") return listResult as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });

    // Before connect: empty
    expect(client.capabilities.methods.size).toBe(0);
    expect(client.capabilities.extensions).toEqual([]);
    expect(client.serverInfo).toBeUndefined();

    await client.connect();
    expect(isClientStateOpen(client.state)).toBe(true);

    // After connect: populated
    expect(client.serverInfo).toEqual({
      name: "@test/gateway",
      version: "1.2.3",
      protocolVersion: "v1",
      connectionId: "conn-42",
    });
    expect(client.capabilities.framework).toEqual(initResult.capabilities);
    expect(client.capabilities.extensions).toEqual(listResult.extensions);
    expect(client.capabilities.methods.has("session/send")).toBe(true);
    expect(client.capabilities.methods.has("crm/listContacts")).toBe(true);
    expect(client.capabilities.notifications.has("crm/contact-changed")).toBe(true);
    expect(client.capabilities.hasMethod("crm/listContacts")).toBe(true);
    expect(client.capabilities.hasNamespace("session")).toBe(true);
    expect(client.capabilities.hasNamespace("crm")).toBe(true);
    expect(client.capabilities.hasNamespace("unknown-namespace")).toBe(false);
    expect(client.capabilities.hasMethod("nonexistent/method")).toBe(false);

    await client.close();
  });

  it("gracefully degrades when server returns MethodNotFound for _extensions/list", async () => {
    const initResult = buildInitializeResult();

    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return initResult as never;
      if (method === "_extensions/list") {
        // Older-server compat: throw a JSON-RPC MethodNotFound shape.
        throw { kind: "rpc", code: ErrorCode.MethodNotFound, message: "no such method" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();

    // Framework flags populated from initialize.
    expect(client.capabilities.framework).toEqual(initResult.capabilities);
    // Extensions empty — old server.
    expect(client.capabilities.extensions).toEqual([]);
    expect(client.capabilities.methods.size).toBe(0);
    // Server info still populated.
    expect(client.serverInfo).toBeDefined();

    await client.close();
  });

  it("propagates non-MethodNotFound errors from _extensions/list", async () => {
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return buildInitializeResult() as never;
      if (method === "_extensions/list") {
        throw { kind: "rpc", code: ErrorCode.InternalError, message: "boom" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await expect(client.connect()).rejects.toMatchObject({
      code: ErrorCode.InternalError,
    });
  });

  it("rejects connect when initialize fails", async () => {
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        throw { kind: "rpc", code: ErrorCode.InvalidParams, message: "bad protocol version" };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await expect(client.connect()).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });

    // Capabilities remain empty on failed connect.
    expect(client.serverInfo).toBeUndefined();
    expect(client.capabilities.extensions).toEqual([]);
  });

  it("clears capabilities on transport state transition away from open", async () => {
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return buildInitializeResult() as never;
      if (method === "_extensions/list") return buildExtensionsList() as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();
    expect(client.capabilities.extensions.length).toBeGreaterThan(0);

    // Simulate reconnecting — capabilities should clear immediately.
    transport.setState("reconnecting");
    expect(client.capabilities.extensions).toEqual([]);
    expect(client.serverInfo).toBeUndefined();

    // Simulate closed — still empty.
    transport.setState("closed");
    expect(client.capabilities.extensions).toEqual([]);
  });

  it("re-runs the handshake on transport reconnect (open → reconnecting → open)", async () => {
    // Counter tracks how many times each handshake RPC has been issued.
    // Initial connect: 1 initialize + 1 _extensions/list.
    // After open→reconnecting→open: expect 2 + 2.
    let initCount = 0;
    let listCount = 0;

    // First response reports one extension; second response (after
    // reconnect) reports a DIFFERENT set. Proves capabilities actually
    // reflect the post-reconnect gateway state, not stale cached values.
    const initialListResult: ExtensionsListResult = {
      extensions: [
        {
          name: "@test/before",
          namespace: "before",
          methods: ["before/ping"],
          notifications: [],
        },
      ],
    };
    const postReconnectListResult: ExtensionsListResult = {
      extensions: [
        {
          name: "@test/after",
          namespace: "after",
          methods: ["after/pong"],
          notifications: ["after/changed"],
        },
      ],
    };

    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        initCount++;
        return buildInitializeResult({
          connectionId: `conn-${initCount}`,
        }) as never;
      }
      if (method === "_extensions/list") {
        listCount++;
        return (listCount === 1 ? initialListResult : postReconnectListResult) as never;
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();

    expect(initCount).toBe(1);
    expect(listCount).toBe(1);
    expect(client.capabilities.hasNamespace("before")).toBe(true);
    expect(client.capabilities.hasNamespace("after")).toBe(false);
    expect(client.serverInfo?.connectionId).toBe("conn-1");

    // Simulate the transport driving reconnect autonomously.
    transport.setState("reconnecting");
    expect(client.capabilities.extensions).toEqual([]);
    expect(client.serverInfo).toBeUndefined();

    // Transport comes back to open — handshake should fire again.
    transport.setState("open");
    await client.whenReady();

    expect(initCount).toBe(2);
    expect(listCount).toBe(2);
    expect(client.capabilities.hasNamespace("before")).toBe(false);
    expect(client.capabilities.hasNamespace("after")).toBe(true);
    expect(client.capabilities.hasMethod("after/pong")).toBe(true);
    expect(client.capabilities.hasNotification("after/changed")).toBe(true);
    expect(client.serverInfo?.connectionId).toBe("conn-2");

    await client.close();
  });

  it("does NOT re-run handshake on the initial `open` transition (only post-reconnect)", async () => {
    // Regression: `connect()` awaits the handshake explicitly. The
    // state-change listener should NOT ALSO trigger a second handshake
    // on the same open transition.
    let initCount = 0;

    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        initCount++;
        return buildInitializeResult() as never;
      }
      if (method === "_extensions/list") return buildExtensionsList() as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();
    await client.whenReady();

    // Only one initialize — the explicit `connect()`, not a
    // state-change-triggered duplicate.
    expect(initCount).toBe(1);

    await client.close();
  });

  it("post-reconnect handshake failure leaves capabilities empty (best-effort)", async () => {
    // If the post-reconnect handshake fails hard (server unreachable
    // on the way back), we can't propagate to a caller — nobody
    // awaited it. Behavior: swallow the failure, capabilities stay
    // empty until the next explicit `connect()` succeeds.
    let initCount = 0;
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        initCount++;
        if (initCount === 1) return buildInitializeResult() as never;
        throw { kind: "rpc", error: { code: ErrorCode.InternalError, message: "boom" } };
      }
      if (method === "_extensions/list") return buildExtensionsList() as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();
    expect(client.capabilities.extensions.length).toBeGreaterThan(0);

    transport.setState("reconnecting");
    transport.setState("open");
    await client.whenReady();

    // Handshake failed on the way back — capabilities remain empty.
    // `whenReady()` still resolves (best-effort, no propagation).
    expect(client.capabilities.extensions).toEqual([]);
    expect(client.serverInfo).toBeUndefined();
    expect(initCount).toBe(2);

    await client.close();
  });

  // -------------------------------------------------------------------
  // #311 — notifications/capabilities/changed refetch + onCapabilitiesChange
  // -------------------------------------------------------------------

  it("refetches _extensions/list on notifications/capabilities/changed and fires onCapabilitiesChange", async () => {
    // Simulates a server that installs a new extension at runtime.
    // Round 1: initial _extensions/list returns [session]. Round 2
    // (after the notification): returns [session, crm]. The client
    // MUST refetch, MUST swap capabilities, MUST fire the subscriber.
    const initResult = buildInitializeResult();
    const round1 = {
      extensions: [
        {
          name: "@agentick/gateway-next#session",
          namespace: "session",
          version: "1.0.0",
          methods: ["session/send"],
          notifications: [],
        },
      ],
    } satisfies ExtensionsListResult;
    const round2 = buildExtensionsList(); // session + crm

    let listCalls = 0;
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return initResult as never;
      if (method === "_extensions/list") {
        listCalls += 1;
        return (listCalls === 1 ? round1 : round2) as never;
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await createClient({ transport });
    const snapshots: number[] = [];
    client.onCapabilitiesChange((c) => snapshots.push(c.extensions.length));

    await client.connect();
    expect(client.capabilities.extensions).toHaveLength(1);
    expect(client.capabilities.hasNamespace("crm")).toBe(false);
    expect(snapshots).toEqual([1]); // initial applyExtensionsList

    transport.emitNotification("notifications/capabilities/changed", {});
    // Refetch is async; give it a microtask cycle.
    await new Promise((r) => setImmediate(r));
    expect(listCalls).toBe(2);
    expect(client.capabilities.extensions).toHaveLength(2);
    expect(client.capabilities.hasNamespace("crm")).toBe(true);
    expect(snapshots).toEqual([1, 2]);

    await client.close();
  });

  it("tolerates MethodNotFound during a capabilities-refetch — capabilities stay put", async () => {
    // Server drops `_extensions/list` support mid-connection. The
    // refetch swallows the error and leaves the current snapshot
    // in place. Adopters get no false-positive empty snapshot.
    const initResult = buildInitializeResult();
    let listCalls = 0;
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return initResult as never;
      if (method === "_extensions/list") {
        listCalls += 1;
        if (listCalls === 1) return buildExtensionsList() as never;
        throw { kind: "rpc", code: ErrorCode.MethodNotFound, message: "gone" };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();
    expect(client.capabilities.extensions).toHaveLength(2);

    transport.emitNotification("notifications/capabilities/changed", {});
    await new Promise((r) => setImmediate(r));
    expect(listCalls).toBe(2);
    // Still populated — the refetch failed but the pre-existing
    // snapshot is unchanged.
    expect(client.capabilities.extensions).toHaveLength(2);
    expect(client.capabilities.hasNamespace("crm")).toBe(true);

    await client.close();
  });

  it("fires onCapabilitiesChange with the empty snapshot on reconnecting / close", async () => {
    const initResult = buildInitializeResult();
    const listResult = buildExtensionsList();
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") return initResult as never;
      if (method === "_extensions/list") return listResult as never;
      throw new Error(`unexpected: ${method}`);
    });

    const client = await createClient({ transport });
    const seen: number[] = [];
    client.onCapabilitiesChange((c) => seen.push(c.extensions.length));

    await client.connect();
    expect(seen).toEqual([2]); // handshake

    transport.setState("reconnecting");
    expect(seen).toEqual([2, 0]); // wire dropped → cleared snapshot

    await client.close();
  });

  it("client.request works with typed WireMethods during handshake", async () => {
    // Regression / type sanity — the connect() flow calls request()
    // with method="initialize" and method="_extensions/list". Both
    // are WireMethod keys. This test exists to catch typing drift
    // if either method name is renamed.
    const seen: string[] = [];
    const transport = fakeTransport(async (method) => {
      seen.push(method);
      if (method === "initialize") return buildInitializeResult() as never;
      if (method === "_extensions/list") return buildExtensionsList() as never;
      throw new Error(`unexpected: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();
    expect(seen).toEqual(["initialize", "_extensions/list"]);
  });
});
