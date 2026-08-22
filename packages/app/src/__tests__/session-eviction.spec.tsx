/**
 * PA2 / PA3 — bounded live session registry.
 *
 * The app's `sessionId → SessionHarness` map was an unbounded `Map` — a
 * memory leak in long-lived deployments that open sessions and never close
 * them. `createApp({ sessions: { maxActive, idleTimeout } })` caps it by
 * EVICTING idle sessions. These tests pin the four load-bearing claims:
 *
 *   1. `maxActive` evicts the LEAST-RECENTLY-ACTIVE session (LRU order),
 *      where activity = a `send` (proven by refreshing an old session).
 *   2. `idleTimeout` evicts a session with no activity, on the background
 *      sweep (no traffic required).
 *   3. Eviction is a CHECKPOINT, not deletion — an evicted session reopens with
 *      its state intact by rebuilding over its stores (checkpointing §4).
 *   4. An in-flight execution is NEVER evicted (the hard invariant), and the
 *      soft cap is restored once the work settles.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { createKnobStore } from "@agentick/knobs";
import { InMemorySessionStore } from "@agentick/session";
import { MemoryTimelineStore } from "@agentick/timeline";
import { waitFor } from "@agentick/utils/testing";
import type { ContentBlock, ExecutionTarget } from "@agentick/spec";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Agent with a single blocking tool — used to hold an execution in-flight. */
function GatedAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a helpful agent.",
    ),
    React.createElement("tool" as never, {
      id: "t.gate",
      name: "gate",
      description: "A tool that blocks until released",
      inputSchema: { type: "object", properties: {} },
      exposure: ["model"],
      handlerRef: "handlers/gate",
    }),
  );
}

/** Agent with no tools — used for plain send / rehydrate round-trips. */
function PlainAgent() {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

/** A scripted run that first calls the `gate` tool, then replies with text. */
function gateScript() {
  return [
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "tool_use" as const, toolUseId: "tc-1", name: "gate", input: {} }],
        stopReason: "tool_use" as const,
        toolCalls: [{ id: "tc-1", name: "gate", input: {} }],
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      },
    },
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "text" as const, text: "GATED-DONE" }],
        stopReason: "end" as const,
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      },
    },
  ];
}

/** A scripted run that replies with a single text turn (no tools). */
function plainScript(text = "ok") {
  return [
    {
      result: {
        specVersion: "2026-05-08" as const,
        output: [{ type: "text" as const, text }],
        stopReason: "end" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// PA2 — maxActive LRU eviction
// ---------------------------------------------------------------------------

describe("PA2 — maxActive LRU eviction", () => {
  it("evicts the least-recently-active session when the cap is exceeded", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("evict-exec", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;

    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      sessions: { maxActive: 2 },
    });

    const a = await app.createSession({ sessionId: "s-A" });
    const b = await app.createSession({ sessionId: "s-B" });
    expect(app.getSession("s-A")).toBeDefined();
    expect(app.getSession("s-B")).toBeDefined();

    // Touch A via a send — now B is the least-recently-active.
    await (
      await a.send({ messages: [{ role: "user", content: "ping" }] })
    ).result;

    // Third session pushes over the cap → LRU (B) evicted, A kept.
    const c = await app.createSession({ sessionId: "s-C" });
    expect(app.getSession("s-C")).toBeDefined();
    expect(app.getSession("s-A")).toBeDefined(); // recently active — kept
    expect(app.getSession("s-B")).toBeUndefined(); // LRU — evicted

    void b;
    void c;
    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// PA3 — idleTimeout eviction
// ---------------------------------------------------------------------------

describe("PA3 — idleTimeout eviction", () => {
  it("evicts a session idle past the timeout via the background sweep", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("idle-exec", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;

    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      sessions: { idleTimeout: 40 },
    });

    await app.createSession({ sessionId: "idle-1" });
    expect(app.getSession("idle-1")).toBeDefined();

    // No activity → the sweep evicts it once it crosses the idle window.
    await waitFor(() => app.getSession("idle-1") === undefined, { timeoutMs: 2000, pollMs: 10 });
    expect(app.getSession("idle-1")).toBeUndefined();

    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// PA2/PA3 — eviction is paging, not deletion (rehydrate round-trip)
// ---------------------------------------------------------------------------

describe("PA2/PA3 — evicted session reopens with state", () => {
  it("rehydrates an evicted session's timeline from the durable store", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("rehydrate-exec", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;

    // Shared durable timeline store — the backing that survives eviction.
    const timelineStore = new MemoryTimelineStore();

    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      // maxActive:1 makes the SECOND createSession evict the first.
      sessions: { maxActive: 1 },
      timeline: { store: timelineStore },
    });

    // Turn on session A — the user message is persisted to the store.
    const a = await app.createSession({ sessionId: "keep-A" });
    await (
      await a.send({ messages: [{ role: "user", content: "REMEMBER-42" }] })
    ).result;

    // Opening a second session evicts A (LRU, over cap).
    await app.createSession({ sessionId: "other-B" });
    expect(app.getSession("keep-A")).toBeUndefined(); // evicted

    // Reopen A by the SAME id — reconstruct + rehydrate from the store.
    const reopened = await app.createSession({ sessionId: "keep-A" });
    expect(app.getSession("keep-A")).toBeDefined();

    // Read the LIVE handle: the durable log IS the timeline's state, so there
    // is no snapshot value to read it out of.
    const text = JSON.stringify(reopened.timeline.readPersisted());
    expect(text).toContain("REMEMBER-42"); // prior turn survived eviction

    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// PA2 — an in-flight execution is never evicted
// ---------------------------------------------------------------------------

describe("PA2 — in-flight guard", () => {
  it("never evicts a session with an in-flight execution; restores the cap after it settles", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("inflight-exec", journal, bus, inbox, {
      scripted: gateScript(),
    });
    await executor.ready;

    // A tool handler that blocks until the test releases it.
    let entered!: () => void;
    const started = new Promise<void>((res) => {
      entered = res;
    });
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const toolHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
      [
        "handlers/gate",
        async () => {
          entered();
          await gate;
          return [{ type: "text", text: "released" }];
        },
      ],
    ]);

    const app = await createApp(React.createElement(GatedAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      toolHandlers,
      sessions: { maxActive: 1 },
    });

    // Start A and hold it in-flight inside the blocking tool.
    const a = await app.createSession({ sessionId: "busy-A" });
    const handle = await a.send({ messages: [{ role: "user", content: "go" }] });
    await started; // tool entered → A is mid-execution
    // `hasInFlightExecution` is the concrete SessionHarness in-flight read the
    // app's eviction guard consults (not on the protocol — app-internal).
    const inFlight = (s: typeof a): boolean =>
      (s as unknown as { hasInFlightExecution: boolean }).hasInFlightExecution;
    expect(inFlight(a)).toBe(true);

    // Opening B would exceed maxActive:1, but A is in-flight → NOT evicted.
    await app.createSession({ sessionId: "arrival-B" });
    expect(app.getSession("busy-A")).toBeDefined(); // in-flight — protected
    expect(app.getSession("arrival-B")).toBeDefined();

    // Release the tool; A settles.
    release();
    const result = await handle.result;
    expect(result.response).toContain("GATED-DONE");
    expect(inFlight(a)).toBe(false);

    // Now A is quiescent — the next create restores the soft cap by evicting
    // the LRU evictable session (A, older than B).
    await app.createSession({ sessionId: "arrival-C" });
    expect(app.getSession("busy-A")).toBeUndefined(); // now evictable → evicted
    expect(app.getSession("arrival-C")).toBeDefined();

    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// Checkpointing §4 — one recovery path, and eviction's public verb
// ---------------------------------------------------------------------------

describe("checkpointing §4 — evict and resume are one code path", () => {
  it("evict→resume reads what a fresh app over the same stores reads", async () => {
    // The three stores are the session's durable identity. Everything else —
    // the live tree, the compiler mount, the app itself — is derived.
    const sessionStore = new InMemorySessionStore();
    const timelineStore = new MemoryTimelineStore();
    const knobStore = createKnobStore();
    const mk = async (appId: string) => {
      const journal = new MemoryJournal();
      const bus = new LocalEventBus();
      const inbox = new LocalInbox();
      const executor = new FakeLanguageModelExecutor(`onepath-${appId}`, journal, bus, inbox, {
        scripted: plainScript(),
      });
      await executor.ready;
      return createApp(React.createElement(PlainAgent), {
        appId,
        modelExecutor: executor,
        target: mkTarget(),
        journal,
        bus,
        inbox,
        sessions: { store: sessionStore, maxActive: 1 },
        timeline: { store: timelineStore },
        knobs: { store: knobStore },
      });
    };

    const appA = await mk("one-path-A");
    const a = await appA.createSession({ sessionId: "S" });
    await (
      await a.send({ messages: [{ role: "user", content: "REMEMBER-7" }] })
    ).result;
    await a.knobs.set({ id: "verbose", value: true });

    await appA.evictSession("S");
    expect(appA.getSession("S")).toBeUndefined();
    const resumed = await appA.resumeSession("S");
    const afterEvict = {
      knob: resumed!.knobs.get("verbose"),
      timeline: JSON.stringify(resumed!.timeline.readPersisted()),
    };
    await appA.closeApp();

    // A DIFFERENT app over the same stores — the restart shape. Same reads.
    const appB = await mk("one-path-B");
    const rebuilt = await appB.createSession({ sessionId: "S" });
    expect({
      knob: rebuilt.knobs.get("verbose"),
      timeline: JSON.stringify(rebuilt.timeline.readPersisted()),
    }).toEqual(afterEvict);
    expect(afterEvict.timeline).toContain("REMEMBER-7");
    expect(afterEvict.knob).toBe(true);

    await appB.closeApp();
  });

  it("retains nothing: the evicted session is unreachable from the app's own state", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("retain-exec", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
    });

    const a = await app.createSession({ sessionId: "gone" });
    await app.evictSession("gone");

    // No field of the app is keyed by the evicted session, and none holds its
    // harness. The deleted paged tier was exactly such a field — a Map keyed by
    // session id whose value carried the whole snapshot — so this assertion
    // fails on the code this phase replaced.
    const fields = Object.values(app as unknown as Record<string, unknown>);
    const keyedByEvicted = fields.filter((v) => v instanceof Map && v.has("gone"));
    expect(keyedByEvicted).toEqual([]);
    const held: unknown[] = [];
    for (const value of fields) {
      if (value instanceof Map) held.push(...value.values());
      else if (value instanceof Set || Array.isArray(value)) held.push(...value);
      else held.push(value);
    }
    expect(held).not.toContain(a);

    await app.closeApp();
  });
});

describe("evictSession — the same operation, invoked by hand", () => {
  it("evicts a live session and resumes it with its state", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("manual-exec", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      // No `maxActive` / `idleTimeout`: eviction needs no configuration when
      // the caller is the one asking for it.
    });

    const a = await app.createSession({ sessionId: "manual" });
    await (
      await a.send({ messages: [{ role: "user", content: "REMEMBER-9" }] })
    ).result;

    await app.evictSession("manual");
    expect(app.getSession("manual")).toBeUndefined();
    // Hibernated, not ended — the record is what makes it resumable.
    expect((await app.getSessionRecord("manual"))?.status).toBe("hibernated");

    const resumed = await app.resumeSession("manual");
    expect(resumed).toBeDefined();
    expect(JSON.stringify(resumed!.timeline.readPersisted())).toContain("REMEMBER-9");

    await app.closeApp();
  });

  it("resolves without effect for an in-flight session", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("manual-inflight", journal, bus, inbox, {
      scripted: gateScript(),
    });
    await executor.ready;

    let entered!: () => void;
    const started = new Promise<void>((res) => {
      entered = res;
    });
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const toolHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
      [
        "handlers/gate",
        async () => {
          entered();
          await gate;
          return [{ type: "text", text: "released" }];
        },
      ],
    ]);

    const app = await createApp(React.createElement(GatedAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      toolHandlers,
    });

    const a = await app.createSession({ sessionId: "busy" });
    const handle = await a.send({ messages: [{ role: "user", content: "go" }] });
    await started;

    // The hard eviction invariant holds for the manual caller too: no refusal,
    // no interruption — the session is simply still there.
    await expect(app.evictSession("busy")).resolves.toBeUndefined();
    expect(app.getSession("busy")).toBeDefined();

    release();
    expect((await handle.result).response).toContain("GATED-DONE");

    // Quiescent now — the same call takes it.
    await app.evictSession("busy");
    expect(app.getSession("busy")).toBeUndefined();

    await app.closeApp();
  });

  it("is a no-op for an unknown id", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("manual-unknown", journal, bus, inbox, {
      scripted: plainScript(),
    });
    await executor.ready;
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
    });
    await expect(app.evictSession("never-existed")).resolves.toBeUndefined();
    await app.closeApp();
  });
});
