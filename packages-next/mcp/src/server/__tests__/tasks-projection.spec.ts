/**
 * Tasks projection — Pattern B over the MCP wire (#171d.3).
 *
 * Drives the full round trip:
 *
 *   1. Server harness with a `taskSupport: "required"` tool.
 *   2. SDK Client connects over in-memory transport.
 *   3. `tools/list` advertises `execution.taskSupport: "required"`.
 *   4. `tools/call` returns `CreateTaskResult` (the `task` field
 *      discriminates from a regular `CallToolResult.content`).
 *   5. `tasks/get` reports the current status.
 *   6. `tasks/result` returns the original `CallToolResult.content`
 *      once the task completes.
 *   7. `tasks/list` enumerates registered tasks.
 *   8. Capability advertisement gates on a Pattern B tool being
 *      present.
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import { waitFor } from "@agentick/utils-next/testing";
import type { ContentBlock } from "@agentick/spec-next";
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

import { inMemoryServerTransport, McpServerHarness } from "../index.js";

async function makeServerWith(tools: ReturnType<typeof createTool>[]): Promise<{
  harness: McpServerHarness;
  transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "tasks-test-server",
      transports: [transport],
      tools,
      serverInfo: { name: "tasks-test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

async function makeClient(
  transport: Awaited<ReturnType<ReturnType<typeof inMemoryServerTransport>["connect"]>>,
): Promise<McpClient> {
  const client = new McpClient(
    { name: "tasks-test-client", version: "0.0.0" },
    { capabilities: { tasks: { listChanged: false } } },
  );
  await client.connect(transport);
  return client;
}

// A canonical Pattern B tool — kicks off a short-running task that
// completes with a single text block.
const LintRepo = createTool({
  name: "lint_repo",
  description: "Lint the repo as a background task.",
  inputSchema: z.object({ strict: z.boolean().optional() }),
  annotations: { taskSupport: "required" },
  handler: async ({ strict }, { ctx }) => {
    return ctx.tasks!.submit(async ({ signal }) => {
      // 50ms per stage; 3 stages; total ~150ms. Short enough for
      // tests; long enough that the initial response is "working".
      const stages = ["scanning", "applying-rules", "formatting"];
      for (const stage of stages) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        await new Promise<void>((r) => setTimeout(r, 30));
        void stage;
      }
      const summary = strict ? "0 errors, 0 warnings (strict)" : "0 errors, 3 warnings";
      return [{ type: "text", text: `lint complete — ${summary}` } as ContentBlock];
    });
  },
});

describe("MCP server tasks projection — Pattern B over the wire", () => {
  it("advertises tasks capability when a Pattern B tool is registered", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        expect(client.getServerCapabilities()?.tasks).toBeDefined();
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("does NOT advertise tasks capability with no Pattern B tools", async () => {
    const Inline = createTool({
      name: "echo",
      description: "Echo input",
      inputSchema: z.object({ text: z.string() }),
      handler: async ({ text }) => [{ type: "text", text } as ContentBlock],
    });
    const { harness, transport } = await makeServerWith([Inline]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        expect(client.getServerCapabilities()?.tasks).toBeUndefined();
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("emits execution.taskSupport on the wire tool descriptor", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        const list = await client.listTools();
        const tool = list.tools.find((t) => t.name === "lint_repo");
        expect(tool).toBeDefined();
        expect((tool as { execution?: { taskSupport?: string } }).execution?.taskSupport).toBe(
          "required",
        );
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("tools/call returns CreateTaskResult (task field) for a Pattern B tool", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        const raw = await client.request(
          { method: "tools/call", params: { name: "lint_repo", arguments: { strict: false } } },
          CallToolResultSchema.passthrough(),
        );
        const taskField = (raw as unknown as { task?: { taskId: string; status: string } }).task;
        expect(taskField).toBeDefined();
        expect(taskField?.taskId).toMatch(/^task:/);
        // Status is "working" immediately after submit; race-tolerant —
        // it might already be "completed" if the test machine is fast.
        expect(["working", "completed"]).toContain(taskField?.status);
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("tasks/get returns the current snapshot", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        const callRaw = await client.request(
          { method: "tools/call", params: { name: "lint_repo", arguments: {} } },
          CallToolResultSchema.passthrough(),
        );
        const taskId = (callRaw as unknown as { task: { taskId: string } }).task.taskId;
        const snapshot = await client.request(
          { method: "tasks/get", params: { taskId } },
          GetTaskResultSchema,
        );
        expect(snapshot.taskId).toBe(taskId);
        expect(["working", "completed"]).toContain(snapshot.status);
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("tasks/result returns the final CallToolResult payload", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        const callRaw = await client.request(
          { method: "tools/call", params: { name: "lint_repo", arguments: { strict: true } } },
          CallToolResultSchema.passthrough(),
        );
        const taskId = (callRaw as unknown as { task: { taskId: string } }).task.taskId;
        const payload = await client.request(
          { method: "tasks/result", params: { taskId } },
          GetTaskPayloadResultSchema,
        );
        expect(payload.isError).toBe(false);
        const content = payload.content as ReadonlyArray<{ type: string; text: string }>;
        const text = content[0]!.text;
        expect(text).toMatch(/lint complete — 0 errors, 0 warnings \(strict\)/);
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("tasks/list enumerates registered tasks", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        await client.request(
          { method: "tools/call", params: { name: "lint_repo", arguments: {} } },
          CallToolResultSchema.passthrough(),
        );
        await client.request(
          { method: "tools/call", params: { name: "lint_repo", arguments: {} } },
          CallToolResultSchema.passthrough(),
        );
        const list = await client.request({ method: "tasks/list" }, ListTasksResultSchema);
        expect(list.tasks.length).toBeGreaterThanOrEqual(2);
        for (const t of list.tasks) {
          expect(t.taskId).toMatch(/^task:/);
          expect(["working", "completed"]).toContain(t.status);
        }
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("projects a PRODUCED input_required status onto the wire (awaitingInput)", async () => {
    // The codec maps `input_required` 1:1 (a defined-but-previously-dead
    // wire state). This proves a task PRODUCES it: a Pattern B tool whose
    // work fn pauses via `ctx.awaitingInput` surfaces `input_required` on
    // `tasks/get`. A test-owned gate makes the pause deterministic — the
    // wire snapshot is asserted WHILE the gate is unresolved (no race).
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const AwaitsInput = createTool({
      name: "awaits_input",
      description: "Pauses awaiting external input, then completes.",
      inputSchema: z.object({}),
      annotations: { taskSupport: "required" },
      handler: async (_args, { ctx }) => {
        return ctx.tasks!.submit(async (task) => {
          await task.awaitingInput(gate, { message: "need input" });
          return [{ type: "text", text: "input provided" } as ContentBlock];
        });
      },
    });

    const { harness, transport } = await makeServerWith([AwaitsInput]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        const callRaw = await client.request(
          { method: "tools/call", params: { name: "awaits_input", arguments: {} } },
          CallToolResultSchema.passthrough(),
        );
        const taskId = (callRaw as unknown as { task: { taskId: string } }).task.taskId;

        // The gate is unresolved → the task is parked in input_required.
        // The WIRE snapshot must report it (produced, not just mapped).
        await waitFor(async () => {
          const snap = await client.request(
            { method: "tasks/get", params: { taskId } },
            GetTaskResultSchema,
          );
          return snap.status === "input_required";
        });
        const paused = await client.request(
          { method: "tasks/get", params: { taskId } },
          GetTaskResultSchema,
        );
        expect(paused.status).toBe("input_required");
        expect(paused.statusMessage).toBe("need input");

        // Provide the input → the task flips back to working and completes.
        releaseGate();
        const payload = await client.request(
          { method: "tasks/result", params: { taskId } },
          GetTaskPayloadResultSchema,
        );
        expect(payload.isError).toBe(false);
        const content = payload.content as ReadonlyArray<{ type: string; text: string }>;
        expect(content[0]!.text).toBe("input provided");
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("tasks/cancel returns a task snapshot in cancelled / terminal status", async () => {
    const { harness, transport } = await makeServerWith([LintRepo]);
    try {
      const client = await makeClient(await transport.connect());
      try {
        const callRaw = await client.request(
          { method: "tools/call", params: { name: "lint_repo", arguments: {} } },
          CallToolResultSchema.passthrough(),
        );
        const taskId = (callRaw as unknown as { task: { taskId: string } }).task.taskId;
        const cancelResult = await client.request(
          { method: "tasks/cancel", params: { taskId } },
          CancelTaskResultSchema,
        );
        expect(cancelResult.taskId).toBe(taskId);
        // Cancel is best-effort — by the time the wire response
        // round-trips, the task may have already completed. Both
        // "cancelled" and "completed" are valid terminal states.
        expect(["cancelled", "completed"]).toContain(cancelResult.status);
      } finally {
        await client.close();
      }
    } finally {
      await harness.close();
    }
  });
});
