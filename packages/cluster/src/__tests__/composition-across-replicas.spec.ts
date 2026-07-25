/**
 * Composition-across-replicas verification.
 *
 * The load-bearing assumption under the multi-tenant distributed
 * gateway: the bus's **fan-in writes / isolated reads** composition
 * (a per-session child bus wrapping its node's bus) still holds when
 * that node bus is cluster-wrapped and events cross replicas.
 *
 * Concretely, with two clustered nodes A and B and a per-session child
 * bus on A:
 *
 *   1. FAN-IN + DISTRIBUTION — an event emitted on the session's child
 *      bus fans UP to node A's (cluster-wrapped) bus and is broadcast
 *      to node B; a gateway-scope observer on node B sees it. Session
 *      output reaches other replicas.
 *
 *   2. ISOLATION SURVIVES CLUSTERING — a *second* session's child bus
 *      on the same node does NOT observe the first session's event,
 *      even though it crossed the cluster. Isolated reads are physical
 *      (separate ring buffers), not filter-based, so clustering can't
 *      leak one session's events into another's read view.
 *
 * If this holds, "multi-tenant" needs no new machinery: it is a child
 * bus per session (isolation) + the existing cluster wire
 * (distribution), composed. This test is the proof.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { EventQuery, ProtocolEvent } from "@agentick/spec";

import type { ClusterParent } from "../cluster.js";
import { defineCluster, defineClusterMembership } from "../define.js";
import {
  createLocalClusterRegistry,
  localClusterTransport,
  type LocalClusterRegistry,
} from "../testing/index.js";

interface NodeRig {
  readonly parent: ClusterParent;
  readonly closes: Array<() => Promise<void> | void>;
}

function mkNode(id: string): NodeRig {
  const closes: Array<() => Promise<void> | void> = [];
  return {
    closes,
    parent: {
      id: `parent:${id}`,
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
      journal: new MemoryJournal(),
      onClose(handler) {
        closes.push(handler);
      },
    },
  };
}

async function teardownNode(rig: NodeRig): Promise<void> {
  for (const h of [...rig.closes].reverse()) await h();
  rig.closes.length = 0;
}

function staticMembership(nodes: string[], current: string) {
  return defineClusterMembership({
    currentNode: current,
    async nodes() {
      return nodes;
    },
    onChange() {
      return async () => {};
    },
    async close() {},
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function ev(id: string, name: string): ProtocolEvent {
  return {
    id,
    surface: "session",
    name,
    phase: "delta",
    timestamp: 0,
    scope: {},
  } as ProtocolEvent;
}

describe("composition across replicas — session child bus + cluster wire", () => {
  let registry: LocalClusterRegistry;
  let nodeA: NodeRig;
  let nodeB: NodeRig;

  beforeEach(() => {
    registry = createLocalClusterRegistry();
    nodeA = mkNode("node-A");
    nodeB = mkNode("node-B");
  });

  afterEach(async () => {
    await teardownNode(nodeA);
    await teardownNode(nodeB);
  });

  it("fan-in from a session child bus reaches another replica; a sibling session stays isolated", async () => {
    const clusterA = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      fanoutMode: "cluster-wide-default",
    })(nodeA.parent);

    const clusterB = await defineCluster({
      nodeId: "node-B",
      transport: localClusterTransport({ registry, nodeId: "node-B" }),
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      fanoutMode: "cluster-wide-default",
    })(nodeB.parent);

    // Two sessions on node A, each a child bus wrapping node A's
    // cluster-wrapped bus — the per-session isolation composition.
    const session1 = new LocalEventBus({ parent: clusterA.bus });
    const session2 = new LocalEventBus({ parent: clusterA.bus });

    const NAME = "session:s1:output";
    const q: EventQuery = { name: { exact: NAME } };

    // Observers: node B gateway-scope (remote), session2 (sibling on A).
    const remoteSeen: string[] = [];
    const siblingSeen: string[] = [];
    const remoteFiber = Effect.runFork(
      clusterB.bus.subscribe(q).pipe(
        Stream.tap((e) => Effect.sync(() => remoteSeen.push(e.id))),
        Stream.runDrain,
      ),
    );
    const siblingFiber = Effect.runFork(
      session2.subscribe(q).pipe(
        Stream.tap((e) => Effect.sync(() => siblingSeen.push(e.id))),
        Stream.runDrain,
      ),
    );
    await flushMicrotasks();

    // Emit on session1's child bus — fans UP to node A's cluster bus.
    await Effect.runPromise(session1.append(ev("s1-evt", NAME)));
    await flushMicrotasks();
    await flushMicrotasks();

    // (1) Fan-in + distribution: node B saw session1's event.
    expect(remoteSeen).toContain("s1-evt");
    // (2) Isolation survives clustering: the sibling session on the
    // SAME node never saw it — isolated reads are physical, so the
    // cluster hop can't leak it into session2's view.
    expect(siblingSeen).not.toContain("s1-evt");

    await Effect.runPromise(Fiber.interrupt(remoteFiber));
    await Effect.runPromise(Fiber.interrupt(siblingFiber));
  });

  it("a session child bus does NOT observe events broadcast onto its node's bus (isolated reads across the wire)", async () => {
    const clusterA = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      fanoutMode: "cluster-wide-default",
    })(nodeA.parent);

    const clusterB = await defineCluster({
      nodeId: "node-B",
      transport: localClusterTransport({ registry, nodeId: "node-B" }),
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      fanoutMode: "cluster-wide-default",
    })(nodeB.parent);

    const sessionOnA = new LocalEventBus({ parent: clusterA.bus });
    const NAME = "session:sB:output";
    const q: EventQuery = { name: { exact: NAME } };

    // A session on node A + node A's own gateway-scope observer.
    const sessionSeen: string[] = [];
    const gatewaySeen: string[] = [];
    const sessionFiber = Effect.runFork(
      sessionOnA.subscribe(q).pipe(
        Stream.tap((e) => Effect.sync(() => sessionSeen.push(e.id))),
        Stream.runDrain,
      ),
    );
    const gatewayFiber = Effect.runFork(
      clusterA.bus.subscribe(q).pipe(
        Stream.tap((e) => Effect.sync(() => gatewaySeen.push(e.id))),
        Stream.runDrain,
      ),
    );
    await flushMicrotasks();

    // A DIFFERENT node emits — it broadcasts onto node A's bus.
    await Effect.runPromise(clusterB.bus.append(ev("remote-evt", NAME)));
    await flushMicrotasks();
    await flushMicrotasks();

    // Node A's gateway-scope observer sees the broadcast (distribution).
    expect(gatewaySeen).toContain("remote-evt");
    // The session child bus on node A does NOT — it reads its own ring,
    // never its parent's, so nothing on the node/cluster bus leaks down
    // into a session's read view.
    expect(sessionSeen).not.toContain("remote-evt");

    await Effect.runPromise(Fiber.interrupt(sessionFiber));
    await Effect.runPromise(Fiber.interrupt(gatewayFiber));
  });
});
