/**
 * High-level ergonomic facade for joining a WebSocket cluster.
 *
 * Wraps broker-bring-up + multiplexed-client + lifecycle in one
 * call. The wire-agnostic facade plumbing (bus,
 * membership.waitForPeers, lifecycle) lives in
 * `@agentick/cluster-next`'s {@link makeClusterNode} — this module
 * only adds the WebSocket-specific setup on top.
 *
 * Two role modes:
 *
 *   - `mode: "broker"` — start the broker on the URL's host:port +
 *     path. If `httpServer` is provided, mount the upgrade handler
 *     on it (cluster shares port with HTTP API); otherwise the
 *     broker owns its own `http.Server`.
 *   - `mode: "client"` (default) — only join as client; assumes
 *     another process is hosting the broker.
 *
 * No bind-race for WS — cross-host topologies are the norm; pick
 * an explicit role. Single-host hot-deploy scenarios should use
 * the Unix or TCP facades.
 *
 * Power users still get `wsBroker`, `wsClusterNode`, and the
 * lower-level `createWsListener` / `createWsConnector` for custom
 * compositions — those exports are unchanged.
 *
 * @see ./ws-cluster.ts (raw factories)
 * @see @agentick/cluster-next `makeClusterNode` (the shared facade builder)
 */

import type { Server as HttpServer } from "node:http";

import { startBroker, type RunningBroker } from "@agentick/cluster-broker-next";
import { makeClusterNode, type ClusterCodec, type ClusterNode } from "@agentick/cluster-next";
import { omitUndefined } from "@agentick/utils-next";

import { createWsListener } from "./ws-listener.js";
import { wsClusterNode, type WsClusterNodeOptions } from "./ws-cluster.js";

export interface JoinWsClusterOptions extends WsClusterNodeOptions {
  /**
   * Role this process takes.
   *   - `"broker"`: start the broker on the URL's host:port AND
   *     participate as a client.
   *   - `"client"` (default): join an existing broker.
   */
  readonly mode?: "broker" | "client";
  /**
   * Broker only — mount the upgrade handler on an existing
   * `http.Server` instead of starting our own. Lets adopters share
   * the cluster port with their HTTP API / gateway. Ignored on
   * `mode: "client"`.
   */
  readonly httpServer?: HttpServer;
  /**
   * Broker only — origin allowlist for the upgrade handshake.
   * Ignored on `mode: "client"`. See {@link createWsListener}.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Codec for the broker if `mode === "broker"`. Defaults to the
   * client-side `codec`.
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
 * Join (or start) a WebSocket cluster on `opts.url`. See
 * {@link JoinWsClusterOptions.mode} for role selection.
 */
export async function joinWsCluster(opts: JoinWsClusterOptions): Promise<ClusterNode> {
  const {
    url,
    nodeId,
    codec,
    brokerCodec,
    onDiagnostic,
    mode = "client",
    httpServer,
    allowedOrigins,
    ...rest
  } = opts;

  const emitDiag = (layer: "broker" | "client", name: string, payload?: unknown): void => {
    onDiagnostic?.(name, payload, layer);
  };

  // For mode === "broker", parse the URL to derive listener
  // host/port/path. The same URL is used by the self-client to
  // dial in — single source of truth.
  let initialBroker: RunningBroker | null = null;
  if (mode === "broker") {
    const parsed = new URL(url);
    const path = parsed.pathname || "/";

    let listener;
    if (httpServer !== undefined) {
      listener = createWsListener({
        httpServer,
        ...omitUndefined({
          path,
          allowedOrigins,
          onDiagnostic: (n: string, p?: unknown) => emitDiag("broker", n, p),
        }),
      });
    } else {
      // Standalone server — broker owns its own http.Server.
      const port = parsed.port ? Number(parsed.port) : 80;
      listener = createWsListener({
        host: parsed.hostname,
        port,
        ...omitUndefined({
          path,
          allowedOrigins,
          onDiagnostic: (n: string, p?: unknown) => emitDiag("broker", n, p),
        }),
      });
    }
    initialBroker = await startBroker({
      listener,
      ...omitUndefined({
        codec: brokerCodec ?? codec,
        onDiagnostic: (n: string, p?: unknown) => emitDiag("broker", n, p),
      }),
    });
  }

  const factories = wsClusterNode({
    nodeId,
    url,
    ...omitUndefined({
      codec,
      onDiagnostic: (n: string, p?: unknown) => emitDiag("client", n, p),
      ...rest,
    }),
  });

  return makeClusterNode({
    nodeId,
    role: mode === "broker" ? "broker" : "client",
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
