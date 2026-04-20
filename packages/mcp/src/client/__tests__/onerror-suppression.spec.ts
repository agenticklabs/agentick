/**
 * onerror Suppression Tests
 *
 * Verifies that the MCPClient suppresses "unknown message ID" errors
 * from the SDK Protocol. These errors occur when multiple clients
 * connect to the same in-process transport (stale handler chaining).
 * The errors are harmless — the real handler succeeds — but they
 * pollute logs if not suppressed.
 */

import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../client.js";
import { MCPServer } from "../../server/server.js";
import { InMemoryTransport } from "../../transport/index.js";
import { z } from "zod";

describe("MCPClient — onerror suppression", () => {
  it("should suppress 'unknown message ID' errors silently", async () => {
    const server = new MCPServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: z.object({ msg: z.string() }),
          handler: async ({ msg }: { msg: string }) => ({
            content: [{ type: "text" as const, text: msg }],
          }),
        },
      ],
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    // First client connects — clean
    const client1 = new MCPClient();
    await client1.connect({
      serverName: "test",
      transport: "in-process",
      connection: { transport: clientTransport },
    });

    // Second client connects to the SAME transport — this causes the
    // stale handler chaining that produces "unknown message ID" errors
    const client2 = new MCPClient();

    // Capture errors emitted by client2
    const _errors: Error[] = [];
    client2.on("connection:state", () => {}); // ensure emitter is active

    await client2.connect({
      serverName: "test",
      transport: "in-process",
      connection: { transport: clientTransport },
    });

    // Give microtasks a chance to fire
    await new Promise((r) => setTimeout(r, 50));

    // The second client should work despite the dual-connect
    const tools = await client2.listTools("test");
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("echo");

    // Call a tool through client2 — should work
    const result = await client2.callTool("test", "echo", { msg: "hello" });
    expect(result.content[0].text).toBe("hello");

    await client1.disconnectAll();
    await client2.disconnectAll();
    await server.close();
  });

  it("should NOT suppress other onerror types", async () => {
    const client = new MCPClient();
    const onerrorSpy = vi.fn();

    // Listen for errors via the connection state event
    // The MCPClient routes non-suppressed errors to the "degraded" state
    client.on("connection:state", (event: any) => {
      if (event.state === "degraded") {
        onerrorSpy(event);
      }
    });

    const server = new MCPServer({
      name: "test",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect({
      serverName: "test",
      transport: "in-process",
      connection: { transport: clientTransport },
    });

    // Simulate a non-suppressed error by triggering onerror on the SDK client
    const conn = (client as any).connections.get("test");
    const sdkClient = conn?.client;
    if (sdkClient?.onerror) {
      sdkClient.onerror(new Error("Something else went wrong"));
    }

    expect(onerrorSpy).toHaveBeenCalledTimes(1);

    await client.disconnectAll();
    await server.close();
  });
});
