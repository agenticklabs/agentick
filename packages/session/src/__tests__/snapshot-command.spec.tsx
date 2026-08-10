/**
 * Recovery pass #1 — the persist/restore cluster (PA4–PA7 + RUN4/RUN5).
 *
 * `session.snapshot()` and `session.restore()` are COMMANDS (ADR 80/83), so
 * the persist/restore hook quartet falls out of the CommandRegistry
 * derivation:
 *
 *   - `onBeforeSessionSnapshot` (veto) + `onAfterSessionSnapshot`
 *     (augment/redact the output — the v1 `onPersist` parity).
 *   - `onBeforeSessionRestore` + `onAfterSessionRestore` (the v1 `onRestore`
 *     parity; migration runs at the version-check decision point).
 *
 * Plus:
 *   - Step 6 (ADR 27) — `snapshot()` folds EVERY `SnapshotCapable` bridge
 *     generically; a fake extension bridge round-trips with ZERO session
 *     changes (feature-detection).
 *   - The migration seam — `migrateSnapshot` runs on `specVersion` skew;
 *     `SnapshotVersionMismatch` throws (fail-closed) when none is supplied.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, deriveHookNames } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { SPEC_VERSION } from "@agentick/spec";
import type {
  ExecutionTarget,
  SessionSnapshot,
  SnapshotCapable,
  SnapshotMigration,
} from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const replyExec = (text: string) =>
  new FakeLanguageModelExecutor(
    `exec-${Math.random()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );

/**
 * A minimal working `SnapshotCapable` extension bridge (a Meszaros FAKE).
 * Not a built-in — passed via `extensionBridges` so the session has NO
 * hardcoded knowledge of it. Proves the Step-6 generic fold picks it up on
 * snapshot AND restores it via `importSnapshot` on restore.
 */
class FakeCounterBridge implements SnapshotCapable<{ count: number }> {
  count = 0;
  exportSnapshot(): { count: number } {
    return { count: this.count };
  }
  importSnapshot(snap: { count: number }): void {
    this.count = snap.count;
  }
}

interface MkOpts {
  readonly migrateSnapshot?: SnapshotMigration;
  readonly ext?: FakeCounterBridge;
}

async function mkSession(id: string, opts: MkOpts = {}) {
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
  const executor = replyExec("ok");
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: id,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    ...(opts.migrateSnapshot ? { migrateSnapshot: opts.migrateSnapshot } : {}),
    ...(opts.ext ? { extensionBridges: new Map<string, unknown>([["counter", opts.ext]]) } : {}),
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

describe("SessionHarness — snapshot/restore commands (recovery pass #1)", () => {
  it("deriveHookNames agrees for session:command:snapshot + restore", () => {
    expect(deriveHookNames("session:command:snapshot")).toEqual([
      "onBeforeSessionSnapshot",
      "onAfterSessionSnapshot",
    ]);
    expect(deriveHookNames("session:command:restore")).toEqual([
      "onBeforeSessionRestore",
      "onAfterSessionRestore",
    ]);
  });

  it("onBefore/AfterSessionSnapshot fire; the after-hook can redact the output (v1 onPersist parity)", async () => {
    const { session, tools } = await mkSession("snap-hooks");
    let before = 0;
    let after = 0;
    session.hooks.onBeforeSessionSnapshot(() => {
      before += 1;
    });
    // AfterHook transform-form: return a reshaped snapshot to redact.
    session.hooks.onAfterSessionSnapshot((snap) => {
      after += 1;
      return { ...snap, metadata: { redacted: true } };
    });

    const snap = await session.snapshot();
    expect(before).toBe(1);
    expect(after).toBe(1);
    expect(snap.metadata).toEqual({ redacted: true });

    await session.close();
    await tools.close();
  });

  it("onBeforeSessionSnapshot can veto (throw) the capture", async () => {
    const { session, tools } = await mkSession("snap-veto");
    session.hooks.onBeforeSessionSnapshot(() => {
      throw new Error("no snapshots allowed");
    });
    await expect(session.snapshot()).rejects.toThrow(/no snapshots allowed/);
    await session.close();
    await tools.close();
  });

  it("onBefore/AfterSessionRestore fire around restore()", async () => {
    const { session: src, tools: t1 } = await mkSession("restore-hooks-src");
    await (
      await src.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;
    const snap = await src.snapshot();
    await src.close();
    await t1.close();

    const { session: dest, tools: t2 } = await mkSession("restore-hooks-dest");
    let before = 0;
    let after = 0;
    session_hookCounts(
      dest,
      () => (before += 1),
      () => (after += 1),
    );
    await dest.restore({ snapshot: { ...snap, id: "restore-hooks-dest" } });
    expect(before).toBe(1);
    expect(after).toBe(1);
    await dest.close();
    await t2.close();
  });

  it("Step 6: a fake SnapshotCapable extension bridge round-trips with NO session change", async () => {
    const srcExt = new FakeCounterBridge();
    srcExt.count = 7;
    const { session: src, tools: t1 } = await mkSession("ext-src", { ext: srcExt });

    const snap = await src.snapshot();
    // The generic fold picked up the extension bridge by feature-detection.
    expect(snap.bridges.counter).toEqual({ count: 7 });
    await src.close();
    await t1.close();

    // Restore into a fresh session whose extension bridge starts at 0.
    const destExt = new FakeCounterBridge();
    const { session: dest, tools: t2 } = await mkSession("ext-dest", { ext: destExt });
    expect(destExt.count).toBe(0);
    await dest.restore({ snapshot: { ...snap, id: "ext-dest" } });
    // importSnapshot fanned out generically to the extension bridge.
    expect(destExt.count).toBe(7);
    await dest.close();
    await t2.close();
  });

  it("migration seam: migrateSnapshot runs on specVersion skew and its output is applied", async () => {
    const srcExt = new FakeCounterBridge();
    srcExt.count = 3;
    const { session: src, tools: t1 } = await mkSession("mig-src", { ext: srcExt });
    const snap = await src.snapshot();
    await src.close();
    await t1.close();

    // Forge an OLD snapshot (different specVersion) whose counter bridge
    // snapshot uses a legacy key the migrator upgrades.
    const legacy: SessionSnapshot = {
      ...snap,
      specVersion: "1999-01-01",
      bridges: { ...snap.bridges, counter: { legacyCount: 42 } },
    };

    let seenFrom: string | undefined;
    let seenTo: string | undefined;
    const migrate: SnapshotMigration = (s, ctx) => {
      seenFrom = ctx.from;
      seenTo = ctx.to;
      const legacyCounter = s.bridges.counter as { legacyCount: number };
      return { ...s, bridges: { ...s.bridges, counter: { count: legacyCounter.legacyCount } } };
    };

    const destExt = new FakeCounterBridge();
    const { session: dest, tools: t2 } = await mkSession("mig-dest", {
      ext: destExt,
      migrateSnapshot: migrate,
    });
    await dest.restore({ snapshot: { ...legacy, id: "mig-dest" } });

    expect(seenFrom).toBe("1999-01-01");
    expect(seenTo).toBe(SPEC_VERSION);
    expect(destExt.count).toBe(42); // migrated legacyCount → count → applied
    await dest.close();
    await t2.close();
  });

  it("migration seam: a version mismatch with NO migrateSnapshot throws SnapshotVersionMismatch (fail-closed)", async () => {
    const { session, tools } = await mkSession("mig-fail");
    const snap = await session.snapshot();
    const stale: SessionSnapshot = { ...snap, specVersion: "1999-01-01" };
    await expect(session.restore({ snapshot: stale })).rejects.toMatchObject({
      _tag: "SnapshotVersionMismatch",
      from: "1999-01-01",
      to: SPEC_VERSION,
    });
    await session.close();
    await tools.close();
  });
});

/** Register restore before/after hook counters (kept out of the test body for readability). */
function session_hookCounts(
  session: SessionHarness,
  onBefore: () => void,
  onAfter: () => void,
): void {
  session.hooks.onBeforeSessionRestore(() => {
    onBefore();
  });
  session.hooks.onAfterSessionRestore(() => {
    onAfter();
  });
}
