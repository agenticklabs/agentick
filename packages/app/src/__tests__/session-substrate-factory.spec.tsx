/**
 * Phase 3 verification — `CreateSessionInput.{bus,inbox,journal}` and
 * `SessionHarnessOptions.{bus,inbox,journal}` accept instance|factory.
 * Per-session substrate is constructed against a `SessionSubstrateParent`
 * shell that exposes the APP's substrate as the default upstream.
 *
 * Multi-tenant adopters now wrap the app's bus per-session with no
 * framework awareness of "tenant" — adopter routing flows through
 * `metadata`. ADR 31.
 */

import React from "react";
import { Effect, Stream, Chunk } from "effect";
import { describe, expect, it } from "vitest";

import { MockLanguageModelExecutor } from "@agentick/executor";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "@agentick/runtime";
import type {
  EventBus,
  EventBusFactory,
  ExecutionTarget,
  MessageInbox,
  ProtocolEvent,
} from "@agentick/spec";

import { createApp } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

function mkExecutor(): MockLanguageModelExecutor {
  return new MockLanguageModelExecutor(
    "phase3-test-exec",
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

describe("createSession substrate slots — default (inherit app substrate)", () => {
  it("session uses the app's substrate when no overrides are passed", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession();
    // session.bus is the same instance as app.bus.
    expect((session as unknown as { bus: EventBus }).bus).toBe(
      (app as unknown as { bus: EventBus }).bus,
    );
    expect((session as unknown as { inbox: MessageInbox }).inbox).toBe(
      (app as unknown as { inbox: MessageInbox }).inbox,
    );
    await app.closeApp();
  });
});

describe("createSession substrate slots — factory at session level", () => {
  it("factory called with a session shell whose .bus is the app's bus", async () => {
    const seenParents: Array<{ id: string; appBus: EventBus | undefined }> = [];
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession({
      bus: (parent) => {
        seenParents.push({ id: parent.id, appBus: parent.bus });
        return new LocalEventBus();
      },
    });
    expect(seenParents).toHaveLength(1);
    expect(seenParents[0]!.id).toMatch(/^session:/);
    // Parent shell's `.bus` is the APP'S bus — what factories wrap to
    // get fan-in to the app level.
    expect(seenParents[0]!.appBus).toBe(
      (app as unknown as { bus: EventBus }).bus,
    );
    void session;
    await app.closeApp();
  });

  it("LocalEventBus.factory() at session slot fans in to app bus by default", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession({
      bus: LocalEventBus.factory(),
    });

    // Subscribe to APP bus, capture envelopes.
    const appEventsFiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(
          (app as unknown as { bus: EventBus }).bus.subscribe({}),
          1,
        ),
      ),
    );
    await new Promise((r) => setImmediate(r));

    // Publish on the SESSION bus.
    const sessionBus = (session as unknown as { bus: EventBus }).bus;
    await Effect.runPromise(
      sessionBus.publish({
        id: "ev_test",
        surface: "session",
        phase: "delta",
        name: "test:event",
        timestamp: Date.now(),
        scope: {},
      } as ProtocolEvent),
    );

    // App-level subscriber sees the session's publish (fan-in).
    const collected = await Effect.runPromise(Effect.fromFiber(appEventsFiber));
    expect(Chunk.toReadonlyArray(collected).length).toBe(1);

    await app.closeApp();
  });

  it("session-local subscribers see ONLY session events (isolated reads)", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession({
      bus: LocalEventBus.factory(),
    });
    const sessionBus = (session as unknown as { bus: EventBus }).bus;
    const appBus = (app as unknown as { bus: EventBus }).bus;

    // Subscribe at SESSION level.
    const sessionSeen: ProtocolEvent[] = [];
    const sessionFiber = Effect.runFork(
      Stream.runForEach(
        sessionBus.subscribe({ name: { exact: "test:from-app" } }),
        (e) =>
          Effect.sync(() => {
            sessionSeen.push(e);
          }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    // Publish on the APP bus — should NOT be seen by session subscriber.
    await Effect.runPromise(
      appBus.publish({
        id: "ev_from_app",
        surface: "session",
        phase: "delta",
        name: "test:from-app",
        timestamp: Date.now(),
        scope: {},
      } as ProtocolEvent),
    );
    await new Promise((r) => setImmediate(r));

    expect(sessionSeen).toHaveLength(0);
    void sessionFiber;
    await app.closeApp();
  });

  it("metadata flows through to substrate factory via parent.metadata", async () => {
    let factorySawTenant = "";
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    await app.createSession({
      metadata: { tenant: "acme-corp" },
      bus: (parent) => {
        factorySawTenant = (parent.metadata["tenant"] as string) ?? "";
        return new LocalEventBus({ parent: parent.bus });
      },
    });
    expect(factorySawTenant).toBe("acme-corp");
    await app.closeApp();
  });

  it("multi-tenant: two sessions get their own per-tenant bus, app sees both via fan-in", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const tenantFactory: EventBusFactory<{
      bus: EventBus;
      onClose(h: () => void | Promise<void>): void;
      metadata: Readonly<Record<string, unknown>>;
    }> = (parent) => new LocalEventBus({ parent: parent.bus });

    const sessionA = await app.createSession({
      metadata: { tenant: "tenant-a" },
      bus: tenantFactory,
    });
    const sessionB = await app.createSession({
      metadata: { tenant: "tenant-b" },
      bus: tenantFactory,
    });

    const busA = (sessionA as unknown as { bus: EventBus }).bus;
    const busB = (sessionB as unknown as { bus: EventBus }).bus;
    const appBus = (app as unknown as { bus: EventBus }).bus;

    // Each tenant bus is a distinct instance (per-session construction).
    expect(busA).not.toBe(busB);
    expect(busA).not.toBe(appBus);
    expect(busB).not.toBe(appBus);

    // App-level subscriber sees events from BOTH tenants (fan-in).
    const appSeen: string[] = [];
    const appFiber = Effect.runFork(
      Stream.runForEach(
        appBus.subscribe({ name: { exact: "tenant:event" } }),
        (e) =>
          Effect.sync(() => {
            appSeen.push(String((e.scope as { tenant?: string }).tenant ?? "?"));
          }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    const mkEv = (tenant: string): ProtocolEvent =>
      ({
        id: `ev_${tenant}`,
        surface: "session",
        phase: "delta",
        name: "tenant:event",
        timestamp: Date.now(),
        scope: { tenant },
      }) as ProtocolEvent;

    await Effect.runPromise(busA.publish(mkEv("tenant-a")));
    await Effect.runPromise(busB.publish(mkEv("tenant-b")));
    await new Promise((r) => setImmediate(r));

    expect(appSeen.sort()).toEqual(["tenant-a", "tenant-b"]);
    void appFiber;
    await app.closeApp();
  });

  it("factory-registered onClose fires when session.close() runs", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    let tenantBusClosed = false;
    const session = await app.createSession({
      bus: (parent) => {
        const bus = new LocalEventBus({ parent: parent.bus });
        parent.onClose(() => {
          tenantBusClosed = true;
          bus.close();
        });
        return bus;
      },
    });
    expect(tenantBusClosed).toBe(false);
    await session.close();
    expect(tenantBusClosed).toBe(true);
    await app.closeApp();
  });
});

describe("createSession close-op semantics (ADR 31 Option G)", () => {
  it("session.close() runs cleanly even when a factory closes the per-session journal", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    // Per-session journal that fans in to the app journal. The factory
    // registers onClose to close the journal — this would crash if
    // session:command:close wrote a terminal envelope to the journal
    // after close runs. The policy override ("bus-only" for the close
    // op) prevents that.
    const session = await app.createSession({
      journal: MemoryJournal.factory({ capacity: 50 }),
    });

    // No throw — close runs cleanly.
    await session.close();

    // The per-session journal is shut down.
    const sessionJournal = (session as unknown as { journal: { closed: boolean } }).journal;
    expect(sessionJournal.closed).toBe(true);
    // App journal stays alive (different instance).
    const appJournal = (app as unknown as { journal: { closed: boolean } }).journal;
    expect(appJournal.closed).toBe(false);

    await app.closeApp();
  });
});

describe("createSession input — new fields from ADR 31 Phase 3", () => {
  it("rootElement override changes the agent for this session", async () => {
    const OtherAgent = () =>
      React.createElement("message" as never, { role: "user" }, "alt");
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    // We can't trivially observe which JSX renders without exercising
    // the model, but createSession should not reject — the rootElement
    // override field is accepted at the API.
    const session = await app.createSession({
      rootElement: React.createElement(OtherAgent),
    });
    expect(session).toBeDefined();
    await app.closeApp();
  });

  it("initialState seeds the session's state handle", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession({
      initialState: { adopterKey: "adopterValue" },
    });
    // SessionHarness exposes the state handle via `session.state`.
    const state = (session as unknown as { state: { get(k: string): unknown } }).state;
    expect(state.get("adopterKey")).toBe("adopterValue");
    await app.closeApp();
  });

  it("parentSessionId is stored on the session when supplied", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const session = await app.createSession({
      parentSessionId: "parent-xyz",
    });
    const stored = (session as unknown as { parentSessionId: string | undefined })
      .parentSessionId;
    expect(stored).toBe("parent-xyz");
    await app.closeApp();
  });
});

describe("createSession substrate slots — instance form (sharing across sessions)", () => {
  it("session uses the same bus instance when passed as an instance", async () => {
    const app = await createApp(React.createElement(MinimalAgent), {
      executor: mkExecutor(),
      target: mkTarget(),
    });
    const sharedSessionBus = new LocalEventBus();
    const sessionA = await app.createSession({ bus: sharedSessionBus });
    const sessionB = await app.createSession({ bus: sharedSessionBus });
    expect((sessionA as unknown as { bus: EventBus }).bus).toBe(sharedSessionBus);
    expect((sessionB as unknown as { bus: EventBus }).bus).toBe(sharedSessionBus);
    // closeApp shouldn't crash even though the shared bus is referenced
    // twice — factories never registered close on it.
    await app.closeApp();
  });
});
