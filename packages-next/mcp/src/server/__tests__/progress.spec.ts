/**
 * MCP progress projection (ADR 64) — `ctx.progress` → bus →
 * `installProgressProjection` → `notifications/progress`.
 *
 * Real in-memory server↔client round-trip, mirroring the logging
 * projection suite. A dispatched tool calls `ctx.progress(...)`; the
 * per-connection progress projection forwards the resulting bus event
 * to the wire.
 *
 * Note on token routing: the SDK client's DEFAULT progress handler only
 * accepts a `notifications/progress` whose token maps to an in-flight
 * request (it does `Number(progressToken)` → messageId lookup). This
 * test overrides that handler via `setNotificationHandler(
 * ProgressNotificationSchema, ...)` so it captures EVERY progress
 * notification regardless of token — we're asserting the server-side
 * projection fires, not the SDK's client-side correlation. Correlating
 * a handler's progress token to the request's `_meta.progressToken` is
 * the separate client-wire stitch tracked by TODO(#19-progress-wire).
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import {
  inMemoryServerTransport,
  McpServerHarness,
  type McpServerOptions,
  type ToolHandlerResolver,
} from "../index.js";

async function makeConnectedClient(options: Omit<McpServerOptions, "transports">): Promise<{
  readonly client: McpClient;
  readonly cleanup: () => Promise<void>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { transports: [transport], serverInfo: { name: "test", version: "0.0.0" }, ...options },
  );
  await harness.ready;
  await harness.start();
  const clientTransport = await transport.connect();
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await harness.close();
    },
  };
}

function progressToolDeclaration(): ToolDeclaration {
  return {
    id: "do_work",
    name: "do_work",
    description: "emits progress then completes",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model"],
    handlerRef: "handler:do_work",
  };
}

const progressHandlerResolver: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:do_work") return null;
  return async (_input, ctx) => {
    ctx.progress("tok-A", { progress: 1, total: 3, message: "step 1" });
    ctx.progress("tok-A", { progress: 3, total: 3 });
    const content: ContentBlock[] = [{ type: "text", text: "done" }];
    return { kind: "inline", content };
  };
};

describe("progress projection — ctx.progress round-trip (ADR 64)", () => {
  it("forwards ctx.progress bus events to notifications/progress with token + fields", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "prog",
      tools: { registry: [progressToolDeclaration()], resolveHandler: progressHandlerResolver },
    });
    const received: Array<{
      progressToken: unknown;
      progress: number;
      total?: number;
      message?: string;
    }> = [];
    // Override the SDK's token-routing default so we capture all progress.
    client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
      received.push({
        progressToken: n.params.progressToken,
        progress: n.params.progress,
        total: n.params.total,
        message: n.params.message,
      });
    });

    await client.callTool({ name: "do_work", arguments: {} });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toEqual([
      { progressToken: "tok-A", progress: 1, total: 3, message: "step 1" },
      { progressToken: "tok-A", progress: 3, total: 3, message: undefined },
    ]);
    await cleanup();
  });

  it("progress needs no capability gate — fires even with logging opted out", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "prog-nolog",
      capabilities: { logging: false },
      tools: { registry: [progressToolDeclaration()], resolveHandler: progressHandlerResolver },
    });
    const received: unknown[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
      received.push(n.params);
    });

    await client.callTool({ name: "do_work", arguments: {} });
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(2);
    await cleanup();
  });
});
