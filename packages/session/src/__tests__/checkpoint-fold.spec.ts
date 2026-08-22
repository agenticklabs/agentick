/**
 * Phase 1 of the checkpointing model (docs/proposals/v2/checkpointing.md §3.2):
 * `session:snapshot` fans out `CheckpointCapable.persist` before composing the
 * legacy blob, `session:restore` fans out `hydrate`, and `SnapshotCapable`-only
 * bridges keep their blob round-trip while the two contracts coexist.
 *
 * GENESIS runs the same `hydrate` fan-out at construction (checkpointing §4 —
 * build-then-hydrate IS resume), so a fresh session has already hydrated once
 * before any of these verbs is called.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import type {
  CheckpointCapable,
  ExecutionTarget,
  HydrateCtx,
  PersistCtx,
  SnapshotCapable,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

/** A harness that owns its own store — the Phase-2 shape, faked. */
class FakeCheckpointBridge implements CheckpointCapable {
  readonly persisted: PersistCtx[] = [];
  readonly hydrated: HydrateCtx[] = [];
  persistError: Error | undefined;
  hydrateError: Error | undefined;

  constructor(
    private readonly label: string,
    private readonly log: string[] = [],
  ) {}

  async persist(ctx: PersistCtx): Promise<void> {
    await Promise.resolve();
    if (this.persistError) throw this.persistError;
    this.persisted.push(ctx);
    this.log.push(`persist:${this.label}`);
  }

  async hydrate(ctx: HydrateCtx): Promise<void> {
    await Promise.resolve();
    if (this.hydrateError) throw this.hydrateError;
    this.hydrated.push(ctx);
    this.log.push(`hydrate:${this.label}`);
  }
}

/** A migrated harness that still duck-types the legacy contract. */
class FakeMigratedBridge extends FakeCheckpointBridge implements SnapshotCapable<{ v: number }> {
  imports = 0;
  exportSnapshot(): { v: number } {
    return { v: 1 };
  }
  importSnapshot(_snapshot: { v: number }): void {
    this.imports += 1;
  }
}

/** The unmigrated shape — blob in, blob out. */
class FakeCounterBridge implements SnapshotCapable<{ count: number }> {
  count = 0;
  exportSnapshot(): { count: number } {
    return { count: this.count };
  }
  importSnapshot(snapshot: { count: number }): void {
    this.count = snapshot.count;
  }
}

async function mkSession(id: string, ext?: ReadonlyMap<string, unknown>) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`c-${id}`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`l-${id}`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`e-${id}`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`t-${id}`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`x-${id}`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: id,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...(ext ? { extensionBridges: ext } : {}),
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

describe("SessionHarness — CheckpointCapable fold (checkpointing phase 1)", () => {
  it("snapshot() awaits persist on every CheckpointCapable bridge, in bag order", async () => {
    const log: string[] = [];
    const first = new FakeCheckpointBridge("first", log);
    const second = new FakeCheckpointBridge("second", log);
    const { session, tools } = await mkSession(
      "cp-order",
      new Map<string, unknown>([
        ["first", first],
        ["second", second],
      ]),
    );

    // Genesis already fanned `hydrate` out over both, in the same bag order.
    expect(log).toEqual(["hydrate:first", "hydrate:second"]);
    log.length = 0;

    await session.snapshot();

    expect(log).toEqual(["persist:first", "persist:second"]);
    await session.close();
    await tools.close();
  });

  it("a CheckpointCapable bridge is excluded from the legacy bridges blob even when it exports a snapshot", async () => {
    const migrated = new FakeMigratedBridge("migrated");
    const { session, tools } = await mkSession(
      "cp-exclude",
      new Map<string, unknown>([["migrated", migrated]]),
    );

    const snap = await session.snapshot();

    expect(migrated.persisted).toHaveLength(1);
    expect(snap.bridges).not.toHaveProperty("migrated");
    await session.close();
    await tools.close();
  });

  it("a SnapshotCapable-only bridge still round-trips through the blob", async () => {
    const src = new FakeCounterBridge();
    src.count = 7;
    const { session: source, tools: t1 } = await mkSession(
      "cp-legacy-src",
      new Map<string, unknown>([["counter", src]]),
    );
    const snap = await source.snapshot();
    expect(snap.bridges.counter).toEqual({ count: 7 });
    await source.close();
    await t1.close();

    const dest = new FakeCounterBridge();
    const { session: destination, tools: t2 } = await mkSession(
      "cp-legacy-dest",
      new Map<string, unknown>([["counter", dest]]),
    );
    await destination.restore({ snapshot: { ...snap, id: "cp-legacy-dest" } });

    expect(dest.count).toBe(7);
    await destination.close();
    await t2.close();
  });

  it("restore() hydrates CheckpointCapable bridges and never calls their importSnapshot", async () => {
    const migrated = new FakeMigratedBridge("migrated");
    const { session, tools } = await mkSession(
      "cp-hydrate",
      new Map<string, unknown>([["migrated", migrated]]),
    );
    const snap = await session.snapshot();
    expect(migrated.hydrated).toHaveLength(1); // genesis

    await session.restore({
      snapshot: { ...snap, bridges: { ...snap.bridges, migrated: { v: 99 } } },
    });

    expect(migrated.hydrated).toHaveLength(2);
    expect(migrated.imports).toBe(0);
    await session.close();
    await tools.close();
  });

  it("a rejected persist propagates out of snapshot() and leaves the session usable", async () => {
    const bridge = new FakeCheckpointBridge("flaky");
    bridge.persistError = new Error("flush failed");
    const { session, tools } = await mkSession(
      "cp-persist-fail",
      new Map<string, unknown>([["flaky", bridge]]),
    );

    await expect(session.snapshot()).rejects.toThrow(/flush failed/);
    expect(session.status).toBe("idle");

    bridge.persistError = undefined;
    await expect(session.snapshot()).resolves.toBeDefined();
    await session.close();
    await tools.close();
  });

  it("a rejected hydrate propagates out of restore()", async () => {
    const bridge = new FakeCheckpointBridge("flaky");
    const { session, tools } = await mkSession(
      "cp-hydrate-fail",
      new Map<string, unknown>([["flaky", bridge]]),
    );
    const snap = await session.snapshot();
    bridge.hydrateError = new Error("load failed");

    await expect(session.restore({ snapshot: snap })).rejects.toThrow(/load failed/);
    await session.close();
    await tools.close();
  });

  it("PersistCtx carries the session id and the current tick", async () => {
    const bridge = new FakeCheckpointBridge("ctx");
    const { session, tools } = await mkSession(
      "cp-ctx",
      new Map<string, unknown>([["ctx", bridge]]),
    );
    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    const snap = await session.snapshot();

    expect(bridge.persisted[0]?.sessionId).toBe("cp-ctx");
    expect(bridge.persisted[0]?.tick).toBe(snap.currentTick);
    expect(snap.currentTick).toBeGreaterThan(0);
    await session.close();
    await tools.close();
  });
});
