/**
 * `createGateway(options)` — top-level factory function. Mirrors
 * `createApp(rootElement, options)` shape — adopters get a ready
 * GatewayHarness without manual `await harness.ready` boilerplate.
 *
 * **Cluster integration.** Pass `cluster: ClusterFactory` to wrap
 * the gateway's local substrate with cluster-aware bus + inbox
 * routing. Apps spawned via `gateway.createApp(...)` automatically
 * inherit the cluster-wrapped substrate (they default to the
 * gateway's `bus`/`inbox`/`journal` instances, which after wrap
 * ARE the cluster-wrapped versions).
 *
 * The gateway owns the cluster lifecycle: `gateway.close()`
 * tears down the cluster AFTER all apps close.
 *
 * This is the recommended pattern for multi-app deployments. Apps
 * passed `cluster: ...` independently via top-level `createApp`
 * each get their own cluster — extra connections, double-delivery.
 * See ADR 35 §10.
 */

import type { ClusterFactory, ClusterParent } from "@agentick/cluster";
import { ulid } from "@agentick/utils";

import { GatewayHarness, type GatewayHarnessOptions } from "./harness.js";

/**
 * Options for {@link createGateway}. Extends
 * {@link GatewayHarnessOptions} with a `cluster` slot.
 */
export interface CreateGatewayOptions extends GatewayHarnessOptions {
  /**
   * Optional cluster factory — produced by `defineUnixCluster`,
   * `defineTcpCluster`, `defineWsCluster`, `defineRedisCluster`,
   * or any custom `ClusterFactory`. When set, the gateway's
   * substrate (`bus`, `inbox`, `journal`) is replaced with the
   * cluster's wrapped substrate, and every App spawned via
   * `gateway.createApp(...)` inherits it.
   *
   * `gateway.close()` closes the cluster after all apps
   * have closed.
   */
  readonly cluster?: ClusterFactory;
}

export async function createGateway(options: CreateGatewayOptions = {}): Promise<GatewayHarness> {
  const { cluster, ...rest } = options;

  let gatewayOptions: GatewayHarnessOptions = rest;
  let clusterClose: (() => Promise<void>) | undefined;

  if (cluster) {
    // Substrate-factory + cluster is incompatible for the same
    // reason as createApp: the cluster needs concrete instances to
    // wrap, and we can't resolve adopter-supplied factories without
    // the parent shell that IS the substrate we're constructing.
    if (
      typeof rest.bus === "function" ||
      typeof rest.inbox === "function" ||
      typeof rest.journal === "function"
    ) {
      throw new Error(
        "createGateway({ cluster }) requires substrate instances (not factories) " +
          "for bus / inbox / journal. Resolve the factories yourself before " +
          "passing to createGateway, or omit them entirely to use defaults.",
      );
    }

    const localBus = rest.bus;
    const localInbox = rest.inbox;
    const localJournal = rest.journal;

    const closeHandlers: Array<() => Promise<void> | void> = [];
    const { LocalEventBus, LocalInbox, MemoryJournal } = await import("@agentick/runtime");
    const parent: ClusterParent = {
      id: rest.gatewayId ?? `gateway:${ulid()}:cluster-parent`,
      bus: localBus ?? new LocalEventBus(),
      inbox: localInbox ?? new LocalInbox(),
      journal: localJournal ?? new MemoryJournal({ capacity: 10_000 }),
      onClose: (h) => {
        closeHandlers.push(h);
      },
    };

    const resolved = await Promise.resolve(cluster(parent));

    gatewayOptions = {
      ...rest,
      bus: resolved.bus,
      inbox: resolved.inbox,
      journal: resolved.journal,
    };

    clusterClose = async () => {
      for (const h of closeHandlers) {
        try {
          await h();
        } catch {
          // best effort
        }
      }
    };
  }

  const gateway = new GatewayHarness(gatewayOptions);

  if (clusterClose) {
    gateway.addInternalCloseHandler(clusterClose);
  }

  await gateway.gatewayReady;
  return gateway;
}
