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

import { Cause, Effect, Fiber, Stream } from "effect";
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

  it("remote ask: routing-side InboxError (AddressNotFound) round-trips with original tag", async () => {
    // Node B exists but never registers a handler. local.ask on B
    // fails with InboxError { _tag: "AddressNotFound" }; the wrapper's
    // causeToAskFailure routes that to a `routing-fail` payload; A
    // reconstructs the typed InboxError and rejects the pending
    // Effect with the original tag preserved.
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

    const exit = await Effect.runPromiseExit(
      clusterA.inbox.ask("calc:no-handler", { type: "query" }, { timeoutMs: 1_000 }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failureOpt = Cause.failureOption(exit.cause);
      expect(failureOpt._tag).toBe("Some");
      if (failureOpt._tag === "Some") {
        // The InboxError typed tag survived; it did NOT collapse to a
        // synthesized HandlerError or to RoutingFailed.
        expect((failureOpt.value as { _tag: string })._tag).toBe("AddressNotFound");
      }
    }
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

// ---------------------------------------------------------------------------
// Phase 3.2: namespace enforcement
// ---------------------------------------------------------------------------

describe("ClusterInbox — reserved namespace enforcement", () => {
  let registry: LocalClusterRegistry;
  let nodeA: NodeRig;

  beforeEach(() => {
    registry = createLocalClusterRegistry();
    nodeA = mkNode("node-A");
  });

  afterEach(async () => {
    await teardownNode(nodeA);
  });

  async function makeClusterA() {
    return defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A"], "node-A"),
    })(nodeA.parent);
  }

  it("register: rejects @cluster/-prefixed address with RoutingFailed", async () => {
    const cluster = await makeClusterA();
    const exit = await Effect.runPromiseExit(
      cluster.inbox.register("@cluster/asks:node-evil", () => Effect.succeed(undefined)),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failureOpt = Cause.failureOption(exit.cause);
      if (failureOpt._tag === "Some") {
        expect((failureOpt.value as { _tag: string })._tag).toBe("RoutingFailed");
      }
    }
  });

  it("send: rejects @cluster/-prefixed address", async () => {
    const cluster = await makeClusterA();
    const exit = await Effect.runPromiseExit(
      cluster.inbox.send("@cluster/asks:node-A", { type: "adopter-message" }),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("send: rejects @cluster/-prefixed message type", async () => {
    const cluster = await makeClusterA();
    const exit = await Effect.runPromiseExit(
      cluster.inbox.send("calc:foo", { type: "@cluster/ask-response" }),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("ask: rejects @cluster/-prefixed address", async () => {
    const cluster = await makeClusterA();
    const exit = await Effect.runPromiseExit(
      cluster.inbox.ask("@cluster/asks:node-A", { type: "spoof" }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

// ---------------------------------------------------------------------------
// Phase 3.2: caller-interrupt cleanup (Effect.async cancel hook)
// ---------------------------------------------------------------------------

describe("ClusterInbox — askRemote caller-interrupt cleanup", () => {
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

  it("emits cluster:ask:interrupted when the asker is interrupted before response", async () => {
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

    // Register a handler on B that NEVER completes (so the asker
    // can be interrupted while pending).
    await Effect.runPromise(clusterB.inbox.register("calc:slow", () => Effect.never));

    const seen: string[] = [];
    const diagFiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({ surface: "cluster", name: { exact: "cluster:ask:interrupted" } })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    // Fire ask in a fiber, then interrupt it. The cancel hook on
    // Effect.async clears the pendingAsks entry + timeoutHandle and
    // emits cluster:ask:interrupted.
    const askFiber = Effect.runFork(
      clusterA.inbox.ask("calc:slow", { type: "go" }, { timeoutMs: 30_000 }),
    );
    await flushMicrotasks();
    await flushMicrotasks();
    await Effect.runPromise(Fiber.interrupt(askFiber));
    await flushMicrotasks();

    await Effect.runPromise(Effect.fromFiber(diagFiber));
    expect(seen).toEqual(["cluster:ask:interrupted"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.2: wire payload validation
// ---------------------------------------------------------------------------

describe("ClusterInbox — wire payload validation", () => {
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

  it("emits cluster:ask:invalid-payload on malformed inbound request", async () => {
    // Two clusters wired up. We'll bypass the wrapper's outbound path
    // and inject a malformed @cluster/ask envelope directly through
    // the transport so we can verify the receiver's validation.
    const partitioning = {
      shardKeyFor: (address: string): string => address,
      nodeFor: async (): Promise<string> => "node-B",
    };
    const transportA = localClusterTransport({ registry, nodeId: "node-A" });
    const transportB = localClusterTransport({ registry, nodeId: "node-B" });
    await defineCluster({
      nodeId: "node-A",
      transport: transportA,
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      partitioning: () => partitioning,
    })(nodeA.parent);
    await defineCluster({
      nodeId: "node-B",
      transport: transportB,
      membership: staticMembership(["node-A", "node-B"], "node-B"),
      partitioning: () => partitioning,
    })(nodeB.parent);

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeB.parent.bus
        .subscribe({ surface: "cluster", name: { exact: "cluster:ask:invalid-payload" } })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    // Build a transport-A handle so we can send a wire-malformed
    // ask request to B. The transport factory captured at construction
    // is what's already wired into A's cluster — we just need
    // ANOTHER handle to the registry for direct injection. Easier:
    // construct a fresh fixture transport for "wire injector" role.
    const injector = await localClusterTransport({
      registry,
      nodeId: "wire-injector",
    })({
      id: "injector",
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
      journal: new MemoryJournal(),
      onClose() {},
    });

    // Send an @cluster/ask envelope with a payload that doesn't match
    // ClusterAskRequestPayload shape (missing innerType string).
    await injector.send("node-B", {
      addressedTo: "calc:foo",
      type: "@cluster/ask",
      messageId: "evil-1",
      timestamp: 0,
      from: "@cluster/asks:wire-injector",
      correlationId: "evil-corr-1",
      payload: { not: "valid", innerType: 42 },
    });

    await flushMicrotasks();
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:ask:invalid-payload"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.2: bus inbound shape validation
// ---------------------------------------------------------------------------

describe("ClusterEventBus — inbound shape validation", () => {
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

  it("emits cluster:event:malformed and drops invalid inbound events", async () => {
    await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-B"], "node-A"),
      fanoutMode: "cluster-wide-default",
    })(nodeA.parent);

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({ surface: "cluster", name: { exact: "cluster:event:malformed" } })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    // Inject a malformed event via a peer transport (missing `surface`).
    const injector = await localClusterTransport({
      registry,
      nodeId: "node-B",
    })({
      id: "injector",
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
      journal: new MemoryJournal(),
      onClose() {},
    });
    await injector.broadcast({
      id: "evil",
      // surface intentionally missing
      name: "tool:test:bogus",
      phase: "delta",
      timestamp: 0,
      scope: {},
    } as unknown as ProtocolEvent);

    await flushMicrotasks();
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:event:malformed"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.2: membership → partitioning end-to-end
// ---------------------------------------------------------------------------

describe("defineCluster — membership deltas propagate to partitioning", () => {
  let registry: LocalClusterRegistry;
  let nodeA: NodeRig;

  beforeEach(() => {
    registry = createLocalClusterRegistry();
    nodeA = mkNode("node-A");
  });

  afterEach(async () => {
    await teardownNode(nodeA);
  });

  it("ownerOf observes a node added to the cluster after construction", async () => {
    let liveNodes: string[] = ["node-A"];
    const membershipFactory = defineClusterMembership({
      currentNode: "node-A",
      async nodes() {
        // Return the LIVE list so consistent-hash partitioning sees
        // topology changes the moment they happen.
        return liveNodes;
      },
      onChange(handler) {
        handler({ kind: "snapshot", nodes: liveNodes, at: "0" });
        return async () => {};
      },
      async close() {},
    });

    const cluster = await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: membershipFactory,
    })(nodeA.parent);

    // Initial state: only node-A. ownerOf for any address must be A.
    const ownerBefore = await cluster.ownerOf("tasks:s-1");
    expect(ownerBefore).toBe("node-A");

    // Grow the cluster.
    liveNodes = ["node-A", "node-B", "node-C"];

    // Find at least one address whose owner is now NOT node-A — this
    // proves the consistent-hash impl saw the live membership state
    // and rebalanced. Sweep a wide address space so the statistical
    // chance of all 100 mapping back to A is effectively zero
    // (~1/3^100).
    let observedNonA = false;
    for (let i = 0; i < 100; i++) {
      const owner = await cluster.ownerOf(`tasks:s-${i}`);
      if (owner !== "node-A") {
        observedNonA = true;
        break;
      }
    }
    expect(observedNonA).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.2: remaining diagnostic event coverage
// ---------------------------------------------------------------------------

describe("ClusterInbox — ask lifecycle diagnostics", () => {
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

  it("emits cluster:ask:dispatched + cluster:ask:resolved on happy-path remote ask", async () => {
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
      clusterB.inbox.register("calc:echo", (env) => Effect.succeed(env.payload)),
    );

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus.subscribe({ surface: "cluster", name: { prefix: "cluster:ask:" } }).pipe(
        Stream.take(2),
        Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
        Stream.runDrain,
      ),
    );
    await flushMicrotasks();

    await Effect.runPromise(
      clusterA.inbox.ask("calc:echo", { type: "x", payload: 42 }).pipe(Effect.orDie),
    );

    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:ask:dispatched", "cluster:ask:resolved"]);
  });

  it("emits cluster:ask:timeout when remote handler doesn't reply within timeoutMs", async () => {
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

    // Handler never completes — drives the asker into the timeout
    // branch (not the no-handler branch).
    await Effect.runPromise(clusterB.inbox.register("calc:stuck", () => Effect.never));

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({ surface: "cluster", name: { exact: "cluster:ask:timeout" } })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    await Effect.runPromiseExit(
      clusterA.inbox.ask("calc:stuck", { type: "go" }, { timeoutMs: 50 }),
    );
    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:ask:timeout"]);
  });

  it("emits cluster:ask:response-orphaned when a response arrives past pending-entry", async () => {
    // Build the asker side only — we'll inject a forged ask-response
    // envelope via a peer transport with a correlationId that has no
    // pending entry. The wrapper must emit response-orphaned and drop.
    const partitioning = {
      shardKeyFor: (address: string): string => address,
      nodeFor: async (): Promise<string> => "node-A",
    };
    await defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: staticMembership(["node-A", "node-injector"], "node-A"),
      partitioning: () => partitioning,
    })(nodeA.parent);

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({ surface: "cluster", name: { exact: "cluster:ask:response-orphaned" } })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    const injector = await localClusterTransport({
      registry,
      nodeId: "node-injector",
    })({
      id: "injector",
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
      journal: new MemoryJournal(),
      onClose() {},
    });

    await injector.send("node-A", {
      addressedTo: clusterReplyAddressForTests("node-A"),
      type: "@cluster/ask-response",
      messageId: "ghost",
      timestamp: 0,
      correlationId: "no-such-pending",
      from: clusterReplyAddressForTests("node-injector"),
      payload: { _tag: "success", value: 0 },
    });

    await flushMicrotasks();
    await flushMicrotasks();
    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:ask:response-orphaned"]);
  });
});

describe("ClusterEventBus — broadcast failure diagnostic", () => {
  let nodeA: NodeRig;

  beforeEach(() => {
    nodeA = mkNode("node-A");
  });

  afterEach(async () => {
    await teardownNode(nodeA);
  });

  it("emits cluster:transport:broadcast:failed when transport.broadcast rejects", async () => {
    const failing = defineFailingTransport();

    const seen: string[] = [];
    const fiber = Effect.runFork(
      nodeA.parent.bus
        .subscribe({
          surface: "cluster",
          name: { exact: "cluster:transport:broadcast:failed" },
        })
        .pipe(
          Stream.take(1),
          Stream.tap((env) => Effect.sync(() => seen.push(env.name))),
          Stream.runDrain,
        ),
    );
    await flushMicrotasks();

    const cluster = await defineCluster({
      nodeId: "node-A",
      transport: failing,
      membership: staticMembership(["node-A"], "node-A"),
    })(nodeA.parent);

    await Effect.runPromise(
      cluster.bus.append({
        id: "x",
        surface: "tool",
        name: "tool:dispatch:started",
        phase: "delta",
        timestamp: 0,
        scope: {},
      }),
    );

    await Effect.runPromise(Effect.fromFiber(fiber));
    expect(seen).toEqual(["cluster:transport:broadcast:failed"]);
  });
});

// ---------------------------------------------------------------------------
// Test helpers — failing transport for diagnostic coverage
// ---------------------------------------------------------------------------

/** Mirror of the production `clusterReplyAddress` helper for test injection. */
function clusterReplyAddressForTests(nodeId: string): string {
  return `@cluster/asks:${nodeId}`;
}

// Silence the unused-import lint — these types are used in inferred
// generic positions above.
type _MHE = MessageHandlerError;
