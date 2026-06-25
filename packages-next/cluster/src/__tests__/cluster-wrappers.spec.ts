/**
 * Phase 3 integration tests — `ClusterEventBus` + `ClusterInbox`
 * wrappers exercised end-to-end against the `LocalClusterTransport`
 * fixture.
 *
 * Two-node setup: factoryA + factoryB share a registry, mirroring the
 * conformance suite. Each test constructs both nodes' clusters via
 * `defineCluster` so the wrappers are wired exactly the way the
 * framework will wire them in createGateway / createApp.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, compileQuery } from "@agentick/runtime-next";
import type { EventQuery, MessageHandlerError, ProtocolEvent } from "@agentick/spec-next";

import type { ClusterParent } from "../cluster.js";
import { defineCluster, defineClusterMembership } from "../define.js";
import {
  createLocalClusterRegistry,
  localClusterTransport,
  type LocalClusterRegistry,
} from "../testing/index.js";

// ---------------------------------------------------------------------------
// Two-node test harness
// ---------------------------------------------------------------------------

interface NodeRig {
  readonly id: string;
  readonly parent: ClusterParent;
  readonly closes: Array<() => Promise<void> | void>;
}

function mkNode(id: string): NodeRig {
  const closes: Array<() => Promise<void> | void> = [];
  return {
    id,
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

/**
 * Yield to the microtask queue so the `LocalClusterTransport` finishes
 * delivering queued envelopes. The fixture routes via `queueMicrotask`;
 * the same `flushMicrotasks` helper as the conformance suite.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// ClusterEventBus
// ---------------------------------------------------------------------------

describe("ClusterEventBus — bus wrapping", () => {
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

  it("cluster-wide-default: append on node A is observed by a subscriber on node B", async () => {
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

    // Subscribe on node B for events named "tool:test:ping".
    const received: ProtocolEvent[] = [];
    const query: EventQuery = { name: { exact: "tool:test:ping" } };
    const fiber = Effect.runFork(
      clusterB.bus.subscribe(query).pipe(
        Stream.take(1),
        Stream.tap((env) => Effect.sync(() => received.push(env))),
        Stream.runDrain,
      ),
    );

    // Give the subscriber a microtask to register before we publish.
    await flushMicrotasks();

    await Effect.runPromise(
      clusterA.bus.append({
        id: "evt-1",
        surface: "tool",
        name: "tool:test:ping",
        phase: "delta",
        timestamp: 0,
        scope: {},
      }),
    );

    // Allow the transport hop + local-bus re-append on B to land.
    await flushMicrotasks();
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));

    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe("tool:test:ping");
    expect(received[0]?.scope.nodeId).toBe("node-A");
  });

  it("node-local-default: append on node A is NOT observed by node B", async () => {
    const clusterA = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      fanoutMode: "node-local-default",
    })(nodeA.parent);

    const clusterB = await defineCluster({
      nodeId: "node-B",
      transport: localClusterTransport({ registry, nodeId: "node-B" }),
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      fanoutMode: "node-local-default",
    })(nodeB.parent);

    const received: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      clusterB.bus.read({ value: 0 }, compileQuery({ name: { exact: "tool:test:ping" } })).pipe(
        Stream.tap((env) => Effect.sync(() => received.push(env))),
        Stream.runDrain,
      ),
    );

    await flushMicrotasks();

    await Effect.runPromise(
      clusterA.bus.append({
        id: "evt-1",
        surface: "tool",
        name: "tool:test:ping",
        phase: "delta",
        timestamp: 0,
        scope: {},
      }),
    );

    // Even after flushing, the remote event must NOT appear on B's bus.
    await flushMicrotasks();
    await flushMicrotasks();

    expect(received).toHaveLength(0);
    fiber.unsafeInterruptAsFork(fiber.id());
  });

  it("local subscribers on the SAME node see local appends regardless of fanoutMode", async () => {
    const cluster = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A"], "node-A"),
      fanoutMode: "node-local-default",
    })(nodeA.parent);

    const received: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      cluster.bus.subscribe({ name: { exact: "tool:local:bing" } }).pipe(
        Stream.take(1),
        Stream.tap((env) => Effect.sync(() => received.push(env))),
        Stream.runDrain,
      ),
    );

    await flushMicrotasks();
    await Effect.runPromise(
      cluster.bus.append({
        id: "evt-local",
        surface: "tool",
        name: "tool:local:bing",
        phase: "delta",
        timestamp: 0,
        scope: {},
      }),
    );

    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(received).toHaveLength(1);
    expect(received[0]?.scope.nodeId).toBe("node-A");
  });

  it("emits cluster:wrap:installed diagnostic on construction", async () => {
    // Subscribe to the LOCAL bus (before wrapping) for the diagnostic
    // event the wrapper emits on construction.
    const seen: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus.subscribe({ surface: "cluster" }).pipe(
        Stream.take(1),
        Stream.tap((env) => Effect.sync(() => seen.push(env))),
        Stream.runDrain,
      ),
    );
    await flushMicrotasks();

    await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A"], "node-A"),
    })(nodeA.parent);

    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("cluster:wrap:installed");
  });
});

// ---------------------------------------------------------------------------
// ClusterInbox
// ---------------------------------------------------------------------------

describe("ClusterInbox — inbox wrapping", () => {
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

  it("local send: address owned by current node bypasses transport", async () => {
    const cluster = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A"], "node-A"),
    })(nodeA.parent);

    const received: string[] = [];
    await Effect.runPromise(
      cluster.inbox.register("tasks:s-local", (env) =>
        Effect.sync(() => {
          received.push(env.type);
        }),
      ),
    );

    await Effect.runPromise(
      cluster.inbox.send("tasks:s-local", { type: "ping", payload: { v: 1 } }),
    );
    await flushMicrotasks();
    expect(received).toEqual(["ping"]);
  });

  it("remote send: address owned by node B is routed via transport to B's handler", async () => {
    // Pin partitioning so address "tasks:s-x" goes to node B regardless
    // of the consistent-hash result.
    const partitioning = {
      shardKeyFor: (address: string): string => address,
      nodeFor: async (): Promise<string> => "node-B",
    };

    const clusterA = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      partitioning: () => partitioning,
    })(nodeA.parent);

    const clusterB = await defineCluster({
      nodeId: "node-B",
      transport: localClusterTransport({ registry, nodeId: "node-B" }),
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      partitioning: () => partitioning,
    })(nodeB.parent);

    const onB: { type: string; from?: string }[] = [];
    await Effect.runPromise(
      clusterB.inbox.register("tasks:s-x", (env) =>
        Effect.sync(() => {
          onB.push({ type: env.type, from: env.from });
        }),
      ),
    );

    const ack = await Effect.runPromise(
      clusterA.inbox.send("tasks:s-x", { type: "cancel", payload: { reason: "user" } }),
    );

    // Multiple flushes — send hops the transport, then B's local
    // send dispatches the handler.
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ack.messageId).toBeTruthy();
    expect(onB).toEqual([{ type: "cancel", from: "node:node-A" }]);
  });

  it("remote ask is not supported in Phase 3 — fails with a clear pointer", async () => {
    const partitioning = {
      shardKeyFor: (address: string): string => address,
      nodeFor: async (): Promise<string> => "node-B",
    };
    const clusterA = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      partitioning: () => partitioning,
    })(nodeA.parent);

    const exit = await Effect.runPromiseExit(
      clusterA.inbox.ask("tasks:s-remote", { type: "query" }),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("local ask: address owned by current node returns the handler's value", async () => {
    const cluster = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A"], "node-A"),
    })(nodeA.parent);

    await Effect.runPromise(
      cluster.inbox.register<{ x: number }, number>("calc:doubler", (env) =>
        Effect.sync(() => (env.payload?.x ?? 0) * 2),
      ),
    );

    const result = await Effect.runPromise<number, never>(
      cluster.inbox
        .ask<{ x: number }, number>("calc:doubler", { type: "double", payload: { x: 5 } })
        // We've registered a handler so MessageHandlerError can't actually
        // occur; cast the Effect into the never-error channel.
        .pipe(Effect.orDie) as unknown as Effect.Effect<number, never, never>,
    );
    expect(result).toBe(10);
  });
});

// Silence the unused-import lint — Effect.fromFiber is used above.
type _MHE = MessageHandlerError;
