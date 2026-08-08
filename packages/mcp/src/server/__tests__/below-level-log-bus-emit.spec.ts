/**
 * Below-level log still emits on the bus (ADR 64) — each PROJECTION
 * applies its own threshold; the emit itself is unconditional.
 *
 * The client sets `logging/setLevel` to `warning`. A tool logs one
 * `debug` line (below level) and one `error` line (at/above level).
 * Assert:
 *   - the MCP projection forwards ONLY the `error` line to the wire
 *     (`notifications/message`) — the `debug` line is filtered out;
 *   - an INDEPENDENT bus subscriber observes BOTH `:signal:log` events,
 *     including the `debug` one the MCP client never saw.
 *
 * This pins the ADR guarantee that a below-level log is NOT swallowed at
 * the source — the agentick app (or an observability sink) can still see
 * `debug` even when an MCP client asked for `warning` only. The MCP
 * client-facing threshold is a per-projection concern, not a gate on the
 * bus event.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { ContentBlock, LogEventPayload, ProtocolEvent, ToolDeclaration } from "@agentick/spec";
import { jsonSchema, logEventName, logEventQuery } from "@agentick/spec";

import { inMemoryServerTransport, McpServerHarness, type ToolHandlerResolver } from "../index.js";

function logToolDeclaration(): ToolDeclaration {
  return {
    id: "emit_logs",
    name: "emit_logs",
    description: "emits one debug + one error log line",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model"],
    handlerRef: "handler:emit_logs",
  };
}

const logResolver: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:emit_logs") return null;
  return async (_input, ctx) => {
    ctx.log("debug", { msg: "below-level-debug" }, "diag");
    ctx.log("error", { msg: "at-level-error" }, "diag");
    const content: ContentBlock[] = [{ type: "text", text: "done" }];
    return { kind: "inline", content };
  };
};

describe("below-level log still emits on the bus (ADR 64)", () => {
  it("MCP projection drops the debug line while an independent bus subscriber sees it", async () => {
    // Own the bus so an independent subscriber can observe the raw
    // signal events — the same bus the harness (and its log projection)
    // use.
    const bus = new LocalEventBus();
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      bus,
      new LocalInbox(),
      {
        transports: [transport],
        serverInfo: { name: "test", version: "0.0.0" },
        name: "below-level",
        tools: { registry: [logToolDeclaration()], resolveHandler: logResolver },
      },
    );
    await harness.ready;
    await harness.start();

    const clientTransport = await transport.connect();
    const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    // Independent bus subscriber — stands in for the agentick app /
    // observability sink. Collects raw `*:signal:log` bus events.
    const busLogs: ProtocolEvent[] = [];
    const busFiber = Effect.runFork(
      Stream.runForEach(bus.subscribe(logEventQuery()), (e) =>
        Effect.sync(() => {
          busLogs.push(e);
        }),
      ),
    );

    // Wire-facing capture.
    const wireLogs: Array<{ level: string; data: unknown }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      wireLogs.push({ level: n.params.level, data: n.params.data });
    });

    // Client only wants warning+ on the wire.
    await client.setLoggingLevel("warning");
    await client.callTool({ name: "emit_logs", arguments: {} });
    await new Promise((r) => setTimeout(r, 20));

    // Wire: the projection dropped the below-level `debug`, forwarded the
    // `error`.
    expect(wireLogs).toEqual([{ level: "error", data: { msg: "at-level-error" } }]);

    // Bus: BOTH signal events are present — the `debug` one the MCP
    // client never received is still observable on the bus.
    const levels = busLogs
      .filter((e) => e.name === logEventName("mcpServer"))
      .map((e) => (e.payload as LogEventPayload).level)
      .sort();
    expect(levels).toEqual(["debug", "error"]);

    await Effect.runPromise(Fiber.interrupt(busFiber));
    await client.close();
    await harness.close();
  });
});
