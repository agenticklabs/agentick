/**
 * Express Handler Tests
 *
 * Tests for the createTentickleHandler factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { createTentickleHandler } from "../router";
import type { App, Session } from "@tentickle/core/app";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockSession(): Session & {
  _events: AsyncGenerator<any, void, unknown>;
  _queuedMessages: any[];
} {
  const queuedMessages: any[] = [];

  async function* eventGenerator() {
    yield { type: "tick_start", tick: 1 };
    yield { type: "content_delta", delta: "Hello" };
    yield { type: "tick_end", tick: 1 };
  }

  return {
    _events: eventGenerator(),
    _queuedMessages: queuedMessages,
    id: "test-session",
    status: "idle",
    currentTick: 0,
    isAborted: false,
    queuedMessages: [],
    schedulerState: null,

    queue: {
      exec: vi.fn(),
    } as any,

    send: vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "tick_start", tick: 1 };
        yield { type: "content_delta", delta: "Hello" };
        yield { type: "tick_end", tick: 1 };
      },
      result: Promise.resolve({
        response: "Hello!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
        raw: {},
      }),
      sessionId: "test-session",
    })),

    tick: vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "tick_start", tick: 1 };
      },
      result: Promise.resolve({
        response: "Hello!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
        raw: {},
      }),
    })),

    interrupt: vi.fn(),
    clearAbort: vi.fn(),
    events: vi.fn(() => eventGenerator()),
    snapshot: vi.fn(() => ({})),
    inspect: vi.fn(() => ({
      id: "test-session",
      status: "idle" as const,
      currentTick: 0,
      queuedMessages: [],
      currentPhase: undefined,
      isAborted: false,
      lastOutput: null,
      lastModelOutput: null,
      lastToolCalls: [],
      lastToolResults: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      tickCount: 0,
      components: { count: 0, names: [] },
      hooks: { count: 0, byType: {} },
    })),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getRecording: vi.fn(),
    getSnapshotAt: vi.fn(),
    channel: vi.fn(() => ({
      publish: vi.fn(),
      subscribe: vi.fn(),
    })),
    submitToolResult: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),

    // EventEmitter stubs
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    once: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    eventNames: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
  } as any;
}

function createMockApp(): App & {
  _sessions: Map<string, Session>;
} {
  const sessions = new Map<string, Session>();

  const app = {
    _sessions: sessions,

    run: {
      exec: vi.fn(async () => ({
        response: "Hello!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
        raw: {},
      })),
    } as any,

    send: vi.fn((input, options) => {
      const sessionId = options?.sessionId ?? `session-${Date.now()}`;
      let session = sessions.get(sessionId);
      if (!session) {
        session = createMockSession();
        (session as any).id = sessionId;
        sessions.set(sessionId, session);
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "tick_start", tick: 1 };
          yield { type: "content_delta", delta: "Hello" };
          yield { type: "tick_end", tick: 1 };
        },
        result: Promise.resolve({
          response: "Hello!",
          outputs: {},
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          stopReason: "end_turn",
          raw: {},
        }),
        sessionId,
      };
    }),

    // session: vi.fn((id) => sessions.get(id)),

    session: vi.fn((id) => {
      let session = sessions.get(id);
      if (!session) {
        session = createMockSession();
        (session as any).id = id;
        sessions.set(id, session);
      }
      return session;
    }),

    close: vi.fn(async (id) => {
      sessions.delete(id);
    }),

    get sessions() {
      return Array.from(sessions.keys());
    },

    has: vi.fn((id) => sessions.has(id)),

    onSessionCreate: vi.fn(() => () => {}),
    onSessionClose: vi.fn(() => () => {}),
  } as any;

  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe("createTentickleHandler", () => {
  let expressApp: Express;
  let mockApp: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    expressApp = express();
    expressApp.use(express.json());
    mockApp = createMockApp();

    const handler = createTentickleHandler(mockApp);
    expressApp.use("/api", handler);
  });

  describe("GET /events (SSE)", () => {
    it("establishes SSE connection and sends connection event", async () => {
      // Use a buffer approach to capture SSE data before timeout
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve) => {
        const req = request(expressApp)
          .get("/api/events")
          .buffer(true)
          .parse((res, callback) => {
            res.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              const text = Buffer.concat(chunks).toString();
              // Wait until we have a complete SSE message with connection data
              if (text.includes("connectionId")) {
                req.abort();
              }
            });
            res.on("end", () => callback(null, Buffer.concat(chunks).toString()));
            res.on("error", () => callback(null, Buffer.concat(chunks).toString()));
          });

        req.end(() => resolve());

        // Fallback timeout
        setTimeout(() => {
          req.abort();
          resolve();
        }, 500);
      });

      const text = Buffer.concat(chunks).toString();
      expect(text).toContain("connectionId");
      expect(text).toContain("conn-");
    });

    it("accepts initial subscriptions via query param", async () => {
      // First create the session
      mockApp.session("conv1");

      const chunks: Buffer[] = [];

      await new Promise<void>((resolve) => {
        const req = request(expressApp)
          .get("/api/events?subscribe=conv1")
          .buffer(true)
          .parse((res, callback) => {
            res.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              const text = Buffer.concat(chunks).toString();
              if (text.includes("connectionId")) {
                req.abort();
              }
            });
            res.on("end", () => callback(null, Buffer.concat(chunks).toString()));
            res.on("error", () => callback(null, Buffer.concat(chunks).toString()));
          });

        req.end(() => resolve());

        setTimeout(() => {
          req.abort();
          resolve();
        }, 500);
      });

      const text = Buffer.concat(chunks).toString();
      expect(text).toContain("connectionId");
      expect(text).toContain("subscriptions");
    });
  });

  describe("POST /subscribe", () => {
    it("returns 400 without connectionId", async () => {
      const response = await request(expressApp)
        .post("/api/subscribe")
        .send({ add: ["session1"] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
    });
  });

  describe("POST /send", () => {
    it("returns 400 without message or messages", async () => {
      const response = await request(expressApp).post("/api/send").send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
    });

    it("accepts single message and streams response", async () => {
      const response = await request(expressApp)
        .post("/api/send")
        .send({
          message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      expect(mockApp.send).toHaveBeenCalled();
    });

    it("accepts messages array", async () => {
      const response = await request(expressApp)
        .post("/api/send")
        .send({
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        });

      expect(response.status).toBe(200);
      expect(mockApp.send).toHaveBeenCalled();
    });

    it("includes sessionId in options when provided", async () => {
      const response = await request(expressApp)
        .post("/api/send")
        .send({
          sessionId: "my-session",
          message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        });

      expect(response.status).toBe(200);
      expect(mockApp.send).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.any(Object) }),
        expect.objectContaining({ sessionId: "my-session" }),
      );
    });
  });

  describe("POST /abort", () => {
    it("returns 404 for non-existent session", async () => {
      const response = await request(expressApp)
        .post("/api/abort")
        .send({ sessionId: "nonexistent" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("SESSION_NOT_FOUND");
    });

    it("aborts existing session", async () => {
      // Create session first
      const session = mockApp.session("test-session");

      const response = await request(expressApp)
        .post("/api/abort")
        .send({ sessionId: "test-session", reason: "user cancelled" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(session.interrupt).toHaveBeenCalledWith(undefined, "user cancelled");
    });
  });

  describe("POST /close", () => {
    it("returns 400 without sessionId", async () => {
      const response = await request(expressApp).post("/api/close").send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
    });

    it("closes existing session", async () => {
      mockApp.session("test-session");

      const response = await request(expressApp)
        .post("/api/close")
        .send({ sessionId: "test-session" });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockApp.close).toHaveBeenCalledWith("test-session");
    });
  });

  describe("POST /tool-response", () => {
    it("returns 404 for non-existent session", async () => {
      const response = await request(expressApp)
        .post("/api/tool-response")
        .send({
          sessionId: "nonexistent",
          toolUseId: "tool-123",
          response: { approved: true },
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("SESSION_NOT_FOUND");
    });

    it("submits tool confirmation to session", async () => {
      const session = mockApp.session("test-session");
      session.submitToolResult = vi.fn();

      const response = await request(expressApp)
        .post("/api/tool-response")
        .send({
          sessionId: "test-session",
          toolUseId: "tool-123",
          response: { approved: true },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(session.submitToolResult).toHaveBeenCalledWith("tool-123", { approved: true });
    });
  });
});

describe("createTentickleHandler with options", () => {
  it("uses custom paths", async () => {
    const mockApp = createMockApp();
    const expressApp = express();
    expressApp.use(express.json());

    const handler = createTentickleHandler(mockApp, {
      paths: {
        events: "/stream",
        send: "/message",
        abort: "/cancel",
        close: "/end",
      },
    });
    expressApp.use("/api", handler);

    // Test custom send path
    const response = await request(expressApp)
      .post("/api/message")
      .send({
        message: { role: "user", content: [{ type: "text", text: "Hi" }] },
      });

    expect(response.status).toBe(200);
    expect(mockApp.send).toHaveBeenCalled();
  });

  it("calls authenticate hook on events endpoint", async () => {
    const mockApp = createMockApp();
    const expressApp = express();
    expressApp.use(express.json());

    const authenticate = vi.fn((req) => ({ userId: "user-123" }));

    const handler = createTentickleHandler(mockApp, { authenticate });
    expressApp.use("/api", handler);

    const chunks: Buffer[] = [];

    await new Promise<void>((resolve) => {
      const req = request(expressApp)
        .get("/api/events")
        .set("Authorization", "Bearer test-token")
        .buffer(true)
        .parse((res, callback) => {
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            req.abort();
          });
          res.on("end", () => callback(null, Buffer.concat(chunks).toString()));
          res.on("error", () => callback(null, Buffer.concat(chunks).toString()));
        });

      req.end(() => resolve());
      setTimeout(() => {
        req.abort();
        resolve();
      }, 200);
    });

    expect(authenticate).toHaveBeenCalled();
  });

  it("calls authorize hook during subscription", async () => {
    const mockApp = createMockApp();
    const expressApp = express();
    expressApp.use(express.json());

    // Create session first
    mockApp.session("protected-session");

    const authorize = vi.fn(() => false);

    const handler = createTentickleHandler(mockApp, { authorize });
    expressApp.use("/api", handler);

    // Start SSE connection and try to subscribe in the initial query
    const chunks: Buffer[] = [];
    let subscribeError = false;

    await new Promise<void>((resolve) => {
      const req = request(expressApp)
        .get("/api/events?subscribe=protected-session")
        .buffer(true)
        .parse((res, callback) => {
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            const text = Buffer.concat(chunks).toString();
            if (text.includes("connectionId")) {
              req.abort();
            }
          });
          res.on("end", () => callback(null, Buffer.concat(chunks).toString()));
          res.on("error", (err) => {
            // Authorization failure closes the connection with an error
            subscribeError = true;
            callback(null, Buffer.concat(chunks).toString());
          });
        });

      req.end(() => resolve());
      setTimeout(() => {
        req.abort();
        resolve();
      }, 500);
    });

    // The authorize hook should have been called
    expect(authorize).toHaveBeenCalledWith(
      undefined, // no user since authenticate not provided
      "protected-session",
      expect.any(Object),
    );
  });
});

describe("Channel endpoints", () => {
  let expressApp: Express;
  let mockApp: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    expressApp = express();
    expressApp.use(express.json());
    mockApp = createMockApp();

    const handler = createTentickleHandler(mockApp);
    expressApp.use("/api", handler);
  });

  describe("POST /channel (publish)", () => {
    it("publishes event to session channel", async () => {
      const session = mockApp.session("test-session");
      const mockChannel = { publish: vi.fn(), subscribe: vi.fn(() => () => {}) };
      (session.channel as any).mockReturnValue(mockChannel);

      const response = await request(expressApp)
        .post("/api/channel")
        .send({
          sessionId: "test-session",
          channel: "notifications",
          type: "user_action",
          payload: { action: "click" },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(session.channel).toHaveBeenCalledWith("notifications");
      expect(mockChannel.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "user_action",
          channel: "notifications",
          payload: { action: "click" },
        }),
      );
    });

    it("returns 400 if sessionId is missing", async () => {
      const response = await request(expressApp).post("/api/channel").send({
        channel: "notifications",
        type: "event",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
      expect(response.body.message).toContain("sessionId");
    });

    it("returns 400 if channel is missing", async () => {
      const response = await request(expressApp).post("/api/channel").send({
        sessionId: "test-session",
        type: "event",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
      expect(response.body.message).toContain("channel");
    });

    it("returns 400 if type is missing", async () => {
      const response = await request(expressApp).post("/api/channel").send({
        sessionId: "test-session",
        channel: "notifications",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
      expect(response.body.message).toContain("type");
    });

    it("returns 404 if session not found", async () => {
      const response = await request(expressApp).post("/api/channel").send({
        sessionId: "non-existent",
        channel: "notifications",
        type: "event",
      });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("SESSION_NOT_FOUND");
    });

    it("returns 403 if authorization fails", async () => {
      const authApp = express();
      authApp.use(express.json());
      const authMockApp = createMockApp();
      authMockApp.session("protected-session");

      const handler = createTentickleHandler(authMockApp, {
        authorize: () => false,
      });
      authApp.use("/api", handler);

      const response = await request(authApp).post("/api/channel").send({
        sessionId: "protected-session",
        channel: "notifications",
        type: "event",
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("UNAUTHORIZED");
    });

    it("includes id and metadata when provided", async () => {
      const session = mockApp.session("test-session");
      const mockChannel = { publish: vi.fn(), subscribe: vi.fn(() => () => {}) };
      (session.channel as any).mockReturnValue(mockChannel);

      const response = await request(expressApp)
        .post("/api/channel")
        .send({
          sessionId: "test-session",
          channel: "notifications",
          type: "request",
          payload: { data: "test" },
          id: "req-123",
          metadata: { userId: "user-1" },
        });

      expect(response.status).toBe(200);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "request",
          channel: "notifications",
          id: "req-123",
          metadata: expect.objectContaining({
            userId: "user-1",
            timestamp: expect.any(Number),
          }),
        }),
      );
    });
  });

  describe("POST /channel/subscribe", () => {
    it("sets up channel listener for session", async () => {
      const session = mockApp.session("test-session");
      const mockChannel = { publish: vi.fn(), subscribe: vi.fn(() => () => {}) };
      (session.channel as any).mockReturnValue(mockChannel);

      const response = await request(expressApp).post("/api/channel/subscribe").send({
        sessionId: "test-session",
        channel: "notifications",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(session.channel).toHaveBeenCalledWith("notifications");
      expect(mockChannel.subscribe).toHaveBeenCalled();
    });

    it("returns 400 if sessionId is missing", async () => {
      const response = await request(expressApp).post("/api/channel/subscribe").send({
        channel: "notifications",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
      expect(response.body.message).toContain("sessionId");
    });

    it("returns 400 if channel is missing", async () => {
      const response = await request(expressApp).post("/api/channel/subscribe").send({
        sessionId: "test-session",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
      expect(response.body.message).toContain("channel");
    });

    it("creates session if it doesn't exist", async () => {
      const response = await request(expressApp).post("/api/channel/subscribe").send({
        sessionId: "non-existent",
        channel: "notifications",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Session should now exist
      expect(mockApp.has("non-existent")).toBe(true);
    });

    it("returns 403 if authorization fails", async () => {
      const authApp = express();
      authApp.use(express.json());
      const authMockApp = createMockApp();
      authMockApp.session("protected-session");

      const handler = createTentickleHandler(authMockApp, {
        authorize: () => false,
      });
      authApp.use("/api", handler);

      const response = await request(authApp).post("/api/channel/subscribe").send({
        sessionId: "protected-session",
        channel: "notifications",
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("UNAUTHORIZED");
    });
  });
});
