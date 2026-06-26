/**
 * Auto-default for `nodeId`. Returns `${hostname}:${pid}` — unique
 * by construction across:
 *
 *   - Multiple processes on one host (distinct pids).
 *   - Multiple hosts (distinct hostnames; K8s pods get unique
 *     hostnames; bare-metal hosts have explicit hostnames).
 *
 * The danger case is a container started without a hostname being
 * set — most runtimes assign `"localhost"` or an empty string in
 * that mode. Two replicas with the same hostname AND colliding
 * pids would silently merge in the cluster's routing layer, with
 * symptoms ranging from message-to-wrong-node to broadcast loops
 * to handler-double-fire. To prevent that footgun,
 * {@link defaultNodeId} detects the suspicious-hostname case and
 * returns a `suspicious: true` flag; callers (each `defineXCluster`
 * factory) emit a `cluster:nodeId:suspicious` diagnostic via the
 * adopter-supplied `onDiagnostic` sink — production deployments
 * should treat that diagnostic as a configuration error.
 *
 * Explicit `nodeId` always wins. The factories only consult
 * {@link resolveNodeId} when the adopter OMITTED the field.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md
 */

import { hostname } from "node:os";

import { resolveSync, type Resolvable } from "@agentick/utils-next";

import type { NodeId } from "./types.js";

export interface DefaultNodeIdResult {
  readonly nodeId: NodeId;
  /**
   * `true` when the resolved hostname looks unsafe for cluster use
   * (empty / "localhost"). Caller emits a `suspicious` diagnostic;
   * production deployments should treat this as a configuration
   * error.
   */
  readonly suspicious: boolean;
  /** Human-readable reason — surfaced in the diagnostic payload. */
  readonly reason: string;
}

export interface DefaultNodeIdOptions {
  /**
   * Test seam — override the hostname source. Defaults to
   * `node:os.hostname()`. Production callers never set this.
   */
  readonly hostname?: () => string;
  /**
   * Test seam — override the pid source. Defaults to `process.pid`.
   * Production callers never set this.
   */
  readonly pid?: () => number;
}

export function defaultNodeId(opts?: DefaultNodeIdOptions): DefaultNodeIdResult {
  let host = "";
  try {
    host = (opts?.hostname ?? hostname)();
  } catch {
    // Highly degraded runtime (chroot, restricted CAP). Surface
    // via the suspicious path rather than crash.
    host = "";
  }
  const pid = (opts?.pid ?? (() => process.pid))();
  const suspicious = host === "" || host === "localhost";
  return {
    nodeId: `${host || "unknown"}:${pid}`,
    suspicious,
    reason: suspicious
      ? `hostname="${host}" — replicas with this hostname will collide. Set the NODE_ID env var or pass nodeId explicitly to defineXCluster.`
      : `hostname="${host}", pid=${pid}`,
  };
}

/**
 * A nodeId may be supplied as a literal string OR as a synchronous
 * thunk that resolves to one. The thunk form lets adopters defer
 * id resolution until factory-invocation time (typically to read
 * an env var that's set after module load):
 *
 *   nodeId: () => process.env.NODE_ID ?? generateId()
 *
 * Synchronous only — `defineXCluster` is sync, so we can't await
 * a Promise here. Adopters with async resolution should await
 * BEFORE calling `defineXCluster`.
 *
 * Alias for `Resolvable<NodeId>` from `@agentick/utils-next` —
 * preserves the domain-specific name at the cluster surface while
 * routing through the shared primitive for the actual resolution.
 */
export type NodeIdInput = Resolvable<NodeId>;

/**
 * Resolve an adopter-supplied nodeId, falling back to the
 * `${hostname}:${pid}` default when undefined. Emits the
 * appropriate diagnostic on the supplied callback at resolution
 * time. Accepts either a literal nodeId or a synchronous thunk
 * (see {@link NodeIdInput}).
 *
 * Sync. Wire factories call this once per construction before
 * building the underlying client (which needs a concrete nodeId).
 *
 * @param explicit  - the adopter-supplied `nodeId` / thunk (or undefined → default)
 * @param onDiagnostic - emit-once sink for the resolution diagnostic
 * @returns the resolved nodeId — never undefined
 */
export function resolveNodeId(
  explicit: NodeIdInput | undefined,
  onDiagnostic?: (name: string, payload?: unknown) => void,
): NodeId {
  if (explicit !== undefined) {
    return resolveSync(explicit);
  }
  const result = defaultNodeId();
  if (onDiagnostic) {
    onDiagnostic(
      result.suspicious ? "cluster:nodeId:suspicious" : "cluster:nodeId:auto-defaulted",
      { nodeId: result.nodeId, reason: result.reason },
    );
  }
  return result.nodeId;
}
