/**
 * High-level WebSocket cluster factories. Wire-specific concerns
 * (mount-on-httpServer vs standalone-port, subprotocol negotiation,
 * allowed-origins policy) are encapsulated in `ws-listener.ts` and
 * `ws-connector.ts`. The shared `{ xBroker, xClusterNode,
 * defineXCluster }` scaffolding lives in
 * `@agentick/cluster-broker-next` (`wire-helpers.ts`).
 */

import type { Server as HttpServer } from "node:http";

import type {
  ClusterCodec,
  ClusterFactory,
  ClusterMembershipFactory,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
  NodeId,
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
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  return startBroker({
    listener,
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
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
      ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
    }),
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.missedPongLimit !== undefined ? { missedPongLimit: opts.missedPongLimit } : {}),
    ...(opts.reconnect !== undefined ? { reconnect: opts.reconnect } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
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

export interface DefineWsClusterOptions extends WsClusterNodeOptions {
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

export function defineWsCluster(opts: DefineWsClusterOptions): ClusterFactory {
  return defineWireCluster({
    nodeId: opts.nodeId,
    node: wsClusterNode(opts),
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.partitioning !== undefined ? { partitioning: opts.partitioning } : {}),
    ...(opts.journal !== undefined ? { journal: opts.journal } : {}),
    ...(opts.fanoutMode !== undefined ? { fanoutMode: opts.fanoutMode } : {}),
  });
}
