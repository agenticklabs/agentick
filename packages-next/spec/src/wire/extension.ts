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
  /** `true` if any authenticated session can call; `false` for open methods (rare). */
  readonly required: boolean;
  /**
   * Optional scope label — used for role-gated dispatch. Opaque to
   * the framework; semantics defined by the gateway's `AuthSource`.
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
 * Runtime context passed to wire-extension handlers. The gateway
 * constructs one per request after auth + cluster routing succeed.
 *
 * `session` / `app` are populated when the method is scoped to one
 * (resolved from params or session affinity); both are absent for
 * truly gateway-level methods.
 */
export interface WireExtensionContext {
  /** Active session, when the method is session-scoped. */
  readonly session?: SessionHarnessProtocol<unknown>;
  /** Active app, when the method is app-scoped or session-scoped. */
  readonly app?: AppHarnessProtocol;
  /** Gateway handle — always present. */
  readonly gateway: GatewayHarnessProtocol;
  /**
   * Active bridges on the resolved session. Empty for gateway-level
   * methods that don't bind to a session.
   */
  readonly bridges: () => HookBridges;
  /**
   * Publish a notification declared in this extension's
   * `notifications` array. The gateway validates the name against
   * the declaration at publish time.
   *
   * Notifications get routed to subscribers based on their declared
   * scope (see `WireExtension.notifications` JSDoc).
   */
  readonly publish: <K extends WireNotificationMethod>(
    name: K,
    params: WireNotificationParams<K>,
  ) => void;
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
 *   const mcpControlWireExtension: WireExtension = {
 *     name: "@agentick/mcp-next",
 *     namespace: "mcpClients",
 *     version: "1.0.0",
 *     methods: {
 *       "mcpClients/list": async (_params, ctx) => {
 *         const clients = ctx.bridges().mcp?.clients ?? [];
 *         return { clients: clients.map(c => ({ serverId: c.serverId, status: c.status })) };
 *       },
 *       "mcpClients/reauthenticate": async ({ serverId }, ctx) => {
 *         const client = ctx.bridges().mcp?.client(serverId);
 *         if (!client) throw new McpClientNotFoundError({ serverId });
 *         await client.reauthenticate();
 *         ctx.publish("mcpClients/status-changed", { serverId, status: client.status });
 *         return { status: client.status };
 *       },
 *     },
 *     notifications: ["mcpClients/status-changed"],
 *     auth: {
 *       "mcpClients/reauthenticate": { required: true, scope: "session-user" },
 *     },
 *   };
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
   * typed result.
   *
   * Names MUST appear in `WireMethods` (via this package's or its
   * dependencies' declaration-merge augmentations). Names MUST start
   * with `${namespace}/`. Both invariants checked at registration.
   *
   * Handlers may be synchronous or async. The dispatcher awaits the
   * returned value.
   */
  readonly methods: {
    readonly [K in WireMethod]?: (
      params: WireParams<K>,
      ctx: WireExtensionContext,
    ) => Promise<WireResult<K>> | WireResult<K>;
  };

  /**
   * Notification names this extension may publish via
   * `ctx.publish(name, params)`. Used for:
   *   - Validation: `ctx.publish("name-not-declared", ...)` throws.
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
 * Wire-extension validation diagnostic. Thrown by
 * {@link defineWireExtension} when the declared extension violates an
 * invariant.
 */
export class WireExtensionDefinitionError extends Error {
  constructor(
    public readonly extensionName: string,
    message: string,
  ) {
    super(`WireExtension "${extensionName}": ${message}`);
    this.name = "WireExtensionDefinitionError";
  }
}

/**
 * Construct a {@link WireExtension} with validation at definition
 * time. Catches namespace mismatches, missing `namespace/` prefixes,
 * and auth/cluster declarations that reference methods not in the
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
  // 1. namespace non-empty + plain identifier-ish.
  if (!ext.namespace) {
    throw new WireExtensionDefinitionError(ext.name, "`namespace` is required and non-empty.");
  }
  if (ext.namespace.includes("/")) {
    throw new WireExtensionDefinitionError(
      ext.name,
      `\`namespace\` ("${ext.namespace}") MUST NOT contain "/" — namespaces are bare identifiers (use "${ext.namespace.split("/")[0]}" instead).`,
    );
  }

  // 2. every method name starts with `${namespace}/`.
  const prefix = `${ext.namespace}/`;
  const methodNames = Object.keys(ext.methods);
  for (const method of methodNames) {
    if (!method.startsWith(prefix)) {
      throw new WireExtensionDefinitionError(
        ext.name,
        `method "${method}" must start with the declared namespace prefix "${prefix}".`,
      );
    }
  }

  // 3. every declared notification starts with `${namespace}/`.
  for (const notif of ext.notifications ?? []) {
    if (!notif.startsWith(prefix)) {
      throw new WireExtensionDefinitionError(
        ext.name,
        `notification "${notif}" must start with the declared namespace prefix "${prefix}".`,
      );
    }
  }

  // 4. `auth` entries reference methods that exist in `methods`.
  for (const authMethod of Object.keys(ext.auth ?? {})) {
    if (!(authMethod in ext.methods)) {
      throw new WireExtensionDefinitionError(
        ext.name,
        `\`auth\` references method "${authMethod}" but no handler is declared for it. Add the handler or remove the auth entry.`,
      );
    }
  }

  // 5. `clusterRoute` entries reference methods that exist in `methods`.
  for (const routeMethod of Object.keys(ext.clusterRoute ?? {})) {
    if (!(routeMethod in ext.methods)) {
      throw new WireExtensionDefinitionError(
        ext.name,
        `\`clusterRoute\` references method "${routeMethod}" but no handler is declared for it. Add the handler or remove the route entry.`,
      );
    }
  }

  // 6. at least one method (otherwise the extension does nothing).
  if (methodNames.length === 0) {
    throw new WireExtensionDefinitionError(
      ext.name,
      "extension declares no methods. At minimum one method handler is required.",
    );
  }

  return ext;
}
