/**
 * Cluster diagnostic event emission — shared between
 * `ClusterEventBus` and `ClusterInbox`.
 *
 * Diagnostics are appended to the parent's LOCAL bus (not the
 * cluster-wrapped bus) so they're guaranteed local-visible regardless
 * of `fanoutMode` and so emitting a diagnostic on a broadcast failure
 * doesn't itself trigger another broadcast.
 *
 * Event taxonomy (all `surface: "cluster"`):
 *   - `cluster:wrap:installed`               wrapper construction
 *   - `cluster:wrap:disposed`                wrapper teardown
 *   - `cluster:membership:joined`            node joined the cluster
 *   - `cluster:membership:lost`              node left / heartbeat timeout
 *   - `cluster:membership:snapshot`          full topology snapshot
 *   - `cluster:transport:broadcast:failed`   broadcast Promise rejected
 *   - `cluster:transport:send:failed`        send Promise rejected
 *   - `cluster:routing:address-not-found`    inbound dispatched to no handler
 *   - `cluster:ask:dispatched`               remote ask sent over the wire
 *   - `cluster:ask:resolved`                 remote ask completed (success/fail)
 *   - `cluster:ask:timeout`                  remote ask exceeded timeoutMs
 *   - `cluster:ask:response-orphaned`        response arrived with no pending entry
 */

import { Effect } from "effect";
import type { EventBus, EventPhase, ProtocolEvent } from "@agentick/spec";
import { ulid } from "@agentick/utils";

import type { NodeId } from "../types.js";

export interface DiagnosticBuilderOptions {
  /** Parent's local bus — diagnostics append here. */
  readonly localBus: EventBus;
  /** Current node id — stamped on every diagnostic's scope. */
  readonly currentNode: NodeId;
}

/**
 * Construct a fire-and-forget diagnostic emitter bound to a local
 * bus + current node. Each call schedules an `Effect.runFork(append)`;
 * if the bus is closed the runFork resolves silently. Callers don't
 * await — diagnostics never block the calling path.
 */
export function makeDiagnostics(opts: DiagnosticBuilderOptions): DiagnosticEmitter {
  return new DiagnosticEmitter(opts.localBus, opts.currentNode);
}

export class DiagnosticEmitter {
  constructor(
    private readonly localBus: EventBus,
    private readonly currentNode: NodeId,
  ) {}

  /**
   * Append a `surface: "cluster"` diagnostic on the local bus. Always
   * `phase: "terminal"` (these are discrete observation events, not
   * operation lifecycles). Fire-and-forget — failures are silent
   * because diagnostic emission MUST NOT block the path that emitted
   * the diagnostic.
   */
  emit(name: string, payload?: unknown, phase: EventPhase = "terminal"): void {
    const event: ProtocolEvent = {
      id: ulid(),
      surface: "cluster",
      name,
      phase,
      timestamp: Date.now(),
      scope: { nodeId: this.currentNode },
      ...(payload !== undefined ? { payload } : {}),
    };
    Effect.runFork(this.localBus.append(event));
  }
}
