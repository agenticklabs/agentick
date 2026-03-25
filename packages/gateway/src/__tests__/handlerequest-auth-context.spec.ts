/**
 * handleRequest Auth Context Propagation Tests
 *
 * Verifies that authentication and ALS context are set once at the
 * request boundary in handleRequest(), and that all downstream handlers,
 * session creation, and plugin routes inherit the authenticated user.
 *
 * Adversarial scenarios:
 * - Concurrent requests with different users don't cross-contaminate
 * - SSE long-lived connections hold correct context
 * - Plugin routes with auth: false still get context if token is present
 * - Session creation (via this.session()) inherits user from outer context
 * - Unauthenticated requests get 401 before any handler runs
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Gateway, createGateway } from "../gateway.js";
import { createMockApp, type MockApp } from "@agentick/core/testing";
import { Context, type UserContext } from "@agentick/kernel";
import { method } from "../types.js";

// ============================================================================
// Mock HTTP helpers
// ============================================================================

function mockHTTP(
  path: string,
  httpMethod = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) {
  const chunks: Buffer[] = [];
  const req = {
    method: httpMethod,
    url: path,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...headers,
    },
    body: body ?? undefined,
    on: vi.fn(),
  } as any;

  const res = {
    statusCode: 200,
    headersSent: false,
    _headers: {} as Record<string, string>,
    _ended: false,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      this.headersSent = true;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) this._headers[k.toLowerCase()] = v;
      }
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this._ended = true;
      this.headersSent = true;
    },
    on: vi.fn(),
  } as any;

  return {
    req,
    res,
    body: () => Buffer.concat(chunks).toString(),
    json: () => JSON.parse(Buffer.concat(chunks).toString()),
    sseEvents: () =>
      Buffer.concat(chunks)
        .toString()
        .split("\n\n")
        .filter((l: string) => l.startsWith("data: "))
        .map((l: string) => JSON.parse(l.replace("data: ", ""))),
  };
}

function bearerHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

// ============================================================================
// Shared setup
// ============================================================================

function createAuthGateway(opts?: {
  methods?: Record<string, any>;
  hydrateUser?: (r: any) => Promise<UserContext>;
}) {
  const app = createMockApp();

  const gateway = createGateway({
    apps: { test: app },
    defaultApp: "test",
    embedded: true,
    auth: {
      type: "custom",
      validate: async (token) => {
        if (!token) return { valid: false };
        if (token === "user-a-token") return { valid: true, user: { id: "user-a" } };
        if (token === "user-b-token") return { valid: true, user: { id: "user-b" } };
        return { valid: false };
      },
      hydrateUser: opts?.hydrateUser,
    },
    methods: opts?.methods,
  });

  return { gateway, app };
}

// ============================================================================
// Tests
// ============================================================================

describe("handleRequest auth context propagation", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway?.running) await gateway.stop();
  });

  // --------------------------------------------------------------------------
  // Basic auth enforcement
  // --------------------------------------------------------------------------

  it("returns 401 for unauthenticated requests to built-in routes", async () => {
    ({ gateway } = createAuthGateway());
    const { req, res } = mockHTTP("/send", "POST", {
      messages: [{ role: "user", content: "hi" }],
    });

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for invalid tokens", async () => {
    ({ gateway } = createAuthGateway());
    const { req, res } = mockHTTP(
      "/send",
      "POST",
      { messages: [{ role: "user", content: "hi" }] },
      bearerHeader("wrong-token"),
    );

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("allows requests with valid tokens", async () => {
    ({ gateway } = createAuthGateway());
    const { req, res } = mockHTTP(
      "/subscribe",
      "POST",
      { sessionId: "s1", clientId: "c1" },
      bearerHeader("user-a-token"),
    );

    // Need an SSE client registered for subscribe to work
    const sseReq = {
      method: "GET",
      url: "/events?token=user-a-token&clientId=c1",
      headers: { host: "localhost" },
      on: vi.fn(),
    } as any;
    const sseRes = {
      statusCode: 200,
      headersSent: false,
      _headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this._headers[name.toLowerCase()] = value;
      },
      writeHead(code: number, headers?: Record<string, string>) {
        this.statusCode = code;
        this.headersSent = true;
      },
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      on: vi.fn(),
    } as any;

    await gateway.handleRequest(sseReq, sseRes);
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
  });

  // --------------------------------------------------------------------------
  // Context propagation into custom methods
  // --------------------------------------------------------------------------

  it("propagates user context to custom methods via invoke", async () => {
    let capturedUser: UserContext | undefined;

    ({ gateway } = createAuthGateway({
      methods: {
        whoami: method({
          handler: async () => {
            capturedUser = Context.tryGet()?.user;
            return { userId: capturedUser?.id };
          },
        }),
      },
    }));

    const { req, res, json } = mockHTTP(
      "/invoke",
      "POST",
      { method: "whoami", params: {} },
      bearerHeader("user-a-token"),
    );

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(capturedUser?.id).toBe("user-a");
    expect(json().userId).toBe("user-a");
  });

  // --------------------------------------------------------------------------
  // hydrateUser integration
  // --------------------------------------------------------------------------

  it("propagates hydrated user to methods", async () => {
    let capturedUser: UserContext | undefined;

    ({ gateway } = createAuthGateway({
      hydrateUser: async (authResult) => ({
        id: authResult.user?.id ?? "unknown",
        roles: ["premium"],
        email: `${authResult.user?.id}@test.com`,
      }),
      methods: {
        profile: method({
          handler: async () => {
            capturedUser = Context.tryGet()?.user;
            return capturedUser;
          },
        }),
      },
    }));

    const { req, res, json } = mockHTTP(
      "/invoke",
      "POST",
      { method: "profile", params: {} },
      bearerHeader("user-a-token"),
    );

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(capturedUser?.id).toBe("user-a");
    expect(capturedUser?.roles).toEqual(["premium"]);
    expect(capturedUser?.email).toBe("user-a@test.com");
  });

  // --------------------------------------------------------------------------
  // Concurrent request isolation
  // --------------------------------------------------------------------------

  it("concurrent requests with different users don't cross-contaminate", async () => {
    const capturedUsers: string[] = [];

    ({ gateway } = createAuthGateway({
      methods: {
        slowMethod: method({
          handler: async () => {
            // Simulate async work that could allow context leaking
            await new Promise((r) => setTimeout(r, 10));
            const user = Context.tryGet()?.user;
            capturedUsers.push(user?.id ?? "none");
            return { userId: user?.id };
          },
        }),
      },
    }));

    const reqA = mockHTTP(
      "/invoke",
      "POST",
      { method: "slowMethod", params: {} },
      bearerHeader("user-a-token"),
    );
    const reqB = mockHTTP(
      "/invoke",
      "POST",
      { method: "slowMethod", params: {} },
      bearerHeader("user-b-token"),
    );

    // Fire both concurrently
    await Promise.all([
      gateway.handleRequest(reqA.req, reqA.res),
      gateway.handleRequest(reqB.req, reqB.res),
    ]);

    expect(capturedUsers).toHaveLength(2);
    expect(capturedUsers).toContain("user-a");
    expect(capturedUsers).toContain("user-b");
    // Each response should have the correct user
    expect(reqA.json().userId).toBe("user-a");
    expect(reqB.json().userId).toBe("user-b");
  });

  it("rapid sequential requests maintain correct context per request", async () => {
    const results: string[] = [];

    ({ gateway } = createAuthGateway({
      methods: {
        identify: method({
          handler: async () => {
            const userId = Context.tryGet()?.user?.id ?? "none";
            results.push(userId);
            return { userId };
          },
        }),
      },
    }));

    // 10 alternating requests
    for (let i = 0; i < 10; i++) {
      const token = i % 2 === 0 ? "user-a-token" : "user-b-token";
      const expected = i % 2 === 0 ? "user-a" : "user-b";
      const { req, res, json } = mockHTTP(
        "/invoke",
        "POST",
        { method: "identify", params: {} },
        bearerHeader(token),
      );

      await gateway.handleRequest(req, res);
      expect(json().userId).toBe(expected);
    }

    expect(results).toHaveLength(10);
    // Even indices should be user-a, odd should be user-b
    results.forEach((userId, i) => {
      expect(userId).toBe(i % 2 === 0 ? "user-a" : "user-b");
    });
  });

  // --------------------------------------------------------------------------
  // SSE token from query params
  // --------------------------------------------------------------------------

  it("authenticates SSE connections via query param token", async () => {
    ({ gateway } = createAuthGateway());

    const { req, res, sseEvents } = mockHTTP("/events?token=user-a-token&clientId=sse-1");

    await gateway.handleRequest(req, res);

    // SSE should respond with connection message, not 401
    expect(res.statusCode).not.toBe(401);
    const events = sseEvents();
    expect(events[0]?.type).toBe("connection");
    expect(events[0]?.connectionId).toBe("sse-1");
  });

  it("rejects SSE connections with invalid query param token", async () => {
    ({ gateway } = createAuthGateway());

    const { req, res } = mockHTTP("/events?token=bad-token&clientId=sse-1");

    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(401);
  });

  // --------------------------------------------------------------------------
  // Plugin route auth opt-out
  // --------------------------------------------------------------------------

  it("plugin routes with auth: false bypass auth but still get context if token present", async () => {
    let capturedContext: boolean | undefined;

    const app = createMockApp();
    gateway = createGateway({
      apps: { test: app },
      defaultApp: "test",
      embedded: true,
      auth: {
        type: "custom",
        validate: async (token) =>
          token === "valid" ? { valid: true, user: { id: "plugin-user" } } : { valid: false },
      },
      plugins: [
        {
          id: "test-public",
          async initialize(ctx) {
            ctx.registerRoute(
              "/public/health",
              (_req, res) => {
                capturedContext = Context.tryGet() !== undefined;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, hasContext: capturedContext }));
              },
              { auth: false },
            );
          },
          async destroy() {},
        },
      ],
    });

    // Request without token — should still work (auth: false)
    const { req, res, json } = mockHTTP("/public/health");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(json().ok).toBe(true);
    // Should have ALS context (just no user on it)
    expect(capturedContext).toBe(true);
  });

  it("plugin routes with auth: true reject unauthenticated requests", async () => {
    const app = createMockApp();
    gateway = createGateway({
      apps: { test: app },
      defaultApp: "test",
      embedded: true,
      auth: {
        type: "custom",
        validate: async (token) =>
          token === "valid" ? { valid: true, user: { id: "user" } } : { valid: false },
      },
      plugins: [
        {
          id: "test-private",
          async initialize(ctx) {
            ctx.registerRoute(
              "/private/data",
              (_req, res) => {
                res.writeHead(200);
                res.end("secret");
              },
              { auth: true },
            );
          },
          async destroy() {},
        },
      ],
    });

    const { req, res } = mockHTTP("/private/data");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(401);
  });

  // --------------------------------------------------------------------------
  // Context available in session creation (this.session() → Context.fork)
  // --------------------------------------------------------------------------

  it("session creation inherits user from handleRequest context", async () => {
    let userDuringSessionCreation: UserContext | undefined;

    const app = createMockApp();
    // Spy on app.session to capture the context during session creation
    const originalSession = app.session.bind(app);
    app.session = vi.fn(async (id: string) => {
      userDuringSessionCreation = Context.tryGet()?.user;
      return originalSession(id);
    }) as any;

    gateway = createGateway({
      apps: { test: app },
      defaultApp: "test",
      embedded: true,
      auth: {
        type: "custom",
        validate: async (token) =>
          token === "valid" ? { valid: true, user: { id: "creator-user" } } : { valid: false },
      },
    });

    // Subscribe triggers getOrCreate but not core session creation.
    // Send triggers this.session() → app.session() where we can observe context.
    const { req, res } = mockHTTP(
      "/send",
      "POST",
      {
        sessionId: "test-session",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      bearerHeader("valid"),
    );

    await gateway.handleRequest(req, res);

    // The mock app's session was called, and context should have had the user
    expect(app.session).toHaveBeenCalledWith("test-session");
    expect(userDuringSessionCreation?.id).toBe("creator-user");
  });

  // --------------------------------------------------------------------------
  // OPTIONS preflight is not affected
  // --------------------------------------------------------------------------

  it("OPTIONS requests bypass auth entirely", async () => {
    ({ gateway } = createAuthGateway());

    const { req, res } = mockHTTP("/send", "OPTIONS");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(204);
  });

  // --------------------------------------------------------------------------
  // 404 for unknown routes (auth still required)
  // --------------------------------------------------------------------------

  it("returns 401 for unknown routes without auth", async () => {
    ({ gateway } = createAuthGateway());

    const { req, res } = mockHTTP("/nonexistent", "GET");
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown routes with valid auth", async () => {
    ({ gateway } = createAuthGateway());

    const { req, res } = mockHTTP("/nonexistent", "GET", undefined, bearerHeader("user-a-token"));
    await gateway.handleRequest(req, res);

    expect(res.statusCode).toBe(404);
  });
});
