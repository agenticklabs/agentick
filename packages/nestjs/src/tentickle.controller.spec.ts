/**
 * Tests for TentickleController
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";

// Must mock @tentickle/server before importing modules that use it
vi.mock("@tentickle/server", () => {
  // Define inside factory to avoid hoisting issues
  class SessionNotFoundError extends Error {
    constructor(id: string) {
      super(`Session not found: ${id}`);
      this.name = "SessionNotFoundError";
    }
  }

  return {
    setSSEHeaders: vi.fn(),
    createSSEWriter: vi.fn(() => ({
      writeEvent: vi.fn(),
      writeComment: vi.fn(),
      close: vi.fn(),
      closed: false,
    })),
    SessionNotFoundError,
  };
});

// Mock the TentickleService entirely
const mockService = {
  createSession: vi.fn(),
  getSession: vi.fn(),
  sendMessage: vi.fn(),
  tick: vi.fn(),
  abort: vi.fn(),
  createConnection: vi.fn(),
  publishEvent: vi.fn(),
};

vi.mock("./tentickle.service.js", () => ({
  TentickleService: vi.fn().mockImplementation(() => mockService),
}));

import { TentickleController } from "./tentickle.controller.js";
import { TentickleService } from "./tentickle.service.js";
import { SessionNotFoundError } from "@tentickle/server";

describe("TentickleController", () => {
  let controller: TentickleController;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create controller with mocked service
    controller = new TentickleController(mockService as unknown as TentickleService);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Session Endpoints
  // ══════════════════════════════════════════════════════════════════════════

  describe("createSession", () => {
    it("creates session and returns result", async () => {
      mockService.createSession.mockResolvedValue({
        sessionId: "session-123",
        status: "created",
      });

      const result = await controller.createSession({});

      expect(result).toEqual({
        sessionId: "session-123",
        status: "created",
      });
    });

    it("passes sessionId and props to service", async () => {
      mockService.createSession.mockResolvedValue({
        sessionId: "custom-id",
        status: "created",
      });

      await controller.createSession({
        sessionId: "custom-id",
        props: { userId: "user-1" },
      });

      expect(mockService.createSession).toHaveBeenCalledWith({
        sessionId: "custom-id",
        props: { userId: "user-1" },
      });
    });
  });

  describe("getSession", () => {
    it("returns session state", async () => {
      const state = {
        sessionId: "session-123",
        status: "idle",
        tick: 5,
        queuedMessages: 0,
      };
      mockService.getSession.mockReturnValue(state);

      const result = await controller.getSession("session-123");

      expect(result).toEqual(state);
    });

    it("throws SessionNotFoundError when session not found (filter converts to 404)", async () => {
      mockService.getSession.mockImplementation(() => {
        throw new SessionNotFoundError("unknown");
      });

      await expect(controller.getSession("unknown")).rejects.toThrow(
        SessionNotFoundError
      );
    });
  });

  describe("sendMessage", () => {
    it("sends message and returns result", async () => {
      mockService.sendMessage.mockResolvedValue({
        success: true,
        response: "Hello!",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const result = await controller.sendMessage("session-123", {
        content: "Hi",
      });

      expect(result).toEqual({
        success: true,
        response: "Hello!",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    });

    it("passes content and role to service", async () => {
      mockService.sendMessage.mockResolvedValue({
        success: true,
        response: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });

      await controller.sendMessage("session-123", { content: "Hi" });

      expect(mockService.sendMessage).toHaveBeenCalledWith(
        "session-123",
        "Hi",
        undefined
      );
    });

    it("uses provided role", async () => {
      mockService.sendMessage.mockResolvedValue({
        success: true,
        response: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });

      await controller.sendMessage("session-123", {
        content: "Hi",
        role: "assistant",
      });

      expect(mockService.sendMessage).toHaveBeenCalledWith(
        "session-123",
        "Hi",
        "assistant"
      );
    });

    it("throws SessionNotFoundError when session not found (filter converts to 404)", async () => {
      mockService.sendMessage.mockRejectedValue(
        new SessionNotFoundError("unknown")
      );

      await expect(
        controller.sendMessage("unknown", { content: "Hi" })
      ).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe("tick", () => {
    it("triggers tick and returns result", async () => {
      mockService.tick.mockResolvedValue({
        success: true,
        response: "Thought...",
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      });

      const result = await controller.tick("session-123", {});

      expect(result).toEqual({
        success: true,
        response: "Thought...",
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      });
    });

    it("passes props to service", async () => {
      mockService.tick.mockResolvedValue({
        success: true,
        response: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });

      await controller.tick("session-123", { props: { mode: "fast" } });

      expect(mockService.tick).toHaveBeenCalledWith("session-123", {
        mode: "fast",
      });
    });

    it("throws SessionNotFoundError when session not found (filter converts to 404)", async () => {
      mockService.tick.mockRejectedValue(new SessionNotFoundError("unknown"));

      await expect(controller.tick("unknown", {})).rejects.toThrow(
        SessionNotFoundError
      );
    });
  });

  describe("abort", () => {
    it("aborts session", async () => {
      mockService.abort.mockReturnValue(undefined);

      const result = await controller.abort("session-123", {});

      expect(mockService.abort).toHaveBeenCalledWith("session-123", undefined);
      expect(result).toEqual({ success: true });
    });

    it("passes reason to service", async () => {
      mockService.abort.mockReturnValue(undefined);

      await controller.abort("session-123", { reason: "User cancelled" });

      expect(mockService.abort).toHaveBeenCalledWith(
        "session-123",
        "User cancelled"
      );
    });

    it("throws SessionNotFoundError when session not found (filter converts to 404)", async () => {
      mockService.abort.mockImplementation(() => {
        throw new SessionNotFoundError("unknown");
      });

      await expect(controller.abort("unknown", {})).rejects.toThrow(
        SessionNotFoundError
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Event Endpoints
  // ══════════════════════════════════════════════════════════════════════════

  describe("events (SSE)", () => {
    it("throws 400 when sessionId is missing", async () => {
      const mockRes = { on: vi.fn() };

      await expect(
        controller.events(undefined as any, undefined, mockRes as any)
      ).rejects.toThrow(
        new HttpException("sessionId is required", HttpStatus.BAD_REQUEST)
      );
    });

    it("calls createConnection with correct params", async () => {
      mockService.createConnection.mockReturnValue({
        connectionId: "conn-123",
        writer: { writeEvent: vi.fn(), close: vi.fn() },
        cleanup: vi.fn(),
      });

      const mockRes = { on: vi.fn() };

      await controller.events("session-123", "user-456", mockRes as any);

      expect(mockService.createConnection).toHaveBeenCalledWith(
        "session-123",
        mockRes,
        "user-456"
      );
    });

    it("throws SessionNotFoundError when session not found (filter converts to 404)", async () => {
      mockService.createConnection.mockImplementation(() => {
        throw new SessionNotFoundError("unknown");
      });

      const mockRes = { on: vi.fn() };

      await expect(
        controller.events("unknown", undefined, mockRes as any)
      ).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe("postEvent", () => {
    it("handles event", async () => {
      mockService.publishEvent.mockResolvedValue(undefined);

      const result = await controller.postEvent({
        connectionId: "conn-123",
        channel: "session",
        type: "message",
        payload: { content: "Hi" },
      });

      expect(mockService.publishEvent).toHaveBeenCalledWith("conn-123", {
        channel: "session",
        type: "message",
        payload: { content: "Hi" },
        id: undefined,
      });
      expect(result).toEqual({ success: true });
    });

    it("throws 400 when connectionId is missing", async () => {
      await expect(
        controller.postEvent({
          connectionId: "",
          channel: "session",
          type: "message",
          payload: {},
        })
      ).rejects.toThrow(
        new HttpException("connectionId is required", HttpStatus.BAD_REQUEST)
      );
    });

    it("throws 400 when channel is missing", async () => {
      await expect(
        controller.postEvent({
          connectionId: "conn-123",
          channel: "",
          type: "message",
          payload: {},
        })
      ).rejects.toThrow(
        new HttpException("channel is required", HttpStatus.BAD_REQUEST)
      );
    });

    it("throws 400 when type is missing", async () => {
      await expect(
        controller.postEvent({
          connectionId: "conn-123",
          channel: "session",
          type: "",
          payload: {},
        })
      ).rejects.toThrow(
        new HttpException("type is required", HttpStatus.BAD_REQUEST)
      );
    });

    it("passes event id when provided", async () => {
      mockService.publishEvent.mockResolvedValue(undefined);

      await controller.postEvent({
        connectionId: "conn-123",
        channel: "session",
        type: "message",
        payload: {},
        id: "event-456",
      });

      expect(mockService.publishEvent).toHaveBeenCalledWith("conn-123", {
        channel: "session",
        type: "message",
        payload: {},
        id: "event-456",
      });
    });
  });
});
