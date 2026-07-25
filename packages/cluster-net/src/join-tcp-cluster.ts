/**
 * High-level ergonomic facade for joining a TCP cluster.
 *
 * Wraps the optional bind-race + broker-bring-up + multiplexed-client
 * + lifecycle ceremony in a single call. Wire-agnostic facade
 * plumbing (bus, membership.waitForPeers, lifecycle) lives in
 * `@agentick/cluster`'s {@link makeClusterNode} — this module
 * only adds TCP-specific setup on top.
 *
 * Three role modes:
 *
 *   - `mode: "broker"` — start the broker on `host:port`, then join
 *     as a client of our own broker. Use for the designated
 *     broker-process in TCP topologies.
 *   - `mode: "client"` — only join as a client; assumes another
 *     process is hosting the broker. Default.
 *   - `mode: "auto"` — race to bind `host:port` (single-host only,
 *     since TCP can't bind the same port across hosts). Loser
 *     joins as client. Single-host hot-deploy scenarios use this.
 *
 * Power users still get the lower-level primitives (`tcpBroker`,
 * `tcpClusterNode`, `tryBindOrConnect`) — those exports are
 * unchanged.
 *
 * @see ./tcp-cluster.ts (raw factories)
 * @see ./auto-elect.ts (bind-race primitive)
 * @see @agentick/cluster `makeClusterNode` (the shared facade builder)
 */

import { startBroker, type RunningBroker } from "@agentick/cluster-broker";
import {
  makeClusterNode,
  resolveNodeId,
  type ClusterCodec,
  type ClusterNode,
  type NodeIdInput,
} from "@agentick/cluster";
import { omitUndefined } from "@agentick/utils";

import { tryBindOrConnect } from "./auto-elect.js";
import { createTcpListener } from "./tcp-listener.js";
import { tcpClusterNode, type TcpClusterNodeOptions } from "./tcp-cluster.js";

export interface JoinTcpClusterOptions extends Omit<TcpClusterNodeOptions, "nodeId"> {
  /**
   * This node's identity. Optional — defaults to `${hostname}:${pid}`
   * via {@link resolveNodeId}. A `cluster:nodeId:auto-defaulted` or
   * `cluster:nodeId:suspicious` diagnostic fires on the supplied
   * `onDiagnostic` sink (with `layer: "client"`) at join time.
   */
  readonly nodeId?: NodeIdInput;
  /**
   * Role this process takes.
   *   - `"broker"`: start the broker on `host:port` AND participate
   *     as a client.
   *   - `"client"`: join an existing broker (default).
   *   - `"auto"`: bind-race on `host:port` (single-host topologies
   *     only — cross-host adopters should pick an explicit role).
   */
  readonly mode?: "broker" | "client" | "auto";
  /**
   * Codec for the broker side. Defaults to the same `codec` used by
   * the client side.
   */
  readonly brokerCodec?: ClusterCodec;
  /**
   * Single diagnostic sink. ONE callback receives every diagnostic
   * from the listener, broker, and client layers — no need to plumb
   * three separate `onDiagnostic` opts. Each event carries a `layer`
   * tag for downstream routing.
   */
  readonly onDiagnostic?: (name: string, payload?: unknown, layer?: "broker" | "client") => void;
}

/**
 * Join (or start) a TCP cluster on `opts.host:opts.port`. See
 * {@link JoinTcpClusterOptions.mode} for the role selection.
 */
export async function joinTcpCluster(opts: JoinTcpClusterOptions): Promise<ClusterNode> {
  const {
    host,
    port,
    nodeId: explicitNodeId,
    codec,
    brokerCodec,
    onDiagnostic,
    mode = "client",
    ...rest
  } = opts;

  const emitDiag = (layer: "broker" | "client", name: string, payload?: unknown): void => {
    onDiagnostic?.(name, payload, layer);
  };

  const nodeId = resolveNodeId(explicitNodeId, (n, p) => emitDiag("client", n, p));

  // Resolve actual role:
  //   - "broker" / "client": as written.
  //   - "auto": race to bind; winner = broker, loser = client.
  let resolvedRole: "broker" | "client" = mode === "broker" ? "broker" : "client";
  let initialBroker: RunningBroker | null = null;

  if (mode === "auto") {
    const elect = await tryBindOrConnect({
      ...omitUndefined({ host }),
      port,
      mode: "auto",
    });
    resolvedRole = elect.role.startsWith("broker") ? "broker" : "client";
    if (resolvedRole === "broker" && elect.server !== undefined) {
      const listener = createTcpListener({
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
  } else if (mode === "broker") {
    // Explicit broker — bind the listener directly (no race).
    const listener = createTcpListener({
      ...omitUndefined({ host }),
      port,
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

  const factories = tcpClusterNode({
    ...omitUndefined({ host }),
    port,
    nodeId,
    ...omitUndefined({
      codec,
      onDiagnostic: (n: string, p?: unknown) => emitDiag("client", n, p),
      ...rest,
    }),
  });

  return makeClusterNode({
    nodeId,
    role: resolvedRole,
    transportFactory: factories.transport,
    membershipFactory: factories.membership,
    cleanup: async () => {
      if (initialBroker) {
        await initialBroker.close();
        initialBroker = null;
      }
    },
    localBrokerRunning: () => initialBroker !== null,
  });
}
