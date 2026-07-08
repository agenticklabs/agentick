/**
 * Cross-connection signal isolation (ADR 64) — the load-bearing
 * multi-tenant guarantee.
 *
 * TWO clients (A and B) connect to ONE `McpServerHarness`. A tool
 * invoked over connection A calls `ctx.log(...)` AND `ctx.progress(...)`.
 * Connection B must receive NEITHER — no `notifications/message`, no
 * `notifications/progress`. The isolation is structural: each
 * connection's log/progress projection subscribes with a
 * `connectionScope` filter (`{ mcpConnectionId, mcpServerId }`), and the
 * per-request ctx emits signals stamped with THAT connection's scope, so
 * a signal from A's tool never matches B's subscription.
 *
 * MUTATION CHECK (performed during authoring): removing the
 * `connectionScope` filter from `installLogProjection` /
 * `installProgressProjection` (subscribing with no scope) makes B leak —
 * this test then FAILS on both the log and progress assertions. The
 * filter was restored after confirming the catch. See the harden report.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { inMemoryServerTransport, McpServerHarness, type ToolHandlerResolver } from "../index.js";

function signalToolDeclaration(): ToolDeclaration {
  return {
    id: "emit_signals",
    name: "emit_signals",
    description: "emits one log + one progress signal",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model"],
    handlerRef: "handler:emit_signals",
  };
}

const signalResolver: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:emit_signals") return null;
  return async (_input, ctx) => {
    ctx.log("warning", { msg: "secret-for-A" }, "tenant-A");
    ctx.progress("A-token", { progress: 1, total: 1, message: "A-only" });
    const content: ContentBlock[] = [{ type: "text", text: "done" }];
    return { kind: "inline", content };
  };
};

/** Attach capturing notification handlers for BOTH signal families. */
function capture(client: McpClient): {
  readonly logs: unknown[];
  readonly progress: unknown[];
} {
  const logs: unknown[] = [];
  const progress: unknown[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
    logs.push(n.params);
  });
  client.setNotificationHandler(ProgressNotificationSchema, async (n) => {
    progress.push(n.params);
  });
  return { logs, progress };
}

describe("cross-connection signal isolation (ADR 64 — multi-tenant guarantee)", () => {
  it("a tool's log + progress over connection A never reach connection B", async () => {
    // ONE server, TWO connections.
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        name: "multi-tenant",
        tools: { registry: [signalToolDeclaration()], resolveHandler: signalResolver },
      },
    );
    await harness.ready;
    await harness.start();

    const clientTransportA = await transport.connect();
    const clientTransportB = await transport.connect();
    const clientA = new McpClient({ name: "client-A", version: "0.0.0" }, { capabilities: {} });
    const clientB = new McpClient({ name: "client-B", version: "0.0.0" }, { capabilities: {} });
    await clientA.connect(clientTransportA);
    await clientB.connect(clientTransportB);

    const capA = capture(clientA);
    const capB = capture(clientB);

    // Invoke the tool over connection A ONLY.
    await clientA.callTool({ name: "emit_signals", arguments: {} });
    // Generous settle window — if B were going to leak, the fan-out
    // would have delivered by now.
    await new Promise((r) => setTimeout(r, 30));

    // A received its own signals …
    expect(capA.logs).toHaveLength(1);
    expect(capA.logs[0]).toMatchObject({ level: "warning", data: { msg: "secret-for-A" } });
    expect(capA.progress).toHaveLength(1);
    expect(capA.progress[0]).toMatchObject({ progressToken: "A-token", progress: 1 });

    // … and B received NEITHER. This is the security assertion the
    // mutation check targets.
    expect(capB.logs).toEqual([]);
    expect(capB.progress).toEqual([]);

    await clientA.close();
    await clientB.close();
    await harness.close();
  });
});
