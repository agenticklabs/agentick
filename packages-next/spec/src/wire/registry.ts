/**
 * `WireExtensionRegistry` — the gateway-side registry that holds every
 * {@link WireExtension} installed on a gateway. Owned by the gateway
 * package (`@agentick/gateway-next` supplies the concrete
 * implementation); consumed by the wire dispatcher when routing
 * incoming JSON-RPC frames.
 *
 * ## Ownership
 *
 * The registry is populated at gateway construction — either by the
 * framework (the gateway installs its own built-in extensions:
 * `gatewayWireExtension`, `sessionWireExtension`, etc.) or by adopters
 * (`createGateway({ wireExtensions: [...] })`). It is a mutable
 * append-only structure during construction; after
 * `gateway.ready` resolves, `register` calls throw.
 *
 * ## Dispatch model
 *
 * Given an incoming method name, the dispatcher calls
 * {@link WireExtensionRegistry.resolve}. If a match is found, the
 * dispatcher builds a {@link WireExtensionContext} and invokes the
 * handler. If no match is found, the dispatcher falls back to its
 * hard-coded built-in path (`initialize`, `ping`, `_extensions/list`
 * during Phase B; everything else during Phase C after the framework
 * methods refactor lands).
 *
 * ## Enumeration
 *
 * {@link WireExtensionRegistry.enumerate} feeds `_extensions/list` —
 * client SDKs call it after `initialize` to populate
 * `client.capabilities`.
 *
 * ## Namespace conflicts
 *
 * `register` throws if two extensions claim the same
 * {@link WireExtension.namespace}. First registration wins; subsequent
 * conflicts throw `WireExtensionDefinitionError`. Adopters can
 * override a framework-supplied namespace only by NOT installing the
 * framework extension in the first place (a future Phase-E composite
 * factory concern; not exposed today).
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import type { WireExtension } from "./extension.js";

/**
 * A single method match on the registry — the extension that owns the
 * namespace and the handler function for the requested method.
 */
export interface WireExtensionResolution {
  /** The owning extension — used by the dispatcher to build context (e.g.,
   *  validate `publish` calls against declared notifications). */
  readonly extension: WireExtension;
  /** The handler for the resolved method. Always async. */
  readonly handler: (params: unknown, ctx: unknown) => Promise<unknown>;
}

/**
 * Discovery info for a single registered extension. Emitted by
 * {@link WireExtensionRegistry.enumerate} and returned wholesale as
 * `ExtensionsListResult.extensions` from the `_extensions/list`
 * built-in.
 */
export interface WireExtensionInfo {
  readonly name: string;
  readonly namespace: string;
  readonly version?: string;
  readonly methods: readonly string[];
  readonly notifications: readonly string[];
}

/**
 * Gateway-side registry of {@link WireExtension} values. Concrete
 * implementation lives in `@agentick/gateway-next`; consumers
 * (transport dispatcher, `_extensions/list` handler) depend only on
 * this interface.
 */
export interface WireExtensionRegistry {
  /**
   * Install an extension. Throws
   * {@link WireExtensionDefinitionError} on:
   *
   *   - namespace conflict with an already-registered extension
   *   - `name` conflict (two extensions claiming the same identity)
   *   - the registry being sealed (i.e., gateway is past construction)
   *
   * Not called by adopters directly — the gateway construction path
   * consumes `wireExtensions: WireExtension[]` and registers each.
   */
  register(extension: WireExtension): void;

  /**
   * Resolve an incoming method name to its owning extension +
   * handler. Returns `undefined` for methods not registered by any
   * extension (dispatcher falls back to built-in switch).
   *
   * The lookup is O(1) via namespace prefix + method-map. Method
   * names are matched exactly — the `${namespace}/${method}` shape is
   * enforced at `defineWireExtension` time.
   */
  resolve(method: string): WireExtensionResolution | undefined;

  /**
   * All installed extensions in registration order. Consumed by the
   * `_extensions/list` built-in to advertise capabilities to clients.
   */
  enumerate(): readonly WireExtensionInfo[];

  /**
   * Freeze the registry — after this, {@link register} throws. The
   * gateway calls this once construction completes so adopters can't
   * mutate the registry post-hoc.
   */
  seal(): void;
}
