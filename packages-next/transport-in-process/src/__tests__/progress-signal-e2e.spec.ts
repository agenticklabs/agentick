/**
 * Progress-signal wire bridge end-to-end (ADR 64 / #19-progress-wire).
 *
 * The full stack, no fakes on the wire path: real client → in-process
 * transport → real gateway → real app → real session → real loop → real
 * tool-executor. A scripted model calls a tool; the tool handler emits
 * `ctx.progress(...)` DURING the in-flight `session/send`; the gateway's
 * `sessionWireExtension["session/send"]` handler (the A2 seam) subscribes
 * to `*:signal:progress` bus events scoped to the execution and forwards
 * each onto the caller's `_meta.progressToken`. We then assert the
 * CLIENT's `client.transport.progress(token)` stream receives a frame
 * carrying the progress fields — proving `ctx.progress` reaches the
 * agentick client, not just an MCP client.
 *
 * The tool stands in for "any harness emitting a progress signal": the
 * bridge is signal-source-agnostic (it keys on the canonical
 * `<surface>:signal:progress` name + executionId scope), and the
 * tool-executor's own emit path is separately pinned in
 * `@agentick/tool-executor-next/__tests__/signals.spec.ts`.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { createGateway } from "@agentick/gateway-next";
import { fakeReconciler } from "@agentick/reconciler-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  jsonSchema,
  progressEventName,
  type ContentBlock,
  type EventFrame,
  type ExecutionTarget,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ProgressEventPayload,
  type ToolHandler,
  type ToolRegistration,
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";

import { inProcessTransport } from "../index.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

/** A runtime-bound tool whose handler emits a progress signal, then completes. */
function progressToolRegistration(): ToolRegistration {
  return {
    declaration: {
      id: "do_work",
      name: "do_work",
      description: "emits a progress signal then completes",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      exposure: ["model", "dispatch"],
    },
    handlerRef: "handlers/do_work",
    binding: { scope: "runtime" },
  };
}

const PROGRESS_TOKEN_ON_CTX = "work-1";

const doWorkHandler: ToolHandler = (_input, { ctx }) => {
  // In-process: the tool picks its own correlation token (no client
  // `_meta.progressToken` on ctx — that's the MCP-only A1 path). The
  // bridge forwards the SIGNAL regardless of the token onto the send's
  // wire progressToken.
  ctx.progress(PROGRESS_TOKEN_ON_CTX, { progress: 2, total: 5, message: "halfway-ish" });
  const content: ContentBlock[] = [{ type: "text", text: "done" }];
  return content;
};

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  // Scripted model: tick 1 → tool_use(do_work); tick 2 → final text.
  const executor = new FakeLanguageModelExecutor("prog-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [
            { type: "tool_use", toolUseId: "tc-1", name: "do_work", input: {} } as ContentBlock,
          ],
          stopReason: "tool_use",
          toolCalls: [{ id: "tc-1", name: "do_work", input: {} }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "all done" } satisfies ContentBlock],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "prog-app",
    rootElement: null,
    options: {
      executor,
      reconciler: fakeReconciler(),
      target,
      // Runtime-bound tool + its handler wired without JSX — the loop
      // dispatches the scripted tool_use against the executor registry.
      inheritedTools: [progressToolRegistration()],
      toolHandlers: new Map<string, ToolHandler>([["handlers/do_work", doWorkHandler]]),
    },
  });
  const session = await app.createSession({ sessionId: "prog-session" });

  let sinkForwarder: ((n: { method: string; params?: unknown }) => void) | undefined;
  const sink: DispatchSink = {
    sendNotification: (n) => sinkForwarder?.(n),
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
    unregisterInFlight: () => {},
  };

  const handler = async (
    req: JsonRpcRequest,
    sendNotification: (n: { method: string; params?: unknown }) => void,
  ): Promise<JsonRpcResponse> => {
    sinkForwarder = sendNotification;
    return dispatchRequest(gateway, req, sink);
  };

  const client = await createClient({ transport: inProcessTransport({ handler }) });
  await client.connect();

  return {
    client,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("progress signal → wire bridge (ADR 64 / A2)", () => {
  it("a tool's ctx.progress during session/send reaches client.transport.progress(token)", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    // Drive the raw wire: open the progress stream on a known token and
    // issue session/send carrying that same token as `_meta.progressToken`.
    const token = "a2-wire-token";
    const stream = client.transport.progress(token);

    const frames: EventFrame[] = [];
    const drain = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();

    const result = await client.request("session/send", {
      sessionId,
      messages: [{ role: "user", content: "go" }],
      _meta: { progressToken: token },
    });
    // Two ticks ran (tool_use → tool dispatch → final text). Output is
    // cumulative across ticks; the run terminated on the scripted text.
    expect(result.result.ticks).toBe(2);
    expect(result.result.output).toContainEqual({ type: "text", text: "all done" });

    // Give the fire-and-forget signal fan-out a beat to land on the wire,
    // then close the stream to end the drain.
    await new Promise((r) => setTimeout(r, 20));
    await stream.close();
    await drain;

    // Among the frames, exactly the tool's progress SIGNAL must appear —
    // self-describing by its canonical name, carrying the progress fields
    // the handler emitted (with the tool's own correlation token).
    const signalFrames = frames.filter((f) => f.envelope.name === progressEventName("tool"));
    expect(signalFrames.length).toBeGreaterThanOrEqual(1);
    const payload = signalFrames[0]!.envelope.payload as ProgressEventPayload;
    expect(payload).toMatchObject({
      token: PROGRESS_TOKEN_ON_CTX,
      progress: 2,
      total: 5,
      message: "halfway-ish",
    });

    await cleanup();
  });
});
