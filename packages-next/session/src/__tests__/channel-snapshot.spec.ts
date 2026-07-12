/**
 * `session.channelSnapshot(channel)` — the generic channel-open-with-snapshot
 * seam (slice 2). The session scans its bridges for a `ChannelSnapshotProvider`
 * and renders the owner's current state into a ready-to-publish envelope. This
 * is the source the `sub/subscribe` wire handler prepends so a fresh subscriber
 * opens WITH the channel's current state (K8s `sendInitialEvents` model).
 *
 * Proves: (1) the knobs harness conforms and is discovered — `channelSnapshot
 * ("knobs-state")` returns an envelope named `session:channel:knobs-state`
 * whose payload equals the knobs harness's live `stateSnapshotFrame()`; and
 * (2) an unowned channel resolves to `undefined`.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { KnobsHarness } from "@agentick/knobs-next";
import type { ContentBlock, ExecutionTarget } from "@agentick/spec-next";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

async function mkSession(initialKnobs?: Readonly<Record<string, unknown>>) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const reconciler = new ReconcilerHarness("cs-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("cs-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("cs-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("cs-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor("cs-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await Promise.all([reconciler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `cs-s-${Math.random()}`,
    agent: null,
    reconciler,
    loop,
    executor,
    toolExecutor: tools,
    target,
    ...(initialKnobs !== undefined ? { initialKnobs } : {}),
  });
  await session.ready;
  await session.mountReady;
  return { session, tools };
}

describe("session.channelSnapshot (slice 2 — channel opens with a snapshot)", () => {
  it("renders the knobs-state channel's current frame into a ready-to-publish envelope", async () => {
    const { session, tools } = await mkSession({ temperature: 0.7, verbose: true });

    // The knobs harness IS the channel owner — read its live frame to
    // compare against (the source of truth the envelope wraps).
    const knobs = session.knobs as unknown as KnobsHarness;
    const expectedPayload = knobs.stateSnapshotFrame();
    expect(expectedPayload.values).toEqual({ temperature: 0.7, verbose: true });

    const env = await session.channelSnapshot("knobs-state");
    expect(env).toBeDefined();
    expect(env!.name).toBe("session:channel:knobs-state");
    expect(env!.surface).toBe("session");
    expect(env!.phase).toBe("delta");
    expect(env!.scope.sessionId).toBe(session.id);
    expect(env!.payload).toEqual(expectedPayload);

    await session.close();
    await tools.close();
  });

  it("returns undefined for a channel no bridge owns", async () => {
    const { session, tools } = await mkSession();

    const env = await session.channelSnapshot("no-such-channel");
    expect(env).toBeUndefined();

    await session.close();
    await tools.close();
  });
});
