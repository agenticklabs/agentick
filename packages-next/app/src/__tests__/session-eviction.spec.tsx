/**
 * PA2 / PA3 — bounded live session registry.
 *
 * The app's `sessionId → SessionHarness` map was an unbounded `Map` — a
 * memory leak in long-lived deployments that open sessions and never close
 * them. `createApp({ sessions: { maxActive, idleTimeout } })` caps it by
 * PAGING OUT idle sessions. These tests pin the four load-bearing claims:
 *
 *   1. `maxActive` evicts the LEAST-RECENTLY-ACTIVE session (LRU order),
 *      where activity = a `send` (proven by refreshing an old session).
 *   2. `idleTimeout` pages out a session with no activity, on the background
 *      sweep (no traffic required).
 *   3. Eviction is PAGING, not deletion — an evicted session reopens with its
 *      state intact via the ADR-49 open-or-rehydrate path over a durable store.
 *   4. An in-flight execution is NEVER evicted (the hard invariant), and the
 *      soft cap is restored once the work settles.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { MemoryTimelineStore } from "@agentick/timeline-next";
import { waitFor } from "@agentick/utils-next/testing";
import type { ContentBlock, ExecutionTarget, TimelineHarnessSnapshot } from "@agentick/spec-next";

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

function persistedOf(snap: { bridges: Record<string, unknown> }): readonly unknown[] {
  return (snap.bridges.timeline as TimelineHarnessSnapshot | undefined)?.persisted ?? [];
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
  it("pages out a session idle past the timeout via the background sweep", async () => {
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

    // No activity → the sweep pages it out once it crosses the idle window.
    await waitFor(() => app.getSession("idle-1") === undefined, { timeoutMs: 2000, pollMs: 10 });
    expect(app.getSession("idle-1")).toBeUndefined();

    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// PA2/PA3 — eviction is paging, not deletion (rehydrate round-trip)
// ---------------------------------------------------------------------------

describe("PA2/PA3 — evicted session reopens with state", () => {
  it("rehydrates a paged-out session's timeline from the durable store", async () => {
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
      session: { timeline: { store: timelineStore } },
    });

    // Turn on session A — the user message is persisted to the store.
    const a = await app.createSession({ sessionId: "keep-A" });
    await (
      await a.send({ messages: [{ role: "user", content: "REMEMBER-42" }] })
    ).result;

    // Opening a second session pages A out (LRU, over cap).
    await app.createSession({ sessionId: "other-B" });
    expect(app.getSession("keep-A")).toBeUndefined(); // evicted (paged out)

    // Reopen A by the SAME id — reconstruct + rehydrate from the store.
    const reopened = await app.createSession({ sessionId: "keep-A" });
    expect(app.getSession("keep-A")).toBeDefined();

    const snap = await reopened.snapshot();
    const persisted = persistedOf(snap);
    const text = JSON.stringify(persisted);
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
