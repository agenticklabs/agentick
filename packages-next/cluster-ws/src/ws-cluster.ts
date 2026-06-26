/**
 * High-level WebSocket cluster factories. Mirror of
 * `cluster-net-next`'s tcp / unix-cluster modules; the WS-specific
 * concerns (mount vs standalone, subprotocol negotiation) are
 * encapsulated in `ws-listener.ts` and `ws-connector.ts`.
 */

import type { Server as HttpServer } from "node:http";

import type {
  ClusterCodec,
  ClusterFactory,
  ClusterMembership,
  ClusterMembershipFactory,
  ClusterParent,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
  MembershipChange,
  NodeId,
} from "@agentick/cluster-next";
import { createJsonCodec, defineCluster } from "@agentick/cluster-next";
import { BaseBroker, BaseClusterClient, type Listener } from "@agentick/cluster-broker-next";

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

export interface RunningWsBroker {
  readonly broker: BaseBroker;
  readonly listener: Listener;
  close(): Promise<void>;
}

export async function wsBroker(opts: WsBrokerOptions): Promise<RunningWsBroker> {
  const listener = createWsListener({
    ...(opts.httpServer !== undefined
      ? ({ httpServer: opts.httpServer } as const)
      : ({ host: opts.host, port: opts.port! } as const)),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  const broker = new BaseBroker({
    listener,
    codec: opts.codec ?? defaultCodec(),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  await broker.start();
  return {
    broker,
    listener,
    async close() {
      await broker.close();
    },
  };
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

export function wsClusterNode(opts: WsClusterNodeOptions): {
  readonly transport: ClusterTransportFactory;
  readonly membership: ClusterMembershipFactory;
} {
  let client: BaseClusterClient | null = null;

  function ensureClient(parent: ClusterParent): BaseClusterClient {
    if (client) return client;
    const c = new BaseClusterClient({
      nodeId: opts.nodeId,
      connector: createWsConnector({
        url: opts.url,
        ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
        ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
      }),
      codec: opts.codec ?? defaultCodec(),
      ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
      ...(opts.missedPongLimit !== undefined ? { missedPongLimit: opts.missedPongLimit } : {}),
      ...(opts.reconnect !== undefined ? { reconnect: opts.reconnect } : {}),
      ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
    });
    client = c;
    parent.onClose(() => c.close());
    return c;
  }

  return {
    transport: (parent) => ensureClient(parent),
    membership: (parent) => clientToMembership(ensureClient(parent), opts.nodeId),
  };
}

function clientToMembership(client: BaseClusterClient, currentNode: NodeId): ClusterMembership {
  return {
    currentNode,
    async nodes() {
      return client.nodes();
    },
    onChange(handler: (change: MembershipChange) => void) {
      const detach = client.onMembershipChange(handler);
      return async () => detach();
    },
    async close() {
      // No-op — shared client's close is wired through parent.onClose.
    },
  };
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
  const node = wsClusterNode(opts);
  return defineCluster({
    nodeId: opts.nodeId,
    transport: node.transport,
    membership: node.membership,
    ...(opts.partitioning !== undefined ? { partitioning: opts.partitioning } : {}),
    ...(opts.journal !== undefined ? { journal: opts.journal } : {}),
    ...(opts.codec !== undefined ? { codec: () => opts.codec! } : {}),
    ...(opts.fanoutMode !== undefined ? { fanoutMode: opts.fanoutMode } : {}),
  });
}

// ============================================================================
// Internals
// ============================================================================

function defaultCodec(): ClusterCodec {
  return createJsonCodec();
}
