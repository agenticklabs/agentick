/**
 * JSON-RPC frame → harness-method dispatch.
 *
 * Pure logic — no transport coupling. The same dispatcher serves
 * every `@agentick/transport-*` server adapter.
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
  createLog,
  WIRE_PROTOCOL_VERSION,
  type AgentickError,
  type Observability,
  type Ops,
  type Span,
  type ExtensionsListResult,
  type GatewayHarnessProtocol,
  type HookBridges,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ProgressStreamWriter,
  type AppHarnessProtocol,
  type SessionHarnessProtocol,
  type SubscriptionHandle,
  type WireExtension,
  type WireMethod,
  type WireMethodAuth,
  type IngressIdentity,
  type WireExtensionContext,
  type WireExtensionTransport,
  type WireNotificationMethod,
  type WireServerDescriptor,
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { projectClientNotification, projectClientResult } from "./client-projection.js";

/**
 * A `DispatchHost` is anything that satisfies `GatewayHarnessProtocol`.
 * The wire dispatcher calls into the gateway's methods; per-connection
 * concerns (auth context, in-flight tracking) live on the server-side
 * extension wrapper, not here.
 */
export type DispatchHost = GatewayHarnessProtocol;

/** No-op {@link Span} handed to the off-path `trace` before host enrichment. */
const NOOP_SPAN: Span = Object.freeze({
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  recordException: () => {},
});

/**
 * Off-path {@link Observability} + {@link Ops} facets pre-seeded onto every
 * wire-extension ctx (ADR 64/78) so the ctx satisfies its type BEFORE the host
 * enriches it. `log` is a no-op callable; `trace`/`metrics` are the frozen
 * no-op / passthrough; `run`/`runner` THROW — a wire host that routes through
 * `runWireDispatch` (the real gateway) OVERWRITES all five in-fiber with live
 * facets, so a surviving throw means a stub host left the ctx un-enriched.
 * Frozen + shared (referential identity, zero per-request build).
 */
const OFF_PATH_FACETS: Observability & Ops = Object.freeze({
  log: createLog(() => {}),
  trace: <T>(_name: string, fn: (span: Span) => T | Promise<T>): Promise<T> =>
    Promise.resolve(fn(NOOP_SPAN)),
  metrics: Object.freeze({ count: () => {}, record: () => {}, gauge: () => {} }),
  run: (() => {
    throw new Error("ctx.run is unavailable: the wire host did not enrich this dispatch context");
  }) as Ops["run"],
  runner: Object.freeze({
    runOperation: () => {
      throw new Error(
        "ctx.runner is unavailable: the wire host did not enrich this dispatch context",
      );
    },
  }) as Ops["runner"],
});

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
  /** Ingress identity established at connection/request time (ADR 34/51). */
  identity?: IngressIdentity,
  /**
   * What the SERVING transport says about itself — its identity and the wire
   * features it frames. The `initialize` answer is built from it (plus the
   * host's registry); every other method ignores it. Omitted ⇒
   * {@link DISPATCHER_DESCRIPTOR}.
   *
   * Per-connection like `identity`, and supplied by the same edge.
   * TODO(wire-dispatch-context): the two belong in one `DispatchContext` bag
   * — a third per-connection fact is the point at which positional stops
   * paying.
   */
  server?: WireServerDescriptor,
): Promise<JsonRpcResponse> {
  // ROADMAP A3 — client tool-output projection, STRICTLY OPT-IN. The gateway
  // configures ONE policy; every transport attached to it inherits it here
  // (no straddle). Bounding is OFF unless the adopter opted in
  // (`createGateway({ clientProjection })`) — an absent policy (the default,
  // and every bare stub host) means `bounder === undefined`, and this
  // boundary does ZERO projection work: the sink is used as-is and the
  // RPC result flows through untouched (the telemetry off-path twin). When
  // ON, this is the single boundary: wrapping the sink covers all
  // notification paths (progress / subscription / ctx.publish), and
  // projecting the extension result below covers the RPC-result paths. The
  // model path and the durable store are BELOW this boundary and stay full.
  const bounder = host.clientProjection;
  const projectedSink: DispatchSink = bounder
    ? {
        ...sink,
        sendNotification: (n) =>
          sink.sendNotification({
            method: n.method,
            params: projectClientNotification(n.method, n.params, bounder),
          }),
      }
    : sink;
  try {
    // Bootstrap methods dispatched directly — must resolve BEFORE the
    // extension registry (initialize runs before the registry is
    // observable; _extensions/list reads the registry itself; ping
    // is stateless keepalive).
    switch (req.method) {
      case "initialize":
        return success(req.id, initialize(req.params, host, server ?? DISPATCHER_DESCRIPTOR));
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
          projectedSink,
          identity,
        );
        try {
          // ADR 83 §"Wire dispatch through the seam": route the handler
          // call through the gateway's operation seam so the wire method
          // fires the gateway's interceptor seam (gateway-scoped
          // guards/hooks), keyed by the wire method as op name. Auth
          // (above) stays the un-waivable pre-gate — it runs BEFORE the op.
          // The host enriches `ctx` IN-FIBER with its Observability + Ops
          // facets (ADR 64/78) before the handler runs — the wire op runtime is
          // only available inside `runWireDispatch`. `ctx` is pre-seeded with
          // off-path no-op facets (buildWireExtensionContext) so a host that
          // does no telemetry leaves a valid ctx.
          // `params` is the op input AFTER the interceptor cascade's
          // before-hooks ran — a `onBeforeWire<...>` hook that RESHAPES the
          // params is honored, so the handler sees the reshaped value (a
          // pure-observe hook returns the original params). Falls back to
          // `req.params` for a pass-through stub host that ignores the arg.
          const result = await host.runWireDispatch(
            req.method as WireMethod,
            req.params,
            ctx,
            (params) => resolution.handler((params ?? req.params) as never, ctx),
          );
          // ROADMAP A3 — when opted in, bound oversized tool output on the
          // RPC-result paths (session/send, session/dispatch); no-op for
          // every other method. OFF (bounder undefined) → the result flows
          // through by reference, zero projection work.
          return success(
            req.id,
            bounder ? projectClientResult(req.method, result, bounder) : result,
          );
        } finally {
          // Streaming handlers may have registered a cancel callback
          // via `ctx.wire.registerCancel(...)`; clear it now
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
    const domain = domainErrorOf(e);
    if (domain !== undefined) {
      return errorResponse(
        req.id,
        agentickErrorToWireCode(domain),
        domain.message,
        domain.toJSON(),
      );
    }
    return errorResponse(req.id, ErrorCode.InternalError, "internal error", {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The typed error a failure should be REPORTED as, dug out from under whatever
 * wrapped it on the way here.
 *
 * A domain error rarely arrives bare. `BaseHarness` wraps every command failure
 * that crosses the inbox in a `HandlerError` (its channel is typed to
 * `MessageHandlerError`), so the thing that reaches this catch says only "inbox
 * message handler failed" while the `PromptArgumentMissing` underneath — the
 * one sentence the caller can act on — hangs off `.cause`. Reporting the
 * wrapper is how a missing argument became `-32603 "internal error"`.
 *
 * The rule is "a wrapper that tells us nothing gets skipped":
 *
 *   - Walk the `cause` chain, collecting every {@link AgentickError} on it.
 *   - Report the FIRST one the code table has a specific answer for. That keeps
 *     an outer error that genuinely knows better — `OperationOutcomeError`,
 *     whose verdict maps to Forbidden / RateLimited — from being unwrapped into
 *     the failure it happens to carry.
 *   - Otherwise report the INNERMOST one, which is the closest thing to the
 *     actual fault, and whose message names it.
 *
 * `undefined` when nothing on the chain is typed — the caller falls back to a
 * generic internal error.
 */
function domainErrorOf(e: unknown): AgentickError | undefined {
  const typed: AgentickError[] = [];
  let current: unknown = e;
  // Bounded: a self-referential `cause` must not spin here.
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (isAgentickError(current)) typed.push(current);
    const next: unknown = (current as { readonly cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  if (typed.length === 0) return undefined;
  return typed.find((t) => agentickErrorToWireCode(t) !== ErrorCode.InternalError) ?? typed.at(-1);
}

/**
 * Map an {@link AgentickError} subclass to the matching JSON-RPC
 * error code. Explicit table keeps the mapping tight — new tags
 * default to `InternalError` until wired.
 *
 * `InternalError` is therefore two things at once: the honest answer for a
 * genuine server fault, and "not classified yet". {@link domainErrorOf} reads it
 * as the second, so adding a row here also stops the tag being skipped over as
 * an uninformative wrapper.
 */
function agentickErrorToWireCode(err: { readonly _tag: string }): number {
  switch (err._tag) {
    case "OperationOutcomeError": {
      // A guard-raised verdict that reached the wire edge (ADR 42 define-time
      // wire guard, ADR 83 verdict taxonomy). Honor the verdict on the JSON-RPC
      // edge rather than collapsing to an opaque InternalError:
      //   veto → Forbidden (a denial), defer → RateLimited (retry-after; the
      //   terminal carries `retryAfter`), canceled → RequestCancelled.
      // A `replace` never reaches here (it resolves the op SUCCESSFULLY). A
      // `failed` op re-raises its ORIGINAL error, so only a replayed cached
      // `failed` terminal falls through to InternalError.
      const outcome = (err as { readonly outcome?: string }).outcome;
      return outcome === "vetoed"
        ? ErrorCode.Forbidden
        : outcome === "deferred"
          ? ErrorCode.RateLimited
          : outcome === "canceled"
            ? ErrorCode.RequestCancelled
            : ErrorCode.InternalError;
    }
    case "AppNotFoundError":
      return ErrorCode.AppNotFound;
    case "SessionNotFoundError":
      return ErrorCode.SessionNotFound;
    // Caller-supplied input the server refused: a required argument absent, a
    // value that failed its schema, a name already taken. All InvalidParams —
    // the caller can fix every one of them from the message, and none is a
    // server fault.
    case "AppAlreadyExistsError":
    case "PromptAlreadyExists":
    case "SkillAlreadyExists":
    case "PromptArgumentMissing":
    case "PromptArgumentInvalid":
    case "ToolValidationError":
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

/**
 * Identity used when the serving transport declared none — a bare test host,
 * or an adopter calling `dispatchRequest` directly. Names the dispatcher
 * itself, which is the only thing true in that case.
 */
const DISPATCHER_DESCRIPTOR: WireServerDescriptor = Object.freeze({
  name: "@agentick/transport",
  version: "0.0.0",
});

/**
 * The handshake. Every flag in the answer is DERIVED from something that is
 * actually wired — the advertised bag is a promise the connection then has to
 * keep, and each promise here has exactly one source of truth:
 *
 *   - `batch` / `streamableHttp` ← the serving transport's
 *     {@link WireServerDescriptor}. Framing is decided in the connection's
 *     decode path, which this dispatcher never sees.
 *   - `subscriptions` / `mcpSurface` ← the host's wire-extension registry.
 *     `sub/subscribe` resolves iff `subscriptionsWireExtension` is
 *     registered; `tools/call` iff something projects the MCP surface onto
 *     this wire.
 *   - `progress` / `cancellation` ← dispatcher-intrinsic. `buildTransportSlot`
 *     hands every handler a `wire.progress(token)` reporter, and
 *     `DispatchSink.registerInFlight` is a REQUIRED sink member that
 *     `wire.registerCancel` writes to — a host reaching this code has both.
 *   - `cursorResume` ← constant `false`. The client half is complete (it
 *     tracks `lastCursor` and resends `fromCursor` on reconnect) but the
 *     server ignores it — see the `TODO(wire-resume)` trailhead on
 *     `subscriptionsWireExtension`. It stays false until replay exists.
 */
function initialize(
  rawParams: unknown,
  host: DispatchHost,
  server: WireServerDescriptor,
): InitializeResult {
  // Untrusted input: `InitializeParams.protocolVersion` is typed to the one
  // literal, so read it wide and compare, rather than trusting the cast.
  const requested = (rawParams as { readonly protocolVersion?: unknown } | undefined)
    ?.protocolVersion;
  if (requested !== undefined && requested !== WIRE_PROTOCOL_VERSION) {
    throw WireRpcError.protocolVersionMismatch(requested, WIRE_PROTOCOL_VERSION);
  }

  const registry = host.wireExtensions?.();
  const serves = (method: string): boolean => registry?.resolve(method) !== undefined;

  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    capabilities: {
      cursorResume: false,
      streamableHttp: server.streamableHttp ?? false,
      batch: server.batch ?? false,
      subscriptions: serves("sub/subscribe") && serves("sub/unsubscribe"),
      progress: true,
      cancellation: true,
      mcpSurface: serves("tools/call"),
    },
    serverInfo: { name: server.name, version: server.version },
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
  const targetSession = sessionId ? findSessionOrUndef(host, sessionId)?.session : undefined;
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

  // ADR 84 §5 — the POLICY calls route through `host.authorize(...)`, the
  // gateway's hookable `authorizer:authorize` op, NOT the raw
  // `host.authorizer.authorize(...)`. This lets `onBeforeAuthorizerAuthorize`
  // grant a contextual scope (or deny) around each ask. The structural ceiling
  // above stays the un-waivable pre-gate — it ran BEFORE this seam, so no
  // authorize hook can widen it. (`host.authorizer` still gates whether policy
  // runs at all, above: a host with no authorizer is trusted-domain.)
  //
  // The verb-derived scope is ALWAYS required — the §3.3 anti-bypass label.
  const verbScope = methodScope(method);
  if (!(await host.authorize(authInput(verbScope))).allowed) {
    throw WireRpcError.forbidden(verbScope);
  }
  // A declared role is ADDITIVE — required ON TOP of the verb scope, never
  // in place of it. Both must pass; the verb gate is never widened.
  if (methodAuth?.scope !== undefined) {
    if (!(await host.authorize(authInput(methodAuth.scope))).allowed) {
      throw WireRpcError.forbidden(methodAuth.scope);
    }
  }
}

/**
 * Build the {@link WireExtensionContext} that gets passed to a wire
 * extension handler. Resolves `session` / `app` from
 * `params.sessionId` / `params.appId`, wires `publish` to validate
 * against the extension's declared notifications, and constructs the
 * `wire` slot backed by the connection's {@link DispatchSink}.
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

  const found = sessionId ? findSessionOrUndef(host, sessionId) : undefined;
  // A session-scoped method resolves its app FROM the session — the doc on
  // `WireExtensionContext.app` says "app-scoped OR session-scoped", and only
  // the first half was ever true. `session/*` params carry no `appId`, so a
  // handler needing app-level state (the `fanIn` lineage walk in
  // `session/send`) had nothing to ask. An explicit `appId` still wins: it is
  // what the consistency check below is checking against.
  const app = appId ? host.app(appId) : found?.app;
  let session = found?.session;

  // Consistency check — if both appId and sessionId are provided, the
  // session must live under that app. Mismatch drops `session` to
  // undefined; the handler surfaces SessionNotFoundError.
  if (session && appId && app) {
    const owned = app.getSession(session.id);
    if (!owned) session = undefined;
  }

  const declaredNotifications = new Set<string>(extension.notifications ?? []);
  const wire = buildTransportSlot(reqId, sink);

  return {
    // ADR 64/78 — off-path facet placeholders (`log`/`trace`/`metrics`/`run`/
    // `runner`). The host overwrites them IN-FIBER in `runWireDispatch` with
    // live facets bound to the wire op runtime + its meter. Spread FIRST so the
    // real fields below (never facets) can't be shadowed.
    ...OFF_PATH_FACETS,
    gateway: host,
    // Authn happened ONCE at ingress (ADR 51 §4.1); dispatch only
    // carries the stamped identity. The dynamic command lane's
    // Authorizer gate consumes `principal` (the scalar projection); the full
    // structured `identity` (user record + scopes) is projected too so a wire
    // handler — and the gateway's before-hooks, into whose op ctx
    // `runWireDispatch` threads it — can read richer identity than the
    // principal string. Both undefined on the unauthenticated local pole.
    ...omitUndefined({ principal: identity?.principal, identity, app, session }),
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
    wire,
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
    // (`@agentick/gateway`) — the send handler owns both the caller's
    // `_meta.progressToken` (→ this reporter) AND the executionId to
    // scope the signal subscription, so the stitch lives there, not in
    // this transport-generic slot builder. This slot just wraps each
    // pushed envelope in the wire `notifications/progress` frame.
    progress(progressToken): ProgressStreamWriter {
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
        // End-of-stream marker. Carries the token and nothing else: a
        // bounded stream reaching its end is not a failure and has no
        // reason (contrast `notifications/subscription/closed`, which
        // reports server-initiated teardown of an open-ended stream).
        close() {
          sink.sendNotification({
            method: "notifications/progress/complete",
            params: { progressToken },
          });
        },
      };
    },
    registerCancel(abort: () => void) {
      sink.registerInFlight(reqId, abort);
    },
    // The id is the CLIENT's (`SubscribeParams.subscriptionId`), adopted
    // verbatim — the handler passes it straight through. Uniqueness is the
    // connection's to enforce (`registerSubscription` throws on a collision).
    registerSubscription(id: string, cleanup: () => Promise<void>): SubscriptionHandle {
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

/**
 * Resolve a session by id across the mounted apps, and answer WHICH app owns
 * it. The owner is not a bonus fact: it is how a session-scoped handler reaches
 * app-level state (`ctx.app`) at all, since `session/*` params name a session
 * and never an app.
 */
function findSessionOrUndef(
  host: GatewayHarnessProtocol,
  sessionId: string,
): { session: SessionHarnessProtocol; app: AppHarnessProtocol } | undefined {
  for (const app of host.apps()) {
    const sess = app.getSession(sessionId);
    if (sess) return { session: sess, app };
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
