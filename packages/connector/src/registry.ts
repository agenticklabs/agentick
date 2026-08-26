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

/** @internal — the mutable map behind the registry, shared via the bridge slot. */
export type ConnectorsBridge = Map<string, ConnectorHandle>;

/** Read the connectors registry off a gateway (empty when none installed). */
export function connectors(gateway: {
  readonly bridges: Readonly<Record<string, unknown>>;
}): ConnectorsRegistry {
  const bridge = gateway.bridges[CONNECTORS_NAMESPACE] as ConnectorsBridge | undefined;
  return {
    get: (name) => bridge?.get(name),
    list: () => [...(bridge?.values() ?? [])],
  };
}
