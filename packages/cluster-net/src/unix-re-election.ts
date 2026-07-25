/**
 * Internal re-election on broker death (Unix socket only).
 *
 * Single-host multi-worker scenarios (PM2 fork, Node cluster module)
 * benefit from automatic broker failover within the cluster: if the
 * broker-process dies, surviving workers should race to bind the
 * vacated socket. Whoever wins becomes the new broker — no external
 * supervisor restart required, no manual intervention.
 *
 * Scope: Unix sockets only. TCP/WS multi-host re-election requires
 * cross-host consensus (Raft/etcd) and is out of scope. The "use
 * Redis for multi-host" tier covers that case via Redis Sentinel /
 * Cluster — adopters who need multi-host HA reach for that, not for
 * re-election here.
 *
 * Trigger: K consecutive client-side reconnect failures with
 * "broker unreachable" semantics (ENOENT / ECONNREFUSED diagnosed as
 * `cluster:broker:client:connect-failed`). After K, the wrapper
 * calls `tryBindOrConnectUnix({ mode: "auto" })`:
 *
 *   - role === "broker" (we won the bind race) → spin up a local
 *     `BaseBroker` adopting the bound `net.Server`. Surviving
 *     workers' clients reconnect into us. Heal complete in ~one
 *     reconnect-backoff window.
 *   - role === "client" (someone else won) → no-op; our client
 *     continues reconnecting and will hit the new broker on next
 *     attempt.
 *
 * Idempotent: while one re-election is in-flight, additional trigger
 * events are no-ops. After completion, the failure counter resets.
 *
 * @see ./auto-elect.ts (the bind-race primitive)
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §8.a
 */

import {
  startBroker,
  type ClusterNodeFactories,
  type RunningBroker,
} from "@agentick/cluster-broker";
import type { ClusterCodec } from "@agentick/cluster";

import { tryBindOrConnectUnix } from "./auto-elect.js";
import { createUnixListener } from "./unix-listener.js";
import { unixClusterNode, type UnixClusterNodeOptions } from "./unix-cluster.js";

export interface ElectableUnixClusterNodeOptions extends UnixClusterNodeOptions {
  /**
   * Re-election failure threshold — after this many consecutive
   * `cluster:broker:client:connect-failed` diagnostics from the
   * client, try to bind the socket ourselves. Default: 5.
   *
   * Pick the trigger high enough to ride out short-lived broker
   * restarts (supervisor coming back up) and low enough to fail over
   * before adopter-visible work times out. Default tunes for
   * supervisor-restart latency of <10s with default reconnect
   * backoff.
   */
  readonly reElectAfterFailures?: number;
  /**
   * Codec for the local broker if this process is promoted via
   * re-election. Defaults to the client `codec`.
   */
  readonly brokerCodec?: ClusterCodec;
  /**
   * Diagnostic emitter for the spun-up local broker. Defaults to the
   * client `onDiagnostic`.
   */
  readonly brokerOnDiagnostic?: (name: string, payload?: unknown) => void;
}

/**
 * `unixClusterNode` + automatic re-election watcher. Returns the
 * standard `{transport, membership}` factory pair plus a
 * `getLocalBroker()` accessor for adopters that need to introspect
 * which process is currently broker.
 */
export interface ElectableUnixClusterNode extends ClusterNodeFactories {
  /**
   * Returns the local `RunningBroker` if this process has been
   * promoted via re-election, or `null` if this process is currently
   * a client. Useful for diagnostics + tests.
   */
  getLocalBroker(): RunningBroker | null;
  /**
   * Tear down the local broker if one is running. Called automatically
   * via the `ClusterParent.onClose` chain in normal lifecycle; exposed
   * for advanced lifecycle management.
   */
  closeLocalBroker(): Promise<void>;
}

export function electableUnixClusterNode(
  opts: ElectableUnixClusterNodeOptions,
): ElectableUnixClusterNode {
  let localBroker: RunningBroker | null = null;
  let reElectionInProgress = false;
  let consecutiveFailures = 0;
  const triggerThreshold = opts.reElectAfterFailures ?? 5;

  const wrappedOnDiagnostic = (name: string, payload?: unknown): void => {
    opts.onDiagnostic?.(name, payload);

    // Count broker-unreachable failures.
    if (name === "cluster:broker:client:connect-failed") {
      consecutiveFailures += 1;
      if (
        consecutiveFailures >= triggerThreshold &&
        !reElectionInProgress &&
        localBroker === null
      ) {
        void attemptReElection();
      }
      return;
    }
    // Reset counter on any successful connect or welcome.
    if (name === "cluster:broker:client:connected" || name === "cluster:broker:client:welcomed") {
      consecutiveFailures = 0;
    }
  };

  async function attemptReElection(): Promise<void> {
    reElectionInProgress = true;
    opts.onDiagnostic?.("cluster:broker:re-election:attempt", {
      socketPath: opts.socketPath,
      consecutiveFailures,
    });
    try {
      const elect = await tryBindOrConnectUnix({
        socketPath: opts.socketPath,
        mode: "auto",
      });
      if (elect.role === "broker" && elect.server !== undefined) {
        const listener = createUnixListener({
          adoptServer: elect.server,
          ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
          ...(opts.brokerOnDiagnostic !== undefined
            ? { onDiagnostic: opts.brokerOnDiagnostic }
            : opts.onDiagnostic !== undefined
              ? { onDiagnostic: opts.onDiagnostic }
              : {}),
        });
        localBroker = await startBroker({
          listener,
          ...(opts.brokerCodec !== undefined
            ? { codec: opts.brokerCodec }
            : opts.codec !== undefined
              ? { codec: opts.codec }
              : {}),
          ...(opts.brokerOnDiagnostic !== undefined
            ? { onDiagnostic: opts.brokerOnDiagnostic }
            : opts.onDiagnostic !== undefined
              ? { onDiagnostic: opts.onDiagnostic }
              : {}),
        });
        opts.onDiagnostic?.("cluster:broker:re-election:promoted", {
          socketPath: opts.socketPath,
        });
      } else {
        opts.onDiagnostic?.("cluster:broker:re-election:lost-race", {
          socketPath: opts.socketPath,
        });
      }
    } catch (cause) {
      opts.onDiagnostic?.("cluster:broker:re-election:failed", {
        socketPath: opts.socketPath,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      reElectionInProgress = false;
      // Always reset counter — caller's own client will reconnect on
      // next backoff tick, hitting either us (if we won) or whoever
      // else did.
      consecutiveFailures = 0;
    }
  }

  // Build the underlying client with our wrapped diagnostic.
  const patchedOpts: UnixClusterNodeOptions = {
    ...opts,
    onDiagnostic: wrappedOnDiagnostic,
  };
  const baseFactories = unixClusterNode(patchedOpts);

  const closeLocalBroker = async (): Promise<void> => {
    if (localBroker) {
      const b = localBroker;
      localBroker = null;
      await b.close();
    }
  };

  return {
    transport: (parent) => {
      parent.onClose(() => closeLocalBroker());
      return baseFactories.transport(parent);
    },
    membership: baseFactories.membership,
    getLocalBroker: () => localBroker,
    closeLocalBroker,
  };
}
