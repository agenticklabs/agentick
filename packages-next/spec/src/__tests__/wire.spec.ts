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
  validateJsonRpcFrame,
  validateJsonRpcInput,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcBatch,
  type JsonRpcErrorResponse,
  type JsonRpcFrame,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
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
    it("constructs a valid request frame with role-bearing messages", () => {
      const req: JsonRpcRequest<SessionSendParams> = {
        jsonrpc: "2.0",
        id: 7,
        method: "session/send",
        params: {
          sessionId: "s1",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
          ],
          _meta: { progressToken: "p-1" },
        },
      };
      expect(req.jsonrpc).toBe("2.0");
      expect(req.params?.messages?.[0]?.role).toBe("user");
    });

    it("rejects responses that carry both result and error at the type level", () => {
      const bad1: JsonRpcSuccessResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: {},
        // @ts-expect-error — JsonRpcSuccessResponse forbids `error`
        error: { code: -32000, message: "x" },
      };
      void bad1;
      const bad2: JsonRpcErrorResponse = {
        jsonrpc: "2.0",
        id: 1,
        // @ts-expect-error — JsonRpcErrorResponse forbids `result`
        result: {},
        error: { code: -32000, message: "x" },
      };
      void bad2;
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
            phase: "before",
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

  describe("initialize handshake", () => {
    it("constructs a valid initialize request + response", () => {
      const req: JsonRpcRequest<InitializeParams> = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "v1",
          capabilities: { cursorResume: true, batch: true },
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      };
      const res: InitializeResult = {
        protocolVersion: "v1",
        capabilities: { cursorResume: true, subscriptions: true, progress: true },
        serverInfo: { name: "test-gateway", version: "0.0.1" },
        connectionId: "conn-1",
      };
      expect(req.params?.protocolVersion).toBe("v1");
      expect(res.connectionId).toBe("conn-1");
    });
  });

  describe("validator — well-formed frames", () => {
    it("validates a request", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: {},
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(isJsonRpcRequest(r.value)).toBe(true);
    });

    it("validates a success response", () => {
      const r = validateJsonRpcFrame({ jsonrpc: "2.0", id: 1, result: {} });
      expect(r.ok).toBe(true);
      if (r.ok) expect(isJsonRpcResponse(r.value)).toBe(true);
    });

    it("validates an error response", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "boom" },
      });
      expect(r.ok).toBe(true);
    });

    it("validates an error response with null id (for parse errors per spec)", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      expect(r.ok).toBe(true);
    });

    it("validates a notification", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(isJsonRpcNotification(r.value)).toBe(true);
    });

    it("validates a batch", () => {
      const r = validateJsonRpcInput([
        { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } },
      ]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(Array.isArray(r.value)).toBe(true);
    });
  });

  describe("validator — malformed input rejected", () => {
    it("rejects non-objects", () => {
      expect(validateJsonRpcFrame("not an object").ok).toBe(false);
      expect(validateJsonRpcFrame(null).ok).toBe(false);
      expect(validateJsonRpcFrame(42).ok).toBe(false);
    });

    it("rejects missing or wrong jsonrpc version", () => {
      const r = validateJsonRpcFrame({ id: 1, method: "ping" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(ErrorCode.InvalidRequest);

      const r2 = validateJsonRpcFrame({ jsonrpc: "1.0", id: 1, method: "ping" });
      expect(r2.ok).toBe(false);
    });

    it("rejects requests with non-string method", () => {
      const r = validateJsonRpcFrame({ jsonrpc: "2.0", id: 1, method: 42 });
      expect(r.ok).toBe(false);
    });

    it("rejects requests with invalid id type", () => {
      const r = validateJsonRpcFrame({ jsonrpc: "2.0", id: true, method: "ping" });
      expect(r.ok).toBe(false);
    });

    it("rejects responses carrying both result and error", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -32000, message: "x" },
      });
      expect(r.ok).toBe(false);
    });

    it("rejects responses carrying neither result nor error", () => {
      const r = validateJsonRpcFrame({ jsonrpc: "2.0", id: 1 });
      expect(r.ok).toBe(false);
    });

    it("rejects errors without code or message", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "x" },
      });
      expect(r.ok).toBe(false);

      const r2 = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000 },
      });
      expect(r2.ok).toBe(false);
    });

    it("rejects empty batches", () => {
      const r = validateJsonRpcInput([]);
      expect(r.ok).toBe(false);
    });

    it("rejects params that aren't object or array", () => {
      const r = validateJsonRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: 42,
      });
      expect(r.ok).toBe(false);
    });
  });

  describe("validator — wire JSON roundtrip", () => {
    const samples: Array<JsonRpcFrame> = [
      { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
      { jsonrpc: "2.0", id: 2, result: { ok: true } },
      { jsonrpc: "2.0", id: 3, error: { code: -32010, message: "missing" } },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: "p1",
          cursor: { value: 7 },
          envelope: {
            id: "e1",
            surface: "executor",
            name: "executor:tick:delta",
            phase: "before",
            timestamp: 0,
            scope: {},
          },
        },
      },
    ];

    it("every frame shape survives JSON.stringify/parse + validation", () => {
      for (const sample of samples) {
        const text = JSON.stringify(sample);
        const parsed = JSON.parse(text);
        const r = validateJsonRpcFrame(parsed);
        expect(r.ok).toBe(true);
      }
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
      type _initialize = WireMethods["initialize"];
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
          phase: "before",
          timestamp: 0,
          scope: {},
        },
      };
      expect(subEvent.cursor.value).toBe(7);
    });
  });
});
