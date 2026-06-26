/**
 * 3×3 matrix for `DispatchInput.task` × `taskSupport` (#164).
 *
 * The executor combines the caller's `task` option with the tool's
 * declared `annotations.taskSupport` to decide Pattern A
 * (await the handle, return its blocks) vs Pattern B (return a
 * `session_task_ref` block immediately). The model-tick path keeps its
 * historical Pattern-B behavior for `required` tools via the
 * `via: "model"` arm of the `"auto"` resolution; host-side callers
 * default to Pattern A.
 *
 *                taskSupport →
 *                unsupported           supported             required
 *  task ↓
 *  "auto"        Pattern A             Pattern A             A (host) / B (model)
 *  "ref"         Conflict              Pattern B             Pattern B
 *  "inline"      Pattern A             Pattern A             Conflict
 *
 * Pre-flight conflicts fail with `ToolTaskModeConflictError` before the
 * handler runs.
 */

import { describe, expect, it } from "vitest";

import { isTaskRefBlock, jsonSchema } from "@agentick/spec-next";
import type { ContentBlock, ToolDeclaration, ToolRegistration } from "@agentick/spec-next";

import { createTestHarness } from "../testing/index.js";
import { omitUndefined } from "@agentick/utils-next";

type SupportMode = "unsupported" | "supported" | "required";
type TaskMode = "auto" | "ref" | "inline";

function makeTool(opts: {
  readonly name: string;
  readonly handlerRef: string;
  readonly taskSupport?: SupportMode;
}): ToolRegistration {
  const declaration: ToolDeclaration = {
    id: opts.handlerRef,
    name: opts.name,
    description: `matrix tool ${opts.name}`,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    exposure: ["model", "dispatch"],
    handlerRef: opts.handlerRef,
    ...(opts.taskSupport !== undefined ? { annotations: { taskSupport: opts.taskSupport } } : {}),
  };
  return { declaration, handlerRef: opts.handlerRef, binding: { scope: "runtime" } };
}

function dispatchOf(opts: {
  readonly name: string;
  readonly toolCallId: string;
  readonly via: "model" | "dispatch";
  readonly task?: TaskMode;
}) {
  return {
    name: opts.name,
    toolCallId: opts.toolCallId,
    input: {},
    context: { via: opts.via },
    ...omitUndefined({ task: opts.task }),
  };
}

/**
 * Handler that returns a long-running TaskHandle so Pattern B observes
 * a `working` ref. The submitted work blocks until `signal.aborted`
 * fires (or the test cancels via the TasksHarness).
 */
function longRunningHandler() {
  return async (
    _input: unknown,
    { ctx }: { ctx: { tasks?: import("@agentick/spec-next").TasksHarnessProtocol } },
  ) => {
    return ctx.tasks!.submit(async ({ signal }) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(resolve, 5_000);
      });
      return [{ type: "text", text: "long-done" } satisfies ContentBlock];
    });
  };
}

/**
 * Handler that returns a TaskHandle that completes immediately. Pattern
 * A awaits and returns its blocks transparently.
 */
function quickTaskHandler() {
  return async (
    _input: unknown,
    { ctx }: { ctx: { tasks?: import("@agentick/spec-next").TasksHarnessProtocol } },
  ) => {
    return ctx.tasks!.submit(async () => [
      { type: "text", text: "quick-done" } satisfies ContentBlock,
    ]);
  };
}

// ---------------------------------------------------------------------------
// (any, "ref") cells — Pattern B except `unsupported` which conflicts
// ---------------------------------------------------------------------------

describe("dispatch task mode matrix — task: 'ref'", () => {
  it("(unsupported, 'ref') → ToolTaskModeConflictError", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "u", handlerRef: "h.u", taskSupport: "unsupported" })],
      handlers: [
        {
          handlerRef: "h.u",
          handler: async () => [{ type: "text", text: "x" }],
        },
      ],
    });
    await expect(
      harness.dispatch(
        dispatchOf({ name: "u", toolCallId: "tc-u-ref", via: "dispatch", task: "ref" }),
      ),
    ).rejects.toMatchObject({
      _tag: "ToolTaskModeConflictError",
      requestedTaskMode: "ref",
      supportMode: "unsupported",
    });
  });

  it("(supported, 'ref') → returns TaskRefBlock (Pattern B, #160)", async () => {
    const { harness, tasks } = await createTestHarness({
      tools: [makeTool({ name: "s", handlerRef: "h.s", taskSupport: "supported" })],
      handlers: [{ handlerRef: "h.s", handler: longRunningHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "s", toolCallId: "tc-s-ref", via: "dispatch", task: "ref" }),
    );
    const block = result.content[0];
    if (!isTaskRefBlock(block!)) throw new Error(`expected task_ref, got ${block?.type}`);
    expect(block.status).toBe("working");

    // Drain the background task — cancel the local handle and swallow
    // the rejection that bubbles through `tasks.result`.
    const drained = tasks.result(block.taskId).catch(() => undefined);
    await tasks.cancel(block.taskId, "test_cleanup");
    await drained;
  });

  it("(required, 'ref') → returns TaskRefBlock (Pattern B, #160)", async () => {
    const { harness, tasks } = await createTestHarness({
      tools: [makeTool({ name: "r", handlerRef: "h.r", taskSupport: "required" })],
      handlers: [{ handlerRef: "h.r", handler: longRunningHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "r", toolCallId: "tc-r-ref", via: "dispatch", task: "ref" }),
    );
    const block = result.content[0];
    if (!isTaskRefBlock(block!)) throw new Error(`expected task_ref, got ${block?.type}`);

    const drained = tasks.result(block.taskId).catch(() => undefined);
    await tasks.cancel(block.taskId, "test_cleanup");
    await drained;
  });
});

// ---------------------------------------------------------------------------
// (any, "inline") cells — Pattern A except `required` which conflicts
// ---------------------------------------------------------------------------

describe("dispatch task mode matrix — task: 'inline'", () => {
  it("(unsupported, 'inline') → Pattern A (awaits handler blocks)", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "u", handlerRef: "h.u", taskSupport: "unsupported" })],
      handlers: [
        {
          handlerRef: "h.u",
          handler: async () => [{ type: "text", text: "inline-direct" } satisfies ContentBlock],
        },
      ],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "u", toolCallId: "tc-u-inline", via: "dispatch", task: "inline" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("inline-direct");
  });

  it("(supported, 'inline') → Pattern A (awaits the handle's result)", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "s", handlerRef: "h.s", taskSupport: "supported" })],
      handlers: [{ handlerRef: "h.s", handler: quickTaskHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "s", toolCallId: "tc-s-inline", via: "dispatch", task: "inline" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("quick-done");
  });

  it("(required, 'inline') → ToolTaskModeConflictError", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "r", handlerRef: "h.r", taskSupport: "required" })],
      handlers: [{ handlerRef: "h.r", handler: longRunningHandler() }],
    });
    await expect(
      harness.dispatch(
        dispatchOf({ name: "r", toolCallId: "tc-r-inline", via: "dispatch", task: "inline" }),
      ),
    ).rejects.toMatchObject({
      _tag: "ToolTaskModeConflictError",
      requestedTaskMode: "inline",
      supportMode: "required",
    });
  });
});

// ---------------------------------------------------------------------------
// (any, "auto") cells — Pattern A everywhere EXCEPT (required, via:"model")
// ---------------------------------------------------------------------------

describe("dispatch task mode matrix — task: 'auto' (host-side default)", () => {
  it("(unsupported, 'auto', dispatch) → Pattern A", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "u", handlerRef: "h.u", taskSupport: "unsupported" })],
      handlers: [
        {
          handlerRef: "h.u",
          handler: async () => [{ type: "text", text: "auto-host" } satisfies ContentBlock],
        },
      ],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "u", toolCallId: "tc-u-auto-h", via: "dispatch" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("auto-host");
  });

  it("(supported, 'auto', dispatch) → Pattern A (host-side default)", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "s", handlerRef: "h.s", taskSupport: "supported" })],
      handlers: [{ handlerRef: "h.s", handler: quickTaskHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "s", toolCallId: "tc-s-auto-h", via: "dispatch" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("quick-done");
  });

  it("(required, 'auto', dispatch) → Pattern A — the load-bearing #164 change", async () => {
    // BEFORE #164: host-side `session.dispatch` for a required tool
    // returned a `session_task_ref` block — callers had to JSON-parse
    // and then poll `tasks.result`. AFTER #164: the dispatch awaits
    // transparently and returns the final blocks.
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "r", handlerRef: "h.r", taskSupport: "required" })],
      handlers: [{ handlerRef: "h.r", handler: quickTaskHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "r", toolCallId: "tc-r-auto-h", via: "dispatch" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("quick-done");
  });
});

describe("dispatch task mode matrix — task: 'auto' (model-tick path)", () => {
  it("(unsupported, 'auto', model) → Pattern A", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "u", handlerRef: "h.u", taskSupport: "unsupported" })],
      handlers: [
        {
          handlerRef: "h.u",
          handler: async () => [{ type: "text", text: "auto-model-u" } satisfies ContentBlock],
        },
      ],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "u", toolCallId: "tc-u-auto-m", via: "model" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("auto-model-u");
  });

  it("(supported, 'auto', model) → Pattern A (Phase C #174 refines)", async () => {
    const { harness } = await createTestHarness({
      tools: [makeTool({ name: "s", handlerRef: "h.s", taskSupport: "supported" })],
      handlers: [{ handlerRef: "h.s", handler: quickTaskHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "s", toolCallId: "tc-s-auto-m", via: "model" }),
    );
    expect((result.content[0] as { text: string }).text).toBe("quick-done");
  });

  it("(required, 'auto', model) → Pattern B — preserves the loop's async-across-ticks contract", async () => {
    const { harness, tasks } = await createTestHarness({
      tools: [makeTool({ name: "r", handlerRef: "h.r", taskSupport: "required" })],
      handlers: [{ handlerRef: "h.r", handler: longRunningHandler() }],
    });
    const result = await harness.dispatch(
      dispatchOf({ name: "r", toolCallId: "tc-r-auto-m", via: "model" }),
    );
    const block = result.content[0];
    if (!isTaskRefBlock(block!)) throw new Error(`expected task_ref, got ${block?.type}`);
    expect(block.status).toBe("working");

    const drained = tasks.result(block.taskId).catch(() => undefined);
    await tasks.cancel(block.taskId, "test_cleanup");
    await drained;
  });
});
