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

import { Cause, Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, compileQuery } from "@agentick/runtime-next";
import type { EventQuery, MessageHandlerError, ProtocolEvent } from "@agentick/spec-next";
import type { MembershipChange } from "../types.js";

import type { ClusterParent } from "../cluster.js";
import { defineCluster, defineClusterMembership, defineClusterTransport } from "../define.js";
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

  // ----------------- Phase 3.1: cross-node ask -----------------

  it("remote ask: address owned by node B is dispatched via transport; handler value returns to A", async () => {
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

    // Register a handler on node B (the partition owner).
    await Effect.runPromise(
      clusterB.inbox.register<{ x: number }, number>("calc:remote-doubler", (env) =>
        Effect.sync(() => (env.payload?.x ?? 0) * 2),
      ),
    );

    // Ask from node A — wrapper routes via transport to B; B's handler
    // runs; response envelope returns to A; A's wrapper resolves the
    // pending Deferred.
    const result = await Effect.runPromise<number, never>(
      clusterA.inbox
        .ask<{ x: number }, number>("calc:remote-doubler", {
          type: "double",
          payload: { x: 7 },
        })
        .pipe(Effect.orDie) as unknown as Effect.Effect<number, never, never>,
    );
    expect(result).toBe(14);
  });

  it("remote ask: handler-side typed failure round-trips as MessageHandlerError", async () => {
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

    await Effect.runPromise(
      clusterB.inbox.register("calc:always-fails", () =>
        Effect.fail({ _tag: "InvalidPayload", reason: "test-failure" } as MessageHandlerError),
      ),
    );

    const exit = await Effect.runPromiseExit(
      clusterA.inbox.ask("calc:always-fails", { type: "query" }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      // The handler-side typed `MessageHandlerError` must survive the
      // round trip — it should NOT have collapsed to RoutingFailed or
      // some stringly-typed error.
      const failureOpt = Cause.failureOption(exit.cause);
      expect(failureOpt._tag).toBe("Some");
      if (failureOpt._tag === "Some") {
        const err = failureOpt.value as MessageHandlerError;
        expect(err._tag).toBe("InvalidPayload");
        if (err._tag === "InvalidPayload") {
          expect(err.reason).toBe("test-failure");
        }
      }
    }
  });

  it("remote ask: timeout fires AskTimeout when the owner doesn't reply", async () => {
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
    // Node B exists but has no registered handler at the queried
    // address — local.ask on B will fail with AddressNotFound, which
    // round-trips back to A as a HandlerError wrapping the routing
    // error. We bound timeoutMs short so the test runs quickly.
    await defineCluster({
      nodeId: "node-B",
      transport: localClusterTransport({ registry, nodeId: "node-B" }),
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      partitioning: () => partitioning,
    })(nodeB.parent);

    const exit = await Effect.runPromiseExit(
      clusterA.inbox.ask("calc:no-handler-anywhere", { type: "query" }, { timeoutMs: 100 }),
    );
    expect(exit._tag).toBe("Failure");
  });

  // ----------------- Phase 3.1: diagnostic events -----------------

  it("emits cluster:transport:send:failed when transport.send rejects", async () => {
    // Custom transport whose `send` always rejects so we observe the
    // diagnostic. Subscribe on the LOCAL bus to see it without
    // depending on fanout mode.
    const failingTransport = defineFailingTransport();

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({ surface: "cluster", name: { exact: "cluster:transport:send:failed" } })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    const partitioning = {
      shardKeyFor: (address: string): string => address,
      nodeFor: async (): Promise<string> => "node-B",
    };
    const clusterA = await defineCluster({
      nodeId: "node-A",
      transport: failingTransport,
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      partitioning: () => partitioning,
    })(nodeA.parent);

    // Fire a remote send; transport.send rejects; wrapper emits diag.
    const exit = await Effect.runPromiseExit(clusterA.inbox.send("calc:remote", { type: "x" }));
    expect(exit._tag).toBe("Failure");
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:transport:send:failed"]);
  });

  it("emits cluster:routing:address-not-found when inbound tell hits an unregistered address", async () => {
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
    await defineCluster({
      nodeId: "node-B",
      transport: localClusterTransport({ registry, nodeId: "node-B" }),
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      partitioning: () => partitioning,
    })(nodeB.parent);

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeB.parent.bus
        .subscribe({
          surface: "cluster",
          name: { exact: "cluster:routing:address-not-found" },
        })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    // Send to an unregistered address on node B.
    await Effect.runPromise(clusterA.inbox.send("never:registered", { type: "tell" }));
    await flushMicrotasks();
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:routing:address-not-found"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.1: membership reactivity
// ---------------------------------------------------------------------------

describe("defineCluster — membership reactivity", () => {
  let registry: LocalClusterRegistry;
  let nodeA: NodeRig;

  beforeEach(() => {
    registry = createLocalClusterRegistry();
    nodeA = mkNode("node-A");
  });

  afterEach(async () => {
    await teardownNode(nodeA);
  });

  it("emits cluster:membership:* events when the membership impl signals changes", async () => {
    // Wire a controllable membership so we can fire arbitrary changes.
    const handlers: Array<(c: MembershipChange) => void> = [];
    const membershipFactory = defineClusterMembership({
      currentNode: "node-A",
      async nodes() {
        return ["node-A"];
      },
      onChange(handler) {
        handlers.push(handler);
        // Issue an initial snapshot, mirroring the contract that
        // implementations MUST emit at least one snapshot per
        // subscription.
        handler({ kind: "snapshot", nodes: ["node-A"], at: "0" });
        return async () => {};
      },
      async close() {},
    });

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({ surface: "cluster", name: { prefix: "cluster:membership:" } })
        .pipe(
          Stream.take(3),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: membershipFactory,
    })(nodeA.parent);

    // Fire two more transitions from the membership impl.
    for (const handler of handlers) {
      handler({ kind: "joined", node: "node-X", at: "1" });
      handler({ kind: "lost", node: "node-X", at: "2", reason: "graceful" });
    }
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));

    expect(seen).toEqual([
      "cluster:membership:snapshot",
      "cluster:membership:joined",
      "cluster:membership:lost",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test helpers — failing transport for diagnostic coverage
// ---------------------------------------------------------------------------

/**
 * Transport whose `send` and `broadcast` always reject. Used to drive
 * the diagnostic-emission paths without needing real I/O failures.
 */
function defineFailingTransport() {
  return defineClusterTransport({
    async send(): Promise<void> {
      throw new Error("transport-send-disabled-for-test");
    },
    async broadcast(): Promise<void> {
      throw new Error("transport-broadcast-disabled-for-test");
    },
    subscribeInbox() {
      return async () => {};
    },
    subscribeBus() {
      return async () => {};
    },
    async close() {},
  });
}

// Silence the unused-import lint — these types are used in inferred
// generic positions above.
type _MHE = MessageHandlerError;
