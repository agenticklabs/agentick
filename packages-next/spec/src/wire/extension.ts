/**
 * `WireExtension` — extensible JSON-RPC namespace contributor for the
 * Agentick client↔gateway wire.
 *
 * A wire extension is a bag of method handlers + notification name
 * declarations + auth metadata + cluster-routing hints, named under a
 * namespace. Registered with the gateway at construction; dispatched
 * when matching RPCs arrive over the wire.
 *
 * Two install paths to one registry:
 *   - Package self-install: framework packages (like `@agentick/mcp-next`)
 *     ship their own WireExtension via the composite extension factory
 *     pattern (returning `{ session?, app?, gateway?, wire? }` from
 *     their `withX(...)` factory). Adopter never sees the extension —
 *     it Just Works when they install the package.
 *   - Adopter ad-hoc: `createGateway({ wireExtensions: [...] })` for
 *     custom RPC namespaces the framework doesn't ship.
 *
 * Type-level extension of `WireMethods` / `WireNotifications` happens
 * via TypeScript declaration merging (see `params.ts` + `notifications.ts`
 * JSDoc). The handler implementations in this `WireExtension` register
 * at the runtime level — the typed declarations are what makes them
 * dispatchable from typed `client.request(...)` calls.
 *
 * Terminology: "wire" here means the Agentick CLIENT↔GATEWAY wire.
 * NOT to be confused with the MCP protocol (a separate layer that
 * `McpClientHarness` speaks to external MCP servers).
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import { WireExtensionDefinitionError } from "../errors/remaining.js";

// Re-export so adopters can `import { WireExtensionDefinitionError } from "@agentick/spec-next"`
// without digging into the errors subpath.
export { WireExtensionDefinitionError } from "../errors/remaining.js";

import type { AppHarnessProtocol } from "../protocol/app-harness.js";
import type { GatewayHarnessProtocol } from "../protocol/gateway-harness.js";
import type { HookBridges } from "../protocol/hook-bridges.js";
import type { SessionHarnessProtocol } from "../protocol/session-harness.js";
import type { WireMethod, WireParams, WireResult } from "./params.js";
import type { WireNotificationMethod, WireNotificationParams } from "./notifications.js";

// ============================================================================
// WireMethodAuth — per-method auth declaration
// ============================================================================

/**
 * Auth requirement declaration for one wire method. Inherits the
 * gateway's default policy if absent from an extension's `auth` map.
 *
 * The `scope` label is opaque to the framework — the gateway's
 * `AuthSource` (per ADR 33) decides what scopes mean. Adopters wire
 * their authorization model into the AuthSource; this declaration is
 * the seam where per-method policy lives.
 */
export interface WireMethodAuth {
  /**
   * Whether the authorizer POLICY gates this method. `true` (or an absent
   * `auth` entry) → gated by the verb-derived scope (`a/b` → `a:b`, ADR 51
   * §3.3). `false` → OPEN: the policy is skipped (rare — for methods with no
   * gated dynamic-lane counterpart). Open does NOT waive the target session's
   * structural `requiredScopes` ceiling — that is un-waivable (#199).
   */
  readonly required: boolean;
  /**
   * Optional role label, checked **additively** — required ON TOP of the
   * verb-derived scope, never in place of it (ADR 51 §3.3 anti-bypass: a
   * porcelain method's authz label is its verb name and cannot be relabeled to
   * reach a verb the plumbing lane would deny; an additive role can only
   * tighten). So `{ scope: "admin" }` on `x/verb` requires BOTH `x:verb` AND
   * `admin`. Opaque to the framework; the gateway's `Authorizer` defines the
   * role's meaning.
   */
  readonly scope?: string;
}

// ============================================================================
// WireExtensionContext — what handlers receive
// ============================================================================

/**
 * Cluster routing hint for a single wire method.
 *
 *   - `"session-local"` — route the request to the node owning the
 *     relevant session. Default for methods whose params include a
 *     sessionId.
 *   - `"any"` — any node holding gateway-level state can answer.
 *     Default for gateway-scoped methods.
 *   - `"leader"` — only the cluster's leader node may answer. For
 *     admin / topology-mutating methods.
 */
export type WireClusterRoute = "session-local" | "any" | "leader";

/**
 * Progress reporter for a single in-flight RPC. Returned by
 * {@link WireExtensionTransport.progress}. Cursor tracking is
 * internal — each `push` auto-increments and stamps the outbound
 * `notifications/progress` frame with a monotonically increasing
 * cursor.
 *
 * Progress delivery is fire-and-forget — cluster-distributed
 * routing failures don't surface to the extension.
 */
export interface ProgressReporter {
  /**
   * Push one progress envelope. Extensions define envelope shape;
   * the framework wraps it in the `notifications/progress`
   * `{ progressToken, cursor, envelope }` structure on the wire.
   */
  push<Envelope>(envelope: Envelope): void;
}

/**
 * A live subscription owned by an extension handler. Returned by
 * {@link WireExtensionTransport.registerSubscription}. The `id` is
 * server-allocated and returned in the handler's RPC response so the
 * client can later `unsubscribe`.
 *
 * `publish` sends `notifications/subscription/event` frames
 * correlated by `id`, with automatic cursor tracking. `close` sends
 * a `notifications/subscription/closed` frame — used for
 * server-initiated teardown (typically on iteration error).
 * Client-initiated unsubscribe fires the cleanup callback passed
 * at registration; no `close` notification is sent because the
 * client already knows.
 */
export interface SubscriptionHandle {
  readonly id: string;
  publish<Envelope>(envelope: Envelope): void;
  close(reason?: { readonly code: number; readonly message: string }): void;
}

/**
 * Transport-level primitives exposed to wire-extension handlers.
 * These reach past the JSON-RPC request/response envelope for
 * long-running or fan-out operations — progress notifications on an
 * in-flight RPC, cancellation registration, and durable subscription
 * fan-out.
 *
 * Framework-supplied extensions (`sessionWireExtension`'s
 * `session/send`, `subscriptionsWireExtension`'s `sub/subscribe`)
 * consume this slot. Most adopter extensions don't need it —
 * simple request/response handlers can ignore `ctx.transport`
 * entirely.
 *
 * The slot is always present on the context (never conditional),
 * matching the pattern established by `ctx.publish` — framework
 * plumbing is uniformly reachable.
 */
export interface WireExtensionTransport {
  /**
   * Start reporting `notifications/progress` frames for this RPC,
   * correlated by `progressToken`. LSP-style protocol convention —
   * the client opted in by including
   * `params._meta.progressToken` on the request.
   *
   * Returns a stateful reporter that auto-tracks cursor ordering.
   * Extensions that don't want progress simply never call this
   * method.
   */
  progress(progressToken: string | number): ProgressReporter;

  /**
   * Register an abort callback fired when the client sends
   * `notifications/cancelled` for this RPC. The callback runs at
   * most once per RPC. Cleanup runs automatically when the RPC
   * completes — extensions do NOT need to unregister.
   *
   * Multiple calls within one RPC replace the prior callback —
   * "one cancel handler per request" is enforced by the underlying
   * in-flight registry.
   */
  registerCancel(abort: () => void): void;

  /**
   * Open a subscription. Returns a handle whose `id` the handler
   * MUST return in its RPC response — clients unsubscribe by that
   * id.
   *
   * `cleanup` runs when the client unsubscribes (via the
   * unsubscribe RPC) or when the connection drops. Server-initiated
   * teardown uses `handle.close({ code, message })` instead — the
   * cleanup ALSO fires in that case.
   */
  registerSubscription(cleanup: () => Promise<void>): SubscriptionHandle;

  /**
   * Client-initiated unsubscribe. Runs the cleanup fn associated
   * with the id, then removes it from the registry. Idempotent —
   * unknown ids are silent no-ops.
   */
  closeSubscription(subscriptionId: string): void;
}

/**
 * Runtime context passed to wire-extension handlers. The gateway
 * constructs one per request after auth + cluster routing succeed.
 *
 * `session` / `app` are populated when the method is scoped to one
 * (resolved from params or session affinity); both are absent for
 * truly gateway-level methods.
 */
export interface WireExtensionContext {
  /**
   * Authenticated caller identity, stamped at ingress (ADR 51 §4.1).
   * Undefined on unauthenticated connections (the local pole). The
   * dynamic command lane's Authorizer gate consumes this; porcelain
   * handlers may read it for principal-scoped behavior.
   */
  readonly principal?: string;
  /** Active session, when the method is session-scoped. */
  readonly session?: SessionHarnessProtocol<unknown>;
  /** Active app, when the method is app-scoped or session-scoped. */
  readonly app?: AppHarnessProtocol;
  /** Gateway handle — always present. */
  readonly gateway: GatewayHarnessProtocol;
  /**
   * Active bridges on the resolved session. Empty for gateway-level
   * methods that don't bind to a session.
   *
   * Thunk (not value) so the gateway can resolve bridges lazily after
   * cluster routing settles — at handler call time the session is
   * known, but bridge construction may depend on cross-node state
   * that wasn't ready at context-build time. Phase B revisits if the
   * lazy bind isn't necessary.
   */
  readonly bridges: () => HookBridges;
  /**
   * Publish a notification declared in this extension's
   * `notifications` array. The gateway-supplied implementation
   * validates the name against the declaration at publish time —
   * `publish("name-not-declared", ...)` throws.
   *
   * Fire-and-forget shape (`void` return). Cluster-distributed
   * publish failures are handled by the gateway's notification
   * router; they don't surface to the handler.
   */
  readonly publish: <K extends WireNotificationMethod>(
    name: K,
    params: WireNotificationParams<K>,
  ) => void;
  /**
   * Transport-level primitives for streaming operations — progress
   * notifications, cancellation registration, subscription fan-out.
   * See {@link WireExtensionTransport}. Adopter extensions that only
   * do simple request/response can ignore this slot entirely.
   */
  readonly transport: WireExtensionTransport;
}

// ============================================================================
// WireExtension — the primitive
// ============================================================================

/**
 * One wire extension contribution to the gateway's JSON-RPC registry.
 *
 * Each `WireExtension` declares methods + notifications under a
 * namespace prefix (`mcpClients/`, `credentials/`, etc.). The
 * gateway aggregates extensions at construction, validates no
 * namespace conflicts, and dispatches incoming RPCs to the registered
 * handlers.
 *
 * Method names + notification names MUST appear in the
 * `WireMethods` / `WireNotifications` type registries (via
 * declaration merging from this package or one it depends on).
 * Otherwise the typed `client.request(...)` calls can't reach them.
 *
 * @example
 *   // In @agentick/mcp-next/src/wire/server.ts (Phase F):
 *   const mcpControlWireExtension: WireExtension = defineWireExtension({
 *     name: "@agentick/mcp-next",
 *     namespace: "mcpClients",
 *     version: "1.0.0",
 *     methods: {
 *       "mcpClients/list": async (_params, ctx) => {
 *         const clients = ctx.bridges().mcp?.clients ?? [];
 *         return {
 *           clients: clients.map(c => ({ serverId: c.serverId, status: c.status })),
 *         };
 *       },
 *       "mcpClients/reauthenticate": async ({ serverId }, ctx) => {
 *         const client = ctx.bridges().mcp?.client(serverId);
 *         if (!client) {
 *           // Throw an AgentickError subclass — Phase F will introduce
 *           // McpClientNotFoundError under McpClientError.
 *           throw new Error(`unknown serverId: ${serverId}`);
 *         }
 *         await client.reauthenticate();
 *         ctx.publish("mcpClients/status-changed", { serverId, status: client.status });
 *         return { status: client.status };
 *       },
 *     },
 *     notifications: ["mcpClients/status-changed"],
 *     auth: {
 *       "mcpClients/reauthenticate": { required: true, scope: "session-user" },
 *     },
 *   });
 */
export interface WireExtension {
  /**
   * Extension identity for diagnostics + conflict detection.
   * Convention: package identifier (`@agentick/mcp-next`), or
   * adopter-supplied for ad-hoc extensions (`adopter:crm-rpc`).
   */
  readonly name: string;

  /**
   * Namespace prefix shared by every method + notification this
   * extension declares. All method names MUST start with
   * `${namespace}/`.
   *
   * The gateway uses this for:
   *   - Conflict detection (two extensions can't claim the same
   *     namespace).
   *   - Auth policy grouping ("everything under `credentials/*`
   *     requires admin").
   *   - Cluster routing defaults (namespace-wide overrides).
   *   - Capability enumeration grouping.
   *
   * Reserved: namespaces starting with `_` are framework-internal
   * (`_extensions/list` for discovery) — adopter extensions cannot
   * claim them; the validator rejects.
   */
  readonly namespace: string;

  /**
   * Optional version string surfaced via `_extensions/list`. Clients
   * can pin behavior or gate features on it. Semver recommended but
   * not enforced.
   */
  readonly version?: string;

  /**
   * Method handlers keyed by full method name. Each handler receives
   * typed params + a {@link WireExtensionContext} and returns the
   * typed result wrapped in a Promise.
   *
   * Names MUST appear in `WireMethods` (via this package's or its
   * dependencies' declaration-merge augmentations). Names MUST start
   * with `${namespace}/`. Both invariants checked at registration.
   *
   * Handlers are always async — Phase A dropped sync support to keep
   * the dispatcher simple; the `Promise<...>` wrap is cheap and the
   * sync escape hatch had no real consumers.
   */
  readonly methods: {
    readonly [K in WireMethod]?: (
      params: WireParams<K>,
      ctx: WireExtensionContext,
    ) => Promise<WireResult<K>>;
  };

  /**
   * Notification names this extension may publish via
   * `ctx.publish(name, params)`. Used for:
   *   - Validation: `ctx.publish("name-not-declared", ...)` throws
   *     at the gateway-supplied `publish` impl.
   *   - Enumeration: surfaced in `_extensions/list`.
   *   - Subscription routing: subscribers to these names are
   *     associated with this extension's namespace.
   *
   * Names MUST appear in `WireNotifications` (declaration-merged).
   * Names MUST start with `${namespace}/`.
   */
  readonly notifications?: readonly WireNotificationMethod[];

  /**
   * Per-method auth declarations. Missing entries inherit the
   * gateway's default policy.
   *
   * The `scope` label is opaque to the framework — the gateway's
   * `AuthSource` decides what it means. Wire framework just routes
   * the declaration through.
   */
  readonly auth?: {
    readonly [K in WireMethod]?: WireMethodAuth;
  };

  /**
   * Per-method cluster routing hints. Missing entries get a default:
   *   - `"session-local"` if the method's params include a sessionId
   *     (gateway can infer from params shape).
   *   - `"any"` otherwise.
   *
   * Override here for methods that need a non-default route (admin
   * operations needing `"leader"`, etc.).
   */
  readonly clusterRoute?: {
    readonly [K in WireMethod]?: WireClusterRoute;
  };
}

// ============================================================================
// defineWireExtension — validating constructor
// ============================================================================

/**
 * Construct a {@link WireExtension} with validation at definition
 * time. Catches empty methods, namespace mismatches, missing
 * `namespace/` prefixes, reserved `_*` namespace claims, and
 * auth/cluster declarations that reference methods not in the
 * `methods` map.
 *
 * Use this instead of `as WireExtension` to get the validation. The
 * runtime cost is one walk over the methods object at definition;
 * after that, the returned value is structurally identical.
 *
 * Type-level alignment with `WireMethods` / `WireNotifications` is
 * enforced by TypeScript's index-signature constraint on the
 * `WireExtension` shape — definitions referencing unknown method
 * names fail typecheck before reaching this validator.
 *
 * Validation order (matters for which error a reader sees first):
 *   1. methods non-empty (the most fundamental requirement)
 *   2. namespace non-empty
 *   3. namespace doesn't contain `/`
 *   4. namespace isn't `_*`-reserved
 *   5. every method starts with `${namespace}/`
 *   6. every notification starts with `${namespace}/`
 *   7. auth entries reference declared methods
 *   8. clusterRoute entries reference declared methods
 *
 * @example
 *   export const myExtension = defineWireExtension({
 *     name: "@agentick/my-package",
 *     namespace: "my",
 *     methods: {
 *       "my/listThings": async (params, ctx) => ({ things: [] }),
 *     },
 *   });
 */
export function defineWireExtension(ext: WireExtension): WireExtension {
  // 1. at least one method (otherwise the extension does nothing).
  const methodNames = Object.keys(ext.methods);
  if (methodNames.length === 0) {
    throw new WireExtensionDefinitionError({
      extensionName: ext.name,
      reason: "extension declares no methods. At minimum one method handler is required.",
    });
  }

  // 2. namespace non-empty.
  if (!ext.namespace) {
    throw new WireExtensionDefinitionError({
      extensionName: ext.name,
      reason: "`namespace` is required and non-empty.",
    });
  }

  // 3. namespace doesn't contain `/`.
  if (ext.namespace.includes("/")) {
    throw new WireExtensionDefinitionError({
      extensionName: ext.name,
      reason: `\`namespace\` ("${ext.namespace}") MUST NOT contain "/" — namespaces are bare identifiers (use "${ext.namespace.split("/")[0]}" instead).`,
    });
  }

  // 4. `_*` namespaces are reserved for framework-internal extensions
  // (`_extensions/list` for capability discovery, future internals).
  if (ext.namespace.startsWith("_")) {
    throw new WireExtensionDefinitionError({
      extensionName: ext.name,
      reason: `\`namespace\` ("${ext.namespace}") starts with "_" — reserved for framework-internal extensions. Pick a different prefix.`,
    });
  }

  // 5. every method name starts with `${namespace}/`.
  const prefix = `${ext.namespace}/`;
  for (const method of methodNames) {
    if (!method.startsWith(prefix)) {
      throw new WireExtensionDefinitionError({
        extensionName: ext.name,
        reason: `method "${method}" must start with the declared namespace prefix "${prefix}".`,
      });
    }
  }

  // 6. every declared notification starts with `${namespace}/`.
  for (const notif of ext.notifications ?? []) {
    if (!notif.startsWith(prefix)) {
      throw new WireExtensionDefinitionError({
        extensionName: ext.name,
        reason: `notification "${notif}" must start with the declared namespace prefix "${prefix}".`,
      });
    }
  }

  // 7. `auth` entries reference methods that exist in `methods`.
  for (const authMethod of Object.keys(ext.auth ?? {})) {
    if (!(authMethod in ext.methods)) {
      throw new WireExtensionDefinitionError({
        extensionName: ext.name,
        reason: `\`auth\` references method "${authMethod}" but no handler is declared for it. Add the handler or remove the auth entry.`,
      });
    }
  }

  // 8. `clusterRoute` entries reference methods that exist in `methods`.
  for (const routeMethod of Object.keys(ext.clusterRoute ?? {})) {
    if (!(routeMethod in ext.methods)) {
      throw new WireExtensionDefinitionError({
        extensionName: ext.name,
        reason: `\`clusterRoute\` references method "${routeMethod}" but no handler is declared for it. Add the handler or remove the route entry.`,
      });
    }
  }

  return ext;
}
