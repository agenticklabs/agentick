/**
 * TASK-WAKE seam — cross-harness integration.
 *
 * The end-to-end proof that a backgrounded (Pattern B) task completing while
 * UNOBSERVED wakes its owning session through the REAL `session.send` path: a
 * journaled execution, attributed via `source: "task-wake"` provenance. Also
 * proves consume-on-observe end-to-end (an in-band `session.tasks.result`
 * read → NO wake execution) and that a wake arriving DURING a running
 * execution STEERS into it (no colliding second execution).
 *
 * Lives in `@agentick/session-next` because it wires a REAL `SessionHarness` +
 * the REAL per-session `TasksHarness` (constructed by `buildSessionBridges`)
 * over one shared substrate — the package that depends on both.
 */

import { afterEach, describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import type {
  ExecutionTarget,
  ToolCall,
  ToolRegistration,
  TimelineEntry,
} from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";
import { waitFor, waitForStable } from "@agentick/utils-next/testing";

import { SessionHarness } from "../harness.js";

// Non-streaming so the loop takes the `run` (not `executeStream`) path.
const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false },
};

const okReply = () => ({
  specVersion: "2026-05-08",
  output: [{ type: "text" as const, text: "ok" }],
  stopReason: "end" as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

function mkExecutor(scripted?: ReadonlyArray<{ result: ReturnType<typeof okReply> }>) {
  return new FakeLanguageModelExecutor(
    "exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    scripted ? { scripted } : { scripted: { result: okReply() } },
  );
}

async function mkSession(
  opts: {
    scripted?: ReadonlyArray<{ result: ReturnType<typeof okReply> }>;
    tools?: readonly ToolRegistration[];
    register?: (r: InMemoryHandlerResolver) => void;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  opts.register?.(resolver);
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const tools = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
    ...(opts.tools ? { initialTools: opts.tools } : {}),
  });
  const executor = mkExecutor(opts.scripted);
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
  });
  await session.ready;
  await session.mountReady;
  return { session };
}

/** Timeline message entries stamped with the task-wake provenance. */
function wakeEntries(entries: readonly TimelineEntry[], taskId?: string) {
  return entries.filter(
    (e): e is Extract<TimelineEntry, { kind: "message" }> =>
      e.kind === "message" &&
      e.message.metadata?.source === "task-wake" &&
      (taskId === undefined || e.message.metadata?.taskId === taskId),
  );
}

function assistantTexts(entries: readonly TimelineEntry[]): string[] {
  return entries
    .filter((e) => e.kind === "message" && e.message.role === "assistant")
    .flatMap((e) => (e.kind === "message" ? e.message.content : []))
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);
}

function boundaryCount(session: {
  timeline: { readPersisted(): readonly TimelineEntry[] };
}): number {
  return session.timeline.readPersisted().filter((e) => e.kind === "boundary").length;
}

describe("TASK-WAKE integration — unobserved completion wakes via the real send path", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("an unobserved Pattern B completion synthesizes a real journaled execution with task-wake provenance", async () => {
    const { session } = await mkSession();
    close = () => session.close();

    // Idle session, backgrounded task with wake. `handle.result` is the
    // ORIGINATOR await — it does NOT consume the wake.
    const handle = session.tasks.submit(async () => [{ type: "text", text: "SECRET-OUTPUT" }], {
      wake: true,
    });
    await handle.result;

    const wake = await waitFor(() => {
      const found = wakeEntries(session.timeline.read().entries, handle.taskId);
      return found.length >= 1 ? found : false;
    });
    await waitForStable(() => wakeEntries(session.timeline.read().entries).length, {
      stableMs: 30,
    });

    expect(wake).toHaveLength(1);
    expect(wake[0]!.message.role).toBe("user");
    expect(wake[0]!.message.metadata).toMatchObject({ source: "task-wake", taskId: handle.taskId });
    // Bounded: no raw task output leaked into the timeline.
    const text = wake[0]!.message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    expect(text).not.toContain("SECRET-OUTPUT");
    expect(text).toContain(handle.taskId);

    // A real execution ran → the scripted model reply is on the timeline and a
    // turn boundary was recorded (proves the normal journaled send path).
    await waitFor(() => assistantTexts(session.timeline.read().entries).includes("ok"));
    expect(boundaryCount(session)).toBeGreaterThanOrEqual(1);
  });

  it("an in-band result() read consumes the wake — NO synthesized execution", async () => {
    const { session } = await mkSession();
    close = () => session.close();

    const handle = session.tasks.submit(async () => [{ type: "text", text: "x" }], { wake: true });
    // Observe in-band (the session_tasks_await path) — consumes the wake.
    await session.tasks.result(handle.taskId);

    await waitForStable(() => session.timeline.read().entries.length, { stableMs: 60 });
    expect(wakeEntries(session.timeline.read().entries)).toHaveLength(0);
    // No execution ran at all (no assistant reply, no boundary).
    expect(assistantTexts(session.timeline.read().entries)).not.toContain("ok");
    expect(boundaryCount(session)).toBe(0);
  });

  it("a wake arriving DURING a running execution steers into it (no colliding second execution)", async () => {
    // The execution is held open by a blocking tool (the realistic Pattern B
    // shape): the model emits a tool_use, its handler blocks on a gate, so the
    // execution is genuinely in-flight while the wake fires.
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => (releaseTool = r));
    const blockerCall: ToolCall = { id: "tc1", name: "blocker", input: {} } as ToolCall;
    const scripted = [
      {
        result: {
          ...okReply(),
          output: [{ type: "text" as const, text: "" }],
          toolCalls: [blockerCall],
          stopReason: "tool_use" as unknown as "end",
        },
      },
      { result: okReply() },
    ];
    const blockerTool: ToolRegistration = {
      declaration: {
        id: "t.blocker",
        name: "blocker",
        description: "blocks",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model", "dispatch"],
      },
      handlerRef: "h.blocker",
      binding: { scope: "runtime" },
    };
    const { session } = await mkSession({
      scripted: scripted as never,
      tools: [blockerTool],
      register: (r) =>
        r.register("h.blocker", async () => {
          await toolGate;
          return [{ type: "text", text: "tool-done" }];
        }),
    });
    close = () => session.close();

    const handle = await session.send({ messages: [{ role: "user", content: "hi" }] });
    // Execution is in-flight, blocked in the tool handler.
    await waitFor(() => session.hasInFlightExecution === true);

    // Complete a backgrounded wake task WHILE the execution runs.
    const taskHandle = session.tasks.submit(async () => [{ type: "text", text: "x" }], {
      wake: true,
    });
    await taskHandle.result;

    // Wait until the wake has actually STEERED into the running execution — its
    // message lands on the timeline WHILE the tool is still gated.
    await waitFor(
      () => wakeEntries(session.timeline.read().entries, taskHandle.taskId).length >= 1,
      { description: "wake steered into the running execution" },
    );
    // No-collision proof: still exactly one in-flight execution, no boundary
    // recorded yet — the wake folded into the running execution.
    expect(session.hasInFlightExecution).toBe(true);
    expect(boundaryCount(session)).toBe(0);

    // Release the tool; the single execution drains to exactly one boundary.
    releaseTool();
    await handle.result;
    await waitForStable(() => session.timeline.readPersisted().length, { stableMs: 60 });

    expect(wakeEntries(session.timeline.read().entries, taskHandle.taskId)).toHaveLength(1);
    expect(boundaryCount(session)).toBe(1);
  });
});
