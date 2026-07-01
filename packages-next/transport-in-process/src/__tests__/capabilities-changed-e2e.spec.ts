/**
 * `notifications/capabilities/changed` end-to-end (#311) — gateway
 * broadcast → in-process transport sink → client
 * `onNotification("notifications/capabilities/changed")` handler →
 * `_extensions/list` refetch → `onCapabilitiesChange` subscriber fires.
 *
 * The gateway registers its wire-extension set at construction and
 * seals the registry (extensions cannot yet be added at runtime — #308
 * lands that). Here we simulate the mutation by swapping the
 * `_extensions/list` response before triggering
 * `broadcastNotification`. This exercises the wire-level plumbing
 * without depending on #308's dynamic-registry API.
 *
 * Covers:
 *   - Gateway `broadcastNotification` fans out to every registered sink
 *   - Client refetches `_extensions/list` on the notification
 *   - `client.onCapabilitiesChange` fires with the fresh snapshot
 *   - Multiple connected clients each receive their own notification
 *   - Client `close()` unsubscribes the sink — post-close broadcasts
 *     don't reach that client
 */

import { createClient } from "@agentick/client-next";
import { createGateway } from "@agentick/gateway-next";
import type {
  ExtensionsListResult,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";
import { describe, expect, it } from "vitest";

import { inProcessTransport } from "../index.js";
import { buildHandshakeInitializeResult } from "../handshake.js";

const ROUND_1: ExtensionsListResult = {
  extensions: [
    {
      name: "@agentick/gateway-next#session",
      namespace: "session",
      version: "1.0.0",
      methods: ["session/send"],
      notifications: [],
    },
  ],
};

const ROUND_2: ExtensionsListResult = {
  extensions: [
    ...ROUND_1.extensions,
    {
      name: "@my-org/dynamic",
      namespace: "dynamic",
      version: "0.1.0",
      methods: ["dynamic/thing"],
      notifications: [],
    },
  ],
};

async function setup(): Promise<{
  readonly gateway: Awaited<ReturnType<typeof createGateway>>;
  readonly setListResult: (r: ExtensionsListResult) => void;
  readonly makeClient: () => ReturnType<typeof createClient>;
  readonly cleanup: () => Promise<void>;
}> {
  const gateway = await createGateway();
  let listResult: ExtensionsListResult = ROUND_1;
  const initResult = buildHandshakeInitializeResult();

  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    if (req.method === "initialize") {
      return { jsonrpc: "2.0", id: req.id, result: initResult };
    }
    if (req.method === "_extensions/list") {
      return { jsonrpc: "2.0", id: req.id, result: listResult };
    }
    // Everything else goes through the real gateway dispatch — none of
    // it fires in these tests but keep the shape honest for regression.
    const sink: DispatchSink = {
      sendNotification: () => {},
      registerSubscription: () => {},
      unregisterSubscription: () => {},
      registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
      unregisterInFlight: () => {},
    };
    return dispatchRequest(gateway, req, sink);
  };

  return {
    gateway,
    setListResult: (r) => {
      listResult = r;
    },
    makeClient: () =>
      createClient({
        transport: inProcessTransport({ handler, gateway }),
      }),
    cleanup: async () => {
      await gateway.close();
    },
  };
}

describe("notifications/capabilities/changed end-to-end (#311)", () => {
  it("gateway.broadcastNotification refreshes the client's capabilities", async () => {
    const { gateway, setListResult, makeClient, cleanup } = await setup();
    const client = await makeClient();
    const snapshots: number[] = [];
    client.onCapabilitiesChange((c) => snapshots.push(c.extensions.length));

    await client.connect();
    expect(client.capabilities.extensions).toHaveLength(1);
    expect(snapshots).toEqual([1]);

    // Server-side "install" — swap the future list, then broadcast.
    setListResult(ROUND_2);
    gateway.broadcastNotification!({
      method: "notifications/capabilities/changed",
      params: {},
    });

    // Refetch is scheduled via a microtask; give the RPC a tick.
    await new Promise((r) => setImmediate(r));
    expect(client.capabilities.extensions).toHaveLength(2);
    expect(client.capabilities.hasNamespace("dynamic")).toBe(true);
    expect(snapshots).toEqual([1, 2]);

    await client.close();
    await cleanup();
  });

  it("multi-client: broadcast reaches every connected client", async () => {
    const { gateway, setListResult, makeClient, cleanup } = await setup();
    const c1 = await makeClient();
    const c2 = await makeClient();
    await c1.connect();
    await c2.connect();
    expect(c1.capabilities.extensions).toHaveLength(1);
    expect(c2.capabilities.extensions).toHaveLength(1);

    setListResult(ROUND_2);
    gateway.broadcastNotification!({
      method: "notifications/capabilities/changed",
      params: {},
    });
    await new Promise((r) => setImmediate(r));

    expect(c1.capabilities.extensions).toHaveLength(2);
    expect(c2.capabilities.extensions).toHaveLength(2);

    await c1.close();
    await c2.close();
    await cleanup();
  });

  it("client.close unregisters the sink — subsequent broadcasts don't reach it", async () => {
    const { gateway, setListResult, makeClient, cleanup } = await setup();
    const c1 = await makeClient();
    const c2 = await makeClient();
    await c1.connect();
    await c2.connect();

    const c1Snapshots: number[] = [];
    c1.onCapabilitiesChange((c) => c1Snapshots.push(c.extensions.length));
    const c2Snapshots: number[] = [];
    c2.onCapabilitiesChange((c) => c2Snapshots.push(c.extensions.length));

    // First broadcast reaches both.
    setListResult(ROUND_2);
    gateway.broadcastNotification!({
      method: "notifications/capabilities/changed",
      params: {},
    });
    await new Promise((r) => setImmediate(r));
    expect(c1Snapshots.length).toBeGreaterThanOrEqual(1);
    expect(c2Snapshots.length).toBeGreaterThanOrEqual(1);

    // Close c1. c2 remains connected.
    await c1.close();
    const c1Before = c1Snapshots.length;
    const c2Before = c2Snapshots.length;

    // Broadcast again — c1's sink is gone, c2 still hears it.
    setListResult(ROUND_1);
    gateway.broadcastNotification!({
      method: "notifications/capabilities/changed",
      params: {},
    });
    await new Promise((r) => setImmediate(r));

    // c1: no NEW capability-driven snapshot (the close-time empty
    // snapshot already fired synchronously, so an equal count means
    // the post-close broadcast did not reach the sink).
    expect(c1Snapshots.length).toBe(c1Before);
    // c2: got the refetch.
    expect(c2Snapshots.length).toBeGreaterThan(c2Before);
    expect(c2.capabilities.extensions).toHaveLength(1);

    await c2.close();
    await cleanup();
  });
});
