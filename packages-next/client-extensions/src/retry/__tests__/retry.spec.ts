/**
 * Retry middleware behavior — best-practice prior-art:
 *   - AWS SDK retry strategy (exponential backoff, full jitter, max attempts)
 *   - axios-retry / got-retry (configurable predicate, per-method override)
 *   - HTTP idempotency-key header (RFC 7231 §4.2.2, Stripe, GCP):
 *     non-idempotent methods get a key so server-side dedup is possible.
 */

import { describe, expect, it } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec-next";
import { createClient } from "@agentick/client-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";

import {
  retry,
  defaultIsRetryable,
  defaultIdempotencyKey,
  generateIdempotencyKey,
} from "../index.js";

describe("retry middleware", () => {
  it("retries on transport-layer errors and ultimately succeeds", async () => {
    let attempts = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      attempts++;
      if (attempts < 3) {
        throw { kind: "connection", message: "ECONNREFUSED" };
      }
      return { jsonrpc: "2.0", id: req.id, result: { attempts } };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({ initialDelayMs: 1 })],
    });
    await client.connect();
    const result = await client.request("ping", {});
    expect((result as { attempts: number }).attempts).toBe(3);
    await client.close();
  });

  it("stops at maxAttempts and re-throws the last error", async () => {
    let attempts = 0;
    const handler = async (): Promise<JsonRpcResponse> => {
      attempts++;
      throw { kind: "connection", message: "always fail" };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({ maxAttempts: 3, initialDelayMs: 1 })],
    });
    await client.connect();
    await expect(client.request("ping", {})).rejects.toMatchObject({ kind: "connection" });
    expect(attempts).toBe(3);
    await client.close();
  });

  it("does NOT retry on non-retryable errors (e.g. auth)", async () => {
    let attempts = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      attempts++;
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32001 /* AuthRequired */, message: "no" },
      };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({ maxAttempts: 5, initialDelayMs: 1 })],
    });
    await client.connect();
    await expect(client.request("ping", {})).rejects.toMatchObject({
      kind: "rpc",
      error: { code: -32001 },
    });
    expect(attempts).toBe(1);
    await client.close();
  });

  it("retries on RPC errors with retryable codes (RateLimited, Backpressure, InternalError)", async () => {
    for (const code of [-32603, -32040, -32050]) {
      let attempts = 0;
      const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
        attempts++;
        if (attempts < 2) {
          return { jsonrpc: "2.0", id: req.id, error: { code, message: "transient" } };
        }
        return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
      };
      const client = await createClient({
        transport: inProcessTransport({ handler }),
        extensions: [retry({ initialDelayMs: 1 })],
      });
      await client.connect();
      await client.request("ping", {});
      expect(attempts).toBe(2);
      await client.close();
    }
  });

  it("attaches an idempotency-key on non-idempotent methods (session/send)", async () => {
    let seenKey: unknown;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const params = req.params as { _meta?: { idempotencyKey?: unknown } };
      seenKey = params._meta?.idempotencyKey;
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          executionId: "e",
          finalCursor: { value: 0 },
          result: {} as unknown,
        },
      };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({})],
    });
    await client.connect();
    await client.send("sess-1", { messages: [{ role: "user", content: "hi" }] }).result;
    expect(typeof seenKey).toBe("string");
    expect((seenKey as string).length).toBeGreaterThan(0);
    await client.close();
  });

  it("does NOT attach idempotency-key on naturally-idempotent methods (gateway/listApps)", async () => {
    let seenMeta: unknown;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const params = req.params as { _meta?: unknown };
      seenMeta = params._meta;
      return { jsonrpc: "2.0", id: req.id, result: { apps: [] } };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({})],
    });
    await client.connect();
    await client.gateway().listApps();
    expect(seenMeta).toBeUndefined();
    await client.close();
  });

  it("preserves the SAME idempotency-key across retries of the same logical call", async () => {
    const seen: unknown[] = [];
    let attempts = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      attempts++;
      const params = req.params as { _meta?: { idempotencyKey?: string } };
      seen.push(params._meta?.idempotencyKey);
      if (attempts < 3) {
        throw { kind: "connection", message: "fail" };
      }
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          executionId: "e",
          finalCursor: { value: 0 },
          result: {} as unknown,
        },
      };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({ initialDelayMs: 1 })],
    });
    await client.connect();
    await client.send("sess-x", { messages: [{ role: "user", content: "hi" }] }).result;
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    await client.close();
  });

  it("respects per-method overrides", async () => {
    let pingAttempts = 0;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      if (req.method === "ping") {
        pingAttempts++;
        throw { kind: "connection", message: "fail" };
      }
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [
        retry({
          maxAttempts: 3,
          initialDelayMs: 1,
          perMethod: { ping: { maxAttempts: 1 } },
        }),
      ],
    });
    await client.connect();
    await expect(client.request("ping", {})).rejects.toBeDefined();
    expect(pingAttempts).toBe(1);
    await client.close();
  });

  it("aborts immediately if the AbortSignal fires during backoff", async () => {
    const handler = async (): Promise<JsonRpcResponse> => {
      throw { kind: "connection", message: "fail" };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler }),
      extensions: [retry({ maxAttempts: 5, initialDelayMs: 1000 })],
    });
    await client.connect();
    const controller = new AbortController();
    const promise = client.request("ping", {}, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ kind: "cancelled" });
    await client.close();
  });
});

describe("defaultIsRetryable predicate", () => {
  it("retries connection / closed / timeout", () => {
    expect(defaultIsRetryable({ kind: "connection" })).toBe(true);
    expect(defaultIsRetryable({ kind: "closed" })).toBe(true);
    expect(defaultIsRetryable({ kind: "timeout" })).toBe(true);
  });

  it("retries rpc codes for transient backend pressure", () => {
    expect(defaultIsRetryable({ kind: "rpc", error: { code: -32603, message: "" } })).toBe(true);
    expect(defaultIsRetryable({ kind: "rpc", error: { code: -32040, message: "" } })).toBe(true);
    expect(defaultIsRetryable({ kind: "rpc", error: { code: -32050, message: "" } })).toBe(true);
  });

  it("does NOT retry auth / forbidden / cancelled / not-found", () => {
    expect(defaultIsRetryable({ kind: "rpc", error: { code: -32001, message: "" } })).toBe(false);
    expect(defaultIsRetryable({ kind: "rpc", error: { code: -32003, message: "" } })).toBe(false);
    expect(defaultIsRetryable({ kind: "cancelled" })).toBe(false);
    expect(defaultIsRetryable({ kind: "rpc", error: { code: -32010, message: "" } })).toBe(false);
  });

  it("rejects non-objects defensively", () => {
    expect(defaultIsRetryable(null)).toBe(false);
    expect(defaultIsRetryable("boom")).toBe(false);
    expect(defaultIsRetryable(42)).toBe(false);
  });
});

describe("defaultIdempotencyKey", () => {
  it("emits keys for non-idempotent methods", () => {
    expect(defaultIdempotencyKey("session/send")).toBeDefined();
    expect(defaultIdempotencyKey("app/runOnce")).toBeDefined();
    expect(defaultIdempotencyKey("session/dispatch")).toBeDefined();
    expect(defaultIdempotencyKey("session/queue")).toBeDefined();
  });

  it("does NOT emit keys for naturally-idempotent methods", () => {
    expect(defaultIdempotencyKey("gateway/listApps")).toBeUndefined();
    expect(defaultIdempotencyKey("app/listSessions")).toBeUndefined();
    expect(defaultIdempotencyKey("ping")).toBeUndefined();
  });
});

describe("generateIdempotencyKey", () => {
  it("returns a non-empty unique string", () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a.length).toBeGreaterThan(8);
    expect(a).not.toBe(b);
  });
});
