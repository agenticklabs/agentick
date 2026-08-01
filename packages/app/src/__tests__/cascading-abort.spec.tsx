/**
 * CASCADING ABORT — the two scopes, and the ladder they sit on.
 *
 * `abort()` has always meant "stop the current execution of THIS session". Two
 * things were unreachable from there: the sub-agents a session spawned (they
 * only ever felt the CONSTRUCTION signal, which abort never touches), and the
 * sub-agents ONE execution spawned. This file pins both, and pins what each of
 * them deliberately does NOT do:
 *
 *   1. `abort()` — unchanged. A child spawned outside the aborted execution
 *      keeps running.
 *   2. `abort({ cascade: true })` — the live spawn subtree stops, deepest-first,
 *      and the session is still there and still usable afterwards. Detached
 *      tasks survive it; `destroySession` on the same setup reaps them, so two
 *      rungs of the ladder are pinned against each other in one test.
 *   3. The EXECUTION scope: a child spawned DURING an execution inherits that
 *      execution's teardown signal, so a plain `abort()` of the parent turn
 *      tears it down — no cascade asked for, because the child belongs to the
 *      turn, not to the session.
 *   4. `originExecutionId` — the durable edge stamped at spawn, which is what
 *      still identifies a turn's fan-out after the turn SUCCEEDED (the live
 *      signal in (3) fires only on cancellation).
 *   5. `app.abortExecutionTree(executionId)` — that edge walked: one settled
 *      execution's descendants stop, a sibling execution's do not.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type {
  ExecutionTarget,
  LanguageModelExecutor,
  SessionExecutionHandle,
  SessionHarnessProtocol,
  ToolHandler,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two tools: one that parks until aborted, one that spawns a sub-agent. */
function Agent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("section" as never, { id: "system", audience: "model" }, "Be helpful."),
    React.createElement("tool" as never, {
      id: "t.gate",
      name: "gate",
      description: "Blocks until the dispatch is aborted",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      exposure: ["model"],
      handlerRef: "handlers/gate",
    }),
    React.createElement("tool" as never, {
      id: "t.spawn",
      name: "spawn_child",
      description: "Spawns a sub-agent and returns without waiting for it",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      exposure: ["model"],
      handlerRef: "handlers/spawn",
    }),
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

const usage = { inputTokens: 8, outputTokens: 4, totalTokens: 12 };

/**
 * One tick calling `tool`. The call id is a PARAMETER, not a constant: two
 * executions of one session that reuse a tool-call id are the same call as far
 * as the executor is concerned, and the second never reaches the handler.
 */
function callTick(tool: string, callId: string) {
  return {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "tool_use" as const, toolUseId: callId, name: tool, input: {} }],
      stopReason: "tool_use" as const,
      toolCalls: [{ id: callId, name: tool, input: {} }],
      usage,
    },
  };
}

function endTick(text: string) {
  return {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "text" as const, text }],
      stopReason: "end" as const,
      usage,
    },
  };
}

/** Parks in `gate` forever — the fake clamps on its last entry, so every tick repeats it. */
const holdScript = (callId: string) => [callTick("gate", callId)];
/** Spawns a sub-agent, then ENDS — the turn succeeds and its child outlives it. */
const spawnThenEndScript = (callId: string) => [
  callTick("spawn_child", callId),
  endTick("TURN-DONE"),
];
/** Spawns a sub-agent, then parks — the turn is still RUNNING with a live child. */
const spawnThenHoldScript = (callId: string) => [
  callTick("spawn_child", callId),
  callTick("gate", `${callId}-gate`),
];

/**
 * A fresh scripted executor. One per SEND that needs its own script: the fake's
 * cursor is per-instance and advances on every tick from any session, so a
 * shared one would make "which session got which tick" an accident of
 * interleaving.
 */
async function mkExec(name: string, scripted: unknown): Promise<LanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    name,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted: scripted as never },
  );
  await exec.ready;
  return exec as unknown as LanguageModelExecutor;
}

/** Narrow the spawn() union: no `send` supplied → a `SessionHarnessProtocol`. */
function asSession(x: SessionExecutionHandle | SessionHarnessProtocol): SessionHarnessProtocol {
  return x as SessionHarnessProtocol;
}

interface Fixture {
  /** Session ids whose `gate` dispatch was released — in release order. */
  readonly releases: string[];
  /** Session ids that entered `gate`. */
  readonly entered: string[];
}

/**
 * An app whose `gate` tool parks until its dispatch signal aborts (so a session
 * is provably in-flight right up to the abort) and whose `spawn_child` tool
 * spawns a parked sub-agent and returns WITHOUT awaiting it (so the spawning
 * turn can settle while its child keeps running).
 */
async function mkApp() {
  const fixture: Fixture = { releases: [], entered: [] };
  let appRef: Awaited<ReturnType<typeof createApp>> | undefined;
  let childSeq = 0;

  const toolHandlers = new Map<string, ToolHandler>([
    [
      "handlers/gate",
      async (_input, { ctx }) => {
        fixture.entered.push(ctx.sessionId ?? "?");
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        fixture.releases.push(ctx.sessionId ?? "?");
        return [{ type: "text", text: "gate released" }];
      },
    ],
    [
      "handlers/spawn",
      async (_input, { ctx }) => {
        const parent = appRef!.getSession(ctx.sessionId!)!;
        const childId = `kid${++childSeq}`;
        await parent.spawn({
          agent: React.createElement(Agent),
          sessionId: childId,
          originCallId: ctx.toolCallId,
          send: {
            messages: [{ role: "user", content: "work" }],
            modelExecutor: await mkExec(`hold-${childId}`, holdScript(`tc-${childId}-gate`)),
          },
        });
        return [{ type: "text", text: `spawned ${childId}` }];
      },
    ],
  ]);

  const app = await createApp(React.createElement(Agent), {
    modelExecutor: await mkExec("cascade-default", holdScript("tc-default-gate")),
    target: mkTarget(),
    toolHandlers,
  });
  appRef = app;

  /**
   * Tear down through `destroySession`, which aborts before it disposes:
   * `closeApp` alone awaits the quiescence of each session, and one parked in
   * `gate` forever never gets there.
   */
  const cleanup = async (...rootIds: string[]) => {
    for (const id of rootIds) await app.destroySession(id, { reason: "test cleanup" });
    await app.closeApp();
  };
  return { app, fixture, cleanup };
}

/** A send that parks in `gate`, on its own script cursor. */
async function sendParked(
  session: SessionHarnessProtocol,
  name: string,
): Promise<SessionExecutionHandle> {
  const handle = await session.send({
    messages: [{ role: "user", content: "go" }],
    modelExecutor: await mkExec(`hold-${name}`, holdScript(`tc-${name}-gate`)),
  });
  // Tests that only assert this stays pending never consume it.
  handle.result.catch(() => undefined);
  return handle;
}

// ---------------------------------------------------------------------------
// 1 + 2 — the session scope
// ---------------------------------------------------------------------------

describe("session.abort — the cascade option", () => {
  it("leaves a spawned child running without cascade (the default is unchanged)", async () => {
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    // Spawned while the root is IDLE — no origin execution, so nothing but an
    // explicit cascade can reach it.
    const child = asSession(
      await root.spawn({ agent: React.createElement(Agent), sessionId: "child" }),
    );
    const childHandle = await sendParked(child, "child");
    const rootHandle = await sendParked(root, "root");
    await waitFor(() => fixture.entered.length === 2, { description: "both parked" });

    await root.abort("stop the root");

    expect((await rootHandle.result).stopReason).toBe("aborted");
    // The child is untouched: still parked, still in-flight, never released.
    expect(fixture.releases).toEqual(["root"]);
    const raced = await Promise.race([
      childHandle.result.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 25)),
    ]);
    expect(raced).toBe("pending");
    expect(app.getSession("child")).toBeDefined();

    await cleanup("root");
  });

  it("aborts the live subtree deepest-first, and the session is usable afterwards", async () => {
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    const child = asSession(
      await root.spawn({ agent: React.createElement(Agent), sessionId: "child" }),
    );
    const grand = asSession(
      await child.spawn({ agent: React.createElement(Agent), sessionId: "grand" }),
    );
    const grandHandle = await sendParked(grand, "grand");
    const childHandle = await sendParked(child, "child");
    const rootHandle = await sendParked(root, "root");
    await waitFor(() => fixture.entered.length === 3, { description: "three parked" });

    await root.abort("stop the tree", { cascade: true });

    expect((await grandHandle.result).stopReason).toBe("aborted");
    expect((await childHandle.result).stopReason).toBe("aborted");
    expect((await rootHandle.result).stopReason).toBe("aborted");
    // Deepest-first: a child stops before the parent waiting on it unwinds.
    expect(fixture.releases).toEqual(["grand", "child", "root"]);

    // Abort is NOT destroy: nothing was disposed, nothing was deleted.
    expect(app.getSession("root")).toBeDefined();
    expect(app.getSession("child")).toBeDefined();
    expect(app.getSession("grand")).toBeDefined();
    expect((await app.getSessionRecord("grand"))?.id).toBe("grand");

    // …and the session takes work again immediately — the cascade cancelled an
    // execution, it did not refuse the next one.
    const again = await root.send({
      messages: [{ role: "user", content: "again" }],
      modelExecutor: await mkExec("root-again", [endTick("BACK-TO-WORK")]),
    });
    expect((await again.result).response).toContain("BACK-TO-WORK");

    await cleanup("root");
  });

  it("does not cancel detached tasks — destroy is the rung that does", async () => {
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    const task = root.tasks.submit(() => new Promise<string>(() => {}), { detached: true });
    // Pre-attached so the eventual cancellation is never an unhandled rejection.
    const outcome = task.result.then(
      () => "resolved",
      (e: { status?: string }) => e.status,
    );
    const rootHandle = await sendParked(root, "root");
    await waitFor(() => fixture.entered.length === 1, { description: "root parked" });

    await root.abort("stop", { cascade: true });
    expect((await rootHandle.result).stopReason).toBe("aborted");

    // Abort is weaker than close, which is weaker than destroy: the detached
    // task outlives the whole first rung.
    expect(root.tasks.status(task.taskId)).toBe("working");

    const destroyed = await app.destroySession("root");
    expect(destroyed.live.cancelledDetachedTasks).toBe(1);
    expect(await outcome).toBe("cancelled");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 — the execution scope
// ---------------------------------------------------------------------------

describe("execution-scoped cascade", () => {
  it("tears down a child spawned DURING the execution when that execution aborts", async () => {
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    // Tick 1 spawns `kid1`; tick 2 parks. Both the turn and its child are live.
    const rootHandle = await root.send({
      messages: [{ role: "user", content: "go" }],
      modelExecutor: await mkExec("root-spawn-hold", spawnThenHoldScript("tc-a")),
    });
    await waitFor(() => fixture.entered.includes("kid1") && fixture.entered.includes("root"), {
      description: "turn + child parked",
    });

    // NO cascade. The child still stops, because it belongs to the TURN: the
    // spawn inherited this execution's teardown signal.
    await rootHandle.abort("stop the turn");

    expect((await rootHandle.result).stopReason).toBe("aborted");
    await waitFor(() => fixture.releases.includes("kid1"), { description: "child released" });
    expect(app.getSession("kid1")?.id).toBe("kid1"); // cancelled, not disposed

    await cleanup("root");
  });

  it("stamps originExecutionId / originCallId, and a SUCCEEDED turn leaves its child running", async () => {
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    const rootHandle = await root.send({
      messages: [{ role: "user", content: "go" }],
      modelExecutor: await mkExec("root-spawn-end", spawnThenEndScript("tc-a")),
    });
    expect((await rootHandle.result).response).toContain("TURN-DONE");

    const record = await app.getSessionRecord("kid1");
    expect(record?.parentSessionId).toBe("root");
    expect(record?.originExecutionId).toBe(rootHandle.executionId);
    expect(record?.originCallId).toBe("tc-a");

    // The turn ended WELL, so its sub-agent keeps working — which is exactly
    // the case `abortExecutionTree` exists for.
    await waitFor(() => fixture.entered.includes("kid1"), { description: "child parked" });
    expect(fixture.releases).toEqual([]);

    await cleanup("root");
  });
});

// ---------------------------------------------------------------------------
// 5 — abortExecutionTree
// ---------------------------------------------------------------------------

describe("app.abortExecutionTree", () => {
  it("cancels one settled turn's fan-out, transitively, and leaves a sibling turn's alone", async () => {
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));

    // Turn A — spawns `kid1`, then ends.
    const turnA = await root.send({
      messages: [{ role: "user", content: "A" }],
      modelExecutor: await mkExec("turn-a", spawnThenEndScript("tc-a")),
    });
    await turnA.result;
    // Turn B — spawns `kid2`, then ends. Its fan-out is not A's business.
    const turnB = await root.send({
      messages: [{ role: "user", content: "B" }],
      modelExecutor: await mkExec("turn-b", spawnThenEndScript("tc-b")),
    });
    await turnB.result;
    await waitFor(() => fixture.entered.includes("kid1") && fixture.entered.includes("kid2"), {
      description: "both kids parked",
    });

    // A grandchild under kid1, host-spawned: its OWN origin execution is kid1's,
    // not turn A's. It is in the tree by LINEAGE — once a branch belongs to the
    // cancelled turn, everything under it does.
    const grand = asSession(
      await app
        .getSession("kid1")!
        .spawn({ agent: React.createElement(Agent), sessionId: "grand" }),
    );
    const grandHandle = await sendParked(grand, "grand");
    await waitFor(() => fixture.entered.includes("grand"), { description: "grandchild parked" });

    const result = await app.abortExecutionTree(turnA.executionId, { reason: "branch cancelled" });

    // Deepest-first, and scoped to turn A: kid2 is untouched.
    expect(result.executionId).toBe(turnA.executionId);
    expect(result.sessionIds).toEqual(["grand", "kid1"]);
    expect(result.originAborted).toBe(false);
    expect((await grandHandle.result).stopReason).toBe("aborted");
    await waitFor(() => fixture.releases.includes("kid1"), { description: "kid1 released" });
    expect(fixture.releases).toEqual(["grand", "kid1"]);

    // Nothing was disposed — abort strength only.
    expect(app.getSession("kid1")).toBeDefined();
    expect(app.getSession("kid2")).toBeDefined();

    await cleanup("root");
  });

  it("is quiet for an execution with no live fan-out", async () => {
    const { app, cleanup } = await mkApp();
    await app.createSession({ sessionId: "root" });

    expect(await app.abortExecutionTree("exec:never-ran")).toEqual({
      executionId: "exec:never-ran",
      sessionIds: [],
      originAborted: false,
    });

    await cleanup("root");
  });
});

// ---------------------------------------------------------------------------
// 6 — executionTreeContains: the same membership, read bottom-up
// ---------------------------------------------------------------------------

describe("app.executionTreeContains", () => {
  it("answers the same membership abortExecutionTree fans out over", async () => {
    // The identical tree the fan-out test builds: turn A → kid1 → grand, turn
    // B → kid2, both turns on `root`. A subscriber filtering a live event
    // stream asks this per event, so every answer below is one a progress fan
    // depends on frame by frame.
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));

    const turnA = await root.send({
      messages: [{ role: "user", content: "A" }],
      modelExecutor: await mkExec("turn-a", spawnThenEndScript("tc-a")),
    });
    await turnA.result;
    const turnB = await root.send({
      messages: [{ role: "user", content: "B" }],
      modelExecutor: await mkExec("turn-b", spawnThenEndScript("tc-b")),
    });
    await turnB.result;
    await waitFor(() => fixture.entered.includes("kid1") && fixture.entered.includes("kid2"), {
      description: "both kids parked",
    });
    await app.getSession("kid1")!.spawn({ agent: React.createElement(Agent), sessionId: "grand" });

    // In: the turn's own child, and everything under it — `grand`'s own origin
    // is kid1's spawn, not turn A, so only the LINEAGE walk finds it.
    expect(app.executionTreeContains(turnA.executionId, "kid1")).toBe(true);
    expect(app.executionTreeContains(turnA.executionId, "grand")).toBe(true);

    // Out, and this is the isolation guarantee: a sibling turn's fan-out, on
    // the SAME session, is a different tree.
    expect(app.executionTreeContains(turnA.executionId, "kid2")).toBe(false);
    expect(app.executionTreeContains(turnB.executionId, "kid1")).toBe(false);
    expect(app.executionTreeContains(turnB.executionId, "kid2")).toBe(true);

    // Out: the ORIGIN session itself. It is not in its own turn's spawn tree —
    // deliberately, because the caller already matches its own work by
    // execution id and a session that has moved on to turn B must not be
    // dragged in by an id naming turn A.
    expect(app.executionTreeContains(turnA.executionId, "root")).toBe(false);

    // Quiet on both unknowns, the same way the fan-out walk is.
    expect(app.executionTreeContains(turnA.executionId, "no-such-session")).toBe(false);
    expect(app.executionTreeContains("exec:never-ran", "kid1")).toBe(false);

    await cleanup("root");
  });
});

// ---------------------------------------------------------------------------
// 7 — sessionTreeContains / sessionTree: the OTHER membership question
// ---------------------------------------------------------------------------

describe("app.sessionTreeContains + app.sessionTree", () => {
  it("keys on lineage, not on a turn — and the ROOT is a member of its own tree", async () => {
    // The same tree as above, asked the question a SUBSCRIPTION asks. A
    // subscription outlives any one turn, so which turn spawned a descendant is
    // not a distinction it can make use of: both kids are in.
    const { app, fixture, cleanup } = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));

    const turnA = await root.send({
      messages: [{ role: "user", content: "A" }],
      modelExecutor: await mkExec("turn-a", spawnThenEndScript("tc-a")),
    });
    await turnA.result;
    const turnB = await root.send({
      messages: [{ role: "user", content: "B" }],
      modelExecutor: await mkExec("turn-b", spawnThenEndScript("tc-b")),
    });
    await turnB.result;
    await waitFor(() => fixture.entered.includes("kid1") && fixture.entered.includes("kid2"), {
      description: "both kids parked",
    });
    await app.getSession("kid1")!.spawn({ agent: React.createElement(Agent), sessionId: "grand" });

    // The asymmetry with `executionTreeContains`, stated as a pair: an
    // execution id names a turn a session moves PAST (so the origin session is
    // out of its own turn's tree), a session id names the session itself (so
    // the root is in).
    expect(app.sessionTreeContains("root", "root")).toBe(true);
    expect(app.executionTreeContains(turnA.executionId, "root")).toBe(false);

    // Lineage, at any depth, from any turn.
    expect(app.sessionTreeContains("root", "kid1")).toBe(true);
    expect(app.sessionTreeContains("root", "kid2")).toBe(true);
    expect(app.sessionTreeContains("root", "grand")).toBe(true);
    // …and read from an intermediate node, which is a smaller tree.
    expect(app.sessionTreeContains("kid1", "grand")).toBe(true);
    expect(app.sessionTreeContains("kid2", "grand")).toBe(false);
    // Never upward: a parent is not in its child's tree.
    expect(app.sessionTreeContains("kid1", "root")).toBe(false);

    // Quiet on unknowns, both ends, like every other registry walk.
    expect(app.sessionTreeContains("root", "no-such-session")).toBe(false);
    expect(app.sessionTreeContains("no-such-root", "kid1")).toBe(false);

    // The enumeration half — root FIRST, then breadth-first, which is the order
    // a snapshot splice needs (a late joiner paints the root's board first).
    expect(app.sessionTree("root")).toEqual(["root", "kid1", "kid2", "grand"]);
    expect(app.sessionTree("kid1")).toEqual(["kid1", "grand"]);
    expect(app.sessionTree("no-such-root")).toEqual([]);

    await cleanup("root");
  });
});
