/**
 * Client-side elicitation surface — end-to-end smoke.
 *
 * Verifies the client/server contract introduced for "client speaks
 * elicitation":
 *
 *   1. `respondToElicitation(...)` (the raw-wire escape hatch) routes through
 *      the `session/respond_to_elicitation` wire method.
 *   2. `session.elicitations` is a `ClientHandle` — `list()`/`get(id)`/
 *      `subscribe(cb)` + `respond(id, body)` — with NO `AsyncIterable`.
 *
 * The dispatcher's real routing is exercised against a stub
 * SessionHarnessProtocol with an `elicitation` slot (the slot is
 * added by the elicitation package's module augmentation; this test
 * file imports that to load the augment).
 */

import "@agentick/elicitation-next";
// ADR 87 — contributes `session.elicitations` / `.elicitations.respond()`.
import "@agentick/elicitation-next/client";
import { respondToElicitation } from "@agentick/elicitation-next/client";

import { createClient } from "@agentick/client-core-next";
import type {
  ElicitationResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionRespondToElicitationParams,
} from "@agentick/spec-next";
import { ErrorCode } from "@agentick/spec-next";
import { describe, expect, it } from "vitest";

import { inProcessTransport } from "../index.js";

describe("client elicitation surface — wire method", () => {
  it("session.respondToElicitation issues session/respond_to_elicitation with the correct params", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      seen.push({ method: req.method, params: req.params });
      if (req.method === "session/respond_to_elicitation") {
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

    await respondToElicitation(client, "sess-1", {
      correlationId: "req:abc",
      outcome: "accepted",
      value: { approved: true },
    });

    const params = seen.find((s) => s.method === "session/respond_to_elicitation")
      ?.params as SessionRespondToElicitationParams;
    expect(params).toBeDefined();
    expect(params.sessionId).toBe("sess-1");
    expect(params.correlationId).toBe("req:abc");
    expect(params.outcome).toBe("accepted");
    expect(params.value).toEqual({ approved: true });

    await client.close();
  });

  it("declined and cancelled outcomes pass reason through verbatim", async () => {
    const seen: Array<SessionRespondToElicitationParams> = [];
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      if (req.method === "session/respond_to_elicitation") {
        seen.push(req.params as SessionRespondToElicitationParams);
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
    await respondToElicitation(client, "sess-2", {
      correlationId: "req:1",
      outcome: "declined",
      reason: "user clicked Deny",
    });
    await respondToElicitation(client, "sess-2", {
      correlationId: "req:2",
      outcome: "cancelled",
      reason: "modal dismissed",
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.outcome).toBe("declined");
    expect(seen[0]!.reason).toBe("user clicked Deny");
    expect(seen[1]!.outcome).toBe("cancelled");
    expect(seen[1]!.reason).toBe("modal dismissed");

    await client.close();
  });
});

describe("client elicitation surface — type checks", () => {
  it("the elicitations handle exposes the ClientHandle contract (list/get/subscribe + respond)", async () => {
    // The structural test — verify the SessionHandle slot is a ClientHandle
    // (no AsyncIterable). The subscription-driven flow is exercised by the
    // gateway integration test (the in-process stub handler doesn't push
    // subscription events without the GatewayHarness adapter).
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      if (req.method === "session/respond_to_elicitation") {
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
    const sess = client.session("sess-3");

    // The resource handle on the ClientHandle contract: Enumerable read surface
    // + Respondable write + the store-contract subscribe — NO AsyncIterable.
    expect(typeof sess.elicitations.list).toBe("function"); // Enumerable read
    expect(typeof sess.elicitations.get).toBe("function"); // by-id read
    expect(typeof sess.elicitations.subscribe).toBe("function"); // store contract
    expect(typeof sess.elicitations.respond).toBe("function"); // Respondable write
    expect(
      (sess.elicitations as unknown as Record<symbol, unknown>)[Symbol.asyncIterator],
    ).toBeUndefined(); // no handle is iterable

    // The raw-wire escape hatch issues the reply (no pending ask needed —
    // the in-process stub doesn't push subscription events).
    await expect(
      respondToElicitation(client, "sess-3", {
        correlationId: "req:any",
        outcome: "accepted",
        value: { approved: true } satisfies Record<string, unknown>,
      }),
    ).resolves.toBeUndefined();

    // Verify the ElicitationResponse type compiles correctly (no
    // assertion needed — TS will fail at build if the type shape
    // drifts).
    const _typeCheck: ElicitationResponse = {
      correlationId: "x",
      outcome: "declined",
      reason: "test",
    };
    void _typeCheck;

    await client.close();
  });
});
