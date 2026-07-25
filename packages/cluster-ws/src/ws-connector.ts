/**
 * `createWsConnector(opts)` — opens a `WebSocket(url)` to the
 * target broker URL, returns a {@link Connection}-wrapped result.
 *
 * Negotiates the `agentick-cluster-v1` subprotocol on connect.
 * Mismatches between client and broker subprotocol versions
 * surface as a clean connect rejection — the broker responds with
 * HTTP 426 (Upgrade Required) and the `ws` library raises an
 * upgrade error, which we map to a `reject(connect)`.
 */

import { WebSocket as WSConnection } from "ws";

import type { Connection, Connector } from "@agentick/cluster-broker";

import { AGENTICK_CLUSTER_SUBPROTOCOL } from "./ws-shared.js";
import { wsToConnection } from "./ws-connection.js";

export interface WsConnectorOptions {
  /** Broker URL, e.g., `ws://127.0.0.1:9876/cluster` or `wss://...`. */
  readonly url: string;
  /**
   * Connection-establishment timeout. Default: 5_000 ms.
   * WebSocket upgrade involves an HTTP round-trip + protocol
   * negotiation; longer than raw TCP.
   */
  readonly connectTimeoutMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function createWsConnector(opts: WsConnectorOptions): Connector {
  const url = opts.url;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
  const onDiagnostic = opts.onDiagnostic ?? (() => {});

  return {
    target: url,
    connect(): Promise<Connection> {
      return new Promise<Connection>((resolve, reject) => {
        let settled = false;
        const ws = new WSConnection(url, [AGENTICK_CLUSTER_SUBPROTOCOL]);

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          onDiagnostic("cluster:broker:ws:connect-timeout", { url, timeoutMs: connectTimeoutMs });
          ws.terminate();
          reject(new Error(`cluster-ws: connect to ${url} timed out`));
        }, connectTimeoutMs);

        const onError = (cause: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          onDiagnostic("cluster:broker:ws:connect-failed", { url, reason: cause.message });
          reject(cause);
        };

        const onOpen = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.off("error", onError);
          // Verify subprotocol negotiation succeeded — `ws` doesn't
          // throw on mismatch, just leaves the protocol empty. The
          // base broker rejects empty-protocol connections via its
          // upgrade handler so this branch is defensive.
          if (ws.protocol !== AGENTICK_CLUSTER_SUBPROTOCOL) {
            onDiagnostic("cluster:broker:ws:subprotocol-mismatch", {
              url,
              expected: AGENTICK_CLUSTER_SUBPROTOCOL,
              actual: ws.protocol,
            });
            ws.terminate();
            reject(
              new Error(
                `cluster-ws: broker did not negotiate ${AGENTICK_CLUSTER_SUBPROTOCOL}; got "${ws.protocol}"`,
              ),
            );
            return;
          }
          const conn = wsToConnection(ws, { onDiagnostic, remote: url });
          onDiagnostic("cluster:broker:ws:connected", { url });
          resolve(conn);
        };

        ws.once("error", onError);
        ws.once("open", onOpen);
      });
    },
  };
}
