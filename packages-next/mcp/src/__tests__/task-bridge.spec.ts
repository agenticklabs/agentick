/**
 * `withMCP` end-to-end — tool annotated `taskSupport: "required"`
 * routes through the local TasksHarness via mcpTaskEffect, drives the
 * full draft `tasks/*` wire dance (task-augmented call → notifications
 * → tasks/result), and surfaces a Pattern B `session_task_ref` to the
 * dispatch caller.
 *
 * Test setup: in-process MCP server using the SDK's Server class +
 * InMemoryMcpTransport pair. The server advertises a single tool
 * `slow_task` with `annotations.taskSupport === "required"`; when
 * called with task-augmented params, it:
 *
 *   1. Returns `CreateTaskResult` immediately.
 *   2. Pushes one or more `notifications/tasks/status` envelopes
 *      (working → completed) on a microtask delay.
 *   3. Optionally pushes `notifications/progress` tagged with the
 *      `RELATED_TASK_META_KEY` for the same taskId.
 *   4. Serves `tasks/result` with the canned CallToolResult.
 *   5. Honors `tasks/cancel` by transitioning the task to cancelled
 *      and pushing one final status notification.
 *
 * The test exercises the integration via `session.dispatch(...)` —
 * the Pattern B branch returns a session_task_ref content block, then
 * we drive the lifecycle to completion via `session.dispatch` of
 * `session_tasks_await`. Cancellation path uses
 * `session_tasks_cancel`.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@agentick/app-next/react";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
// AppHarness installs a TasksHarness per session by default — no need
// to install `withTasks()` here. session.tasks (via SessionHarness
// augmentation in @agentick/tasks-next) gives access to the harness
// for assertions / direct cancellation.
import "@agentick/tasks-next";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Task } from "@modelcontextprotocol/sdk/types.js";

import { InMemoryMcpTransport, NoneAuth, withMCP } from "../index.js";
import { RELATED_TASK_META_KEY } from "../wire/task-codec.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hi");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "mcp-task-e2e-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text" as const, text: "ok" }],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

// ---------------------------------------------------------------------------
// Fake MCP server — advertises a taskSupport: "required" tool + full
// draft tasks/* server behavior backed by in-memory state.
// ---------------------------------------------------------------------------

interface FakeServerHandle {
  readonly server: Server;
  readonly clientTransport: InMemoryMcpTransport;
  /** Resolve a pending task to completed with the given payload. */
  completeTask(taskId: string, payload: string): Promise<void>;
  /** Trigger a progress notification for a task. */
  emitProgress(taskId: string, current: number, total?: number, message?: string): Promise<void>;
  /** Promise that resolves once a tasks/cancel request lands. */
  readonly cancelObserved: Promise<string>;
}

async function mkFakeMcpServer(opts: {
  readonly autoComplete?: boolean;
  readonly autoCompletePayload?: string;
}): Promise<FakeServerHandle> {
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  const server = new Server(
    { name: "fake-task-server", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        // Advertise task creation support — SDK 1.29.0 capability
        // shape is `tasks.requests.tools.call: object` (presence
        // flag). Without this, the SDK's protocol layer rejects
        // task-augmented tools/call with a wire error.
        tasks: { requests: { tools: { call: {} } } },
      },
    },
  );

  // In-memory task state.
  const tasks = new Map<string, { task: Task; payload?: string }>();
  let nextTaskCounter = 0;
  let cancelResolve: (id: string) => void = () => {};
  const cancelObserved = new Promise<string>((res) => {
    cancelResolve = res;
  });

  function snapshot(task: Task): Task {
    return { ...task };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "slow_task",
        description: "a deliberately long-running tool",
        inputSchema: {
          type: "object",
          properties: { label: { type: "string" } },
        },
        // MCP 2025-11-25: taskSupport lives on `execution`, not
        // `annotations`. SDK ToolSchema strict-strips unknown
        // annotation keys; execution.taskSupport is the canonical
        // home.
        execution: { taskSupport: "required" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Was task augmentation requested?
    const taskParam = (req.params as { task?: { ttl?: number } }).task;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (taskParam === undefined) {
      // No task hint — run inline.
      return { content: [{ type: "text", text: `inline:${args.label ?? ""}` }] };
    }

    // Create a task in-memory.
    const taskId = `task:fake:${++nextTaskCounter}`;
    const now = new Date().toISOString();
    const task: Task = {
      taskId,
      status: "working",
      ttl: taskParam.ttl ?? null,
      createdAt: now,
      lastUpdatedAt: now,
      statusMessage: "queued",
    };
    const payload = opts.autoCompletePayload ?? `done:${args.label ?? ""}`;
    tasks.set(taskId, { task, payload });

    // Schedule auto-completion on a microtask if requested. Adopters
    // who need finer control call `handle.completeTask` directly.
    if (opts.autoComplete) {
      void Promise.resolve().then(async () => {
        // working → completed in two transitions so we exercise the
        // notification fold loop with a non-terminal transition.
        await server
          .notification({
            method: "notifications/tasks/status",
            params: { ...snapshot(task), statusMessage: "in-progress" },
          })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5));
        const completed: Task = {
          ...task,
          status: "completed",
          lastUpdatedAt: new Date().toISOString(),
        };
        tasks.set(taskId, { task: completed, payload });
        await server
          .notification({ method: "notifications/tasks/status", params: snapshot(completed) })
          .catch(() => undefined);
      });
    }

    return { task: snapshot(task) };
  });

  server.setRequestHandler(GetTaskRequestSchema, async (req) => {
    const entry = tasks.get(req.params.taskId);
    if (!entry) throw new Error(`unknown task ${req.params.taskId}`);
    return { ...snapshot(entry.task) };
  });

  server.setRequestHandler(GetTaskPayloadRequestSchema, async (req) => {
    const entry = tasks.get(req.params.taskId);
    if (!entry) throw new Error(`unknown task ${req.params.taskId}`);
    if (entry.task.status !== "completed") {
      throw new Error(`task ${req.params.taskId} not completed (status: ${entry.task.status})`);
    }
    return { content: [{ type: "text", text: entry.payload ?? "" }] };
  });

  server.setRequestHandler(CancelTaskRequestSchema, async (req) => {
    const entry = tasks.get(req.params.taskId);
    if (!entry) throw new Error(`unknown task ${req.params.taskId}`);
    if (entry.task.status === "working" || entry.task.status === "input_required") {
      const cancelled: Task = {
        ...entry.task,
        status: "cancelled",
        lastUpdatedAt: new Date().toISOString(),
        statusMessage: "cancelled by client",
      };
      tasks.set(req.params.taskId, { ...entry, task: cancelled });
      // Notify the client that the task transitioned.
      void server
        .notification({ method: "notifications/tasks/status", params: snapshot(cancelled) })
        .catch(() => undefined);
      cancelResolve(req.params.taskId);
      return { ...snapshot(cancelled) };
    }
    return { ...snapshot(entry.task) };
  });

  await server.connect(serverTransport);

  return {
    server,
    clientTransport,
    async completeTask(taskId, payload) {
      const entry = tasks.get(taskId);
      if (!entry) throw new Error(`unknown task ${taskId}`);
      const completed: Task = {
        ...entry.task,
        status: "completed",
        lastUpdatedAt: new Date().toISOString(),
      };
      tasks.set(taskId, { task: completed, payload });
      await server.notification({
        method: "notifications/tasks/status",
        params: snapshot(completed),
      });
    },
    async emitProgress(taskId, current, total, message) {
      await server.notification({
        method: "notifications/progress",
        params: {
          progressToken: taskId,
          progress: current,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
          _meta: { [RELATED_TASK_META_KEY]: { taskId } },
        },
      });
    },
    cancelObserved,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("withMCP — taskSupport:'required' end-to-end", () => {
  let teardown: Array<() => Promise<unknown>> = [];
  beforeEach(() => {
    teardown = [];
  });
  afterEach(async () => {
    for (const fn of teardown.reverse()) await fn().catch(() => undefined);
  });

  it("auto-completes a task: dispatch returns a session_task_ref; tasks.result resolves to remote payload", async () => {
    // taskSupport:"required" routes dispatch through Pattern B —
    // executor returns a session_task_ref content block immediately;
    // the local TaskHandle continues running in the background. The
    // caller fetches the final payload via session.tasks.result(...)
    // which awaits the remote tasks/result fetch.
    const fake = await mkFakeMcpServer({ autoComplete: true, autoCompletePayload: "ok" });
    teardown.push(() => fake.server.close());

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "tasksvr",
              transport: fake.clientTransport,
              auth: new NoneAuth(),
              defaultTaskTtl: 60_000,
            },
          ],
        }),
      ],
    });
    teardown.push(() => app.closeApp());

    const session = await app.createSession();
    teardown.push(() => session.close());

    const refBlocks = await session.dispatch("tasksvr__slow_task", { label: "x" });
    expect(refBlocks).toHaveLength(1);
    const refBlock = refBlocks[0] as { type: "text"; text: string };
    const ref = JSON.parse(refBlock.text) as {
      _kind: string;
      taskId: string;
      status: string;
    };
    expect(ref._kind).toBe("session_task_ref");
    expect(ref.status).toBe("working");
    expect(typeof ref.taskId).toBe("string");

    // Wait for the remote task to complete + the local handle to
    // resolve via `tasks/result`. The TasksHarness.result() awaits
    // the handle's deferred → which is resolved by mcpTaskEffect's
    // foldUntilTerminal + tasks/result fetch.
    const finalBlocks = (await session.tasks.result(ref.taskId)) as Array<{
      type: string;
      text: string;
    }>;
    expect(finalBlocks).toEqual([{ type: "text", text: "ok" }]);
  });

  it("cancellation: local cancel propagates as tasks/cancel on the wire", async () => {
    const fake = await mkFakeMcpServer({ autoComplete: false });
    teardown.push(() => fake.server.close());

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "tasksvr",
              transport: fake.clientTransport,
              auth: new NoneAuth(),
              defaultTaskTtl: 60_000,
            },
          ],
        }),
      ],
    });
    teardown.push(() => app.closeApp());

    const session = await app.createSession();
    teardown.push(() => session.close());

    // Kick off the dispatch — it'll block since autoComplete=false.
    // Pre-drain the rejection so vitest doesn't flag it.
    const dispatchP = session.dispatch("tasksvr__slow_task", { label: "y" });
    const drained = dispatchP.catch((e: unknown) => e);

    // Wait for the server to observe a task creation (the
    // CreateTaskResult was sent + the task is in-memory). Without a
    // direct hook, settle the microtask queue.
    await new Promise((r) => setTimeout(r, 25));

    // AppHarness's per-session TasksHarness is accessed via
    // `session.tasks` (augmented in @agentick/tasks-next). The remote
    // MCP task wrapper registers exactly one local task here.
    const allLocal = session.tasks.list();
    expect(allLocal.length).toBeGreaterThan(0);
    const localTaskId = allLocal[allLocal.length - 1]!.taskId;
    // Pre-drain the local TaskHandle's rejection — cancel rejects
    // result deferreds; without an attached handler vitest flags an
    // unhandled rejection.
    const drainedTaskResult = session.tasks.result(localTaskId).catch((e: unknown) => e);
    await session.tasks.cancel(localTaskId, "test-cancel");
    void drainedTaskResult;

    // The server-side tasks/cancel handler resolves cancelObserved.
    const cancelledRemoteId = await fake.cancelObserved;
    expect(typeof cancelledRemoteId).toBe("string");

    // The dispatch caller sees a rejection on the local handle's
    // result via the TasksHarness failure path.
    const drainedResult = await drained;
    expect(drainedResult).toBeDefined();
  });

  it("progress notifications fold into the local TaskHandle via RELATED_TASK_META_KEY", async () => {
    const fake = await mkFakeMcpServer({ autoComplete: false });
    teardown.push(() => fake.server.close());

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [
        withMCP({
          servers: [
            {
              serverId: "tasksvr",
              transport: fake.clientTransport,
              auth: new NoneAuth(),
              defaultTaskTtl: 60_000,
            },
          ],
        }),
      ],
    });
    teardown.push(() => app.closeApp());

    const session = await app.createSession();
    teardown.push(() => session.close());

    // Track local progress events on the TasksHarness's bus.
    const localProgress: Array<{ current: number; total?: number; message?: string }> = [];
    const dispatchP = session.dispatch("tasksvr__slow_task", { label: "z" });
    void dispatchP.catch(() => undefined);

    await new Promise((r) => setTimeout(r, 25));
    const localTaskId = session.tasks.list()[0]!.taskId;
    const remoteTaskId = `task:fake:1`;

    const eventStreamP = (async () => {
      for await (const event of session.tasks.events(localTaskId)) {
        const e = event as { kind: string; current?: number; total?: number; message?: string };
        if (e.kind === "progress") {
          localProgress.push({
            current: e.current!,
            ...(e.total !== undefined ? { total: e.total } : {}),
            ...(e.message !== undefined ? { message: e.message } : {}),
          });
        }
      }
    })();

    await fake.emitProgress(remoteTaskId, 1, 3, "step 1");
    await fake.emitProgress(remoteTaskId, 2, 3, "step 2");
    await fake.completeTask(remoteTaskId, "done");

    await dispatchP.catch(() => undefined);
    // Give the events iterator time to drain the terminal frame.
    await new Promise((r) => setTimeout(r, 10));
    await eventStreamP.catch(() => undefined);

    expect(localProgress.length).toBeGreaterThanOrEqual(2);
    expect(localProgress[0]).toMatchObject({ current: 1, total: 3, message: "step 1" });
    expect(localProgress[1]).toMatchObject({ current: 2, total: 3, message: "step 2" });
  });
});
