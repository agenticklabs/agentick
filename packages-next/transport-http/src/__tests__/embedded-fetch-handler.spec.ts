/**
 * The EMBEDDED gateway entry door (C4.5) — driven through the ACTUAL
 * `httpFetchHandler` by constructing web-standard `Request` objects and
 * asserting the `Response`. No Node `http.Server`, no port: this is the
 * fetch-native surface an adopter mounts inside Hono / Nitro / Next.js.
 *
 * Covers the six acceptance proofs: identity round-trip, identity
 * short-circuit, fail-closed default + host-managed opt-out, scope
 * enforcement through the existing authorizeDispatch path, the subscription
 * stream, and a compile-only mount example.
 */

import { describe, expect, it } from "vitest";
import { createGateway, permissiveAuthorizer, staticAuthorizer } from "@agentick/gateway-next";
import { claimsAuthorizer } from "@agentick/gateway-next";
import { spyAuthorizer } from "@agentick/transport-next/testing";
import { waitFor } from "@agentick/utils-next/testing";

import { httpFetchHandler, type FetchHandler, type Identity } from "../server/fetch-handler.js";

const URL_BASE = "http://127.0.0.1/agentick";

/** Build a POST Request carrying a JSON-RPC frame. Host is loopback so the
 *  default web-security host allow-list admits it. */
function rpc(method: string, params: unknown = {}, sessionId?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Host: "127.0.0.1",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return new Request(URL_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function body(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("embedded fetch handler — identity round-trip (proof 1)", () => {
  it("a stubbed identity fn supplies a principal; dispatch sees THAT principal", async () => {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const handler = httpFetchHandler(gateway, {
      csrf: false,
      identity: () => ({ principal: "alice", scopes: ["gateway:list_apps"] }),
    });

    const res = await handler(rpc("gateway/list_apps"));
    const payload = await body(res);

    expect(res.status).toBe(200);
    expect(payload.result).toBeDefined();
    expect(payload.error).toBeUndefined();
    // The authorizer at the dispatch choke point saw the identity fn's principal.
    expect(spy.seen).toContain("alice");

    await gateway.close();
  });
});

describe("embedded fetch handler — identity short-circuit (proof 2)", () => {
  it("identity fn returning a Response is delivered verbatim; nothing reaches dispatch", async () => {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const rejection = new Response(JSON.stringify({ why: "host said no" }), {
      status: 401,
      headers: { "X-Host-Auth": "denied" },
    });
    const handler = httpFetchHandler(gateway, { csrf: false, identity: () => rejection });

    const res = await handler(rpc("gateway/list_apps"));

    expect(res.status).toBe(401);
    expect(res.headers.get("X-Host-Auth")).toBe("denied");
    expect((await body(res)).why).toBe("host said no");
    // The choke point was never reached — the host's own rejection stopped it.
    expect(spy.seen).toHaveLength(0);

    await gateway.close();
  });
});

describe("embedded fetch handler — fail-closed default + host-managed opt-out (proof 3)", () => {
  it("no identity fn → refused with a typed error (fail closed)", async () => {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const handler = httpFetchHandler(gateway, { csrf: false });

    const res = await handler(rpc("gateway/list_apps"));
    const payload = await body(res);

    expect(res.status).toBe(401);
    expect(payload.error._tag).toBe("IngressAuthRequired");
    expect(spy.seen).toHaveLength(0);

    await gateway.close();
  });

  it('security: "host-managed" with no identity fn → proceeds as the local pole', async () => {
    const spy = spyAuthorizer();
    const gateway = await createGateway({ authorizer: spy.authorizer });
    const handler = httpFetchHandler(gateway, { security: "host-managed" });

    const res = await handler(rpc("gateway/list_apps"));
    const payload = await body(res);

    expect(res.status).toBe(200);
    expect(payload.result).toBeDefined();
    // Local pole: dispatch ran with no principal.
    expect(spy.seen).toContain(undefined);

    await gateway.close();
  });
});

describe("embedded fetch handler — scopes flow through authorizeDispatch (proof 4)", () => {
  it("in-scope method is allowed; out-of-scope method is DENIED by the existing choke point", async () => {
    const gateway = await createGateway({ authorizer: claimsAuthorizer() });

    const inScope = httpFetchHandler(gateway, {
      csrf: false,
      identity: () => ({ principal: "alice", scopes: ["gateway:list_apps"] }),
    });
    const allowed = await body(await inScope(rpc("gateway/list_apps")));
    expect(allowed.result).toBeDefined();
    expect(allowed.error).toBeUndefined();

    const outOfScope = httpFetchHandler(gateway, {
      csrf: false,
      identity: () => ({ principal: "alice", scopes: ["session:send"] }),
    });
    const denied = await body(await outOfScope(rpc("gateway/list_apps")));
    expect(denied.result).toBeUndefined();
    // WireRpcError.forbidden → JSON-RPC Forbidden (-32003).
    expect(denied.error.code).toBe(-32003);

    await gateway.close();
  });
});

describe("embedded fetch handler — subscription over the handler surface (proof 5)", () => {
  it("GET SSE + sub/subscribe delivers at least one frame, then tears down on cancel", async () => {
    const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
    const handler = httpFetchHandler(gateway, {
      csrf: false,
      identity: () => ({ principal: "alice", scopes: ["*"] }),
    });

    // Open the persistent SSE notification stream.
    const getRes = await handler(
      new Request(URL_BASE, {
        method: "GET",
        headers: { Accept: "text/event-stream", Host: "127.0.0.1" },
      }),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Type")).toContain("text/event-stream");
    const sessionId = getRes.headers.get("Mcp-Session-Id")!;
    expect(sessionId).toBeTruthy();

    // Drain the stream in the background, flagging when a subscription event frame lands.
    const reader = getRes.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    let sawEvent = false;
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (acc.includes("notifications/subscription/event")) sawEvent = true;
        }
      } catch {
        /* cancelled */
      }
    })();

    // Subscribe on the SAME session id (gateway scope), then emit gateway events.
    const subRes = await body(
      await handler(rpc("sub/subscribe", { scope: { kind: "gateway" } }, sessionId)),
    );
    expect(subRes.result.subscriptionId).toBeTruthy();

    // Re-emit each poll until the frame is observed (absorbs the subscribe→bus race).
    await waitFor(
      () => {
        gateway.emitCapabilitiesChanged();
        return sawEvent;
      },
      { timeoutMs: 3_000, pollMs: 25, description: "subscription event frame" },
    );
    expect(sawEvent).toBe(true);

    // Teardown: cancelling the reader detaches the stream (heartbeat cleared).
    await reader.cancel();
    await pump;

    await gateway.close();
  });
});

describe("embedded fetch handler — web-security stays ON by default when embedded", () => {
  it("a cross-site request is rejected (security applies MORE, not less, when embedded)", async () => {
    const gateway = await createGateway({ authorizer: spyAuthorizer().authorizer });
    const handler = httpFetchHandler(gateway, {
      identity: () => ({ principal: "alice" }),
    });

    const res = await handler(
      new Request(URL_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "127.0.0.1",
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway/list_apps", params: {} }),
      }),
    );

    expect(res.status).toBe(403);
    await gateway.close();
  });
});

describe("embedded fetch handler — Hono-style mount typechecks (proof 6)", () => {
  it("mounts as app.all('/agentick/*', (c) => handler(c.req.raw))", async () => {
    // A minimal shape of the fetch-native frameworks (Hono / Nitro / Next).
    interface HonoLikeContext {
      readonly req: { readonly raw: Request };
    }
    interface HonoLikeApp {
      all(path: string, fn: (c: HonoLikeContext) => Response | Promise<Response>): void;
    }

    const gateway = await createGateway({ authorizer: staticAuthorizer({ grants: {} }) });

    // The drawn adopter code — the identity callback returns the ADR-48 shape.
    const handler: FetchHandler = httpFetchHandler(gateway, {
      identity: async (req): Promise<Identity | Response> => {
        const token = req.headers.get("authorization");
        if (!token) return new Response(null, { status: 401 });
        return { principal: "user-123", user: { tenantId: "acme" }, scopes: ["session:send"] };
      },
    });

    const calls: string[] = [];
    const app: HonoLikeApp = {
      all(path, fn) {
        calls.push(path);
        void fn;
      },
    };
    app.all("/agentick/*", (c) => handler(c.req.raw));

    expect(calls).toEqual(["/agentick/*"]);
    expect(typeof handler).toBe("function");

    await gateway.close();
  });
});
