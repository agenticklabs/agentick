/**
 * `client.send(sessionId, input)` — Vercel-style shortcut.
 *
 * README claims `client.send(sessionId, input)` is equivalent to
 * `client.session(sessionId).send(input)`. Verifies both forms produce
 * the same RPC params.
 */

import { createClient } from "@agentick/client-core-next";
import { describe, expect, it } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec-next";

import { inProcessTransport, withHandshake, type InProcessGatewayHandler } from "../index.js";

describe("client.send(sessionId, input) shortcut", () => {
  function makeHandler(): {
    handler: InProcessGatewayHandler;
    seen: Array<{ method: string; params: unknown }>;
  } {
    const seen: Array<{ method: string; params: unknown }> = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      seen.push({ method: req.method, params: req.params });
      if (req.method === "session/send") {
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            executionId: "exec-1",
            finalCursor: { value: 0 },
            result: {
              response: "",
              output: [],
              toolResults: [],
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              stopReason: "end" as const,
              ticks: 1,
              executionId: "exec-1",
            },
          },
        };
      }
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    return { handler, seen };
  }

  it("emits the same `session/send` RPC as client.session(id).send(input)", async () => {
    const { handler: handlerA, seen: seenA } = makeHandler();
    const clientA = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handlerA) }),
    });
    await clientA.connect();
    await clientA.send("sess-x", { messages: [{ role: "user", content: "hi" }] }).result;
    await clientA.close();

    const { handler: handlerB, seen: seenB } = makeHandler();
    const clientB = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handlerB) }),
    });
    await clientB.connect();
    await clientB.session("sess-x").send({ messages: [{ role: "user", content: "hi" }] }).result;
    await clientB.close();

    // The wire RPC issued must match in both cases (apart from the
    // adopter-allocated progress token which is non-deterministic).
    const sendA = seenA.find((s) => s.method === "session/send");
    const sendB = seenB.find((s) => s.method === "session/send");
    expect(sendA).toBeDefined();
    expect(sendB).toBeDefined();

    const stripProgress = (params: unknown): unknown => {
      const p = params as { _meta?: unknown; [k: string]: unknown };
      const { _meta: _omit, ...rest } = p;
      return rest;
    };
    expect(stripProgress(sendA!.params)).toEqual(stripProgress(sendB!.params));
  });

  it("returns the canonical SessionExecutionHandle shape", async () => {
    const { handler } = makeHandler();
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
    });
    await client.connect();
    const handle = client.send("sess-x", { messages: [{ role: "user", content: "hi" }] });
    expect(typeof handle.abort).toBe("function");
    expect(handle.result).toBeInstanceOf(Promise);
    expect(typeof handle.events).toBe("function");
    expect(typeof handle.events()[Symbol.asyncIterator]).toBe("function");
    await handle.result;
    await client.close();
  });
});
