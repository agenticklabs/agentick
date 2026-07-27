/**
 * Cluster conformance suite — verifies adapter implementations
 * against the protocol contract.
 *
 * Adapter packages call `runClusterTransportConformance({ setup })`
 * inside a `describe` block in their test file; the suite registers
 * its own `describe` / `it` blocks via vitest's discovery and runs
 * automatically.
 *
 * The `setup` callback is invoked per test — it returns two transport
 * factories sharing the same simulated wire (or two real adapter
 * factories sharing a real broker), plus a `teardown` to release
 * any per-test resources.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md (Conformance)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { EventEnvelope, MessageEnvelope } from "@agentick/spec";
import { waitFor, waitForStable } from "@agentick/utils/testing";

import type { ClusterParent } from "./cluster.js";
import type { ClusterTransport } from "./transport.js";
import type { ClusterTransportFactory } from "./factories.js";
import type { NodeId } from "./types.js";

// ============================================================================
// Conformance config
// ============================================================================

/**
 * Per-test setup contract. The conformance suite calls `setup()`
 * before every test and `teardown()` after; adapters that need
 * real infrastructure (Redis containers, NATS streams) start them
 * here.
 *
 * ## Factory ready-state contract
 *
 * `factoryA` / `factoryB` MUST return transports that are
 * IMMEDIATELY ready to `send` / `subscribeInbox` / `subscribeBus`.
 * For wire transports with handshake (TCP, WebSocket), this
 * means the factory awaits the client's handshake-complete
 * Promise (e.g., `BaseClusterClient.ready`) before returning.
 *
 * Adopters writing custom adapter conformance setups: returning a
 * transport that's still mid-handshake will produce flaky tests —
 * subscribes and sends issued before the wire is ready may be
 * dropped or queued without a back-pressure signal. Await the
 * ready state in the factory.
 *
 * In-memory transports (`LocalClusterTransport`) honor this
 * trivially since they have no handshake.
 */
export interface ClusterTransportConformanceSetup {
  /** Factory for node A's transport. Returns a READY transport. */
  readonly factoryA: ClusterTransportFactory;
  /** Factory for node B's transport. Returns a READY transport. */
  readonly factoryB: ClusterTransportFactory;
  /** Node-A identity. */
  readonly nodeAId: NodeId;
  /** Node-B identity. */
  readonly nodeBId: NodeId;
  /** Cleanup hook — called after every test. */
  teardown(): Promise<void>;
}

export interface ClusterTransportConformanceConfig {
  /** Per-test setup; returns two factories + their node ids. */
  readonly setup: () => Promise<ClusterTransportConformanceSetup>;
}

// ============================================================================
// Suite implementation
// ============================================================================

/**
 * Adapter-side test entrypoint. Adopters call this at the top level
 * of their spec file (or inside their own `describe` block for
 * grouping); the suite registers its `describe` / `it` blocks via
 * vitest's standard discovery.
 *
 * Each suite call adds these top-level groups:
 *   - "ClusterTransport conformance — send / subscribeInbox"
 *   - "ClusterTransport conformance — broadcast / subscribeBus"
 *   - "ClusterTransport conformance — subscription lifecycle"
 *   - "ClusterTransport conformance — close"
 *
 * Wrap the call in your own describe (e.g.
 * `describe("@agentick/cluster-redis", () => { runCluster...(...); })`)
 * for adapter-specific grouping.
 */
export function runClusterTransportConformance(config: ClusterTransportConformanceConfig): void {
  let ctx: ClusterTransportConformanceSetup;
  let txA: ClusterTransport;
  let txB: ClusterTransport;
  let parentA: TrackedParent;
  let parentB: TrackedParent;

  beforeEach(async () => {
    ctx = await config.setup();
    parentA = mkParent("parent-A");
    parentB = mkParent("parent-B");
    txA = (await resolveFactory(ctx.factoryA, parentA)) as ClusterTransport;
    txB = (await resolveFactory(ctx.factoryB, parentB)) as ClusterTransport;
    // Defensive: if the transport exposes a `ready` Promise (the
    // convention from @agentick/cluster-broker's BaseClusterClient),
    // await it. Adopter setups SHOULD have awaited ready inside
    // their factory; this catches the case where they forgot and
    // produces an early, descriptive failure rather than a flaky
    // delivery test.
    await awaitTransportReady(txA);
    await awaitTransportReady(txB);
  });

  afterEach(async () => {
    // Run any close handlers the factories registered with their
    // parents (transport.close() is registered via parent.onClose
    // by defineClusterTransport).
    await parentA.runCloseHandlers();
    await parentB.runCloseHandlers();
    await ctx.teardown();
  });

  // ────────── send / receive ──────────

  describe("ClusterTransport conformance — send / subscribeInbox", () => {
    it("delivers a message from A to B's matching subscriber", async () => {
      const received: MessageEnvelope[] = [];
      const unsub = txB.subscribeInbox({ surface: "tasks" }, (env) => {
        received.push(env);
      });
      await txB.flush();
      await txA.send(ctx.nodeBId, mkMessage("tasks:session-x", "tasks-cancel"));
      await waitFor(() => received.length === 1, { description: "1 message delivered to B" });
      expect(received[0]?.type).toBe("tasks-cancel");
      await unsub();
    });

    it("filter by surface narrows delivery", async () => {
      const tasks: MessageEnvelope[] = [];
      const elicits: MessageEnvelope[] = [];
      const unsubTasks = txB.subscribeInbox({ surface: "tasks" }, (env) => tasks.push(env));
      const unsubElicits = txB.subscribeInbox({ surface: "elicitation" }, (env) =>
        elicits.push(env),
      );
      await txB.flush();
      await txA.send(ctx.nodeBId, mkMessage("tasks:session-x", "tasks-cancel"));
      await txA.send(ctx.nodeBId, mkMessage("elicitation:session-y", "elicit-request"));
      await waitFor(() => tasks.length === 1 && elicits.length === 1, {
        description: "1 task + 1 elicit delivered",
      });
      expect(tasks[0]?.addressedTo).toBe("tasks:session-x");
      expect(elicits[0]?.addressedTo).toBe("elicitation:session-y");
      await unsubTasks();
      await unsubElicits();
    });

    it("filter by exact address matches verbatim", async () => {
      const matched: MessageEnvelope[] = [];
      const unsub = txB.subscribeInbox({ address: "tasks:session-exact" }, (env) =>
        matched.push(env),
      );
      await txB.flush();
      await txA.send(ctx.nodeBId, mkMessage("tasks:session-exact", "tasks-cancel"));
      await txA.send(ctx.nodeBId, mkMessage("tasks:session-other", "tasks-cancel"));
      // Wait for the matching delivery + give the unmatched one a
      // chance to (NOT) land — use waitForStable to confirm no
      // late delivery.
      await waitFor(() => matched.length === 1, { description: "exact-match delivered" });
      await waitForStable(() => matched.length, { stableMs: 50 });
      expect(matched).toHaveLength(1);
      expect(matched[0]?.addressedTo).toBe("tasks:session-exact");
      await unsub();
    });

    it("per-(source, destination) FIFO: messages from A to B arrive in order", async () => {
      const received: MessageEnvelope[] = [];
      const unsub = txB.subscribeInbox({}, (env) => received.push(env));
      await txB.flush();
      for (let i = 0; i < 20; i++) {
        await txA.send(ctx.nodeBId, mkMessage("test:x", "ping", { seq: i }));
      }
      await waitFor(() => received.length === 20, { description: "20 messages delivered" });
      const seqs = received.map((m) => (m.payload as { seq: number }).seq);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
      await unsub();
    });
  });

  // ────────── broadcast / subscribeBus ──────────

  describe("ClusterTransport conformance — broadcast / subscribeBus", () => {
    it("delivers a broadcast from A to B's matching subscriber", async () => {
      const received: EventEnvelope[] = [];
      const unsub = txB.subscribeBus({ surface: "tool" }, (env) => received.push(env));
      await txB.flush();
      await txA.broadcast(mkEvent("tool", "tool:dispatch:started"));
      await waitFor(() => received.length === 1, { description: "broadcast delivered to B" });
      expect(received[0]?.name).toBe("tool:dispatch:started");
      await unsub();
    });

    it("does NOT echo broadcast back to the sending node", async () => {
      const fromA: EventEnvelope[] = [];
      const fromB: EventEnvelope[] = [];
      const unsubA = txA.subscribeBus({}, (env) => fromA.push(env));
      const unsubB = txB.subscribeBus({}, (env) => fromB.push(env));
      await Promise.all([txA.flush(), txB.flush()]);
      await txA.broadcast(mkEvent("tool", "tool:dispatch:started"));
      // B receives → wait for that, then confirm A's count is
      // stable at 0 (no self-echo).
      await waitFor(() => fromB.length === 1, { description: "broadcast delivered to B" });
      await waitForStable(() => fromA.length, { stableMs: 50 });
      expect(fromA).toHaveLength(0);
      expect(fromB).toHaveLength(1);
      await unsubA();
      await unsubB();
    });

    it("filter by name.prefix narrows delivery", async () => {
      const matched: EventEnvelope[] = [];
      const unsub = txB.subscribeBus(
        { surface: "tool", name: { prefix: "tool:dispatch:" } },
        (env) => matched.push(env),
      );
      await txB.flush();
      await txA.broadcast(mkEvent("tool", "tool:dispatch:started"));
      await txA.broadcast(mkEvent("tool", "tool:dispatch:completed"));
      await txA.broadcast(mkEvent("tool", "tool:register"));
      await waitFor(() => matched.length === 2, { description: "2 prefix-matching broadcasts" });
      await waitForStable(() => matched.length, { stableMs: 50 });
      expect(matched).toHaveLength(2);
      expect(matched.map((e) => e.name)).toEqual([
        "tool:dispatch:started",
        "tool:dispatch:completed",
      ]);
      await unsub();
    });
  });

  // ────────── subscription lifecycle ──────────

  describe("ClusterTransport conformance — subscription lifecycle", () => {
    it("after unsubscribe, no further callbacks fire", async () => {
      const received: MessageEnvelope[] = [];
      const unsub = txB.subscribeInbox({}, (env) => received.push(env));
      await txB.flush();
      await txA.send(ctx.nodeBId, mkMessage("test:x", "ping"));
      await waitFor(() => received.length === 1, { description: "first ping delivered" });
      await unsub();
      await txA.send(ctx.nodeBId, mkMessage("test:x", "ping"));
      // No new deliveries — assert the count stays at 1 across
      // a window long enough for any late delivery to land.
      await waitForStable(() => received.length, { stableMs: 100 });
      expect(received).toHaveLength(1);
    });

    it("unsubscribe twice is a no-op (no throws)", async () => {
      const unsub = txB.subscribeInbox({}, () => {});
      await unsub();
      await expect(unsub()).resolves.toBeUndefined();
    });
  });

  // ────────── close ──────────

  describe("ClusterTransport conformance — close", () => {
    it("close() resolves; subsequent close() is idempotent", async () => {
      await expect(txA.close()).resolves.toBeUndefined();
      await expect(txA.close()).resolves.toBeUndefined();
    });
  });
}

// ============================================================================
// Test helpers
// ============================================================================

interface TrackedParent extends ClusterParent {
  runCloseHandlers(): Promise<void>;
}

function mkParent(id: string): TrackedParent {
  const handlers: Array<() => Promise<void> | void> = [];
  return {
    id,
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
    journal: new MemoryJournal(),
    onClose(handler) {
      handlers.push(handler);
    },
    async runCloseHandlers() {
      // LIFO — match the framework's harness teardown order.
      for (const h of [...handlers].reverse()) {
        await h();
      }
      handlers.length = 0;
    },
  };
}

let seq = 0;
function mkMessage<T = unknown>(
  addressedTo: string,
  type: string,
  payload?: T,
): MessageEnvelope<T> {
  return {
    addressedTo,
    type,
    messageId: `msg-${++seq}`,
    timestamp: 0,
    ...(payload !== undefined ? { payload } : {}),
  };
}

function mkEvent(surface: string, name: string): EventEnvelope {
  return {
    id: `evt-${++seq}`,
    surface: surface as EventEnvelope["surface"],
    name,
    phase: "delta",
    timestamp: 0,
    scope: {},
  };
}

// Phase 4b.1: `flushMicrotasks` was deleted in favor of
// `waitFor` / `waitForStable` from `@agentick/utils/testing`.
// Tests state the observable they're waiting for; the helpers
// poll until satisfied or fail with a descriptive timeout. No
// more magic-number yield counts.
//
// TODO(phase-4c): sweep the remaining spec files (cluster-broker,
// cluster-net, cluster wrappers) and replace any local
// flushMicrotasks helpers with the canonical waitFor.

/**
 * Resolve a `Factory<R, P>` return shape (sync, Promise, or Effect)
 * to a Promise<R>. Phase 2: sync + Promise; Effect returns throw.
 */
async function resolveFactory<R, P>(factory: (parent: P) => unknown, parent: P): Promise<R> {
  const result = factory(parent);
  if (
    typeof result === "object" &&
    result !== null &&
    "pipe" in result &&
    typeof (result as { pipe: unknown }).pipe === "function" &&
    Symbol.iterator in result
  ) {
    throw new Error("conformance suite: Effect-returning factories not supported (Phase 3).");
  }
  return Promise.resolve(result as R | Promise<R>);
}

/**
 * Defensive ready-state check. If the transport-under-test exposes
 * a `ready` Promise (the convention from @agentick/cluster-broker's
 * `BaseClusterClient`), await it. Adopter setups should have done
 * this in their factory, but the contract is non-obvious enough
 * that it's worth catching here too.
 *
 * Transports without a `ready` property (e.g., `LocalClusterTransport`)
 * are treated as immediately ready.
 */
async function awaitTransportReady(transport: ClusterTransport): Promise<void> {
  const maybeReady = (transport as { readonly ready?: unknown }).ready;
  if (maybeReady && typeof (maybeReady as PromiseLike<unknown>).then === "function") {
    await maybeReady;
  }
}
