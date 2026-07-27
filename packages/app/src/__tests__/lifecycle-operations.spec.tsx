/**
 * ADR 92 §Family 2 items 4 + 5 — session lifecycle crossings are operations.
 *
 * Two asymmetries closed here:
 *
 *   4. SPAWN / FORK. `session.spawn()` reached `createSessionBody` directly,
 *      past the create op. The `onSessionCreate` hook fired (ADR 48) so
 *      adopters were not blind, but the ENVELOPE was missing: no guard, no
 *      journal lineage, no span parenting. Now a spawn is TWO linked records —
 *      `session:command:spawn` (depth ceiling, lineage, principal descent) and
 *      `app:command:create-child-session` (construction, registry admission) —
 *      per the ADR's layering principle.
 *
 *   5. CLOSE. `App.closeApp` and `Gateway.close` have been ops since ADR 84;
 *      the session tore down as a plain method. Now `session:command:close` is
 *      the single teardown path, and the app's LRU / idle EVICTION sweep routes
 *      through it with `reason: "evicted"` rather than around it.
 *
 * Pins, one describe per contract clause. Every assertion is against the app's
 * real bus + journal — no stubbed substrate.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { waitFor } from "@agentick/utils/testing";
import { Effect, Stream } from "effect";
import type { ExecutionTarget, ProtocolEvent, SessionHarnessProtocol } from "@agentick/spec";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPAWN_OP = "session:command:spawn";
const CREATE_CHILD_OP = "app:command:create-child-session";
const CREATE_OP = "app:command:create-session";
const CLOSE_OP = "session:command:close";

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

interface Rig {
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly journal: MemoryJournal;
  readonly events: ProtocolEvent[];
}

async function rig(
  options: { readonly sessions?: { maxActive?: number; idleTimeout?: number } } = {},
): Promise<Rig> {
  const journal = new MemoryJournal({ capacity: 20_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("lifecycle-exec", journal, bus, inbox, {
    scripted: plainScript(),
  });
  await executor.ready;

  const events: ProtocolEvent[] = [];
  Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );

  const app = await createApp(React.createElement(PlainAgent), {
    modelExecutor: executor,
    target: mkTarget(),
    journal,
    bus,
    inbox,
    ...(options.sessions ? { sessions: options.sessions } : {}),
  });
  return { app, journal, events };
}

/** Settle the microtask + bus fan-out queue. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function opsNamed(events: readonly ProtocolEvent[], name: string): readonly ProtocolEvent[] {
  return events.filter((e) => e.name === name);
}

function terminalOf(events: readonly ProtocolEvent[], name: string): ProtocolEvent | undefined {
  return opsNamed(events, name).find((e) => e.phase === "terminal");
}

async function journaled(journal: MemoryJournal, name: string): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({ name: { exact: name } }, "beginning")),
  );
  return Array.from(out);
}

// ===========================================================================
// 4 — spawn: the two-layer envelope
// ===========================================================================

describe("a spawn runs as session:command:spawn → app:command:create-child-session", () => {
  it("emits BOTH ops, with the child-create carrying the full lineage as scope", async () => {
    const { app, events } = await rig();
    const parent = await app.createSession({ sessionId: "s-parent" });

    const child = (await parent.spawn({})) as SessionHarnessProtocol;
    await settle();

    const spawn = terminalOf(events, SPAWN_OP)!;
    expect(spawn.surface).toBe("session");
    expect(spawn.scope.sessionId).toBe("s-parent");
    expect(spawn.outcome).toBe("succeeded");

    const created = terminalOf(events, CREATE_CHILD_OP)!;
    expect(created.surface).toBe("app");
    expect(created.scope.sessionId).toBe(child.id);
    expect(created.scope.parentSessionId).toBe("s-parent");
    expect(created.scope.spawnPath).toEqual(["s-parent"]);

    await app.closeApp();
  });

  it("PARENTS the child-create under the invoking session's spawn op", async () => {
    const { app, events } = await rig();
    const parent = await app.createSession({ sessionId: "s-parent" });

    await parent.spawn({});
    await settle();

    const spawnRequested = opsNamed(events, SPAWN_OP).find((e) => e.phase === "requested")!;
    const createdRequested = opsNamed(events, CREATE_CHILD_OP).find(
      (e) => e.phase === "requested",
    )!;
    // The whole point of the promotion: the audit trail nests the construction
    // under the spawn that asked for it, across the Promise boundary between
    // the two layers.
    expect(spawnRequested.opId).toMatch(/^session:spawn:/);
    expect(createdRequested.parentOpId).toBe(spawnRequested.opId);

    await app.closeApp();
  });

  it("uses its OWN verb — the host create op is untouched by a spawn", async () => {
    const { app, events } = await rig();
    const parent = await app.createSession({ sessionId: "s-parent" });
    const hostCreates = opsNamed(events, CREATE_OP).filter((e) => e.phase === "terminal").length;

    await parent.spawn({});
    await settle();

    // A spawn adds child-create records, never host-create records — so a
    // guard on `app:create-session` does not silently police spawns and
    // vice-versa.
    expect(opsNamed(events, CREATE_OP).filter((e) => e.phase === "terminal")).toHaveLength(
      hostCreates,
    );
    expect(opsNamed(events, CREATE_CHILD_OP).filter((e) => e.phase === "terminal")).toHaveLength(1);

    await app.closeApp();
  });

  it("journals the spawn lineage — both records are durable", async () => {
    const { app, journal } = await rig();
    const parent = await app.createSession({ sessionId: "s-parent" });

    await parent.spawn({});
    await settle();

    const spawnRows = await journaled(journal, SPAWN_OP);
    const childRows = await journaled(journal, CREATE_CHILD_OP);
    expect(spawnRows.map((e) => e.phase)).toEqual(
      expect.arrayContaining(["requested", "terminal"]),
    );
    expect(childRows.map((e) => e.phase)).toEqual(
      expect.arrayContaining(["requested", "terminal"]),
    );
    expect(childRows.every((e) => e.scope.parentSessionId === "s-parent")).toBe(true);

    await app.closeApp();
  });

  it("a fork inherits the envelope transitively (a fork IS a spawn plus a restore)", async () => {
    const { app, events } = await rig();
    const parent = await app.createSession({ sessionId: "s-forker" });

    await parent.fork({});
    await settle();

    expect(terminalOf(events, SPAWN_OP)?.outcome).toBe("succeeded");
    expect(terminalOf(events, CREATE_CHILD_OP)?.outcome).toBe("succeeded");
    // The three layers of a fork, each its own record.
    expect(terminalOf(events, "session:command:snapshot")?.outcome).toBe("succeeded");
    expect(terminalOf(events, "session:command:restore")?.outcome).toBe("succeeded");

    await app.closeApp();
  });

  it("the ADR-48 onSessionCreate hook still fires for a spawn — unchanged", async () => {
    const { app } = await rig();
    const seen: Array<string | undefined> = [];
    app.onSessionCreate(async (input) => {
      seen.push(input.parentSessionId);
    });
    const parent = await app.createSession({ sessionId: "s-parent" });

    await parent.spawn({});

    // Two creates observed: the host one (no parent) and the spawn (parented).
    expect(seen).toContain("s-parent");

    await app.closeApp();
  });
});

// ===========================================================================
// 4 — the guard seam over spawn
// ===========================================================================

describe("a guard veto blocks a spawn", () => {
  it("a vetoed spawn creates NO child — no registry entry, no create-child op", async () => {
    const { app, events } = await rig();
    const parent = await app.createSession({ sessionId: "s-parent" });
    const before = (await app.listSessions()).length;

    app.guard((_input, ctx) =>
      ctx.op === "SessionSpawn" ? { kind: "veto", reason: "no-subagents" } : undefined,
    );

    await expect(parent.spawn({})).rejects.toBeTruthy();
    await settle();

    expect(terminalOf(events, SPAWN_OP)?.outcome).toBe("vetoed");
    // The construction layer never ran.
    expect(opsNamed(events, CREATE_CHILD_OP)).toHaveLength(0);
    expect(await app.listSessions()).toHaveLength(before);

    await app.closeApp();
  });

  it("a veto at the CONSTRUCTION layer also creates no child", async () => {
    const { app, events } = await rig();
    const parent = await app.createSession({ sessionId: "s-parent" });
    const before = (await app.listSessions()).length;

    app.guard((_input, ctx) =>
      ctx.op === "AppCreateChildSession" ? { kind: "veto", reason: "quota" } : undefined,
    );

    await expect(parent.spawn({})).rejects.toBeTruthy();
    await settle();

    expect(terminalOf(events, CREATE_CHILD_OP)?.outcome).toBe("vetoed");
    expect(await app.listSessions()).toHaveLength(before);
    // The outer spawn op records the failure too — layered execution, layered
    // records.
    expect(terminalOf(events, SPAWN_OP)?.outcome).toBe("failed");

    await app.closeApp();
  });

  it("a host createSession is NOT blocked by a spawn-only guard", async () => {
    const { app } = await rig();
    app.guard((_input, ctx) =>
      ctx.op === "SessionSpawn" ? { kind: "veto", reason: "no-subagents" } : undefined,
    );

    await expect(app.createSession({ sessionId: "s-host" })).resolves.toBeDefined();

    await app.closeApp();
  });
});

// ===========================================================================
// 5 — close: the op, its policy, and the eviction route
// ===========================================================================

describe("session teardown runs as session:command:close", () => {
  it("an explicit close emits the op with reason 'closed'", async () => {
    const { app, events } = await rig();
    const s = await app.createSession({ sessionId: "s-close" });

    await s.close();
    await settle();

    const ops = opsNamed(events, CLOSE_OP).filter((e) => e.scope.sessionId === "s-close");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.find((e) => e.phase === "terminal")?.outcome).toBe("succeeded");
    const requested = ops.find((e) => e.phase === "requested")!;
    expect(requested.payload).toEqual({ reason: "closed" });

    await app.closeApp();
  });

  it("close is BUS-ONLY — the envelope never reaches the journal", async () => {
    const { app, journal } = await rig();
    const s = await app.createSession({ sessionId: "s-busonly" });

    await s.close();
    await settle();

    // The policy override the SessionHarness constructor has always declared
    // is now load-bearing: it is what keeps the terminal from being appended
    // to a journal an `onClose` handler may have torn down.
    expect(await journaled(journal, CLOSE_OP)).toHaveLength(0);

    await app.closeApp();
  });

  it("a guard veto holds the session open", async () => {
    const { app, events } = await rig();
    const s = await app.createSession({ sessionId: "s-held" });

    app.guard((_input, ctx) =>
      ctx.op === "SessionClose" ? { kind: "veto", reason: "draining" } : undefined,
    );

    await expect(s.close()).rejects.toBeTruthy();
    await settle();

    expect(terminalOf(events, CLOSE_OP)?.outcome).toBe("vetoed");
    // Still usable — teardown never ran.
    expect(app.getSession("s-held")).toBeDefined();
    await expect(s.snapshot()).resolves.toBeDefined();
  });
});

describe("idle eviction routes THROUGH the close op", () => {
  it("a swept session's teardown carries reason 'evicted'", async () => {
    const { app, events } = await rig({ sessions: { idleTimeout: 40 } });
    await app.createSession({ sessionId: "s-idle" });

    await waitFor(() => app.getSession("s-idle") === undefined, { timeoutMs: 3000, pollMs: 10 });
    await settle();

    const ops = opsNamed(events, CLOSE_OP).filter((e) => e.scope.sessionId === "s-idle");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.find((e) => e.phase === "terminal")?.outcome).toBe("succeeded");
    // Page-out and hangup take the SAME path; the record tells them apart.
    expect(ops.find((e) => e.phase === "requested")?.payload).toEqual({ reason: "evicted" });

    await app.closeApp();
  });

  it("an LRU page-out carries reason 'evicted' too", async () => {
    const { app, events } = await rig({ sessions: { maxActive: 1 } });
    await app.createSession({ sessionId: "s-lru-1" });
    await app.createSession({ sessionId: "s-lru-2" });
    await settle();

    expect(app.getSession("s-lru-1")).toBeUndefined();
    const ops = opsNamed(events, CLOSE_OP).filter((e) => e.scope.sessionId === "s-lru-1");
    expect(ops.find((e) => e.phase === "requested")?.payload).toEqual({ reason: "evicted" });

    await app.closeApp();
  });
});
