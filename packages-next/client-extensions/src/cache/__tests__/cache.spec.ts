/**
 * Cache middleware — method-allowlist, TTL, LRU, key derivation,
 * _meta strip-from-key (so progress-token and idempotency-key
 * variations don't poison the cache lookup).
 */

import { describe, expect, it, vi } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec-next";
import { createClient } from "@agentick/client-core-next";
import { inProcessTransport, withHandshake } from "@agentick/transport-in-process-next";

import { cache, LruCacheStore } from "../index.js";

describe("cache middleware", () => {
  it("only caches methods explicitly opted in", async () => {
    let calls = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      calls++;
      if (req.method === "gateway/list_apps") {
        return { jsonrpc: "2.0", id: req.id, result: { apps: [{ id: "a" }] } };
      }
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [cache({ methods: { "gateway/list_apps": { ttlMs: 60_000 } } })],
    });
    await client.connect();
    calls = 0;

    await client.gateway().listApps();
    await client.gateway().listApps();
    await client.gateway().listApps();
    expect(calls).toBe(1);

    // ping is NOT in the allowlist — every call hits the handler
    await client.request("ping", {});
    await client.request("ping", {});
    expect(calls).toBe(3);

    await client.close();
  });

  it("respects TTL — expired entries refetch", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      calls++;
      return { jsonrpc: "2.0", id: req.id, result: { apps: [] } };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [cache({ methods: { "gateway/list_apps": { ttlMs: 1000 } } })],
    });
    await client.connect();
    calls = 0;

    await client.gateway().listApps();
    expect(calls).toBe(1);

    vi.advanceTimersByTime(500);
    await client.gateway().listApps();
    expect(calls).toBe(1); // still cached

    vi.advanceTimersByTime(600);
    await client.gateway().listApps();
    expect(calls).toBe(2); // TTL expired, refetched

    vi.useRealTimers();
    await client.close();
  });

  it("keys differentiate by params — different appIds get different cache slots", async () => {
    let calls = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      calls++;
      const params = req.params as { appId: string };
      return { jsonrpc: "2.0", id: req.id, result: { id: params.appId } };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [cache({ methods: { "gateway/get_app": { ttlMs: 60_000 } } })],
    });
    await client.connect();
    calls = 0;

    await client.gateway().getApp("a");
    await client.gateway().getApp("a");
    await client.gateway().getApp("b");
    await client.gateway().getApp("b");
    expect(calls).toBe(2);
    await client.close();
  });

  it("strips _meta before keying (progress token / trace context don't poison)", async () => {
    let calls = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      calls++;
      return { jsonrpc: "2.0", id: req.id, result: { apps: [] } };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [cache({ methods: { "gateway/list_apps": { ttlMs: 60_000 } } })],
    });
    await client.connect();
    calls = 0;

    // Two requests with same logical params but different `_meta`
    // entries — should be a cache hit on the second.
    await client.request("gateway/list_apps", { _meta: { traceparent: "00-a-b-01" } } as never);
    await client.request("gateway/list_apps", { _meta: { traceparent: "00-c-d-01" } } as never);
    expect(calls).toBe(1);
    await client.close();
  });

  it("LruCacheStore evicts least-recently-used when over capacity", () => {
    const store = new LruCacheStore(3);
    store.set("a", { value: 1, expiresAt: Infinity });
    store.set("b", { value: 2, expiresAt: Infinity });
    store.set("c", { value: 3, expiresAt: Infinity });
    expect(store.size()).toBe(3);

    // Touch "a" — moves it to most-recent
    store.get("a");

    // Add "d" — capacity exceeded; "b" (now least-recently-used) evicts
    store.set("d", { value: 4, expiresAt: Infinity });
    expect(store.size()).toBe(3);
    expect(store.get("a")?.value).toBe(1);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")?.value).toBe(3);
    expect(store.get("d")?.value).toBe(4);
  });

  it("custom key fn overrides default", async () => {
    let calls = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      calls++;
      return { jsonrpc: "2.0", id: req.id, result: { id: "x" } };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [
        cache({
          methods: {
            "gateway/get_app": {
              ttlMs: 60_000,
              key: (params) => (params as { appId: string }).appId,
            },
          },
        }),
      ],
    });
    await client.connect();
    calls = 0;

    await client.gateway().getApp("a");
    await client.gateway().getApp("a");
    expect(calls).toBe(1);
    await client.close();
  });

  it("adopter-supplied store is used end-to-end", async () => {
    const store = new LruCacheStore(10);
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: { ok: true },
    });
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [
        cache({
          methods: { "gateway/list_apps": { ttlMs: 60_000 } },
          store,
        }),
      ],
    });
    await client.connect();
    expect(store.size()).toBe(0);
    await client.gateway().listApps();
    expect(store.size()).toBe(1);
    await client.close();
  });
});
