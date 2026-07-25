/**
 * Client-side client-tool WRITE verbs — end-to-end smoke.
 *
 * Verifies the stage-2 client/server contract for "client declares its tools +
 * relays a result", now on the `session.clientToolCalls` handle (B2 slice 3):
 *
 *   1. `session.clientToolCalls.set(declarations)` routes through the
 *      `session/set_client_tools` wire method with the serializable set (the
 *      declarative whole-slice replace).
 *   2. `respondToToolCall(client, sessionId, correlationId, result)` (the by-id
 *      escape hatch) routes through `session/respond_to_tool_call`.
 *
 * Mirrors `elicitation.spec.ts`: the dispatcher's real routing is exercised
 * against a stub JSON-RPC handler; the full suspend-resume-through-the-loop
 * flow is covered by the tool-executor harness tests (`client-tools.spec.ts`).
 */

// ADR 87 — contributes `session.clientToolCalls` (the folded handle).
import "@agentick/tool-executor/client";
import { respondToToolCall } from "@agentick/tool-executor/client";

import { createClient } from "@agentick/client-core";
import type {
  ClientToolDeclaration,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionRespondToToolCallParams,
  SessionSetClientToolsParams,
} from "@agentick/spec";
import { ErrorCode } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { inProcessTransport } from "../index.js";

const DECL: ClientToolDeclaration = {
  name: "get_weather",
  description: "client-handled weather lookup",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  annotations: { requiresResponse: true },
};

describe("client client-tool surface — wire methods", () => {
  it("clientToolCalls.set issues session/set_client_tools with the declaration set", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      seen.push({ method: req.method, params: req.params });
      if (req.method === "session/set_client_tools") {
        return { jsonrpc: "2.0", id: req.id, result: { count: 1 } };
      }
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: ErrorCode.MethodNotFound, message: req.method },
      };
    };

    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();

    const ack = await client.session("sess-1").clientToolCalls.set([DECL]);
    expect(ack).toEqual({ count: 1 });

    const params = seen.find((s) => s.method === "session/set_client_tools")
      ?.params as SessionSetClientToolsParams;
    expect(params).toBeDefined();
    expect(params.sessionId).toBe("sess-1");
    expect(params.declarations).toEqual([DECL]);

    await client.close();
  });

  it("clientToolCalls.set([]) issues the verb with an empty set (clear the slice)", async () => {
    const seen: Array<SessionSetClientToolsParams> = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      if (req.method === "session/set_client_tools") {
        seen.push(req.params as SessionSetClientToolsParams);
        return { jsonrpc: "2.0", id: req.id, result: { count: 0 } };
      }
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: ErrorCode.MethodNotFound, message: req.method },
      };
    };

    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();

    const ack = await client.session("sess-clear").clientToolCalls.set([]);
    expect(ack).toEqual({ count: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.declarations).toEqual([]);

    await client.close();
  });

  it("respondToToolCall issues session/respond_to_tool_call with correlationId + result", async () => {
    const seen: Array<SessionRespondToToolCallParams> = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      if (req.method === "session/respond_to_tool_call") {
        seen.push(req.params as SessionRespondToToolCallParams);
        return { jsonrpc: "2.0", id: req.id, result: null };
      }
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: ErrorCode.MethodNotFound, message: req.method },
      };
    };

    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();

    await expect(
      respondToToolCall(client, "sess-2", "corr:abc", [{ type: "text", text: "sunny, 24C" }]),
    ).resolves.toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.sessionId).toBe("sess-2");
    expect(seen[0]!.correlationId).toBe("corr:abc");
    expect(seen[0]!.result).toEqual([{ type: "text", text: "sunny, 24C" }]);

    await client.close();
  });

  it("exposes the folded verbs on the clientToolCalls handle", async () => {
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: ErrorCode.MethodNotFound, message: req.method },
    });
    const client = await createClient({ transport: inProcessTransport({ handler }) });
    await client.connect();
    const calls = client.session("sess-3").clientToolCalls;
    expect(typeof calls.set).toBe("function");
    expect(typeof calls.route).toBe("function");
    expect(typeof calls.confirm).toBe("function");
    expect(typeof calls.respond).toBe("function");
    calls.close();
    await client.close();
  });
});
