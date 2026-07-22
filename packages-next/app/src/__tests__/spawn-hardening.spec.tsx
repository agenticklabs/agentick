/**
 * Spawn hardening — SP4 / SP5 / SP6 (v1→v2 parity recovery pass #3).
 *
 *   - SP4 — `sessions.maxSpawnDepth` bounds recursive spawn; a session at the
 *     ceiling throws `SpawnDepthExceededError` (fail-closed). Default 10 (v1
 *     `MAX_SPAWN_DEPTH`).
 *   - SP5 — a spawned child's `spawnPath` (ancestor lineage, root-first) is
 *     stamped on its `SessionRecord`, its loop execution/tick `EventScope`,
 *     and its per-execution handle stream, so sub-agent work is attributable.
 *   - SP6 — a parent close / abort cascades to its spawned children: the child
 *     is disposed from the live registry (no leak) and its in-flight work is
 *     torn down through the parent's construction signal (PA1 plumbing).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  ContentBlock,
  ExecutionTarget,
  SessionExecutionHandle,
  SessionHarnessProtocol,
} from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function MinimalAgent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section" as never,
      { id: "system", audience: "model" },
      "You are a helpful agent.",
    ),
    React.createElement("tool" as never, {
      id: "t.calculator",
      name: "calculator",
      description: "Evaluate arithmetic",
      inputSchema: {
        type: "object",
        required: ["expression"],
        properties: { expression: { type: "string" } },
      },
      exposure: ["model"],
      handlerRef: "handlers/calculator",
    }),
    React.createElement("message" as never, { role: "user" }, "47 * 23"),
  );
}

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

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

const calcScript = [
  {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "tool_use" as const, toolUseId: "tc-1", name: "calculator", input: {} }],
      stopReason: "tool_use" as const,
      toolCalls: [{ id: "tc-1", name: "calculator", input: { expression: "47 * 23" } }],
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    },
  },
  {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "text" as const, text: "47 × 23 = 1081." }],
      stopReason: "end" as const,
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    },
  },
];

const gateScript = [
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

const calcHandlers = new Map<string, (input: unknown) => Promise<ContentBlock[]>>([
  ["handlers/calculator", async () => [{ type: "text", text: "1081" }]],
]);

/** Build a standalone app (its own substrate) rooted on `MinimalAgent`. */
async function mkApp(
  opts: { maxSpawnDepth?: number; signal?: AbortSignal; shareSubstrate?: boolean } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("spawn-exec", journal, bus, inbox, {
    scripted: calcScript,
  });
  await executor.ready;
  return createApp(React.createElement(MinimalAgent), {
    modelExecutor: executor,
    target: mkTarget(),
    toolHandlers: calcHandlers,
    ...(opts.shareSubstrate ? { journal, bus, inbox } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.maxSpawnDepth !== undefined
      ? { sessions: { maxSpawnDepth: opts.maxSpawnDepth } }
      : {}),
  });
}

/** Narrow the spawn() union: no `send` supplied → a `SessionHarnessProtocol`. */
function asSession(x: SessionExecutionHandle | SessionHarnessProtocol): SessionHarnessProtocol {
  return x as SessionHarnessProtocol;
}
/** Narrow the spawn() union: `send` supplied → a `SessionExecutionHandle`. */
function asHandle(x: SessionExecutionHandle | SessionHarnessProtocol): SessionExecutionHandle {
  return x as SessionExecutionHandle;
}

// ---------------------------------------------------------------------------
// SP4 — spawn depth bound
// ---------------------------------------------------------------------------

describe("SP4 — spawn depth ceiling", () => {
  it("throws SpawnDepthExceededError once the lineage is at the configured ceiling", async () => {
    const app = await mkApp({ maxSpawnDepth: 2 });
    const root = asSession(await app.createSession({ sessionId: "root" })); // depth 0
    const child = asSession(
      await root.spawn({ agent: React.createElement(MinimalAgent), sessionId: "c1" }),
    ); // depth 1
    const grandchild = asSession(
      await child.spawn({ agent: React.createElement(MinimalAgent), sessionId: "c2" }),
    ); // depth 2 — at the ceiling

    await expect(
      grandchild.spawn({ agent: React.createElement(MinimalAgent), sessionId: "c3" }),
    ).rejects.toMatchObject({ _tag: "SpawnDepthExceededError", depth: 2, maxDepth: 2 });

    // The refused child was never constructed / registered.
    expect(app.getSession("c3")).toBeUndefined();
    await app.closeApp();
  });

  it("defaults the ceiling to 10 (v1 MAX_SPAWN_DEPTH parity)", async () => {
    const app = await mkApp(); // no maxSpawnDepth → default 10
    // Chain 10 spawns (depths 1..10) — all succeed.
    let node = asSession(await app.createSession({ sessionId: "d0" }));
    for (let depth = 1; depth <= 10; depth++) {
      node = asSession(
        await node.spawn({ agent: React.createElement(MinimalAgent), sessionId: `d${depth}` }),
      );
    }
    // The depth-10 session is AT the default ceiling → its spawn fails typed.
    await expect(
      node.spawn({ agent: React.createElement(MinimalAgent), sessionId: "d11" }),
    ).rejects.toMatchObject({ _tag: "SpawnDepthExceededError", depth: 10, maxDepth: 10 });
    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// SP5 — spawnPath lineage
// ---------------------------------------------------------------------------

describe("SP5 — spawnPath lineage", () => {
  it("stamps the ancestor chain on the child's SessionRecord (and leaves root bare)", async () => {
    const app = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    const child = asSession(
      await root.spawn({ agent: React.createElement(MinimalAgent), sessionId: "child" }),
    );
    await child.spawn({ agent: React.createElement(MinimalAgent), sessionId: "grand" });

    // Root is not spawned — no lineage.
    expect((await app.getSessionRecord("root"))?.spawnPath).toBeUndefined();

    // Direct child: lineage is [root]; length 1 == depth.
    const childRec = await app.getSessionRecord("child");
    expect(childRec?.parentSessionId).toBe("root");
    expect(childRec?.spawnPath).toEqual(["root"]);

    // Grandchild: full ancestry [root, child]; parent edge still just its parent.
    const grandRec = await app.getSessionRecord("grand");
    expect(grandRec?.parentSessionId).toBe("child");
    expect(grandRec?.spawnPath).toEqual(["root", "child"]);
    await app.closeApp();
  });

  it("stamps spawnPath on the child's loop EventScope (bus attribution)", async () => {
    const app = await mkApp({ shareSubstrate: true });
    const root = asSession(await app.createSession({ sessionId: "root" }));

    const loopEvents: Array<{ scope?: { spawnPath?: readonly string[] } }> = [];
    const iter = app.events({ surface: "loop" });
    const collect = (async () => {
      for await (const ev of iter) {
        loopEvents.push(ev as never);
        if (loopEvents.length >= 6) break;
      }
    })();
    // Let the scoped subscription register before work begins.
    await new Promise((r) => setTimeout(r, 50));

    const handle = asHandle(
      await root.spawn({
        agent: React.createElement(MinimalAgent),
        sessionId: "child",
        send: { messages: [{ role: "user", content: "go" }] },
      }),
    );
    await handle.result;
    await collect;

    const stamped = loopEvents.find((e) => Array.isArray(e.scope?.spawnPath));
    expect(stamped?.scope?.spawnPath).toEqual(["root"]);
    await app.closeApp();
  });

  it("stamps spawnPath on the child's handle stream events", async () => {
    const app = await mkApp();
    const root = asSession(await app.createSession({ sessionId: "root" }));
    const handle = asHandle(
      await root.spawn({
        agent: React.createElement(MinimalAgent),
        sessionId: "child",
        send: { messages: [{ role: "user", content: "go" }] },
      }),
    );

    const withPath: Array<readonly string[]> = [];
    for await (const ev of handle.events()) {
      if (Array.isArray(ev.spawnPath)) withPath.push(ev.spawnPath);
    }
    await handle.result;

    expect(withPath.length).toBeGreaterThan(0);
    expect(withPath.every((p) => p.length === 1 && p[0] === "root")).toBe(true);
    await app.closeApp();
  });
});

// ---------------------------------------------------------------------------
// SP6 — parent teardown → child disposal
// ---------------------------------------------------------------------------

describe("SP6 — parent teardown cascades to children", () => {
  it("parent close disposes its spawned children (no registry leak)", async () => {
    const app = await mkApp();
    const parent = asSession(await app.createSession({ sessionId: "parent" }));
    await parent.spawn({ agent: React.createElement(MinimalAgent), sessionId: "child" });

    expect(app.getSession("child")).toBeDefined();

    await parent.close();

    // Child is gone from the LIVE registry (disposeSession removed it).
    expect(app.getSession("child")).toBeUndefined();
    // Its durable record survives on a terminal status (close, not evict).
    expect((await app.getSessionRecord("child"))?.status).toBe("closed");
    await app.closeApp();
  });

  it("parent abort mid-child-execution tears the child down (no leak)", async () => {
    const controller = new AbortController();
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("spawn-abort-exec", journal, bus, inbox, {
      scripted: gateScript,
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

    // App default agent is irrelevant — the parent never sends; the CHILD runs
    // the gated flow via the per-spawn `agent`.
    const app = await createApp(React.createElement(GatedAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      toolHandlers,
      journal,
      bus,
      inbox,
      signal: controller.signal,
    });

    const parent = asSession(await app.createSession({ sessionId: "parent" }));
    const handle = asHandle(
      await parent.spawn({
        agent: React.createElement(GatedAgent),
        sessionId: "child",
        send: { messages: [{ role: "user", content: "go" }] },
      }),
    );
    await started; // child execution is mid-flight, blocked in the gate tool
    expect(app.getSession("child")).toBeDefined();

    // Fire the app signal (the parent's construction signal, fanned into the
    // child). The child's in-flight work tears down (PA1 merge) AND the
    // parent's abort listener disposes the child from the registry.
    controller.abort();
    release();

    const result = await handle.result;
    expect(result.stopReason).toBe("aborted");
    expect(result.response).not.toContain("GATED-DONE"); // final tick never ran

    // SP6 — the child is gone from the live registry (parent-abort cascade).
    await waitFor(() => app.getSession("child") === undefined, {
      description: "child disposed after parent abort",
    });
    await app.closeApp();
  });
});
