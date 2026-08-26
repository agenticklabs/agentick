/**
 * The connectors registry — programmatic reach into installed connectors.
 *
 * Every `defineConnector` self-registers into the gateway's `connectors`
 * bridge namespace (first connector creates it; ADR 50 slot rules). No
 * `withConnectors(...)` wrapper to remember: declaring a connector IS
 * registering it. `connectors(gateway)` is the typed accessor.
 *
 * The handle's `deliver` pushes OUTBOUND through the connector's own
 * `deliver` — a proactive notification with no agent turn behind it.
 */

import type { ConnectorStatus, OutboundDelivery } from "./types.js";

declare module "@agentick/spec" {
  interface GatewayBridges {
    connectors?: ConnectorsBridge;
  }
}

export const CONNECTORS_NAMESPACE = "connectors";

/** A host-facing handle onto one installed connector. */
export interface ConnectorHandle {
  readonly name: string;
  readonly status: ConnectorStatus;
  /**
   * Push outbound through the connector's `deliver` — `output` defaults to a
   * single text block of `response`. Throws if the connector is ingress-only.
   */
  deliver(delivery: {
    readonly sessionId: string;
    readonly response: string;
    readonly output?: OutboundDelivery["output"];
  }): Promise<void>;
}

export interface ConnectorsRegistry {
  get(name: string): ConnectorHandle | undefined;
  list(): readonly ConnectorHandle[];
}

/**
 * The bridge value at `gateway.bridges.connectors` — a read-only registry
 * facade (hosts can look up and deliver, never mutate). Registration is
 * `defineConnector`'s own, via the internal methods.
 */
export class ConnectorsBridge implements ConnectorsRegistry {
  readonly #handles = new Map<string, ConnectorHandle>();

  get(name: string): ConnectorHandle | undefined {
    return this.#handles.get(name);
  }

  list(): readonly ConnectorHandle[] {
    return [...this.#handles.values()];
  }

  /** @internal defineConnector only. */
  register(handle: ConnectorHandle): void {
    this.#handles.set(handle.name, handle);
  }

  /** @internal defineConnector only. */
  unregister(name: string): void {
    this.#handles.delete(name);
  }
}

/**
 * Read the connectors registry off a gateway. Sugar over the typed
 * augmentation — `gateway.bridges.connectors?.get(name)` is the same door —
 * collapsing the none-installed case to an empty registry.
 */
export function connectors(gateway: {
  readonly bridges: Readonly<Record<string, unknown>>;
}): ConnectorsRegistry {
  const bridge = gateway.bridges[CONNECTORS_NAMESPACE] as ConnectorsBridge | undefined;
  return {
    get: (name) => bridge?.get(name),
    list: () => bridge?.list() ?? [],
  };
}
