/**
 * Tests for the `session_tasks_*` model-facing tools registered by
 * `withTasks()` (#157).
 *
 * Tests drive each tool's handler directly with a stub `ToolHandlerCtx`
 * carrying a real {@link TasksHarness} — no tool-executor in this
 * package's dep tree (keeping `tasks-next` ↔ `tool-executor-next`
 * acyclic; full end-to-end coverage already exists in
 * `tool-executor-next/__tests__/task-handle.spec.ts`).
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock, ToolHandlerCtx } from "@agentick/spec-next";
import { drainRejection } from "@agentick/utils-next/testing";

import { TasksHarness } from "../harness.js";
import {
  SESSION_TASKS_LIST,
  SESSION_TASKS_GET,
  SESSION_TASKS_CANCEL,
  SESSION_TASKS_AWAIT,
  buildSessionTasksTools,
} from "../tools.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  readonly tasks: TasksHarness;
  readonly close: () => Promise<void>;
  readonly handlerOf: (
    name: string,
  ) => (input: Readonly<Record<string, unknown>>) => Promise<readonly ContentBlock[]>;
}

async function fixture(sessionId = "test-session"): Promise<Fixture> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  const tasks = new TasksHarness(`${sessionId}:tasks`, journal, bus, inbox);
  await tasks.ready;

  const bundle = buildSessionTasksTools(sessionId);
  const handlersByName = new Map<string, (typeof bundle.handlers)[number]["handler"]>();
  for (const reg of bundle.registrations) {
    const handler = bundle.handlers.find((h) => h.handlerRef === reg.handlerRef);
    if (handler === undefined) throw new Error(`missing handler for ${reg.declaration.name}`);
    handlersByName.set(reg.declaration.name, handler.handler);
  }

  const baseCtx = {
    toolCallId: "tc",
    signal: new AbortController().signal,
    setState: () => {},
    emit: () => {},
    tasks,
  } as unknown as ToolHandlerCtx;

  return {
    tasks,
    close: async () => {
      await tasks.close();
    },
    handlerOf:
      (name) =>
      async (input): Promise<readonly ContentBlock[]> => {
        const handler = handlersByName.get(name);
        if (handler === undefined) throw new Error(`unknown tool ${name}`);
        const result = await handler(input, { ctx: baseCtx, use: {} });
        return result as readonly ContentBlock[];
      },
  };
}

function parseJsonBlock(blocks: readonly ContentBlock[]): Record<string, unknown> {
  const first = blocks[0] as { text?: string } | undefined;
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// session_tasks_list
// ---------------------------------------------------------------------------

describe("session_tasks_list", () => {
  it("returns an empty list when no tasks are running", async () => {
    const fx = await fixture();
    try {
      const blocks = await fx.handlerOf(SESSION_TASKS_LIST)({});
      expect(parseJsonBlock(blocks)).toEqual({ tasks: [] });
    } finally {
      await fx.close();
    }
  });

  it("lists every active and recently-terminal task in the session", async () => {
    const fx = await fixture();
    try {
      const a = fx.tasks.submit(async () => [{ type: "text", text: "a" } as ContentBlock]);
      const b = fx.tasks.submit(async () => [{ type: "text", text: "b" } as ContentBlock]);
      const blocks = await fx.handlerOf(SESSION_TASKS_LIST)({});
      const payload = parseJsonBlock(blocks) as { tasks: { taskId: string }[] };
      const ids = payload.tasks.map((t) => t.taskId).sort();
      expect(ids).toEqual([a.taskId, b.taskId].sort());
    } finally {
      await fx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// session_tasks_get
// ---------------------------------------------------------------------------

describe("session_tasks_get", () => {
  it("returns the TaskInfo for a known taskId", async () => {
    const fx = await fixture();
    try {
      const handle = fx.tasks.submit(async () => [{ type: "text", text: "ok" } as ContentBlock], {
        statusMessage: "running",
      });
      const blocks = await fx.handlerOf(SESSION_TASKS_GET)({ taskId: handle.taskId });
      const payload = parseJsonBlock(blocks) as { task: { taskId: string } };
      expect(payload.task.taskId).toBe(handle.taskId);
    } finally {
      await fx.close();
    }
  });

  it("returns { error: 'unknown_task' } for an unknown taskId", async () => {
    const fx = await fixture();
    try {
      const blocks = await fx.handlerOf(SESSION_TASKS_GET)({ taskId: "task:nope" });
      expect(parseJsonBlock(blocks)).toEqual({ error: "unknown_task", taskId: "task:nope" });
    } finally {
      await fx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// session_tasks_cancel
// ---------------------------------------------------------------------------

describe("session_tasks_cancel", () => {
  it("cancels an in-flight task; subsequent get reports cancelled status", async () => {
    const fx = await fixture();
    try {
      const handle = fx.tasks.submit(async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return [];
      });
      const blocks = await fx.handlerOf(SESSION_TASKS_CANCEL)({
        taskId: handle.taskId,
        reason: "model_cancel",
      });
      expect(parseJsonBlock(blocks)).toEqual({ cancelled: handle.taskId });
      // Drain the rejected handle.result so vitest doesn't flag it as unhandled.
      await drainRejection(handle.result);
      expect(fx.tasks.get(handle.taskId)?.status).toBe("cancelled");
    } finally {
      await fx.close();
    }
  });

  it("returns { error: 'unknown_task' } for an unknown taskId", async () => {
    const fx = await fixture();
    try {
      const blocks = await fx.handlerOf(SESSION_TASKS_CANCEL)({ taskId: "task:nope" });
      expect(parseJsonBlock(blocks)).toEqual({ error: "unknown_task", taskId: "task:nope" });
    } finally {
      await fx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// session_tasks_await
// ---------------------------------------------------------------------------

describe("session_tasks_await", () => {
  it("resolves with the task's content blocks on `completed`", async () => {
    const fx = await fixture();
    try {
      const handle = fx.tasks.submit(async () => [
        { type: "text", text: "finished" } as ContentBlock,
      ]);
      const blocks = await fx.handlerOf(SESSION_TASKS_AWAIT)({ taskId: handle.taskId });
      expect((blocks[0] as { text: string }).text).toBe("finished");
    } finally {
      await fx.close();
    }
  });

  it("returns a structured failure block when the task is cancelled mid-await", async () => {
    const fx = await fixture();
    try {
      const handle = fx.tasks.submit(async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return [];
      });
      // Cancel after the await tool begins waiting.
      setTimeout(() => {
        void drainRejection(fx.tasks.cancel(handle.taskId, "outside_cancel"));
      }, 10);
      const blocks = await fx.handlerOf(SESSION_TASKS_AWAIT)({ taskId: handle.taskId });
      const payload = parseJsonBlock(blocks) as { error?: string; status?: string };
      expect(payload.error).toBe("task_failed");
      expect(payload.status).toBe("cancelled");
    } finally {
      await fx.close();
    }
  });

  it("returns { error: 'unknown_task' } for an unknown taskId", async () => {
    const fx = await fixture();
    try {
      const blocks = await fx.handlerOf(SESSION_TASKS_AWAIT)({ taskId: "task:nope" });
      expect(parseJsonBlock(blocks)).toEqual({ error: "unknown_task", taskId: "task:nope" });
    } finally {
      await fx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle wiring
// ---------------------------------------------------------------------------

describe("buildSessionTasksTools (bundle shape)", () => {
  it("returns four registrations and four matching handlers", () => {
    const bundle = buildSessionTasksTools("s1");
    expect(bundle.registrations).toHaveLength(4);
    expect(bundle.handlers).toHaveLength(4);
    const names = bundle.registrations.map((r) => r.declaration.name).sort();
    expect(names).toEqual(
      [SESSION_TASKS_LIST, SESSION_TASKS_GET, SESSION_TASKS_CANCEL, SESSION_TASKS_AWAIT].sort(),
    );
  });

  it("handler refs are namespaced by sessionId — zero overlap across sessions", () => {
    const a = buildSessionTasksTools("session-A");
    const b = buildSessionTasksTools("session-B");
    const aRefs = a.handlers.map((h) => h.handlerRef);
    const bRefs = b.handlers.map((h) => h.handlerRef);
    for (const ref of aRefs) expect(ref).toContain("session-A");
    for (const ref of bRefs) expect(ref).toContain("session-B");
    expect(aRefs.some((r) => bRefs.includes(r))).toBe(false);
  });

  it("all four tools are bound at session-extension level", () => {
    const bundle = buildSessionTasksTools("s1");
    for (const reg of bundle.registrations) {
      expect(reg.binding).toMatchObject({
        scope: "extension",
        level: "session",
        extensionName: "@agentick/tasks-next",
      });
    }
  });

  it("declarations expose model + dispatch and explicit input schemas", () => {
    const bundle = buildSessionTasksTools("s1");
    for (const reg of bundle.registrations) {
      expect(reg.declaration.exposure).toEqual(["model", "dispatch"]);
      expect(reg.declaration.inputSchema).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Extension factory smoke (option surface only — full install path is
// covered by `app-extensions` integration tests when a session is created)
// ---------------------------------------------------------------------------

describe("withTasks() factory", () => {
  it("default factory shape is `{ name, target: 'session', install }`", async () => {
    const { withTasks } = await import("../extension.js");
    const ext = withTasks();
    expect(ext.name).toBe("@agentick/tasks-next");
    expect(ext.target).toBe("session");
    expect(typeof ext.install).toBe("function");
  });

  it("accepts { registerModelTools: false } as a typed option", async () => {
    const { withTasks } = await import("../extension.js");
    const ext = withTasks({ registerModelTools: false });
    expect(ext.name).toBe("@agentick/tasks-next");
  });
});
