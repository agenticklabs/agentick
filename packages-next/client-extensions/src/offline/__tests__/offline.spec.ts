/**
 * Offline queue middleware — per-method policy, FIFO replay on open,
 * fail-fast / never / queue branches, namespace exposure.
 */

import { describe, expect, it } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec-next";
import { createClient } from "@agentick/client-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";

import { offline, InMemoryOfflineStore } from "../index.js";

describe("offline middleware", () => {
  it("default policy: fail-fast on a closed transport", async () => {
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [offline()],
    });
    // Don't connect — transport state is "idle".
    await expect(client.request("ping", {})).rejects.toMatchObject({
      kind: "connection",
    });
    await client.close();
  });

  it("queue policy: buffers requests + drains FIFO on connect", async () => {
    const observed: string[] = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      observed.push(`${req.method}:${JSON.stringify(req.params)}`);
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    const store = new InMemoryOfflineStore();
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [offline({ methods: { ping: "queue" }, store })],
    });

    // Without connect() — should queue
    await client.request("ping", { call: 1 } as never);
    await client.request("ping", { call: 2 } as never);
    expect(await store.size()).toBe(2);
    expect(observed).toHaveLength(0);

    await client.connect();
    // Allow drain to flush
    await new Promise((r) => setTimeout(r, 30));

    expect(observed).toEqual(['ping:{"call":1}', 'ping:{"call":2}']);
    expect(await store.size()).toBe(0);

    await client.close();
  });

  it("'never' policy passes through (transport-level error surfaces)", async () => {
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [offline({ methods: { ping: "never" } })],
    });

    // No connect — transport rejects with kind: "connection"
    await expect(client.request("ping", {})).rejects.toMatchObject({
      kind: "connection",
    });
    await client.close();
  });

  it("exposes pending() / size() / flush() / clear() via client.offline namespace", async () => {
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [offline({ methods: { ping: "queue" } })],
    });

    await client.request("ping", { a: 1 } as never);
    await client.request("ping", { b: 2 } as never);

    expect(await client.offline.size()).toBe(2);
    const pending = await client.offline.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.method).toBe("ping");

    await client.offline.clear();
    expect(await client.offline.size()).toBe(0);

    await client.close();
  });

  it("onReplayError fires when a replayed request fails", async () => {
    const errors: unknown[] = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32011, message: "fail" },
    });
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [
        offline({
          methods: { ping: "queue" },
          onReplayError: (_req, err) => errors.push(err),
        }),
      ],
    });
    await client.request("ping", {});
    await client.connect();
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    expect((errors[0] as { kind: string }).kind).toBe("rpc");
    await client.close();
  });

  it("InMemoryOfflineStore enforces maxSize", async () => {
    const store = new InMemoryOfflineStore(2);
    await store.enqueue("ping", { a: 1 });
    await store.enqueue("ping", { a: 2 });
    await expect(store.enqueue("ping", { a: 3 })).rejects.toMatchObject({
      kind: "backpressure",
    });
  });

  it("InMemoryOfflineStore drain returns and clears", async () => {
    const store = new InMemoryOfflineStore();
    await store.enqueue("a", {});
    await store.enqueue("b", {});
    const drained = await store.drain();
    expect(drained.map((d) => d.method)).toEqual(["a", "b"]);
    expect(await store.size()).toBe(0);
  });
});
