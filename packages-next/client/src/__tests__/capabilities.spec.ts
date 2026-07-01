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
