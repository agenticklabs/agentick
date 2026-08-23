/**
 * ADR 102 — sessions resolve their bus through the scope-node tree when (and
 * only when) the adopter names a topology (stage 1), and an execution's
 * emissions land on that node even though the spine driving them is shared by
 * the whole app (stage 2).
 */

import React from "react";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import {
  forkBusSubscription,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  ScopeNodeRegistry,
} from "@agentick/runtime";
import type {
  EventBus,
  ExecutionTarget,
  ExecutorFactory,
  ExecutorFactoryDeps,
  ProtocolEvent,
} from "@agentick/spec";

import { createApp } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

function mkExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "scope-node-test-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted: [] },
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: false, supportsStreaming: false },
  };
}

const busOf = (harness: unknown): EventBus => (harness as { bus: EventBus }).bus;

describe("scope nodes — inert without config", () => {
  it("a session runs on the app's own bus when no sessionNode is configured", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession({ principal: "user:ryan" });
    expect(busOf(session)).toBe(busOf(app));
    await app.closeApp();
  });

  it("a path of [] resolves to the app's bus — the principal-less pole", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      sessionNode: (ctx) => (ctx.principal !== undefined ? [ctx.principal] : []),
    });
    const session = await app.createSession();
    expect(busOf(session)).toBe(busOf(app));
    await app.closeApp();
  });
});

describe("scope nodes — configured topology", () => {
  it("isolates principals: a node subscriber sees only its own sessions, the root sees both", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      sessionNode: (ctx) => (ctx.principal !== undefined ? [ctx.principal] : []),
    });

    const sessionA = await app.createSession({ principal: "alice" });
    const sessionB = await app.createSession({ principal: "bob" });

    const busA = busOf(sessionA);
    const busB = busOf(sessionB);
    const appBus = busOf(app);
    expect(busA).not.toBe(busB);
    expect(busA).not.toBe(appBus);

    const atA: string[] = [];
    const atRoot: string[] = [];
    const unsubs = [
      forkBusSubscription(busA, { name: { exact: "topology:probe" } }, (e) => void atA.push(e.id)),
      forkBusSubscription(
        appBus,
        { name: { exact: "topology:probe" } },
        (e) => void atRoot.push(e.id),
      ),
    ];
    await settle();

    await Effect.runPromise(busA.append(probe("from-alice")));
    await Effect.runPromise(busB.append(probe("from-bob")));
    await settle();

    expect(atA).toEqual(["from-alice"]);
    expect(atRoot.sort()).toEqual(["from-alice", "from-bob"]);

    for (const u of unsubs) u();
    await app.closeApp();
  });

  it("two sessions of one principal share that principal's node", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      sessionNode: (ctx) => ["tenant:acme", `user:${ctx.principal ?? "anon"}`],
    });
    const first = await app.createSession({ principal: "ryan" });
    const second = await app.createSession({ principal: "ryan" });
    expect(busOf(first)).toBe(busOf(second));
    await app.closeApp();
  });

  it("an explicit per-session bus wins over the topology", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      sessionNode: (ctx) => [ctx.principal ?? "anon"],
    });
    const own = new LocalEventBus();
    const session = await app.createSession({ principal: "ryan", bus: own });
    expect(busOf(session)).toBe(own);
    await app.closeApp();
  });

  it("the node closes with its last session and is rebuilt for the next one", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      sessionNode: (ctx) => [ctx.principal ?? "anon"],
    });
    const first = await app.createSession({ principal: "ryan" });
    const firstBus = busOf(first);
    await first.close();

    const second = await app.createSession({ principal: "ryan" });
    expect(busOf(second)).not.toBe(firstBus);
    await app.closeApp();
  });
});

/**
 * A factory so the app builds the executor on the APP's substrate — the shared
 * spine whose emissions this suite is about. A pre-constructed instance would
 * carry a private bus and prove nothing.
 */
function streamingExecutorFactory(): ExecutorFactory {
  return Object.assign(
    (deps?: ExecutorFactoryDeps) =>
      new FakeLanguageModelExecutor(
        deps?.scopeId ?? "scope-node-stream-exec",
        deps?.journal ?? new MemoryJournal(),
        deps?.bus ?? new LocalEventBus(),
        deps?.inbox ?? new LocalInbox(),
        {},
      ),
    { executorFactory: true as const },
  );
}

describe("scope nodes — per-execution emission", () => {
  it("model deltas from the app-shared executor reach the session's node, the root, and no sibling", async () => {
    const root = new LocalEventBus();
    const scopeNodes = new ScopeNodeRegistry({ root });
    const app = await createApp(React.createElement(MinimalAgent), {
      bus: root,
      modelExecutor: streamingExecutorFactory(),
      sessionNode: (ctx) => [ctx.principal ?? "anon"],
      scopeNodes,
    });

    const alice = await app.createSession({ principal: "alice" });
    const bobNode = scopeNodes.node(["bob"]);

    const deltas = { surface: "model", phase: "delta" } as const;
    const atAlice: ProtocolEvent[] = [];
    const atBob: ProtocolEvent[] = [];
    const atRoot: ProtocolEvent[] = [];
    const unsubs = [
      forkBusSubscription(busOf(alice), deltas, (e) => void atAlice.push(e)),
      forkBusSubscription(bobNode.bus, deltas, (e) => void atBob.push(e)),
      forkBusSubscription(root, deltas, (e) => void atRoot.push(e)),
    ];
    await settle();

    await alice.send({ messages: [{ role: "user", content: "go" }] });
    await settle();

    expect(atAlice.length).toBeGreaterThan(0);
    expect(atRoot.length).toBe(atAlice.length);
    expect(atBob).toEqual([]);

    for (const u of unsubs) u();
    bobNode.release();
    await app.closeApp();
  });
});

function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function probe(id: string): ProtocolEvent {
  return {
    id,
    surface: "session",
    name: "topology:probe",
    phase: "delta",
    timestamp: Date.now(),
    scope: {},
  } as ProtocolEvent;
}
