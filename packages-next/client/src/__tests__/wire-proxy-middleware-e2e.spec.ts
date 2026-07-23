/**
 * B2 slice 4 — the WIRE PROXY zero-client-code vertical + client MIDDLEWARE
 * universality, end-to-end over a real `createClient` + in-process transport.
 *
 * Proves, against the acceptance criteria:
 *   1. ZERO CLIENT CODE (guide §1): a `WireMethods` row + a gateway handler are
 *      the ONLY code — `session.testns.doThing({ … })` is typed and round-trips
 *      with NO client-package method written for it (the runtime Proxy
 *      synthesizes it; the mapped type is the compile guard).
 *   2. MIDDLEWARE UNIVERSALITY (§7): a `client.use(...)` registered ONCE is
 *      observed on BOTH the zero-code `testns/doThing` AND the registered
 *      handle's `knobs/set` — the derived-from-wire rule made checkable.
 *   3. PER-HANDLE SCOPE: `session.knobs.use(...)` fires only for the `knobs/*`
 *      namespace; unsubscribe restores.
 *
 * @see docs/proposals/v2/guide-wire-and-client.md §1, §7
 */

import { describe, expect, it } from "vitest";
import { createClient } from "@agentick/client-core-next";
import { inProcessTransport, withHandshake } from "@agentick/transport-in-process-next";
import { ErrorCode, type JsonRpcRequest, type JsonRpcResponse } from "@agentick/spec-next";
// Side-effect import: registers the `knobs` sub-handle + types `session.knobs`.
import "@agentick/knobs-next/client";

// The ONLY type definition for the `testns` vertical — the row. The client method
// falls out of it (guide §1). An adopter writes exactly this + the handler below.
declare module "@agentick/spec-next" {
  interface WireMethods {
    "testns/doThing": {
      params: { sessionId: string; count: number };
      result: { echoed: number };
    };
  }
}

/**
 * The "gateway handler" half of the vertical — a plain method switch. Records
 * every method it sees so the test can prove what actually reached the wire.
 */
function makeHandler(seen: string[]) {
  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    seen.push(req.method);
    switch (req.method) {
      case "testns/doThing": {
        const p = req.params as { count: number };
        return { jsonrpc: "2.0", id: req.id, result: { echoed: p.count } };
      }
      case "knobs/set":
        return { jsonrpc: "2.0", id: req.id, result: null };
      case "sub/subscribe":
        return { jsonrpc: "2.0", id: req.id, result: { subscriptionId: "sub-1" } };
      case "sub/unsubscribe":
        return { jsonrpc: "2.0", id: req.id, result: null };
      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: ErrorCode.MethodNotFound, message: `no such method: ${req.method}` },
        };
    }
  };
  return withHandshake(handler);
}

describe("B2 slice 4 — wire proxy vertical + middleware universality (e2e)", () => {
  it("a zero-client-code namespace method is typed and round-trips", async () => {
    const seen: string[] = [];
    const client = await createClient({
      transport: inProcessTransport({ handler: makeHandler(seen) }),
    });
    await client.connect();

    const session = client.session("s1");
    // No `testns` client code exists — only the row + handler. This is typed
    // (params-object minus sessionId; result `{ echoed }`) AND round-trips.
    const result = await session.testns.doThing({ count: 7 });
    expect(result).toEqual({ echoed: 7 });
    expect(seen).toContain("testns/doThing");

    await client.close();
  });

  it("client.use is observed on the zero-code method AND on knobs.set (universality)", async () => {
    const seen: string[] = [];
    const client = await createClient({
      transport: inProcessTransport({ handler: makeHandler(seen) }),
    });
    await client.connect();

    const observed: Array<{ method: string; sessionId?: string }> = [];
    const off = client.use(async (params, next, ctx) => {
      observed.push({ method: ctx.method, sessionId: ctx.sessionId });
      return next(params);
    });

    const session = client.session("s1");
    await session.testns.doThing({ count: 1 }); // wire-proxy derived
    await session.knobs.set("depth", 5); // registered handle, derived-identical sugar

    const methods = observed.map((o) => o.method);
    expect(methods).toContain("testns/doThing");
    expect(methods).toContain("knobs/set");
    // Addressing is lifted onto the ctx for both.
    expect(observed.find((o) => o.method === "knobs/set")?.sessionId).toBe("s1");
    expect(observed.find((o) => o.method === "testns/doThing")?.sessionId).toBe("s1");

    // Unsubscribe restores — a later call is not observed.
    off();
    observed.length = 0;
    await session.testns.doThing({ count: 2 });
    expect(observed).toHaveLength(0);

    await client.close();
  });

  it("session.knobs.use scopes to the knobs namespace only", async () => {
    const seen: string[] = [];
    const client = await createClient({
      transport: inProcessTransport({ handler: makeHandler(seen) }),
    });
    await client.connect();

    const scoped: string[] = [];
    const session = client.session("s1");
    const off = session.knobs.use(async (params, next, ctx) => {
      scoped.push(ctx.method);
      return next(params);
    });

    await session.knobs.set("depth", 3); // in-namespace → observed
    await session.testns.doThing({ count: 9 }); // out-of-namespace → NOT observed
    expect(scoped).toEqual(["knobs/set"]);

    off();
    await session.knobs.set("depth", 4);
    expect(scoped).toEqual(["knobs/set"]); // unchanged after unsubscribe

    await client.close();
  });
});
