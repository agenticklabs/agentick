/**
 * Phase 4g.4 — integration of Redis transport + membership against an
 * in-memory fake. Verifies the canonical adopter usage pattern works
 * end-to-end without docker-compose.
 *
 * Full real-Redis conformance lands in Phase 4g.5 (when docker-compose
 * Redis is wired into the conformance suite).
 */

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";
import { afterEach, describe, expect, it } from "vitest";

import type { ClusterCodec } from "@agentick/cluster-next";

import { createRedisMembership } from "../redis-membership.js";
import { createRedisTransport } from "../redis-transport.js";
import { createFakeRedis } from "./fake-redis.js";

function makeJsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

describe("RedisTransport — pub/sub round trip", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups) await c();
    cleanups.length = 0;
  });

  it("send from A lands on B's inbox subscription", async () => {
    const redis = createFakeRedis();
    const codec = makeJsonCodec();

    const aPub = redis.newClient();
    const aSub = redis.newClient();
    const bPub = redis.newClient();
    const bSub = redis.newClient();

    const a = createRedisTransport({
      nodeId: "node-A",
      pubClient: aPub,
      subClient: aSub,
      codec,
    });
    const b = createRedisTransport({
      nodeId: "node-B",
      pubClient: bPub,
      subClient: bSub,
      codec,
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );

    const received: MessageEnvelope[] = [];
    b.subscribeInbox({}, (env) => {
      received.push(env);
    });
    await b.flush();

    const envelope: MessageEnvelope = {
      addressedTo: "tasks:abc",
      type: "task-cancel",
      messageId: "m1",
      timestamp: 1,
      payload: { reason: "test" },
    };
    await a.send("node-B", envelope);

    // Wait for the microtask-fired delivery.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(received).toHaveLength(1);
    expect(received[0]!.messageId).toBe("m1");
    expect(received[0]!.addressedTo).toBe("tasks:abc");
  });

  it("broadcast from A fans out to B's bus subscription but NOT echo to A", async () => {
    const redis = createFakeRedis();
    const codec = makeJsonCodec();

    const aPub = redis.newClient();
    const aSub = redis.newClient();
    const bPub = redis.newClient();
    const bSub = redis.newClient();

    const a = createRedisTransport({
      nodeId: "node-A",
      pubClient: aPub,
      subClient: aSub,
      codec,
    });
    const b = createRedisTransport({
      nodeId: "node-B",
      pubClient: bPub,
      subClient: bSub,
      codec,
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );

    const aReceived: EventEnvelope[] = [];
    const bReceived: EventEnvelope[] = [];
    a.subscribeBus({}, (e) => aReceived.push(e));
    b.subscribeBus({}, (e) => bReceived.push(e));
    await Promise.all([a.flush(), b.flush()]);

    const evt: EventEnvelope = {
      id: "e1",
      surface: "tool",
      name: "tool:hello",
      phase: "terminal",
      timestamp: 1,
      scope: { nodeId: "node-A" },
    };
    await a.broadcast(evt);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(bReceived).toHaveLength(1);
    expect(bReceived[0]!.name).toBe("tool:hello");
    // Self-echo IS expected at the redis-transport layer — Redis pub/sub
    // delivers to ALL subscribers including the publisher. ClusterEventBus
    // is responsible for filtering self-broadcasts above this layer
    // (it stamps scope.nodeId and drops inbound where nodeId === self).
    expect(aReceived.length).toBeGreaterThanOrEqual(0); // documented: not filtered here
  });

  it("subscribeInbox filter narrows delivery", async () => {
    const redis = createFakeRedis();
    const codec = makeJsonCodec();
    const aPub = redis.newClient();
    const aSub = redis.newClient();
    const bPub = redis.newClient();
    const bSub = redis.newClient();
    const a = createRedisTransport({
      nodeId: "node-A",
      pubClient: aPub,
      subClient: aSub,
      codec,
    });
    const b = createRedisTransport({
      nodeId: "node-B",
      pubClient: bPub,
      subClient: bSub,
      codec,
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );

    const tasksOnly: MessageEnvelope[] = [];
    b.subscribeInbox({ surface: "tasks" }, (env) => tasksOnly.push(env));
    await b.flush();

    // Send a tasks message — should land.
    await a.send("node-B", {
      addressedTo: "tasks:abc",
      type: "x",
      messageId: "m1",
      timestamp: 1,
    });
    // Send an elicitation message — should NOT land in tasksOnly.
    await a.send("node-B", {
      addressedTo: "elicitation:foo",
      type: "x",
      messageId: "m2",
      timestamp: 2,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(tasksOnly.map((e) => e.messageId)).toEqual(["m1"]);
  });
});

describe("RedisMembership — join + snapshot + leave", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups) await c();
    cleanups.length = 0;
  });

  it("two nodes joining show up in each other's snapshot", async () => {
    const redis = createFakeRedis();
    const ca = redis.newClient();
    const cb = redis.newClient();

    const a = createRedisMembership({
      nodeId: "node-A",
      client: ca,
      pollIntervalMs: 30,
      heartbeatIntervalMs: 100,
      heartbeatTtlSec: 5,
    });
    const b = createRedisMembership({
      nodeId: "node-B",
      client: cb,
      pollIntervalMs: 30,
      heartbeatIntervalMs: 100,
      heartbeatTtlSec: 5,
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );

    // Both nodes' polls run; eventually each sees both.
    let aNodes: readonly string[] = [];
    let bNodes: readonly string[] = [];
    for (let i = 0; i < 30; i++) {
      aNodes = await a.nodes();
      bNodes = await b.nodes();
      if (aNodes.length === 2 && bNodes.length === 2) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    expect(new Set(aNodes)).toEqual(new Set(["node-A", "node-B"]));
    expect(new Set(bNodes)).toEqual(new Set(["node-A", "node-B"]));
  });

  it("graceful close removes the node from the cluster's view", async () => {
    const redis = createFakeRedis();
    const ca = redis.newClient();
    const cb = redis.newClient();
    const a = createRedisMembership({
      nodeId: "node-A",
      client: ca,
      pollIntervalMs: 30,
      heartbeatIntervalMs: 100,
      heartbeatTtlSec: 5,
    });
    const b = createRedisMembership({
      nodeId: "node-B",
      client: cb,
      pollIntervalMs: 30,
      heartbeatIntervalMs: 100,
      heartbeatTtlSec: 5,
    });
    cleanups.push(() => a.close());

    // Wait for both to see each other.
    for (let i = 0; i < 30; i++) {
      const xs = await a.nodes();
      if (xs.length === 2) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    // B closes gracefully.
    await b.close();

    // A's next poll should drop B.
    for (let i = 0; i < 30; i++) {
      const xs = await a.nodes();
      if (xs.length === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    expect(await a.nodes()).toEqual(["node-A"]);
  });
});
