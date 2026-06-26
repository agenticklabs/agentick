/**
 * High-level ergonomic facade for joining a Unix-socket cluster.
 *
 * Wraps the bind-race + broker-bring-up + multiplexed-client +
 * lifecycle ceremony in a single call. The wire-agnostic facade
 * plumbing (bus, membership.waitForPeers, parent shim, asyncDispose)
 * lives in `@agentick/cluster-next`'s
 * {@link makeClusterNode} — this module only adds the Unix-socket
 * wire-specific setup (bind race + broker adoption) on top.
 *
 * Power users can still reach for the lower-level primitives
 * (`tryBindOrConnectUnix`, `createUnixListener`, `startBroker`,
 * `electableUnixClusterNode`) — those exports are unchanged.
 *
 * @example
 * ```ts
 * await using node = await joinUnixCluster({
 *   socketPath: "/tmp/my-cluster.sock",
 *   nodeId: process.env.NODE_ID!,
 * });
 *
 * node.bus.subscribe("hello", (env) => console.log("from", env.scope.nodeId));
 * await node.membership.waitForPeers(2);
 * await node.bus.broadcast("hello");
 * ```
 *
 * @see ./auto-elect.ts (the bind-race primitive)
 * @see ./unix-re-election.ts (the re-election watcher this wraps)
 * @see @agentick/cluster-next `makeClusterNode` (the shared facade builder)
 */

import { startBroker, type RunningBroker } from "@agentick/cluster-broker-next";
import { makeClusterNode, type ClusterCodec, type ClusterNode } from "@agentick/cluster-next";
import { omitUndefined } from "@agentick/utils-next";

import { tryBindOrConnectUnix } from "./auto-elect.js";
import { createUnixListener } from "./unix-listener.js";
import {
  electableUnixClusterNode,
  type ElectableUnixClusterNodeOptions,
} from "./unix-re-election.js";

export interface JoinUnixClusterOptions extends ElectableUnixClusterNodeOptions {
  /**
   * Codec for the broker if this process wins the initial bind race.
   * Defaults to the same `codec` used by the client side.
   */
  readonly brokerCodec?: ClusterCodec;
  /**
   * Single diagnostic sink. ONE callback receives every diagnostic
   * from the listener, broker, and client layers — no need to plumb
   * three separate `onDiagnostic` opts. Each event carries a `layer`
   * tag (`"broker"` or `"client"`) for downstream routing.
   */
  readonly onDiagnostic?: (name: string, payload?: unknown, layer?: "broker" | "client") => void;
}

/**
 * Join (or start) a Unix-socket cluster on `opts.socketPath`. Races
 * the bind: winner starts a `BaseBroker` adopting the bound server
 * AND participates as a client; losers join as clients only.
 *
 * Re-election watches client-side connect failures and re-runs the
 * bind race when the broker disappears (see
 * {@link electableUnixClusterNode}). Single-host failover requires
 * no external supervisor.
 */
export async function joinUnixCluster(opts: JoinUnixClusterOptions): Promise<ClusterNode> {
  const { socketPath, nodeId, codec, brokerCodec, onDiagnostic, ...rest } = opts;

  const emitDiag = (layer: "broker" | "client", name: string, payload?: unknown): void => {
    onDiagnostic?.(name, payload, layer);
  };

  // 1. Race the bind.
  const elect = await tryBindOrConnectUnix({ socketPath, mode: "auto" });

  // 2. If we won, adopt the bound server into a broker.
  let initialBroker: RunningBroker | null = null;
  if (elect.role === "broker" && elect.server !== undefined) {
    const listener = createUnixListener({
      adoptServer: elect.server,
      onDiagnostic: (n, p) => emitDiag("broker", n, p),
    });
    initialBroker = await startBroker({
      listener,
      ...omitUndefined({
        codec: brokerCodec ?? codec,
        onDiagnostic: (n: string, p?: unknown) => emitDiag("broker", n, p),
      }),
    });
  }

  // 3. Build the electable client factories. `electableUnixClusterNode`
  //    handles reconnect + auto-promote-on-broker-death.
  const factories = electableUnixClusterNode({
    socketPath,
    nodeId,
    ...omitUndefined({
      codec,
      brokerCodec,
      onDiagnostic: (n: string, p?: unknown) => emitDiag("client", n, p),
      brokerOnDiagnostic: (n: string, p?: unknown) => emitDiag("broker", n, p),
      ...rest,
    }),
  });

  // 4. Hand the factory pair to the shared facade builder. Everything
  //    bus/membership/lifecycle related is wire-agnostic.
  return makeClusterNode({
    nodeId,
    // Collapse the explicit/inferred axis — adopters only care
    // whether THIS process is currently serving the broker or not.
    role: elect.role.startsWith("broker") ? "broker" : "client",
    transportFactory: factories.transport,
    membershipFactory: factories.membership,
    cleanup: async () => {
      if (initialBroker) {
        await initialBroker.close();
        initialBroker = null;
      }
      await factories.closeLocalBroker();
    },
    localBrokerRunning: () => initialBroker !== null || factories.getLocalBroker() !== null,
  });
}
