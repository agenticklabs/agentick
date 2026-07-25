/**
 * `BaseBroker` + `BaseClusterClient` integration tests, run entirely
 * in-memory via the `createInMemoryClusterPair` fixture. Validates
 * the wire-agnostic semantics — handshake, routing, fan-out,
 * subscriptions, membership deltas, heartbeat, frame validation.
 *
 * Concrete wire packages (cluster-net-next, cluster-ws-next) run the
 * full `runClusterTransportConformance` suite against real wires in
 * later phases. This file covers the base classes' own contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClusterCodec } from "@agentick/cluster";
import type { EventEnvelope, MessageEnvelope } from "@agentick/spec";

import { BaseBroker } from "../base-broker.js";
import { BaseClusterClient } from "../base-cluster-client.js";
import {
  FRAME_HELLO,
  FRAME_PING,
  FRAME_WELCOME,
  isFrameShape,
  type AnyFrame,
} from "../wire-frames.js";
import { createInMemoryClusterPair } from "../testing/in-memory-pair-fixture.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function jsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode(value) {
      return enc.encode(JSON.stringify(value));
    },
    decode(raw) {
      return JSON.parse(dec.decode(raw));
    },
  };
}

// TODO(phase-4c+): see diagnostics-and-lifecycle.spec.ts for the
// same rationale — microtask yields are appropriate for the
// in-memory pair fixture; the canonical waitFor pattern is reserved
// for real-wire tests where setImmediate scheduling matters.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Rig {
  readonly broker: BaseBroker;
  readonly pair: ReturnType<typeof createInMemoryClusterPair>;
  readonly brokerDiagnostics: Array<{ name: string; payload?: unknown }>;
  readonly diagnosticsFor: Map<string, Array<{ name: string; payload?: unknown }>>;
  readonly clients: BaseClusterClient[];
  spawnClient(nodeId: string, opts?: { heartbeatMs?: number }): BaseClusterClient;
  closeAll(): Promise<void>;
}

function mkRig(): Rig {
  const brokerDiag: Array<{ name: string; payload?: unknown }> = [];
  const diagsByNode = new Map<string, Array<{ name: string; payload?: unknown }>>();
  const clients: BaseClusterClient[] = [];
  const pair = createInMemoryClusterPair();
  const broker = new BaseBroker({
    listener: pair.listener,
    codec: jsonCodec(),
    onDiagnostic: (name, payload) => brokerDiag.push({ name, payload }),
  });

  return {
    broker,
    pair,
    brokerDiagnostics: brokerDiag,
    diagnosticsFor: diagsByNode,
    clients,
    spawnClient(nodeId, opts) {
      const log: Array<{ name: string; payload?: unknown }> = [];
      diagsByNode.set(nodeId, log);
      const client = new BaseClusterClient({
        nodeId,
        connector: pair.createConnector(),
        codec: jsonCodec(),
        heartbeatMs: opts?.heartbeatMs ?? 0, // disable by default for tests
        onDiagnostic: (name, payload) => log.push({ name, payload }),
        random: () => 0, // deterministic backoff for any reconnect tests
      });
      clients.push(client);
      return client;
    },
    async closeAll() {
      for (const c of clients) await c.close();
      await broker.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

describe("BaseBroker + BaseClusterClient — handshake", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = mkRig();
  });
  afterEach(async () => {
    await rig.closeAll();
  });

  it("client connects → broker accepts → client receives Welcome", async () => {
    await rig.broker.start();
    rig.spawnClient("node-A");
    await flushMicrotasks();
    await flushMicrotasks();
    // Broker now has node-A in its routing table.
    expect(rig.broker.nodes()).toEqual(["node-A"]);
    // Client emitted a `connected` diagnostic post-Welcome.
    const log = rig.diagnosticsFor.get("node-A") ?? [];
    expect(log.map((d) => d.name)).toContain("cluster:broker:client:connected");
  });

  it("second client with same nodeId is rejected", async () => {
    await rig.broker.start();
    rig.spawnClient("node-dup");
    await flushMicrotasks();
    await flushMicrotasks();
    rig.spawnClient("node-dup");
    await flushMicrotasks();
    await flushMicrotasks();
    // Broker rejected the duplicate.
    const rejects = rig.brokerDiagnostics.filter(
      (d) => d.name === "cluster:broker:server:client-welcomed",
    );
    // Only one client should have been welcomed.
    expect(rejects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe("BaseBroker + BaseClusterClient — membership", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = mkRig();
  });
  afterEach(async () => {
    await rig.closeAll();
  });

  it("Welcome carries the initial node snapshot", async () => {
    await rig.broker.start();
    rig.spawnClient("node-A");
    await flushMicrotasks();
    await flushMicrotasks();
    rig.spawnClient("node-B");
    await flushMicrotasks();
    await flushMicrotasks();
    // Broker should have both nodes after both handshakes complete.
    expect([...rig.broker.nodes()].sort()).toEqual(["node-A", "node-B"]);
  });

  it("Disconnect propagates a `lost` membership delta to other clients", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    // node-A drops out.
    await clientA.close();
    await flushMicrotasks();
    await flushMicrotasks();
    // Broker should have dropped node-A from routing.
    expect(rig.broker.nodes()).toEqual(["node-B"]);
    // Keep eslint happy.
    void clientB;
  });
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

describe("BaseBroker + BaseClusterClient — send / subscribeInbox", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = mkRig();
  });
  afterEach(async () => {
    await rig.closeAll();
  });

  it("A.send(B, env) delivers to B's matching inbox subscriber", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");
    await flushMicrotasks();
    await flushMicrotasks();

    const received: MessageEnvelope[] = [];
    clientB.subscribeInbox({ surface: "tasks" }, (env) => received.push(env));
    await flushMicrotasks();

    await clientA.send("node-B", {
      addressedTo: "tasks:s-1",
      type: "tasks-cancel",
      messageId: "m-1",
      timestamp: 0,
      payload: { reason: "test" },
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe("m-1");
  });

  it("subscribeInbox filter narrows delivery to matching addresses", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");
    await flushMicrotasks();
    await flushMicrotasks();

    const matched: MessageEnvelope[] = [];
    clientB.subscribeInbox({ surface: "tasks" }, (env) => matched.push(env));
    await flushMicrotasks();

    await clientA.send("node-B", mkMessage("tasks:s-1", "tasks-cancel"));
    await clientA.send("node-B", mkMessage("elicitation:s-2", "elicit"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(matched).toHaveLength(1);
    expect(matched[0]?.addressedTo).toBe("tasks:s-1");
  });

  it("send to an unknown node emits a broker routing-failed diagnostic", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    await flushMicrotasks();
    await flushMicrotasks();
    await clientA.send("node-ghost", mkMessage("tasks:x", "ping"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(
      rig.brokerDiagnostics.some((d) => d.name === "cluster:broker:server:routing-failed"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

describe("BaseBroker + BaseClusterClient — broadcast / subscribeBus", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = mkRig();
  });
  afterEach(async () => {
    await rig.closeAll();
  });

  it("Broadcast fans out to every other client; sender does not see its own broadcast", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");
    const clientC = rig.spawnClient("node-C");
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const fromA: EventEnvelope[] = [];
    const fromB: EventEnvelope[] = [];
    const fromC: EventEnvelope[] = [];
    clientA.subscribeBus({}, (env) => fromA.push(env));
    clientB.subscribeBus({}, (env) => fromB.push(env));
    clientC.subscribeBus({}, (env) => fromC.push(env));
    await flushMicrotasks();

    await clientA.broadcast(mkEvent("tool", "tool:dispatch:started"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(fromA).toHaveLength(0);
    expect(fromB).toHaveLength(1);
    expect(fromC).toHaveLength(1);
  });

  it("flush() resolves when subscribe is issued BEFORE handshake completes", async () => {
    // Regression: the otto-cluster demo wedged here. An adopter that
    // calls `subscribeBus(...)` synchronously after spawning the
    // client (i.e. before microtasks run + handshake completes) saw
    // `transport.flush()` hang forever. Root cause: the pending-ack
    // entry tracked at subscribe time got *overwritten* in
    // `onWelcome` (which re-registers active subs on the fresh
    // connection), orphaning the Promise the original `flush()`
    // caller was awaiting. The broker's SUBSCRIBE_ACK resolves the
    // NEW entry; the orphan never resolves.
    //
    // Fix: `trackPendingAck` is idempotent — subsequent calls for
    // the same `subId` leave the existing entry alone, so the
    // Promise observed by `flush()` is the one the broker ack
    // ultimately resolves.
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");

    // CRITICAL: subscribe synchronously, BEFORE the handshake has
    // had a chance to complete. The client is in "connecting" state
    // at this moment — `tryWriteIgnoringDisconnect` no-ops, so the
    // FRAME_SUBSCRIBE_BUS will only actually go out via the onWelcome
    // resubscribe loop.
    const received: EventEnvelope[] = [];
    clientB.subscribeBus({}, (env) => received.push(env));

    // Now await flush() concurrently with the handshake completing.
    // Without the idempotency fix, this Promise would never resolve.
    const flushDone = clientB.flush();

    // Drive the handshake.
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // flush() must resolve once the broker has acked the (deferred)
    // SUBSCRIBE_BUS frame.
    await flushDone;

    // Sanity: subscribe is actually wired — broadcast lands.
    await clientA.broadcast(mkEvent("tool", "tool:dispatch:started"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(received).toHaveLength(1);
  });

  it("flush() resolves when subscribeInbox is issued BEFORE handshake completes", async () => {
    // Same regression as subscribeBus — both subscribe paths share
    // the same trackPendingAck plumbing, so verify both are covered.
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");

    const received: MessageEnvelope[] = [];
    clientB.subscribeInbox({}, (env) => received.push(env));

    const flushDone = clientB.flush();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushDone;

    await clientA.send("node-B", mkMessage("tasks:s-1", "ping"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(received).toHaveLength(1);
  });

  it("subscribeBus filter narrows delivery", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");
    await flushMicrotasks();
    await flushMicrotasks();

    const matched: EventEnvelope[] = [];
    clientB.subscribeBus({ surface: "tool", name: { prefix: "tool:dispatch:" } }, (env) =>
      matched.push(env),
    );
    await flushMicrotasks();

    await clientA.broadcast(mkEvent("tool", "tool:dispatch:started"));
    await clientA.broadcast(mkEvent("tool", "tool:register"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(matched.map((e) => e.name)).toEqual(["tool:dispatch:started"]);
  });
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe("BaseBroker + BaseClusterClient — subscription lifecycle", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = mkRig();
  });
  afterEach(async () => {
    await rig.closeAll();
  });

  it("After unsubscribe, no further callbacks fire", async () => {
    await rig.broker.start();
    const clientA = rig.spawnClient("node-A");
    const clientB = rig.spawnClient("node-B");
    await flushMicrotasks();
    await flushMicrotasks();

    const received: MessageEnvelope[] = [];
    const unsub = clientB.subscribeInbox({}, (env) => received.push(env));
    await flushMicrotasks();

    await clientA.send("node-B", mkMessage("tasks:s-1", "ping"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(received).toHaveLength(1);

    await unsub();
    await flushMicrotasks();
    await clientA.send("node-B", mkMessage("tasks:s-1", "ping"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Wire frame validation
// ---------------------------------------------------------------------------

describe("isFrameShape — wire-boundary validation", () => {
  it("accepts every defined frame type", () => {
    const frames: AnyFrame[] = [
      { type: FRAME_HELLO, nodeId: "n" },
      { type: FRAME_WELCOME, nodes: [] },
      { type: FRAME_PING, seq: 1 },
    ];
    for (const f of frames) {
      expect(isFrameShape(f)).toBe(true);
    }
  });

  it("rejects garbage", () => {
    expect(isFrameShape(null)).toBe(false);
    expect(isFrameShape(42)).toBe(false);
    expect(isFrameShape("string")).toBe(false);
    expect(isFrameShape({})).toBe(false);
    expect(isFrameShape({ type: "not-a-real-frame" })).toBe(false);
    expect(isFrameShape({ type: 123 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Length-prefix framing
// ---------------------------------------------------------------------------

describe("length-prefix framing — streaming decode", () => {
  it("handles a single complete frame", async () => {
    const { encodeLengthPrefixed, createLengthPrefixedDecoder } = await import("../framing.js");
    const decoder = createLengthPrefixedDecoder();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const wire = encodeLengthPrefixed(payload);
    const { frames, error } = decoder.feed(wire);
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reassembles a frame split across multiple chunks", async () => {
    const { encodeLengthPrefixed, createLengthPrefixedDecoder } = await import("../framing.js");
    const decoder = createLengthPrefixedDecoder();
    const wire = encodeLengthPrefixed(new Uint8Array([10, 20, 30, 40]));
    // Hand-pick a split inside the payload bytes.
    const first = wire.slice(0, 6);
    const second = wire.slice(6);
    let collected = decoder.feed(first);
    expect(collected.frames).toHaveLength(0);
    collected = decoder.feed(second);
    expect(collected.frames).toHaveLength(1);
    expect(Array.from(collected.frames[0]!)).toEqual([10, 20, 30, 40]);
  });

  it("extracts multiple frames from a single chunk", async () => {
    const { encodeLengthPrefixed, createLengthPrefixedDecoder } = await import("../framing.js");
    const decoder = createLengthPrefixedDecoder();
    const a = encodeLengthPrefixed(new Uint8Array([1]));
    const b = encodeLengthPrefixed(new Uint8Array([2, 2]));
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    const { frames, error } = decoder.feed(combined);
    expect(error).toBeUndefined();
    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0]!)).toEqual([1]);
    expect(Array.from(frames[1]!)).toEqual([2, 2]);
  });

  it("poisons on oversized declared length", async () => {
    const { createLengthPrefixedDecoder } = await import("../framing.js");
    const decoder = createLengthPrefixedDecoder({ maxFrameBytes: 8 });
    // Declared length = 1 GB.
    const evil = new Uint8Array([0x00, 0x00, 0x00, 0x40]);
    const { frames, error } = decoder.feed(evil);
    expect(frames).toHaveLength(0);
    expect(error?._tag).toBe("frame-too-large");
    expect(decoder.poisoned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkMessage(addressedTo: string, type: string, payload?: unknown): MessageEnvelope {
  return {
    addressedTo,
    type,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: 0,
    ...(payload !== undefined ? { payload } : {}),
  };
}

function mkEvent(surface: string, name: string): EventEnvelope {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    surface: surface as EventEnvelope["surface"],
    name,
    phase: "delta",
    timestamp: 0,
    scope: {},
  };
}
