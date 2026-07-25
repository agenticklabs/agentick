/**
 * Phase 2 verification — AppHarnessOptions.{bus,inbox,journal} accept
 * `instance | factory`. ADR 31.
 *
 * Tests focus on what changes vs Phase 1:
 *   1. Factory at the slot is called with the AppSubstrateParent shell.
 *   2. Default factory's auto-close on parent.onClose actually fires
 *      when app.close() runs.
 *   3. Instance form still works (today's behavior preserved).
 *   4. `LocalEventBus.factory(opts)` static helper accepted at slot.
 *   5. Adopter metadata flows through `parent.metadata`.
 *   6. Adopter-supplied factories CAN access parent.id, etc.
 *   7. Sync-factory contract: async factory throws.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor, LanguageModelExecutor } from "@agentick/model-executor";
import { scriptedAdapter } from "@agentick/model/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  EventBus,
  EventBusFactory,
  ExecutionTarget,
  MessageInbox,
  OperationJournal,
} from "@agentick/spec";

import { createApp } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

function mkExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    "app-substrate-test-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "pong" }],
            stopReason: "end",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      ],
    },
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

describe("AppHarness substrate slots — instance form (Phase 1 behavior preserved)", () => {
  it("accepts a pre-built EventBus instance and uses it as-is", async () => {
    const sharedBus = new LocalEventBus();
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      bus: sharedBus,
    });
    // The shared instance IS the app's bus.
    expect((app as unknown as { bus: EventBus }).bus).toBe(sharedBus);
    await app.closeApp();
  });

  it("accepts pre-built MessageInbox + OperationJournal instances", async () => {
    const inbox = new LocalInbox();
    const journal = new MemoryJournal();
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      inbox,
      journal,
    });
    expect((app as unknown as { inbox: MessageInbox }).inbox).toBe(inbox);
    expect((app as unknown as { journal: OperationJournal }).journal).toBe(journal);
    await app.closeApp();
  });
});

describe("AppHarness substrate slots — factory form (Phase 2)", () => {
  it("calls a factory with the app shell as parent and uses the result", async () => {
    const seenParents: Array<{ id: string; hasMetadata: boolean }> = [];
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      metadata: { tag: "phase-2-test" },
      bus: (parent) => {
        seenParents.push({
          id: parent.id,
          hasMetadata: parent.metadata?.["tag"] === "phase-2-test",
        });
        return new LocalEventBus();
      },
    });
    expect(seenParents).toHaveLength(1);
    expect(seenParents[0]!.id).toMatch(/^app:/);
    expect(seenParents[0]!.hasMetadata).toBe(true);
    await app.closeApp();
  });

  it("LocalEventBus.factory() accepted directly as a slot value", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      bus: LocalEventBus.factory(),
    });
    // Bus was constructed by the factory.
    expect((app as unknown as { bus: EventBus }).bus).toBeInstanceOf(LocalEventBus);
    await app.closeApp();
  });

  it("LocalEventBus.factory({ parent: undefined }) produces a leaf bus", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      bus: LocalEventBus.factory({ parent: undefined }),
    });
    expect((app as unknown as { bus: EventBus }).bus).toBeInstanceOf(LocalEventBus);
    await app.closeApp();
  });

  it("MemoryJournal.factory + LocalInbox.factory accepted at slots", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      journal: MemoryJournal.factory({ capacity: 100 }),
      inbox: LocalInbox.factory({ idempotencyTtlMs: 1000 }),
    });
    expect((app as unknown as { journal: OperationJournal }).journal).toBeInstanceOf(MemoryJournal);
    expect((app as unknown as { inbox: MessageInbox }).inbox).toBeInstanceOf(LocalInbox);
    await app.closeApp();
  });

  it("factory-registered onClose fires when app.close() runs", async () => {
    let factoryClosedRan = false;
    const factory: EventBusFactory<{ onClose(h: () => void): void }> = (parent) => {
      const bus = new LocalEventBus();
      parent.onClose(() => {
        factoryClosedRan = true;
        bus.close();
      });
      return bus;
    };
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      bus: factory,
    });
    expect(factoryClosedRan).toBe(false);
    await app.closeApp();
    expect(factoryClosedRan).toBe(true);
  });

  it("throws clearly when a factory returns a Promise (async at app level)", async () => {
    let thrown: unknown;
    try {
      await createApp(React.createElement(MinimalAgent), {
        modelExecutor: mkExecutor(),
        target: mkTarget(),
        bus: (() => Promise.resolve(new LocalEventBus())) as unknown as EventBusFactory<unknown>,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toMatch(/synchronous/);
  });
});

describe("AppHarness substrate slots — explicit parent passing", () => {
  it("factories receive `parent` as a named argument, not via `this`", async () => {
    const captured: Array<unknown> = [];
    const app = await createApp(React.createElement(MinimalAgent), {
      modelExecutor: mkExecutor(),
      target: mkTarget(),
      bus: function (...args: unknown[]) {
        captured.push(args.length);
        captured.push(args[0]);
        return new LocalEventBus();
      } as unknown as EventBusFactory<unknown>,
    });
    expect(captured[0]).toBe(1); // exactly one positional arg
    expect(typeof captured[1]).toBe("object"); // and it's the shell
    expect((captured[1] as { id: string }).id).toMatch(/^app:/);
    await app.closeApp();
  });
});

describe("AppHarness model slot — LanguageModelAdapter form (ADR 52)", () => {
  it("wraps a bare adapter in the ONE LanguageModelExecutor on the app's substrate", async () => {
    const adapter = scriptedAdapter("pong from adapter");
    const app = await createApp(React.createElement(MinimalAgent), {
      model: adapter,
    });
    const exec = (app as unknown as { modelExecutor: unknown }).modelExecutor;
    expect(exec).toBeInstanceOf(LanguageModelExecutor);
    // Self-described target flows adapter → executor → app.
    expect((app as unknown as { target: ExecutionTarget }).target).toMatchObject({
      provider: "scripted",
      modelId: "scripted-v1",
    });
    await app.closeApp();
  });

  it("adapter-backed app round-trips a send", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("pong from adapter"),
    });
    const session = await app.createSession();
    const handle = await session.send({
      messages: [{ role: "user", content: "ping" }],
    });
    const result = await handle.result;
    expect(result.response).toContain("pong from adapter");
    await app.closeApp();
  });
});

describe("AppHarness model/executor slot guards", () => {
  it("rejects both model and executor", async () => {
    await expect(
      createApp(React.createElement(MinimalAgent), {
        model: scriptedAdapter("guard"),
        modelExecutor: mkExecutor(),
      }),
    ).rejects.toThrow(/not both/);
  });

  it("allows neither model nor executor — a model-less app is legal", async () => {
    // The model requirement moved to execution time (the loop's per-tick
    // resolution → NoModelForExecutionError). Construction with no model
    // succeeds: dispatch, snapshot/restore, and wire plumbing all work
    // model-less. Only a send that resolves no effective model fails.
    const app = await createApp(React.createElement(MinimalAgent), {});
    expect((app as unknown as { modelExecutor: unknown }).modelExecutor).toBeUndefined();
    expect((app as unknown as { target: unknown }).target).toBeUndefined();
    await app.closeApp();
  });

  it("rejects a bare adapter on the executor slot", async () => {
    await expect(
      createApp(React.createElement(MinimalAgent), {
        modelExecutor: scriptedAdapter("guard") as unknown as FakeLanguageModelExecutor,
      }),
    ).rejects.toThrow(/goes on the `model` slot/);
  });
});
