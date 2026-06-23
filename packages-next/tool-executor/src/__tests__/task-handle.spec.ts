/**
 * ToolExecutor task integration (#156) — `ctx.tasks` /
 * `ctx.elicitation` + TaskHandle-return detection branching on
 * `taskSupport` annotation.
 */

import { describe, expect, it } from "vitest";

import { jsonSchema } from "@agentick/spec-next";
import type {
  ContentBlock,
  TaskHandle,
  ToolDeclaration,
  ToolRegistration,
} from "@agentick/spec-next";

import { createTestHarness } from "../testing/index.js";

// ---------------------------------------------------------------------------
// Tool registration helpers
// ---------------------------------------------------------------------------

function makeTool(opts: {
  readonly name: string;
  readonly handlerRef: string;
  readonly taskSupport?: "unsupported" | "supported" | "required";
}): ToolRegistration {
  const declaration: ToolDeclaration = {
    id: opts.handlerRef,
    name: opts.name,
    description: `test tool ${opts.name}`,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    exposure: ["model", "dispatch"],
    handlerRef: opts.handlerRef,
    ...(opts.taskSupport !== undefined ? { annotations: { taskSupport: opts.taskSupport } } : {}),
  };
  return {
    declaration,
    handlerRef: opts.handlerRef,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(name: string, toolCallId: string) {
  return {
    name,
    toolCallId,
    input: {},
    context: { via: "dispatch" as const },
  };
}

// ---------------------------------------------------------------------------
// ctx.tasks + ctx.elicitation are wired
// ---------------------------------------------------------------------------

describe("ToolExecutor ctx — substrate primitives (#156)", () => {
  it("ctx.tasks and ctx.elicitation are provided to handlers", async () => {
    let capturedCtx: { tasks?: unknown; elicitation?: unknown } | undefined;
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "probe", handlerRef: "h.probe" })],
      handlers: [
        {
          handlerRef: "h.probe",
          handler: async (_input, { ctx }) => {
            capturedCtx = { tasks: ctx.tasks, elicitation: ctx.elicitation };
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });
    await harness.dispatch(dispatchOf("probe", "tc-1"));
    expect(capturedCtx?.tasks).toBeDefined();
    expect(capturedCtx?.elicitation).toBeDefined();
  });

  it("handler can submit a task via ctx.tasks; result resolves to its blocks (Pattern A)", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "compute", handlerRef: "h.compute" })],
      handlers: [
        {
          handlerRef: "h.compute",
          handler: async (_input, { ctx }) => {
            // No `taskSupport` annotation → Pattern A: executor awaits
            // the handle's result transparently.
            const handle = ctx.tasks!.submit(async () => [
              { type: "text", text: "computed-via-task" } satisfies ContentBlock,
            ]);
            return handle;
          },
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("compute", "tc-2"));
    expect(result.succeeded).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("computed-via-task");
  });
});

// ---------------------------------------------------------------------------
// TaskHandle return + taskSupport branching (Pattern A vs B)
// ---------------------------------------------------------------------------

describe("ToolExecutor — TaskHandle return + taskSupport branching (#156)", () => {
  it("taskSupport: 'unsupported' (default) → awaits handle.result (Pattern A)", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "wait", handlerRef: "h.wait", taskSupport: "unsupported" })],
      handlers: [
        {
          handlerRef: "h.wait",
          handler: async (_input, { ctx }) => {
            return ctx.tasks!.submit(async () => [
              { type: "text", text: "done" } satisfies ContentBlock,
            ]);
          },
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("wait", "tc-3"));
    expect(result.succeeded).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("done");
  });

  it("taskSupport: 'required' → returns task-ref JSON content block (Pattern B)", async () => {
    const { harness, tasks } = await createTestHarness({
      tools: [makeTool({ name: "deploy", handlerRef: "h.deploy", taskSupport: "required" })],
      handlers: [
        {
          handlerRef: "h.deploy",
          handler: async (_input, { ctx }) => {
            // Long-running work so the task is genuinely in
            // `working` state at the moment the executor serializes
            // the ref (Pattern B's whole point — return the ref
            // BEFORE the work completes).
            return ctx.tasks!.submit(
              async ({ signal }) => {
                await new Promise<void>((resolve, reject) => {
                  if (signal.aborted) {
                    reject(new Error("aborted"));
                    return;
                  }
                  signal.addEventListener("abort", () => reject(new Error("aborted")));
                  setTimeout(resolve, 200);
                });
                return [{ type: "text", text: "deployed" } satisfies ContentBlock];
              },
              { statusMessage: "deploying" },
            );
          },
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("deploy", "tc-4"));
    expect(result.succeeded).toBe(true);
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as {
      _kind: string;
      taskId: string;
      status: string;
      statusMessage?: string;
    };
    expect(parsed._kind).toBe("task-ref");
    expect(parsed.taskId).toMatch(/^task:/);
    expect(parsed.status).toBe("working");
    expect(parsed.statusMessage).toBe("deploying");

    // Clean up — cancel the task and swallow the resulting
    // rejection (the task's `result` promise rejects with
    // TaskRejection on cancel; nobody awaits it in the test, so
    // vitest sees an unhandled rejection without this).
    const cleanupResult = tasks.result(parsed.taskId).catch(() => undefined);
    await tasks.cancel(parsed.taskId, "test_cleanup");
    await cleanupResult;
  });

  it("Pattern B — task continues running after executor returns the ref", async () => {
    const { harness, tasks } = await createTestHarness({
      tools: [makeTool({ name: "slow", handlerRef: "h.slow", taskSupport: "required" })],
      handlers: [
        {
          handlerRef: "h.slow",
          handler: async (_input, { ctx }) => {
            return ctx.tasks!.submit(async ({ signal }) => {
              await new Promise<void>((resolve, reject) => {
                if (signal.aborted) {
                  reject(new Error("aborted"));
                  return;
                }
                setTimeout(resolve, 30);
              });
              return [{ type: "text", text: "finished" } satisfies ContentBlock];
            });
          },
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("slow", "tc-5"));
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      taskId: string;
    };
    // Task is still running at this point — the executor returned the
    // ref without awaiting. Await via the tasks harness.
    const finalBlocks = await tasks.result<readonly ContentBlock[]>(parsed.taskId);
    expect((finalBlocks[0] as { text: string }).text).toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// Pattern B — dispatch abort propagates to the task
// ---------------------------------------------------------------------------

describe("ToolExecutor — Pattern A dispatch abort cancels the task (#156)", () => {
  it("aborting the dispatch cancels the in-flight task (Pattern A path)", async () => {
    let savedHandle: TaskHandle<readonly ContentBlock[]> | undefined;
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "long", handlerRef: "h.long", taskSupport: "unsupported" })],
      handlers: [
        {
          handlerRef: "h.long",
          handler: async (_input, { ctx }) => {
            const handle = ctx.tasks!.submit(async ({ signal }) => {
              await new Promise<void>((_resolve, reject) => {
                if (signal.aborted) {
                  reject(new Error("aborted"));
                  return;
                }
                signal.addEventListener("abort", () => reject(new Error("aborted")));
              });
              return [{ type: "text", text: "x" } satisfies ContentBlock];
            });
            savedHandle = handle;
            return handle;
          },
        },
      ],
    });

    // Pattern A awaits the task. Trigger a dispatch abort partway
    // through. The executor's abort path fires `handle.cancel`
    // (wired in #156), so the task itself transitions to cancelled.
    const ctrl = new AbortController();
    const dispatchP = harness.dispatch({
      ...dispatchOf("long", "tc-6"),
      signal: ctrl.signal,
    });
    // Race a small delay against the dispatch so we have a chance
    // to abort while it's still in-flight. The dispatch resolves
    // with a failed result on abort (the executor maps the abort
    // to a `succeeded: false` shape rather than rethrowing).
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort("test_abort");
    let result: Awaited<typeof dispatchP> | undefined;
    let caughtAbort = false;
    try {
      result = await dispatchP;
    } catch {
      // Some abort code paths reject the promise rather than return
      // a failed result — either shape is acceptable here; the load-
      // bearing assertion is that the underlying TASK transitioned
      // to `cancelled` via the wired cancel-on-abort path.
      caughtAbort = true;
    }
    expect(savedHandle).toBeDefined();
    // Allow the cancel-on-abort microtask to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(savedHandle!.info().status).toBe("cancelled");
    // Either path is fine — assert that the dispatch didn't succeed.
    if (!caughtAbort && result !== undefined) {
      expect(result.succeeded).toBe(false);
    }
  });
});
