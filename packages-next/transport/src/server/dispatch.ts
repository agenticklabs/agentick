/**
 * JSON-RPC frame → harness-method dispatch.
 *
 * Pure logic — no transport coupling. The same dispatcher serves
 * every `@agentick/transport-*-next` server adapter.
 *
 * Post-#295 (Phase B/C) + #303 (streaming primitives):
 * dispatch is uniform across ALL framework methods except three
 * bootstrap builtins (`initialize`, `ping`, `_extensions/list`).
 * Every other framework method — including `session/send`,
 * `sub/subscribe`, `sub/unsubscribe` — is a `WireExtension` value
 * registered on `GatewayHarness` construction, dispatched through
 * the same registry adopter extensions use.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import {
  ErrorCode,
  isAgentickError,
  type ExtensionsListResult,
  type GatewayHarnessProtocol,
  type HookBridges,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ProgressReporter,
  type SessionHarnessProtocol,
  type SubscriptionHandle,
  type WireExtension,
  type WireExtensionContext,
  type WireExtensionTransport,
  type WireNotificationMethod,
} from "@agentick/spec-next";

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

/**
 * Module-scoped subscription-id counter. IDs need to be unique within
 * a connection; using a module counter is stronger than needed but
 * costs nothing and matches the prior implementation.
 */
let subscriptionCounter = 0;

export async function dispatchRequest(
  host: DispatchHost,
  req: JsonRpcRequest,
  sink: DispatchSink,
): Promise<JsonRpcResponse> {
  try {
    // Bootstrap methods dispatched directly — must resolve BEFORE the
    // extension registry (initialize runs before the registry is
    // observable; _extensions/list reads the registry itself; ping
    // is stateless keepalive).
    switch (req.method) {
      case "initialize":
        return success(req.id, initialize(req.params as InitializeParams));
      case "ping":
        return success(req.id, {});
      case "_extensions/list": {
        // Capability discovery (ADR 46 §Discovery). Reads the sealed
        // registry that the gateway populated at construction.
        const registry = host.wireExtensions?.();
        const extensions = registry ? registry.enumerate() : [];
        const result: ExtensionsListResult = { extensions };
        return success(req.id, result);
      }
    }

    // Registry-based dispatch. Framework-supplied extensions
    // (gateway/*, app/*, session/*, sub/*) register on GatewayHarness
    // construction; adopter-supplied extensions register after.
    // Both resolve through this single path.
    const registry = host.wireExtensions?.();
    if (registry) {
      const resolution = registry.resolve(req.method);
      if (resolution) {
        const ctx = buildWireExtensionContext(host, resolution.extension, req.id, req.params, sink);
        try {
          const result = await resolution.handler(req.params, ctx);
          return success(req.id, result);
        } finally {
          // Streaming handlers may have registered a cancel callback
          // via `ctx.transport.registerCancel(...)`; clear it now
          // that the RPC has returned. No-op if not registered.
          sink.unregisterInFlight(req.id);
        }
      }
    }

    return errorResponse(req.id, ErrorCode.MethodNotFound, `no such method: ${req.method}`);
  } catch (e) {
    // Typed AgentickError → JSON-RPC error with the class's own
    // wire-code mapping when the class provides one; falls back to
    // InternalError with a `reason` describing the tag. Payload is
    // the error's canonical `toJSON()` projection (kept in sync by
    // the AgentickError base class).
    if (isAgentickError(e)) {
      const wireCode = agentickErrorToWireCode(e);
      return errorResponse(req.id, wireCode, e.message, e.toJSON());
    }
    return errorResponse(req.id, ErrorCode.InternalError, "internal error", {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Map an {@link AgentickError} subclass to the matching JSON-RPC
 * error code. Explicit table keeps the mapping tight — new tags
 * default to `InternalError` until wired.
 */
function agentickErrorToWireCode(err: { readonly _tag: string }): number {
  switch (err._tag) {
    case "AppNotFoundError":
      return ErrorCode.AppNotFound;
    case "SessionNotFoundError":
      return ErrorCode.SessionNotFound;
    case "AppAlreadyExistsError":
      return ErrorCode.InvalidParams;
    case "AppClosedError":
    case "SessionClosedError":
    case "GatewayClosedError":
      return ErrorCode.InvalidRequest;
    case "ValidationFailed":
    case "InvalidPayload":
    case "InvalidDispatchInput":
      return ErrorCode.InvalidParams;
    case "ToolNotFoundError":
    case "SkillNotFound":
    case "PromptNotFound":
    case "McpServerNotFound":
      return ErrorCode.MethodNotFound;
    default:
      return ErrorCode.InternalError;
  }
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
// WireExtension context builder — ADR 46
// ============================================================================

/**
 * Build the {@link WireExtensionContext} that gets passed to a wire
 * extension handler. Resolves `session` / `app` from
 * `params.sessionId` / `params.appId`, wires `publish` to validate
 * against the extension's declared notifications, and constructs the
 * `transport` slot backed by the connection's {@link DispatchSink}.
 *
 * Consistency: when params carry BOTH `sessionId` and `appId`,
 * the builder validates the session belongs to the named app.
 * Inconsistent params surface as `app` set to the requested value
 * but `session` unresolved — the handler then throws
 * `SessionNotFoundError`. This is defense in depth: adopter
 * handlers can trust that if both slots are populated, they're
 * consistent.
 *
 * `bridges()` returns an empty proxy for now — no
 * framework-shipped extension consumes it. Phase F
 * (`mcpControlWireExtension`) will resolve `HookBridges` from the
 * session's session-extension registry.
 */
function buildWireExtensionContext(
  host: DispatchHost,
  extension: WireExtension,
  reqId: JsonRpcId,
  rawParams: unknown,
  sink: DispatchSink,
): WireExtensionContext {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  const appId = typeof params.appId === "string" ? params.appId : undefined;

  const app = appId ? host.app(appId) : undefined;
  let session = sessionId ? findSessionOrUndef(host, sessionId) : undefined;

  // Consistency check — if both appId and sessionId are provided, the
  // session must live under that app. Mismatch drops `session` to
  // undefined; the handler surfaces SessionNotFoundError.
  if (session && appId && app) {
    const owned = app.getSession(session.id);
    if (!owned) session = undefined;
  }

  const declaredNotifications = new Set<string>(extension.notifications ?? []);
  const transport = buildTransportSlot(reqId, sink);

  return {
    gateway: host,
    ...(app ? { app } : {}),
    ...(session ? { session } : {}),
    // TODO(phase-F): resolve HookBridges from the session's session-extension
    // registry when the mcpControlWireExtension needs `ctx.bridges().mcp`.
    // For Phase B/C, no framework-shipped extension uses bridges — the empty
    // object honors the type without lying about behavior.
    bridges: (): HookBridges => ({}) as HookBridges,
    publish: <K extends WireNotificationMethod>(name: K, notifParams: unknown) => {
      // Undeclared publish always rejects — an extension without a
      // `notifications` array is declaring "I publish nothing." Extensions
      // that want to publish MUST declare the names they own.
      if (!declaredNotifications.has(name)) {
        throw new Error(
          `extension "${extension.name}" cannot publish "${name}" — ` +
            `${extension.notifications ? "not in its declared notifications list" : "no notifications declared"}.`,
        );
      }
      sink.sendNotification({ method: name, params: notifParams });
    },
    transport,
  };
}

/**
 * Construct the {@link WireExtensionTransport} slot backed by the
 * connection's `DispatchSink`. Encapsulates the framework's wire
 * conventions (`notifications/progress`,
 * `notifications/subscription/event`, etc.) so extension handlers
 * don't hardcode them.
 */
function buildTransportSlot(reqId: JsonRpcId, sink: DispatchSink): WireExtensionTransport {
  return {
    progress(progressToken): ProgressReporter {
      let cursor = 0;
      return {
        push(envelope) {
          sink.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              cursor: { value: ++cursor },
              envelope,
            },
          });
        },
      };
    },
    registerCancel(abort: () => void) {
      sink.registerInFlight(reqId, abort);
    },
    registerSubscription(cleanup: () => Promise<void>): SubscriptionHandle {
      const id = `srv-sub-${++subscriptionCounter}`;
      let cursor = 0;
      sink.registerSubscription(id, cleanup);
      return {
        id,
        publish(envelope) {
          sink.sendNotification({
            method: "notifications/subscription/event",
            params: {
              subscriptionId: id,
              cursor: { value: ++cursor },
              envelope,
            },
          });
        },
        close(reason) {
          sink.sendNotification({
            method: "notifications/subscription/closed",
            params: {
              subscriptionId: id,
              reason: reason ?? null,
            },
          });
        },
      };
    },
    closeSubscription(subscriptionId: string): void {
      sink.unregisterSubscription(subscriptionId);
    },
  };
}

function findSessionOrUndef(
  host: GatewayHarnessProtocol,
  sessionId: string,
): SessionHarnessProtocol | undefined {
  for (const app of host.apps()) {
    const sess = app.getSession(sessionId);
    if (sess) return sess;
  }
  return undefined;
}

// ============================================================================
// helpers
// ============================================================================

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
