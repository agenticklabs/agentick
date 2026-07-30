/**
 * `client.capabilities` — post-connect handshake tests.
 *
 * Verifies the client issues `initialize` + `_extensions/list` and
 * populates `client.capabilities` + `client.serverInfo`. Uses a
 * hand-rolled fake transport (no in-process compiler needed) so the
 * test isolates capability plumbing from execution semantics.
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  isClientStateOpen,
  WIRE_PROTOCOL_VERSION,
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
} from "@agentick/spec";

import { createClient } from "../client.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/**
 * Fake transport — hands off `request` to a caller-supplied handler.
 * Handles the state machine: idle → connecting → open on connect().
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
        name: "@agentick/gateway#session",
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

  it("rejects connect when the server answers with another protocol version", async () => {
    // The client's half of version negotiation (#252). The server rejects a
    // request it cannot serve; this rejects an ANSWER it cannot read — before
    // anything is committed, so capabilities stay empty.
    const transport = fakeTransport(async (method) => {
      if (method === "initialize") {
        return buildInitializeResult({
          protocolVersion: "v9" as InitializeResult["protocolVersion"],
        }) as never;
      }
      if (method === "_extensions/list") return buildExtensionsList() as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await expect(client.connect()).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { received: "v9", expected: WIRE_PROTOCOL_VERSION },
    });
    expect(client.serverInfo).toBeUndefined();
    expect(client.capabilities.extensions).toEqual([]);
  });

  it("advertises the handshake capabilities it actually implements", async () => {
    // `capabilities: {}` was a producer-less wire surface: the field existed,
    // typed, and the client never filled it (#252 §4). `cursorResume` is the
    // one claim — every client transport tracks each subscription's cursor and
    // resends it on reconnect. Per-wire framing flags stay unclaimed because
    // client-core cannot answer for whichever transport it was handed.
    let sentParams: unknown;
    const transport = fakeTransport(async (method, params) => {
      if (method === "initialize") {
        sentParams = params;
        return buildInitializeResult() as never;
      }
      if (method === "_extensions/list") return buildExtensionsList() as never;
      throw new Error(`unexpected method: ${method}`);
    });

    const client = await createClient({ transport });
    await client.connect();

    expect(sentParams).toMatchObject({
      protocolVersion: WIRE_PROTOCOL_VERSION,
      capabilities: { cursorResume: true },
    });
    const sentCapabilities = (sentParams as { capabilities: Record<string, unknown> }).capabilities;
    expect(sentCapabilities).not.toHaveProperty("batch");
    expect(sentCapabilities).not.toHaveProperty("streamableHttp");
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
  // ADR 47 — onCapabilitiesChange fires on handshake / reconnect / drop.
  // Runtime `gateway:capabilities:changed` reactivity (client re-syncing
  // its own capabilities when dynamic extensions mutate the set) is
  // deferred to #308, when that event can actually fire — the registry
  // is sealed at gateway construction today.
  // -------------------------------------------------------------------

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
