/**
 * High-level WebSocket cluster factories. Wire-specific concerns
 * (mount-on-httpServer vs standalone-port, subprotocol negotiation,
 * allowed-origins policy) are encapsulated in `ws-listener.ts` and
 * `ws-connector.ts`. The shared `{ xBroker, xClusterNode,
 * defineXCluster }` scaffolding lives in
 * `@agentick/cluster-broker-next` (`wire-helpers.ts`).
 */

import type { Server as HttpServer } from "node:http";

import {
  resolveNodeId,
  type ClusterCodec,
  type ClusterFactory,
  type ClusterMembershipFactory,
  type ClusterPartitioningFactory,
  type ClusterTransportFactory,
  type DurableJournalFactory,
  type NodeId,
  type NodeIdInput,
} from "@agentick/cluster-next";
import {
  createClusterNode,
  defineWireCluster,
  startBroker,
  type ClusterNodeFactories,
  type RunningBroker,
} from "@agentick/cluster-broker-next";

import { createWsConnector } from "./ws-connector.js";
import { createWsListener } from "./ws-listener.js";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// wsBroker — convenience for the broker-elected process
// ============================================================================

export type WsBrokerOptions = (
  | { readonly httpServer: HttpServer; readonly host?: undefined; readonly port?: undefined }
  | { readonly httpServer?: undefined; readonly host?: string; readonly port: number }
) & {
  readonly path?: string;
  readonly allowedOrigins?: readonly string[];
  readonly codec?: ClusterCodec;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
};

export type RunningWsBroker = RunningBroker;

export async function wsBroker(opts: WsBrokerOptions): Promise<RunningWsBroker> {
  const listener = createWsListener({
    ...(opts.httpServer !== undefined
      ? ({ httpServer: opts.httpServer } as const)
      : ({ host: opts.host, port: opts.port! } as const)),
    ...omitUndefined({
      path: opts.path,
      allowedOrigins: opts.allowedOrigins,
      onDiagnostic: opts.onDiagnostic,
    }),
  });
  return startBroker({
    listener,
    ...omitUndefined({ codec: opts.codec, onDiagnostic: opts.onDiagnostic }),
  });
}

// ============================================================================
// wsClusterNode — multiplexed transport + membership
// ============================================================================

export interface WsClusterNodeOptions {
  readonly nodeId: NodeId;
  /** Broker URL, e.g., `ws://127.0.0.1:9876/cluster`. */
  readonly url: string;
  readonly codec?: ClusterCodec;
  readonly heartbeatMs?: number;
  readonly missedPongLimit?: number;
  readonly reconnect?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly maxAttempts?: number;
  };
  readonly connectTimeoutMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function wsClusterNode(opts: WsClusterNodeOptions): ClusterNodeFactories {
  return createClusterNode({
    nodeId: opts.nodeId,
    connector: createWsConnector({
      url: opts.url,
      ...omitUndefined({
        connectTimeoutMs: opts.connectTimeoutMs,
        onDiagnostic: opts.onDiagnostic,
      }),
    }),
    ...omitUndefined({
      codec: opts.codec,
      heartbeatMs: opts.heartbeatMs,
      missedPongLimit: opts.missedPongLimit,
      reconnect: opts.reconnect,
      onDiagnostic: opts.onDiagnostic,
    }),
  });
}

export function wsTransport(opts: WsClusterNodeOptions): ClusterTransportFactory {
  return wsClusterNode(opts).transport;
}

export function wsMembership(opts: WsClusterNodeOptions): ClusterMembershipFactory {
  return wsClusterNode(opts).membership;
}

// ============================================================================
// defineWsCluster — top-level convenience
// ============================================================================

export interface DefineWsClusterOptions extends Omit<WsClusterNodeOptions, "nodeId"> {
  /**
   * This node's identity. Optional — defaults to `${hostname}:${pid}`
   * via {@link resolveNodeId}. Accepts either a literal string or a
   * synchronous thunk (e.g. `() => process.env.NODE_ID ?? generateId()`).
   * A `cluster:nodeId:auto-defaulted` or `cluster:nodeId:suspicious`
   * diagnostic fires on the supplied `onDiagnostic` sink at
   * construction time.
   */
  readonly nodeId?: NodeIdInput;
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

export function defineWsCluster(opts: DefineWsClusterOptions): ClusterFactory {
  // Resolve nodeId once at the public boundary; pass concrete value
  // to both the wire factory and defineWireCluster so they agree.
  const nodeId = resolveNodeId(opts.nodeId, opts.onDiagnostic);
  return defineWireCluster({
    nodeId,
    node: wsClusterNode({ ...opts, nodeId }),
    ...omitUndefined({
      codec: opts.codec,
      partitioning: opts.partitioning,
      journal: opts.journal,
      fanoutMode: opts.fanoutMode,
    }),
  });
}
