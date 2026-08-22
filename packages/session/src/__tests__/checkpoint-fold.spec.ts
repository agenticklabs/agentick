/**
 * The checkpointing model (docs/proposals/v2/checkpointing.md §3.2):
 * `session:snapshot` fans `CheckpointCapable.persist` out over the bridge bag
 * and `session:restore` fans `hydrate` out over it. No value crosses the seam
 * in either direction.
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
import type { CheckpointCapable, ExecutionTarget, HydrateCtx, PersistCtx } from "@agentick/spec";
import { SessionBusyError } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

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

async function mkSession(
  id: string,
  ext?: ReadonlyMap<string, unknown>,
  holdUntil?: Promise<void>,
) {
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
      ...(holdUntil !== undefined ? { holdUntil } : {}),
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

describe("SessionHarness — CheckpointCapable fold", () => {
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
    await expect(session.snapshot()).resolves.toBeUndefined();
    await session.close();
    await tools.close();
  });

  it("a rejected hydrate propagates out of restore()", async () => {
    const bridge = new FakeCheckpointBridge("flaky");
    const { session, tools } = await mkSession(
      "cp-hydrate-fail",
      new Map<string, unknown>([["flaky", bridge]]),
    );
    await session.snapshot();
    bridge.hydrateError = new Error("load failed");

    await expect(session.restore()).rejects.toThrow(/load failed/);
    await session.close();
    await tools.close();
  });

  it("restore() rejects while an execution is in flight, and succeeds once it settles", async () => {
    // Hydrate REPLACES each projection, so a restore under a live tick would
    // swap the timeline out from under a loop that has already read it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, tools } = await mkSession("cp-inflight", undefined, held);

    const inFlight = session.send({ messages: [{ role: "user", content: "hi" }] });
    await waitFor(() => session.hasInFlightExecution);

    await expect(session.restore()).rejects.toBeInstanceOf(SessionBusyError);

    release();
    await (
      await inFlight
    ).result;
    await expect(session.restore()).resolves.toBeUndefined();

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

    await session.snapshot();

    expect(bridge.persisted[0]?.sessionId).toBe("cp-ctx");
    expect(bridge.persisted[0]?.tick).toBeGreaterThan(0);
    await session.close();
    await tools.close();
  });
});
