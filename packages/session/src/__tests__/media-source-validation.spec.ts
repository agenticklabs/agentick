/**
 * The send door rejects a `base64` media source carrying a `data:` URI.
 *
 * Past the door the block is durable: it replays into a provider rejection
 * (Gemini: TYPE_BYTES, base64 decode) on every later turn — the session is
 * poisoned by one bad send. The check is the string prefix and nothing more:
 * validating the alphabet of megabyte payloads buys nothing over the one
 * failure shape producers actually emit (`readAsDataURL` output, unstripped).
 */

import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { ElicitationHarness } from "@agentick/elicitation";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ExecutionTarget } from "@agentick/spec";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

async function mkSession(sessionId: string) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness(`${sessionId}-r`, journal, bus, inbox);
  const loop = new LoopExecutorHarness(`${sessionId}-l`, journal, bus, inbox);
  const elicitation = new ElicitationHarness(`${sessionId}:elicitation`, journal, bus, inbox);
  const tools = new ToolExecutorHarness(`${sessionId}-t`, journal, bus, inbox, {
    handlerResolver: new InMemoryHandlerResolver(),
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor(`${sessionId}-x`, journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
      },
    },
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  return { session, tools };
}

const RAW = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA=";

describe("base64 media sources at the send door", () => {
  it("a data: URI in a base64 source rejects the send, and nothing lands on the timeline", async () => {
    const { session, tools } = await mkSession("media-1");
    await session.mountReady;

    await expect(
      session.send({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see attached" },
              {
                type: "image",
                source: {
                  type: "base64",
                  data: `data:image/png;base64,${RAW}`,
                  mimeType: "image/png",
                },
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ _tag: "InvalidMediaSource", blockIndex: 1, blockType: "image" });

    expect(session.timeline.read().entries).toHaveLength(0);

    await session.close();
    await tools.close();
  });

  it("raw base64 passes", async () => {
    const { session, tools } = await mkSession("media-2");
    await session.mountReady;

    const handle = await session.send({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: RAW, mimeType: "image/png" } },
          ],
        },
      ],
    });
    await handle.result;

    expect(session.timeline.read().entries.length).toBeGreaterThan(0);

    await session.close();
    await tools.close();
  });
});
