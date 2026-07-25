import { createClient } from "@agentick/client-core";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec";
import { ErrorCode } from "@agentick/spec";
import { describe, expect, it } from "vitest";
import { inProcessTransport, withHandshake, type InProcessGatewayHandler } from "../index.js";

/**
 * Phase 33.B smoke — client → in-process transport → stub handler.
 *
 * Validates the typed `ClientProtocol` surface end-to-end: ping
 * roundtrip, RPC error propagation, method dispatch via handler
 * registry. The handler here is a simple switch; the full
 * GatewayHarness adapter lands separately.
 */
describe("inProcessTransport option validation", () => {
  it("requires exactly one of gateway / handler", () => {
    expect(() => inProcessTransport({})).toThrow(/gateway.*or.*handler/i);
    const handler: InProcessGatewayHandler = async () => ({ jsonrpc: "2.0", id: 1, result: null });
    const gateway = {} as never;
    expect(() => inProcessTransport({ handler, gateway })).toThrow(/not both/i);
  });
});

describe("client-next + in-process transport smoke", () => {
  function makeStubHandler(): {
    handler: InProcessGatewayHandler;
    lastSeen: { method?: string; params?: unknown };
  } {
    const lastSeen: { method?: string; params?: unknown } = {};
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      lastSeen.method = req.method;
      lastSeen.params = req.params;
      switch (req.method) {
        case "ping":
          return { jsonrpc: "2.0", id: req.id, result: {} };
        case "gateway/list_apps":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { apps: [{ id: "app-1" }, { id: "app-2" }] },
          };
        case "app/list_sessions":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              sessions: [
                {
                  id: "sess-a",
                  status: "active",
                  metadata: {},
                  createdAt: 1717_000_000,
                },
              ],
            },
          };
        case "session/abort":
          return { jsonrpc: "2.0", id: req.id, result: null };
        default:
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: ErrorCode.MethodNotFound,
              message: `no such method: ${req.method}`,
            },
          };
      }
    };
    return { handler, lastSeen };
  }

  it("connects + dispatches a ping", async () => {
    const { handler } = makeStubHandler();
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();
    expect(client.state).toBe("open");
    await client.request("ping", {});
    await client.close();
    expect(client.state).toBe("closed");
  });

  it("gateway.listApps returns typed apps array", async () => {
    const { handler } = makeStubHandler();
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();
    const result = await client.gateway().listApps();
    expect(result.apps).toHaveLength(2);
    expect(result.apps[0]?.id).toBe("app-1");
    await client.close();
  });

  it("app(id).listSessions narrows to SessionEntry[]", async () => {
    const { handler } = makeStubHandler();
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();
    const sessions = await client.app("app-1").listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("sess-a");
    expect(sessions[0]?.status).toBe("active");
    await client.close();
  });

  it("session.abort dispatches with the correct params", async () => {
    const { handler, lastSeen } = makeStubHandler();
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();
    await client.session("sess-a").abort("test-reason");
    expect(lastSeen.method).toBe("session/abort");
    expect(lastSeen.params).toEqual({ sessionId: "sess-a", reason: "test-reason" });
    await client.close();
  });

  it("RPC errors propagate as TransportError of kind 'rpc'", async () => {
    const { handler } = makeStubHandler();
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();
    await expect(client.request("gateway/get_app", { appId: "no-such" })).rejects.toMatchObject({
      kind: "rpc",
      error: { code: ErrorCode.MethodNotFound },
    });
    await client.close();
  });

  it("wireParity: true roundtrips frames through JSON.parse(stringify)", async () => {
    const { handler } = makeStubHandler();
    const client = await createClient({
      transport: inProcessTransport({ handler, wireParity: true }),
    });
    await client.connect();
    const result = await client.gateway().listApps();
    expect(result.apps).toHaveLength(2);
    await client.close();
  });

  it("request rejects before connect", async () => {
    const { handler } = makeStubHandler();
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await expect(client.request("ping", {})).rejects.toMatchObject({
      kind: "connection",
    });
  });

  it("extensions: request middleware sees the call before the transport", async () => {
    const { handler } = makeStubHandler();
    const observed: string[] = [];
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [
        {
          name: "observer",
          async request(req, next) {
            observed.push(`before:${req.method}`);
            const r = await next(req);
            observed.push(`after:${req.method}`);
            return r;
          },
        },
      ],
    });
    await client.connect();
    // Filter to just the test's method-of-interest — connect() runs
    // the initialize + _extensions/list handshake, which middleware
    // ALSO sees (correctly: it's an all-request pipeline).
    observed.length = 0;
    await client.request("ping", {});
    expect(observed).toEqual(["before:ping", "after:ping"]);
    await client.close();
  });

  it("extensions: install() registers a namespace visible on the client", async () => {
    const { handler } = makeStubHandler();
    type CounterApi = { value(): number; increment(): void };
    let counter = 0;
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [
        {
          name: "counter",
          install(installer) {
            installer.registerNamespace<"counter", CounterApi>("counter", {
              value: () => counter,
              increment: () => {
                counter++;
              },
            });
          },
        },
      ],
    });
    await client.connect();
    const ns = (client as unknown as { counter: CounterApi }).counter;
    expect(ns.value()).toBe(0);
    ns.increment();
    ns.increment();
    expect(ns.value()).toBe(2);
    await client.close();
  });

  it("extensions: install onClose handlers fire in LIFO order on close()", async () => {
    const { handler } = makeStubHandler();
    const order: string[] = [];
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [
        {
          name: "first",
          install(installer) {
            installer.onClose(() => {
              order.push("first");
            });
          },
        },
        {
          name: "second",
          install(installer) {
            installer.onClose(() => {
              order.push("second");
            });
          },
        },
      ],
    });
    await client.connect();
    await client.close();
    expect(order).toEqual(["second", "first"]);
  });
});
