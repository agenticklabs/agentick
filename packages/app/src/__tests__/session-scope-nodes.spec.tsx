/**
 * ADR 102 stage 1 — sessions resolve their bus through the scope-node
 * tree when (and only when) the adopter names a topology.
 */

import React from "react";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { forkBusSubscription, LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { EventBus, ExecutionTarget, ProtocolEvent } from "@agentick/spec";

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
