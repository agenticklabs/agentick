/**
 * JSON-RPC frame → harness-method dispatch.
 *
 * Pure logic — no transport coupling. The same dispatcher will serve
 * the HTTP and Unix-socket server adapters in Phase 33.D / 33.E.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import {
  ErrorCode,
  type AppCreateSessionParams,
  type AppGetSessionParams,
  type AppHarnessProtocol,
  type AppListSessionsParams,
  type EventEnvelope,
  type GatewayHarnessProtocol,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SessionAbortParams,
  type SessionCloseParams,
  type SessionDispatchParams,
  type SessionHarnessProtocol,
  type SessionSendParams,
  type SubscribeParams,
  type UnsubscribeParams,
} from "@agentick/spec-next";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

/**
 * A `DispatchHost` is anything that satisfies `GatewayHarnessProtocol`.
 * The wire dispatcher calls into the gateway's methods; per-connection
 * concerns (auth context, in-flight tracking) live on the server-side
 * extension wrapper, not here.
 */
export type DispatchHost = GatewayHarnessProtocol;

export interface DispatchSink {
  sendNotification(notification: { method: string; params?: unknown }): void;
  registerSubscription(subId: string, unsubscribe: () => Promise<void>): void;
  unregisterSubscription(subId: string): void;
  /**
   * Register an in-flight RPC so `notifications/cancelled` can abort it.
   * Cleared automatically when the dispatch returns.
   */
  registerInFlight(id: JsonRpcId, abort: () => void): void;
  unregisterInFlight(id: JsonRpcId): void;
}

export async function dispatchRequest(
  host: DispatchHost,
  req: JsonRpcRequest,
  sink: DispatchSink,
): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case "initialize":
        return success(req.id, initialize(req.params as InitializeParams));
      case "ping":
        return success(req.id, {});
      case "gateway/listApps":
        return success(req.id, {
          apps: host.apps().map((a) => ({ id: a.id })),
        });
      case "gateway/getApp": {
        const params = req.params as { appId: string };
        const app = host.app(params.appId);
        if (!app)
          return errorResponse(req.id, ErrorCode.AppNotFound, "app not found", {
            appId: params.appId,
          });
        return success(req.id, { id: app.id });
      }
      case "app/createSession": {
        const params = req.params as AppCreateSessionParams;
        const app = requireApp(host, params.appId);
        if (isError(app)) return errorResponse(req.id, app.code, app.message, app.data);
        const session = await app.createSession({
          sessionId: params.sessionId,
          metadata: params.metadata,
        });
        return success(req.id, { sessionId: session.id });
      }
      case "app/getSession": {
        const params = req.params as AppGetSessionParams;
        const app = requireApp(host, params.appId);
        if (isError(app)) return errorResponse(req.id, app.code, app.message, app.data);
        const entry = app.listSessions().find((e) => e.id === params.sessionId);
        if (!entry) {
          return errorResponse(req.id, ErrorCode.SessionNotFound, "session not found", {
            appId: params.appId,
            sessionId: params.sessionId,
          });
        }
        return success(req.id, entry);
      }
      case "app/listSessions": {
        const params = req.params as AppListSessionsParams;
        const app = requireApp(host, params.appId);
        if (isError(app)) return errorResponse(req.id, app.code, app.message, app.data);
        return success(req.id, { sessions: app.listSessions(params.filter) });
      }
      case "session/send": {
        const params = req.params as SessionSendParams;
        const sess = requireSession(host, params.sessionId);
        if (isError(sess)) return errorResponse(req.id, sess.code, sess.message, sess.data);
        return dispatchSessionSend(req.id, sess, params, sink);
      }
      case "session/dispatch": {
        const params = req.params as SessionDispatchParams;
        const sess = requireSession(host, params.sessionId);
        if (isError(sess)) return errorResponse(req.id, sess.code, sess.message, sess.data);
        const content = await sess.dispatch(params.tool, params.input as Record<string, unknown>);
        return success(req.id, { content });
      }
      case "session/abort": {
        // SessionHarnessProtocol exposes abort() on the SessionExecutionHandle
        // returned from send(), not on the session itself. Wiring session-level
        // abort requires per-session active-handle tracking on the server adapter.
        // Deferred — Phase 33.C ships the wire method; the adapter tracking
        // lands when the GatewayExtension wrapper is built.
        const params = req.params as SessionAbortParams;
        const sess = requireSession(host, params.sessionId);
        if (isError(sess)) return errorResponse(req.id, sess.code, sess.message, sess.data);
        return success(req.id, null);
      }
      case "session/close": {
        const params = req.params as SessionCloseParams;
        const sess = requireSession(host, params.sessionId);
        if (isError(sess)) return errorResponse(req.id, sess.code, sess.message, sess.data);
        await sess.close();
        return success(req.id, null);
      }
      case "subscribe": {
        const params = req.params as SubscribeParams;
        return startSubscription(req.id, host, params, sink);
      }
      case "unsubscribe": {
        const params = req.params as UnsubscribeParams;
        sink.unregisterSubscription(params.subscriptionId);
        return success(req.id, null);
      }
      default:
        return errorResponse(req.id, ErrorCode.MethodNotFound, `no such method: ${req.method}`);
    }
  } catch (e) {
    return errorResponse(req.id, ErrorCode.InternalError, "internal error", {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

// ============================================================================
// session/send — RPC + progress notifications when _meta.progressToken set
// ============================================================================

async function dispatchSessionSend(
  reqId: JsonRpcId,
  session: SessionHarnessProtocol,
  params: SessionSendParams,
  sink: DispatchSink,
): Promise<JsonRpcResponse> {
  const progressToken = params._meta?.progressToken;

  const handle = await session.send({
    messages: params.messages,
    props: params.props,
    metadata: params.metadata,
    maxTicks: params.maxTicks,
    stream: params.stream,
    target: params.target,
  });

  // Register the handle for cancellation via notifications/cancelled.
  sink.registerInFlight(reqId, () => {
    void handle.abort("client cancelled");
  });

  if (progressToken) {
    // Drain handle's AsyncIterable; forward each event as
    // notifications/progress with a synthetic cursor counter.
    let cursorN = 0;
    (async () => {
      try {
        for await (const event of handle) {
          sink.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              cursor: { value: ++cursorN },
              envelope: {
                id: `progress-${cursorN}`,
                surface: "session",
                name: "session:execution:event",
                phase: "started",
                timestamp: Date.now(),
                scope: { sessionId: session.id },
                payload: event,
              },
            },
          });
        }
      } catch {
        /* the result-Promise below carries the error */
      }
    })();
  }

  try {
    const result = await handle.result;
    return success(reqId, {
      executionId: handle.executionId,
      finalCursor: { value: 0 },
      result,
    });
  } finally {
    sink.unregisterInFlight(reqId);
  }
}

// ============================================================================
// subscribe — open a bus subscription on the gateway / app / session scope
// ============================================================================

let subscriptionCounter = 0;

function startSubscription(
  reqId: JsonRpcId,
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
  sink: DispatchSink,
): JsonRpcResponse {
  const subscriptionId = `srv-sub-${++subscriptionCounter}`;
  const eventsIterable = openScopeEvents(gateway, params);
  if (!eventsIterable) {
    return errorResponse(reqId, ErrorCode.AppNotFound, "scope not found");
  }

  let cursorN = 0;
  let cancelled = false;

  (async () => {
    try {
      for await (const envelope of eventsIterable) {
        if (cancelled) return;
        sink.sendNotification({
          method: "notifications/subscription/event",
          params: {
            subscriptionId,
            cursor: { value: ++cursorN },
            envelope,
          },
        });
      }
    } catch (e) {
      sink.sendNotification({
        method: "notifications/subscription/closed",
        params: {
          subscriptionId,
          reason: { code: ErrorCode.InternalError, message: String(e) },
        },
      });
    }
  })();

  sink.registerSubscription(subscriptionId, async () => {
    cancelled = true;
  });

  return success(reqId, { subscriptionId });
}

function openScopeEvents(
  gateway: GatewayHarnessProtocol,
  params: SubscribeParams,
): AsyncIterable<EventEnvelope> | null {
  const scope = params.scope;
  if (scope.kind === "gateway") {
    return gateway.events(params.query) as AsyncIterable<EventEnvelope>;
  }
  if (scope.kind === "app") {
    const app = gateway.app(scope.id);
    if (!app) return null;
    return app.events(params.query) as AsyncIterable<EventEnvelope>;
  }
  if (scope.kind === "session") {
    // Session events live on the owning app's bus, scoped by sessionId.
    for (const app of gateway.apps()) {
      const sess = app.getSession(scope.id);
      if (sess) {
        const query = {
          ...(params.query ?? {}),
          scope: { ...(params.query?.scope ?? {}), sessionId: scope.id },
        };
        return app.events(query) as AsyncIterable<EventEnvelope>;
      }
    }
    return null;
  }
  return null;
}

// ============================================================================
// initialize
// ============================================================================

function initialize(_params: InitializeParams): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: {
      cursorResume: true,
      streamableHttp: false,
      batch: true,
      subscriptions: true,
      progress: true,
      cancellation: true,
      mcpSurface: false,
    },
    serverInfo: { name: "@agentick/transport-websocket-next", version: "0.0.0" },
    connectionId: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

// ============================================================================
// helpers
// ============================================================================

type Located<T> = T | { __error: true; code: number; message: string; data?: unknown };

function isError<T>(
  v: Located<T>,
): v is { __error: true; code: number; message: string; data?: unknown } {
  return typeof v === "object" && v !== null && "__error" in v;
}

function requireApp(gateway: GatewayHarnessProtocol, appId: string): Located<AppHarnessProtocol> {
  const app = gateway.app(appId);
  if (!app)
    return {
      __error: true,
      code: ErrorCode.AppNotFound,
      message: "app not found",
      data: { appId },
    };
  return app;
}

function requireSession(
  gateway: GatewayHarnessProtocol,
  sessionId: string,
): Located<SessionHarnessProtocol> {
  for (const app of gateway.apps()) {
    const sess = app.getSession(sessionId);
    if (sess) return sess;
  }
  return {
    __error: true,
    code: ErrorCode.SessionNotFound,
    message: "session not found",
    data: { sessionId },
  };
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id as JsonRpcId,
    error: { code, message, data },
  };
}

// Effect-typed helpers may be needed later; the named imports above keep
// the module ready for streaming dispatchers (Effect.Fiber for cancellation,
// Stream.toAsyncIterable for bus → wire fan-out) that ship in 33.D.
void Effect;
void Fiber;
void Stream;
