/**
 * Eviction transparency — regression + contract suite.
 *
 * The app's session-eviction paths, exercised against the REAL app / session /
 * compiler (only the model executor is a legitimate fake). Originally the bug
 * repro (all `[DEFECT]` tests red); now the fixes are in and these lock the
 * behavior in. Each carries an inline mechanism note with file:line.
 *
 * Leg 1 — a reopened session (same id) re-establishes its compiler mount. The
 *         mount Operation's idempotency opId now folds a per-mountId generation
 *         (bumped on unmount), so a reopen is a fresh op and `mountBody` re-runs
 *         instead of replaying the first, torn-down mount. Plus construction
 *         single-flight, and the address-by-id handle contract.
 * Leg 2 — knob + `useSessionState` survive evict→reopen: eviction flushes each
 *         harness to its OWN store (`persist`), and the reopen's genesis fans
 *         `hydrate` back out over the same stores. The app retains nothing in
 *         between (checkpointing §4).
 *
 * Run:
 *   npx vitest run packages/app/src/__tests__/session-eviction-defects.spec.tsx
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { MemoryTimelineStore } from "@agentick/timeline";
import "@agentick/knobs";
import type { ExecutionTarget } from "@agentick/spec";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

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

function PlainAgent(): React.ReactElement {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    "You are a helpful agent.",
  );
}

/**
 * `@agentick/app` does not declare `@agentick/state` directly, so the
 * `session.state` augmentation type isn't in scope here. The handle exists at
 * RUNTIME (the session constructs the StateHarness unconditionally); this
 * narrow face reaches it without the package import.
 */
interface StateFace {
  set(input: { key: string; value: unknown }): Promise<void>;
  get(key: string): unknown;
}
function stateOf(session: unknown): StateFace {
  return (session as { state: StateFace }).state;
}

interface Harnesses {
  journal: MemoryJournal;
  bus: LocalEventBus;
  inbox: LocalInbox;
  executor: FakeLanguageModelExecutor;
}

async function mkExecutor(name: string): Promise<Harnesses> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor(name, journal, bus, inbox, {
    scripted: plainScript(),
  });
  await executor.ready;
  return { journal, bus, inbox, executor };
}

// ===========================================================================
// LEG 1 — reopen never re-mounts (deterministic)
// ===========================================================================

describe("LEG 1 — eviction/reopen activation", () => {
  // -------------------------------------------------------------------------
  // 1a — DEFECT (headline): evict → reopen (same id) → send throws NotMounted.
  //
  // CONFIRMED MECHANISM (deterministic, NOT a race):
  //   - The mount registry is keyed by sessionId: `mount:<sessionId>`
  //     (session/harness.ts:1131).
  //   - `CompilerHarness.mount` runs through an Operation whose idempotency
  //     opId is DERIVED FROM the mountId: `compiler:mount:${mountId}`
  //     (compiler-harness.ts:241).
  //   - On evict, `unmount` deletes the mount (compiler-harness.ts:419) — it
  //     carries NO idempotency key.
  //   - On reopen (same sessionId → same mountId → same mount opId), the
  //     Operation runtime treats the second mount as an idempotent REPLAY of
  //     the first (already-completed) mount and returns its cached result
  //     WITHOUT executing `mountBody`. Line 571's `this.mounts.set(...)` never
  //     runs, so the mount is never re-established.
  //   - The reopened session's first tick calls
  //     `compiler.dispatchLifecycle({ mountId })` (lifecycle-projection.ts),
  //     the mount is absent → `NotMounted` (compiler-harness.ts:392).
  //
  // Verified by tracing `this.mounts` mutations: on reopen, `mount()` resolves
  // with NO `mounts.set` for the mountId.
  //
  // EXPECTED: currently REJECTS with NotMounted.
  // -------------------------------------------------------------------------
  it("[DEFECT] evict→reopen→send never re-mounts (NotMounted)", async () => {
    const { journal, bus, inbox, executor } = await mkExecutor("leg1-reopen");
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      sessions: { maxActive: 1 },
    });

    const a = await app.createSession({ sessionId: "A" });
    await (
      await a.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    await app.createSession({ sessionId: "B" }); // evicts A (LRU, over cap)
    expect(app.getSession("A")).toBeUndefined();

    const reopened = await app.createSession({ sessionId: "A" });
    expect(app.getSession("A")).toBeDefined(); // registry says it's live…

    // …but the compiler mount was never re-established → NotMounted.
    // EXPECTED-FAIL: the correct behavior is that this resolves.
    const res = await (
      await reopened.send({ messages: [{ role: "user", content: "again" }] })
    ).result;
    expect(res.response).toContain("ok");

    await app.closeApp();
  });

  // -------------------------------------------------------------------------
  // 1b — DEFECT: concurrent same-id reopen double-constructs (no single-flight).
  //
  // CONFIRMED MECHANISM: after A is fully evicted, two `createSession("A")`
  // calls race. `buildSession`'s disposal barrier (harness.ts:2163) has
  // nothing to await (disposal already settled) and there is NO construction
  // single-flight guard (no `building` map beside `disposing`). Both builds
  // proceed and construct the per-session sub-harnesses, which register
  // substrate inbox addresses; the second collides on `tasks:A:tasks` →
  // `RoutingFailed: address already registered` (local-inbox.ts:158). The
  // collision surfaces on the fire-and-forget sub-harness `.ready`
  // registration, i.e. as an UNHANDLED rejection, not on the createSession
  // promise — so this test drains it via an `unhandledRejection` listener.
  //
  // EXPECTED: currently a collision is observed (bug present). The assertion
  // demands the CORRECT behavior (no collision) and therefore FAILS today.
  // -------------------------------------------------------------------------
  it("[DEFECT] concurrent same-id reopen double-constructs", async () => {
    const { journal, bus, inbox, executor } = await mkExecutor("leg1-concurrent");
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      sessions: { maxActive: 1 },
    });

    const a = await app.createSession({ sessionId: "A" });
    await (
      await a.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    await app.createSession({ sessionId: "B" }); // evicts A
    expect(app.getSession("A")).toBeUndefined();

    const rejections: unknown[] = [];
    const onRej = (e: unknown): void => {
      rejections.push(e);
    };
    process.on("unhandledRejection", onRej);
    try {
      const settled = await Promise.allSettled([
        app.createSession({ sessionId: "A" }),
        app.createSession({ sessionId: "A" }),
      ]);
      // Let the fire-and-forget sub-harness registrations settle so any
      // collision surfaces (and is captured) rather than leaking cross-test.
      await new Promise((r) => setTimeout(r, 50));

      const createRejected = settled.some((s) => s.status === "rejected");
      const collided = rejections.some((e) =>
        String((e as { message?: string })?.message ?? e).includes("already registered"),
      );

      // Correct behavior: two concurrent reopens collapse to ONE construction,
      // no address collision. EXPECTED-FAIL: a collision is observed today.
      expect(createRejected || collided).toBe(false);
    } finally {
      process.removeListener("unhandledRejection", onRej);
    }

    await app.closeApp();
  });

  // -------------------------------------------------------------------------
  // 1c — CONTRACT: a handle held across eviction is invalid; re-fetch by id.
  //
  // The session id is the durable address; a SessionHarness handle is a
  // TRANSIENT in-process reference. LRU eviction closes the held instance
  // (_closed=true at harness.ts:1801, unmount at :1808). The contract is NOT
  // "the handle rehydrates" — it is "address by id": re-fetch via
  // `createSession(id)`, which transparently reopens (open-or-rehydrate) with
  // state restored. A stale handle fails LOUD (SessionClosedError) rather than
  // silently resurrecting a dead reference.
  //
  // TODO(eviction-handle-error): a dedicated "evicted — re-fetch by id" error
  // would read clearer than the generic SessionClosedError.
  // -------------------------------------------------------------------------
  it("[CONTRACT] handle held across eviction is invalid; re-fetch by id reopens", async () => {
    const { journal, bus, inbox, executor } = await mkExecutor("leg1-held");
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      sessions: { maxActive: 1 },
    });

    const a = await app.createSession({ sessionId: "A" });
    await (
      await a.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    await app.createSession({ sessionId: "B" }); // evicts A — test still holds `a`
    expect(app.getSession("A")).toBeUndefined();

    // The STALE handle is invalid — it fails loud, never silently.
    await expect(
      a.send({ messages: [{ role: "user", content: "stale" }] }).then((h) => h.result),
    ).rejects.toBeDefined();

    // The supported path: re-fetch by id transparently reopens the session.
    const a2 = await app.createSession({ sessionId: "A" });
    await expect(
      a2.send({ messages: [{ role: "user", content: "again" }] }).then((h) => h.result),
    ).resolves.toBeDefined();

    await app.closeApp();
  });
});

// ===========================================================================
// LEG 2 — knob + session-state loss across evict→reopen
// ===========================================================================

describe("LEG 2 — knob + session-state survive evict→reopen", () => {
  // -------------------------------------------------------------------------
  // 2a — the fix this file was written to demand. Eviction runs
  // `session:snapshot` (the `persist` fan-out — each harness flushes to its own
  // store) before the unmount, and the reopen's genesis runs the `hydrate`
  // fan-out over those same stores. Both stores are APP-scoped by default, which
  // is the part that makes it work with no configuration: a per-harness default
  // store would go to the grave with the harness that owned it.
  // -------------------------------------------------------------------------
  it("knob + session-state survive evict→reopen", async () => {
    const { journal, bus, inbox, executor } = await mkExecutor("leg2-survives");
    const timelineStore = new MemoryTimelineStore();
    const app = await createApp(React.createElement(PlainAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      sessions: { maxActive: 1 },
      timeline: { store: timelineStore },
    });

    const a = await app.createSession({ sessionId: "A" });
    await (
      await a.send({ messages: [{ role: "user", content: "seed" }] })
    ).result;

    // Write a knob value and a session-state value onto the LIVE bridges.
    await a.knobs.set({ id: "verbose", value: true });
    await stateOf(a).set({ key: "count", value: 99 });
    expect(a.knobs.get("verbose")).toBe(true);
    expect(stateOf(a).get("count")).toBe(99);

    await app.createSession({ sessionId: "B" }); // evicts A
    expect(app.getSession("A")).toBeUndefined();
    const reopened = await app.createSession({ sessionId: "A" });

    expect(reopened.knobs.get("verbose")).toBe(true);
    expect(stateOf(reopened).get("count")).toBe(99);

    await app.closeApp();
  });
});
