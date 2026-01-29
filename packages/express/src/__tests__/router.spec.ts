/**
 * Express Router Tests
 *
 * Tests for the createTentickleRouter factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import { createTentickleRouter } from "../router.js";
import type { SessionHandler, EventBridge, SessionStateInfo } from "@tentickle/server";
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
      then: (resolve: any) => resolve({
        response: "Hello!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
        raw: {},
      }),
    })),

    tick: vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "tick_start", tick: 1 };
      },
      then: (resolve: any) => resolve({
        response: "Hello!",
        outputs: {},
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
        raw: {},
      }),
    })),

    queueMessage: vi.fn((msg) => queuedMessages.push(msg)),
    sendMessage: vi.fn(),
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

function createMockSessionHandler(): SessionHandler & {
  _sessions: Map<string, Session>;
} {
  const sessions = new Map<string, Session>();

  return {
    _sessions: sessions,

    create: vi.fn(async ({ sessionId }) => {
      const id = sessionId ?? `session-${Date.now()}`;
      const session = createMockSession();
      sessions.set(id, session);
      return { sessionId: id, session };
    }),

    send: vi.fn(async () => ({
      response: "Hello!",
      outputs: {},
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: "end_turn",
      raw: {},
    })),

    stream: vi.fn(function* () {
      yield { type: "tick_start", tick: 1 };
      yield { type: "content_delta", delta: "Hello" };
      yield { type: "tick_end", tick: 1 };
    }),

    getSession: vi.fn((id) => sessions.get(id)),

    getState: vi.fn((id): SessionStateInfo | undefined => {
      const session = sessions.get(id);
      if (!session) return undefined;
      return {
        sessionId: id,
        status: "idle",
        tick: 0,
        queuedMessages: 0,
      };
    }),

    delete: vi.fn((id) => {
      const had = sessions.has(id);
      sessions.delete(id);
      return had;
    }),

    list: vi.fn(() => Array.from(sessions.keys())),
  };
}

function createMockEventBridge(): EventBridge {
  const connections = new Map<string, any>();

  return {
    registerConnection: vi.fn((conn) => {
      connections.set(conn.id, conn);
    }),

    unregisterConnection: vi.fn((id) => {
      connections.delete(id);
    }),

    handleEvent: vi.fn(async () => {}),

    sendToSession: vi.fn(async () => {}),

    destroy: vi.fn(),
  };
}

function createMockApp(): App {
  return {
    createSession: vi.fn(() => createMockSession()),
    run: vi.fn(),
  } as any;
}

// ============================================================================
// Tests
// ============================================================================

describe("createTentickleRouter", () => {
  let expressApp: Express;
  let mockSessionHandler: ReturnType<typeof createMockSessionHandler>;
  let mockEventBridge: ReturnType<typeof createMockEventBridge>;
  let destroy: () => void;

  beforeEach(() => {
    expressApp = express();
    expressApp.use(express.json());

    mockSessionHandler = createMockSessionHandler();
    mockEventBridge = createMockEventBridge();

    const result = createTentickleRouter({
      sessionHandler: mockSessionHandler,
      eventBridge: mockEventBridge,
    });

    expressApp.use("/api", result.router);
    destroy = result.destroy;
  });

  afterEach(() => {
    destroy();
  });

  describe("POST /sessions", () => {
    it("creates a new session with generated ID", async () => {
      const response = await request(expressApp)
        .post("/api/sessions")
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.sessionId).toBeDefined();
      expect(response.body.status).toBe("created");
      expect(mockSessionHandler.create).toHaveBeenCalled();
    });

    it("creates a session with provided ID", async () => {
      const response = await request(expressApp)
        .post("/api/sessions")
        .send({ sessionId: "my-session" });

      expect(response.status).toBe(201);
      expect(response.body.sessionId).toBe("my-session");
      expect(response.body.status).toBe("created");
    });

    it("returns existing session if ID already exists", async () => {
      // Create first session
      await request(expressApp)
        .post("/api/sessions")
        .send({ sessionId: "existing" });

      // Try to create again with same ID
      const response = await request(expressApp)
        .post("/api/sessions")
        .send({ sessionId: "existing" });

      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe("existing");
      expect(response.body.status).toBe("existing");
    });
  });

  describe("GET /sessions/:sessionId", () => {
    it("returns session state", async () => {
      // Create session first
      await request(expressApp)
        .post("/api/sessions")
        .send({ sessionId: "test" });

      const response = await request(expressApp)
        .get("/api/sessions/test");

      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe("test");
      expect(response.body.status).toBe("idle");
    });

    it("returns 404 for non-existent session", async () => {
      const response = await request(expressApp)
        .get("/api/sessions/nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("SESSION_NOT_FOUND");
    });
  });

  describe("DELETE /sessions/:sessionId", () => {
    it("deletes existing session", async () => {
      // Create session first
      await request(expressApp)
        .post("/api/sessions")
        .send({ sessionId: "to-delete" });

      const response = await request(expressApp)
        .delete("/api/sessions/to-delete");

      expect(response.status).toBe(200);
      expect(response.body.deleted).toBe(true);
      expect(mockSessionHandler.delete).toHaveBeenCalledWith("to-delete");
    });

    it("returns deleted: false for non-existent session", async () => {
      const response = await request(expressApp)
        .delete("/api/sessions/nonexistent");

      expect(response.status).toBe(200);
      expect(response.body.deleted).toBe(false);
    });
  });

  describe("GET /events (SSE)", () => {
    it("returns 400 without sessionId", async () => {
      const response = await request(expressApp)
        .get("/api/events");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
      expect(response.body.message).toContain("sessionId");
    });

    it("returns 404 for non-existent session", async () => {
      const response = await request(expressApp)
        .get("/api/events?sessionId=nonexistent");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("SESSION_NOT_FOUND");
    });

    it("sets up SSE connection for valid session", async () => {
      // Create session first
      await request(expressApp)
        .post("/api/sessions")
        .send({ sessionId: "sse-test" });

      // The SSE request will hang waiting for events, so we need to abort it
      const response = await request(expressApp)
        .get("/api/events?sessionId=sse-test")
        .timeout(100)
        .catch((e) => e.response);

      // Should have registered a connection
      expect(mockEventBridge.registerConnection).toHaveBeenCalled();
    });
  });

  describe("POST /events", () => {
    it("returns 400 without channel and type", async () => {
      const response = await request(expressApp)
        .post("/api/events")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_REQUEST");
    });

    it("returns 400 without connectionId or sessionId", async () => {
      const response = await request(expressApp)
        .post("/api/events")
        .send({ channel: "test", type: "message" });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain("connectionId or sessionId");
    });

    it("handles event with connectionId", async () => {
      const response = await request(expressApp)
        .post("/api/events")
        .send({
          connectionId: "conn-123",
          channel: "session:control",
          type: "tick",
          payload: {},
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockEventBridge.handleEvent).toHaveBeenCalledWith(
        "conn-123",
        expect.objectContaining({ channel: "session:control", type: "tick" }),
      );
    });

    it("handles event with sessionId (ephemeral connection)", async () => {
      const response = await request(expressApp)
        .post("/api/events")
        .send({
          sessionId: "session-456",
          channel: "session:messages",
          type: "message",
          payload: { text: "Hello" },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockEventBridge.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-456",
          id: expect.stringContaining("ephemeral-"),
        }),
        expect.objectContaining({ channel: "session:messages", type: "message" }),
      );
    });
  });

  describe("destroy()", () => {
    it("cleans up event bridge", () => {
      destroy();

      expect(mockEventBridge.destroy).toHaveBeenCalled();
    });
  });
});

describe("createTentickleRouter with app", () => {
  it("creates sessionHandler and eventBridge from app", () => {
    const mockApp = createMockApp();
    const expressApp = express();

    const result = createTentickleRouter({ app: mockApp });
    expressApp.use("/api", result.router);

    expect(result.sessionHandler).toBeDefined();
    expect(result.eventBridge).toBeDefined();
    expect(result.destroy).toBeDefined();

    result.destroy();
  });

  it("throws if neither app nor sessionHandler provided", () => {
    expect(() => createTentickleRouter({} as any)).toThrow(
      "Either app or sessionHandler must be provided",
    );
  });
});

describe("createTentickleRouter with authentication", () => {
  let expressApp: Express;
  let mockSessionHandler: ReturnType<typeof createMockSessionHandler>;
  let mockEventBridge: ReturnType<typeof createMockEventBridge>;
  let destroy: () => void;
  let authenticateFn: ReturnType<typeof vi.fn>;
  let getUserIdFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    expressApp = express();
    expressApp.use(express.json());

    mockSessionHandler = createMockSessionHandler();
    mockEventBridge = createMockEventBridge();

    authenticateFn = vi.fn((req) => {
      const auth = req.headers.authorization;
      return auth?.replace("Bearer ", "");
    });

    getUserIdFn = vi.fn((req) => {
      // Simulate extracting user ID from token
      const token = req.headers.authorization?.replace("Bearer ", "");
      return token ? `user-${token}` : undefined;
    });

    const result = createTentickleRouter({
      sessionHandler: mockSessionHandler,
      eventBridge: mockEventBridge,
      authenticate: authenticateFn,
      getUserId: getUserIdFn,
    });

    expressApp.use("/api", result.router);
    destroy = result.destroy;
  });

  afterEach(() => {
    destroy();
  });

  it("calls authenticate and getUserId on each request", async () => {
    await request(expressApp)
      .post("/api/sessions")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(authenticateFn).toHaveBeenCalled();
    expect(getUserIdFn).toHaveBeenCalled();
  });

  it("extracts token from authorization header", async () => {
    await request(expressApp)
      .post("/api/sessions")
      .set("Authorization", "Bearer my-token")
      .send({});

    expect(authenticateFn).toHaveReturnedWith("my-token");
  });
});

describe("createTentickleRouter with custom paths", () => {
  it("mounts routes at custom paths", async () => {
    const mockSessionHandler = createMockSessionHandler();
    const mockEventBridge = createMockEventBridge();

    const expressApp = express();
    expressApp.use(express.json());

    const result = createTentickleRouter({
      sessionHandler: mockSessionHandler,
      eventBridge: mockEventBridge,
      paths: {
        sessions: "/chat/sessions",
        session: "/chat/sessions/:sessionId",
        events: "/chat/stream",
      },
    });

    expressApp.use("/api", result.router);

    // Test custom session path
    const response = await request(expressApp)
      .post("/api/chat/sessions")
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("created");

    result.destroy();
  });
});
