/**
 * `ClientCapabilities` — the client-side view of what the connected
 * gateway supports. Populated by `client.connect()` running the
 * post-connect handshake: `initialize` (framework-flag capabilities +
 * server info) followed by `_extensions/list` (wire-extension
 * enumeration).
 *
 * Adopters use this surface for feature-gating UI:
 *
 * ```ts
 * if (client.capabilities.hasMethod("mcpClients/reauthenticate")) {
 *   // Backend has @agentick/mcp-next installed — show the button.
 * }
 * ```
 *
 * Two categories live under the same roof:
 *
 * - **Framework flags** — `capabilities.framework` mirrors the
 *   {@link ServerCapabilities} block the server returned from
 *   `initialize`. These are boolean protocol features
 *   (`cursorResume`, `progress`, `subscriptions`, etc.) — they gate
 *   optional wire-protocol semantics, not adopter surface.
 *
 * - **Wire extensions** — `capabilities.extensions` is the enumeration
 *   returned by `_extensions/list`; `capabilities.methods` and
 *   `capabilities.notifications` are pre-computed lookup sets for
 *   O(1) feature-gate checks.
 *
 * ## Timing
 *
 * Before `client.connect()` resolves (or after a disconnect):
 *   - `capabilities.framework` is empty
 *   - `capabilities.extensions` is `[]`
 *   - `capabilities.methods` / `capabilities.notifications` are empty
 *
 * After a successful connect:
 *   - all three populated from the gateway's handshake response
 *
 * On reconnect: repopulated from the new handshake. Stale values are
 * cleared during the transitional `reconnecting` state.
 *
 * ## Graceful degradation
 *
 * If the server returns `MethodNotFound` for `_extensions/list`
 * (older-server compat), extensions remain `[]` and lookup sets
 * remain empty. Framework flags from `initialize` are still populated.
 * Adopters checking `hasMethod("foo/bar")` on old servers get
 * `false` — technically correct: the client can't confirm the method
 * exists, so it's not safe to call.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md §"Capability discovery"
 */

import type { ServerCapabilities } from "../wire/params.js";
import type { WireExtensionInfo } from "../wire/registry.js";

/**
 * Server identity, populated from the `initialize` handshake response.
 */
export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: "v1";
  /** Server-allocated connection id — sticky-session affinity key. */
  readonly connectionId: string;
}

/**
 * Empty-seed for extension-provided typed capability metadata.
 *
 * The base fields on {@link ClientCapabilities} (framework flags,
 * method set, notification set, extension enumeration) cover the
 * generic capability model. Extensions with STATIC capability
 * metadata beyond boolean flags — e.g., "MCP extension supports OAuth
 * flow variants X and Y" — can declare typed slots here via TypeScript
 * declaration merging.
 *
 * The MCP extension might declare:
 *
 * ```ts
 * declare module "@agentick/spec-next" {
 *   interface ClientCapabilityExtensions {
 *     mcp?: {
 *       readonly authFlavors: readonly ("oauth2" | "static-token")[];
 *       readonly supportsTaskProgress: boolean;
 *     };
 *   }
 * }
 * ```
 *
 * Runtime population is out of `_extensions/list` scope today — the
 * gateway would need to include per-extension metadata blobs in
 * `WireExtensionInfo`. Filed as forward-compat: the type slot is
 * ready even before the runtime pipeline is.
 *
 * Framework-level boolean flags belong on {@link ServerCapabilities}
 * (which is also declaration-merge extensible). This slot is for
 * shapes beyond simple booleans.
 *
 * Companion to the `HookBridges` pattern — an intentionally-empty
 * seed the ecosystem grows into.
 */
export interface ClientCapabilityExtensions {}

/**
 * Client-side capabilities view. Structurally readonly; the concrete
 * `AgentickClient` swaps the instance on each connect.
 */
export interface ClientCapabilities {
  /**
   * Framework-level protocol flags advertised by the server in the
   * `initialize` response. Empty object before connect / after
   * disconnect.
   */
  readonly framework: ServerCapabilities;

  /**
   * Every wire extension registered on the connected gateway, in
   * registration order (framework extensions first, then adopter
   * extensions). Empty before connect / after disconnect / on older
   * servers that don't implement `_extensions/list`.
   */
  readonly extensions: readonly WireExtensionInfo[];

  /**
   * Union of every method name from every registered extension —
   * O(1) `has` for feature-gating.
   */
  readonly methods: ReadonlySet<string>;

  /**
   * Union of every notification name declared by any registered
   * extension — O(1) `has` for subscription-availability checks.
   */
  readonly notifications: ReadonlySet<string>;

  /**
   * O(1) check for a specific wire method. Equivalent to
   * `capabilities.methods.has(name)`; provided as a convenience.
   */
  hasMethod(name: string): boolean;

  /**
   * O(1) check for a specific wire notification name. Equivalent to
   * `capabilities.notifications.has(name)`.
   */
  hasNotification(name: string): boolean;

  /**
   * True if any registered extension owns the given namespace.
   * Convenience for "is the whole extension available" checks —
   * cheaper than iterating `capabilities.extensions`.
   */
  hasNamespace(namespace: string): boolean;

  /**
   * Extension-provided typed capability metadata. Populated by
   * declaration-merge into {@link ClientCapabilityExtensions}. Empty
   * on connections whose extensions haven't declared any typed
   * slots. Runtime population lives in a follow-up when per-extension
   * metadata blobs get added to `_extensions/list` responses.
   */
  readonly ext: Readonly<ClientCapabilityExtensions>;
}

/**
 * The empty {@link ClientCapabilities} used before the handshake
 * completes and after disconnect. Exported for consumers that want
 * to reset their own local caches to the same shape.
 */
export const EMPTY_CLIENT_CAPABILITIES: ClientCapabilities = {
  framework: {},
  extensions: [],
  methods: new Set(),
  notifications: new Set(),
  hasMethod: () => false,
  hasNotification: () => false,
  hasNamespace: () => false,
  ext: {},
};
