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
  scopeCovers,
  WireRpcError,
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
  type WireMethod,
  type WireMethodAuth,
  type IngressIdentity,
  type WireExtensionContext,
  type WireExtensionTransport,
  type WireNotificationMethod,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

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
  /** Ingress identity established at connection/request time (ADR 34/51). */
  identity?: IngressIdentity,
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
        // ── THE authorization choke point (ADR 51 §3.3/§4.3, review
        // finding: the porcelain lane shipped ungated). EVERY resolved
        // method — porcelain and dynamic — is authorized here with its
        // verb-derived scope label (`session/send` → `session:send`),
        // BEFORE the handler runs. The target session's owning
        // principal (structural identity, ADR 48) feeds the
        // same-principal rule. Bootstrap methods (initialize / ping /
        // _extensions/list) returned above and are deliberately
        // pre-auth.
        await authorizeDispatch(
          host,
          req.method,
          req.params,
          identity,
          resolution.extension.auth?.[req.method as WireMethod],
        );
        const ctx = buildWireExtensionContext(
          host,
          resolution.extension,
          req.id,
          req.params,
          sink,
          identity,
        );
        try {
          // ADR 83 §"Wire dispatch through the seam": route the handler
          // call through the gateway's operation seam so the wire method
          // fires the gateway's interceptor seam (gateway-scoped
          // guards/hooks), keyed by the wire method as op name. Auth
          // (above) stays the un-waivable pre-gate — it runs BEFORE the op.
          const result = await host.runWireDispatch(req.method as WireMethod, req.params, () =>
            resolution.handler(req.params, ctx),
          );
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
    // WireRpcError carries its own code/message/data — map verbatim
    // (the dynamic command lane's Forbidden / MethodNotFound / etc.).
    if (e instanceof WireRpcError) {
      return errorResponse(req.id, e.code, e.message, e.data);
    }
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

/** Verb-derived scope label: `a/b` → `a:b` (ADR 51 §3.3 — one label
 *  covers both lanes; grants are written once). */
function methodScope(method: string): string {
  const slash = method.indexOf("/");
  return slash > 0 ? `${method.slice(0, slash)}:${method.slice(slash + 1)}` : method;
}

/**
 * The single wire authorization gate. Resolves the TARGET session's
 * owning principal (when params name a session) so the Authorizer's
 * same-principal rule has real input — before this fix the gate only
 * ever saw `{ sessionId }` and the rule was structurally dead (review
 * finding: cross-principal access under surface-glob grants).
 *
 * The optional `methodAuth` is the resolved extension's declared
 * {@link WireMethodAuth} for this method (ADR 46 `WireExtension.auth`),
 * finally wired in:
 *   - `required: false` → OPEN: the authorizer POLICY is skipped (the
 *     structural ceiling below still applies — it is un-waivable). For
 *     the rare method with no gated dynamic-lane counterpart.
 *   - `scope` (a declared role, e.g. `"admin"`) → checked ADDITIVELY, ON
 *     TOP of the verb-derived scope — NEVER as a replacement. ADR 51 §3.3
 *     (anti-bypass): a porcelain method's authz label is its verb name and
 *     cannot be relabeled to reach a verb the plumbing lane would deny; an
 *     additive role can only tighten, never widen. So a role-gated method
 *     requires BOTH `verb:scope` AND the role.
 *   - absent → verb-derived scope, gated (the default; unchanged).
 */
async function authorizeDispatch(
  host: DispatchHost,
  method: string,
  rawParams: unknown,
  identity: IngressIdentity | undefined,
  methodAuth?: WireMethodAuth,
): Promise<void> {
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  // NOTE: session resolution keys on the `sessionId` param by
  // convention — the same convention buildWireExtensionContext uses.
  // TODO(trail-session-resolution-seam): methods that reach a session
  // via other params (a future app/run_once) must route through the
  // same resolution or the ceiling won't see them.
  const targetSession = sessionId ? findSessionOrUndef(host, sessionId) : undefined;
  // #199 — the target session's scope CEILING is structural (resource-
  // declared, like its principal) and checked BEFORE policy AND before
  // the no-authorizer short-circuit: no authorizer — including an
  // absent one — can waive it (review finding: it sat behind the
  // guard). Cover-aware: a star/glob claim satisfies its members.
  // Applies EVEN to `required: false` methods — the ceiling is a
  // resource constraint, orthogonal to a method's policy openness.
  const requiredScopes = targetSession?.requiredScopes;
  if (requiredScopes !== undefined && requiredScopes.length > 0) {
    const held = identity?.scopes ?? [];
    if (!requiredScopes.every((req) => held.some((claim) => scopeCovers(claim, req)))) {
      throw WireRpcError.forbidden(methodScope(method));
    }
  }

  // Declared-open methods skip the authorizer POLICY (the ceiling above
  // still applied). Absent declaration → gated (the default).
  if (methodAuth?.required === false) return;

  const authorizer = host.authorizer;
  if (!authorizer) return; // hosts without a policy (bare test hosts) are trusted-domain

  const target =
    sessionId !== undefined
      ? { sessionId, ...omitUndefined({ principal: targetSession?.principal }) }
      : undefined;
  const authInput = (scope: string) => ({
    scope,
    ...omitUndefined({ principal: identity?.principal, tokenScopes: identity?.scopes, target }),
  });

  // The verb-derived scope is ALWAYS required — the §3.3 anti-bypass label.
  const verbScope = methodScope(method);
  if (!(await authorizer.authorize(authInput(verbScope))).allowed) {
    throw WireRpcError.forbidden(verbScope);
  }
  // A declared role is ADDITIVE — required ON TOP of the verb scope, never
  // in place of it. Both must pass; the verb gate is never widened.
  if (methodAuth?.scope !== undefined) {
    if (!(await authorizer.authorize(authInput(methodAuth.scope))).allowed) {
      throw WireRpcError.forbidden(methodAuth.scope);
    }
  }
}

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
  identity?: IngressIdentity,
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
    // Authn happened ONCE at ingress (ADR 51 §4.1); dispatch only
    // carries the stamped identity. The dynamic command lane's
    // Authorizer gate consumes it.
    ...omitUndefined({ principal: identity?.principal, app, session }),
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
    // ADR 64 / #19-progress-wire: `ctx.progress` bus signals are bridged
    // to this reporter in `sessionWireExtension["session/send"]`
    // (@agentick/gateway-next) — the send handler owns both the caller's
    // `_meta.progressToken` (→ this reporter) AND the executionId to
    // scope the signal subscription, so the stitch lives there, not in
    // this transport-generic slot builder. This slot just wraps each
    // pushed envelope in the wire `notifications/progress` frame.
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
