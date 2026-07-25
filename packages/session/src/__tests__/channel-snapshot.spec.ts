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

import { waitFor } from "@agentick/utils/testing";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness, type ElicitationSnapshotFrame } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import type { ToolCallSnapshotFrame } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { KnobsHarness } from "@agentick/knobs";
import { jsonSchema } from "@agentick/spec";
import type { ContentBlock, ExecutionTarget, StandardSchemaV1 } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

function lenientObject(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return jsonSchema<Record<string, unknown>>(
    { type: "object", additionalProperties: true },
    {
      validator: (raw) =>
        raw !== null && typeof raw === "object"
          ? { value: raw as Record<string, unknown> }
          : { issues: [{ message: "expected an object" }] },
    },
  );
}

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
  const compiler = new CompilerHarness("cs-r", journal, bus, inbox);
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
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `cs-s-${Math.random()}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
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

  // ─── Request channels are snapshot-first too (§6.1 — the live-only fix) ───

  it("MID-ASK: opens the elicitation channel with the pending ask", async () => {
    const { session, tools } = await mkSession();

    // Raise an ask on the session's elicitation harness but do NOT await it.
    void session.elicitation.elicit({ message: "pick a fruit", schema: lenientObject() });
    const elic = session.elicitation as unknown as ElicitationHarness;
    await waitFor(() => elic.pendingCount() === 1);

    // The session discovers the elicitation harness as a channel provider and
    // renders its pending asks into the opening frame — a mid-ask subscriber
    // sees the outstanding prompt in frame one (previously: nothing).
    const env = await session.channelSnapshot("elicitation");
    expect(env).toBeDefined();
    expect(env!.name).toBe("session:channel:elicitation");
    expect(env!.scope.sessionId).toBe(session.id);
    const frame = env!.payload as ElicitationSnapshotFrame;
    expect(frame.kind).toBe("snapshot");
    expect(frame.requests).toHaveLength(1);
    expect((frame.requests[0]!.payload as { message: string }).message).toBe("pick a fruit");

    await session.close();
    await tools.close();
  });

  it("discovers the tool executor as the tool_call channel provider (empty when idle)", async () => {
    const { session, tools } = await mkSession();

    // The tool executor is held OUTSIDE `bridges` (as `session.toolExecutor`)
    // yet is discovered by the provider scan — an unowned channel used to
    // resolve `undefined`; now it opens with an empty pending-call frame.
    const env = await session.channelSnapshot("tool_call");
    expect(env).toBeDefined();
    expect(env!.name).toBe("session:channel:tool_call");
    expect(env!.payload).toEqual({
      kind: "snapshot",
      requests: [],
    } satisfies ToolCallSnapshotFrame);

    await session.close();
    await tools.close();
  });
});
