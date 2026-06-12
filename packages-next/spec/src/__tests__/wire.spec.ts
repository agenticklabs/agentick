import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ErrorCode,
  isAppScope,
  isGatewayScope,
  isJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcSuccess,
  isSessionScope,
  type JsonRpcBatch,
  type JsonRpcFrame,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ProgressNotificationParams,
  type RequestMeta,
  type SessionSendParams,
  type SubscribeParams,
  type SubscribeResult,
  type SubscriptionEventParams,
  type SubscriptionScope,
  type WireMethod,
  type WireMethods,
  type WireNotificationMethod,
  type WireNotifications,
  type WireParams,
  type WireResult,
} from "../index.js";

describe("@agentick/spec-next — wire structural tests", () => {
  describe("JSON-RPC envelopes", () => {
    it("constructs a valid request frame", () => {
      const req: JsonRpcRequest<SessionSendParams> = {
        jsonrpc: "2.0",
        id: 7,
        method: "session/send",
        params: { sessionId: "s1", messages: [] },
      };
      expect(req.jsonrpc).toBe("2.0");
    });

    it("constructs a valid success response", () => {
      const res: JsonRpcResponse<SubscribeResult> = {
        jsonrpc: "2.0",
        id: 8,
        result: { subscriptionId: "sub-3" },
      };
      expect(isJsonRpcSuccess(res)).toBe(true);
      expect(isJsonRpcError(res)).toBe(false);
    });

    it("constructs a valid error response with structured data", () => {
      const res: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 9,
        error: {
          code: ErrorCode.SessionNotFound,
          message: "session not found",
          data: { appId: "a1", sessionId: "missing" },
        },
      };
      expect(isJsonRpcError(res)).toBe(true);
      if (isJsonRpcError(res)) {
        expect(res.error.code).toBe(-32010);
      }
    });

    it("constructs a notification with no id", () => {
      const note: JsonRpcNotification<ProgressNotificationParams> = {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: "p1",
          cursor: { value: 42 },
          envelope: {
            id: "evt-1",
            surface: "session",
            name: "session:lifecycle:start",
            phase: "started",
            timestamp: 0,
            scope: {},
          },
        },
      };
      expect("id" in note).toBe(false);
    });
  });

  describe("type guards", () => {
    const req: JsonRpcFrame = { jsonrpc: "2.0", id: 1, method: "ping", params: {} };
    const res: JsonRpcFrame = { jsonrpc: "2.0", id: 1, result: {} };
    const err: JsonRpcFrame = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.InternalError, message: "boom" },
    };
    const note: JsonRpcFrame = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    };

    it("isJsonRpcRequest narrows to JsonRpcRequest", () => {
      expect(isJsonRpcRequest(req)).toBe(true);
      expect(isJsonRpcRequest(res)).toBe(false);
      expect(isJsonRpcRequest(err)).toBe(false);
      expect(isJsonRpcRequest(note)).toBe(false);
    });

    it("isJsonRpcResponse narrows to either success or error response", () => {
      expect(isJsonRpcResponse(req)).toBe(false);
      expect(isJsonRpcResponse(res)).toBe(true);
      expect(isJsonRpcResponse(err)).toBe(true);
      expect(isJsonRpcResponse(note)).toBe(false);
    });

    it("isJsonRpcNotification narrows to notification frame", () => {
      expect(isJsonRpcNotification(req)).toBe(false);
      expect(isJsonRpcNotification(note)).toBe(true);
    });
  });

  describe("batches", () => {
    it("accepts a heterogeneous batch", () => {
      const batch: JsonRpcBatch = [
        { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } },
      ];
      expect(batch).toHaveLength(2);
    });
  });

  describe("error codes", () => {
    it("exposes the canonical numeric values", () => {
      expect(ErrorCode.ParseError).toBe(-32700);
      expect(ErrorCode.RequestCancelled).toBe(-32800);
      expect(ErrorCode.SessionNotFound).toBe(-32010);
      expect(ErrorCode.CursorEvicted).toBe(-32020);
      expect(ErrorCode.ChallengeRequired).toBe(-32030);
    });

    it("ErrorCode type narrows from the const namespace", () => {
      const code: ErrorCode = ErrorCode.AuthRequired;
      expect(typeof code).toBe("number");
    });
  });

  describe("subscription scope", () => {
    it("isGatewayScope narrows to the gateway variant", () => {
      const s: SubscriptionScope = { kind: "gateway" };
      expect(isGatewayScope(s)).toBe(true);
    });

    it("isAppScope narrows to the app variant", () => {
      const s: SubscriptionScope = { kind: "app", id: "a1" };
      expect(isAppScope(s)).toBe(true);
      if (isAppScope(s)) {
        expectTypeOf(s.id).toEqualTypeOf<string>();
      }
    });

    it("isSessionScope narrows to the session variant", () => {
      const s: SubscriptionScope = { kind: "session", id: "s1" };
      expect(isSessionScope(s)).toBe(true);
    });
  });

  describe("RequestMeta", () => {
    it("attaches a progress token via _meta", () => {
      const params: SessionSendParams = {
        sessionId: "s1",
        messages: [],
        _meta: { progressToken: "p-5" },
      };
      const meta: RequestMeta | undefined = params._meta;
      expect(meta?.progressToken).toBe("p-5");
    });
  });

  describe("WireMethods registry", () => {
    it("WireParams<M> resolves params per method", () => {
      expectTypeOf<WireParams<"session/send">>().toEqualTypeOf<SessionSendParams>();
      expectTypeOf<WireParams<"subscribe">>().toEqualTypeOf<SubscribeParams>();
    });

    it("WireResult<M> resolves result per method", () => {
      expectTypeOf<WireResult<"subscribe">>().toEqualTypeOf<SubscribeResult>();
    });

    it("WireMethod is the union of every registered method name", () => {
      const m: WireMethod = "session/send";
      expect(m).toBe("session/send");
      // Should NOT accept an unregistered method
      // @ts-expect-error — unregistered method
      const bogus: WireMethod = "session/nonexistent";
      void bogus;
    });

    it("WireMethods exposes the expected method namespace surface", () => {
      // Compile-time: every namespace's first method exists.
      type _gateway = WireMethods["gateway/listApps"];
      type _app = WireMethods["app/createSession"];
      type _session = WireMethods["session/send"];
      type _subscribe = WireMethods["subscribe"];
      type _auth = WireMethods["auth/refresh"];
      type _ping = WireMethods["ping"];
    });
  });

  describe("WireNotifications registry", () => {
    it("WireNotifications exposes every notification method", () => {
      type _progress = WireNotifications["notifications/progress"];
      type _subEvent = WireNotifications["notifications/subscription/event"];
      type _subEvicted = WireNotifications["notifications/subscription/evicted"];
      type _cancelled = WireNotifications["notifications/cancelled"];
      type _authExpired = WireNotifications["notifications/auth/expired"];
    });

    it("WireNotificationMethod narrows to the notification union", () => {
      const m: WireNotificationMethod = "notifications/subscription/event";
      expect(m).toBe("notifications/subscription/event");
    });

    it("notification param shapes match expectations", () => {
      const subEvent: SubscriptionEventParams = {
        subscriptionId: "sub-1",
        cursor: { value: 7 },
        envelope: {
          id: "evt-1",
          surface: "executor",
          name: "executor:tick:delta",
          phase: "started",
          timestamp: 0,
          scope: {},
        },
      };
      expect(subEvent.cursor.value).toBe(7);
    });
  });
});
