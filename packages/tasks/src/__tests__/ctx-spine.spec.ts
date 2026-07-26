/**
 * ADR 91 §2 — the task work body receives the framework spine.
 *
 * `TaskWorkContext = OperationCtx & TaskWorkVerbs`: the harness derives the
 * trunk (from the submitting op's scope — a per-session `TasksHarness` stamps
 * its `sessionId`) + the `log`/`trace`/`metrics`/`run` facets via
 * `deriveContext`, and the executor composes its verbs in as branded boundary
 * extras. So a task body reads `ctx.sessionId` and can `ctx.log(...)`.
 */

import { describe, expect, it } from "vitest";

import type { TaskWorkContext } from "@agentick/spec";

import { fakeTasks } from "../testing/fake-tasks.js";

describe("ADR 91 §2 — task work ctx", () => {
  it("carries the submitting scope's trunk (sessionId) + the facets", async () => {
    const bundle = await fakeTasks({ sessionId: "sess-91" });
    let received: TaskWorkContext | undefined;
    const handle = bundle.harness.submit(async (ctx) => {
      received = ctx;
      return "ok" as const;
    });
    await handle.result;

    // Trunk — the task reads its owning session's coordinates.
    expect(received?.sessionId).toBe("sess-91");
    // Observability + Ops facets present (a task can log / open spans / run ops).
    expect(typeof received?.log).toBe("function");
    expect(received?.trace).toBeDefined();
    expect(received?.metrics).toBeDefined();
    expect(typeof received?.run).toBe("function");
    expect(received?.runner).toBeDefined();
    // Task verbs still ride over the trunk+facets.
    expect(typeof received?.onProgress).toBe("function");
    expect(typeof received?.setStatusMessage).toBe("function");
    expect(received?.signal).toBeInstanceOf(AbortSignal);

    await bundle.harness.close();
  });

  it("ctx.log on a task body is a live callable that does not throw", async () => {
    const bundle = await fakeTasks({ sessionId: "sess-log" });
    const handle = bundle.harness.submit(async (ctx) => {
      // Fire-and-forget log — never a control path, never throws.
      ctx.log.info({ msg: "task-progress" });
      ctx.log("warning", { msg: "verbatim-call-form" });
      return 1;
    });
    await expect(handle.result).resolves.toBe(1);
    await bundle.harness.close();
  });
});
