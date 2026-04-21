/**
 * MCPClient Progress E2E Test
 *
 * Verifies that the MCPClient's onProgress callback receives progress
 * notifications from the server's ctx.sendProgress() through the SDK's
 * built-in progress plumbing (progressToken = requestId).
 */

import { describe, it, expect } from "vitest";
import { MCPClient } from "../client.js";
import { MCPServer } from "../../server/server.js";
import { InMemoryTransport } from "../../transport/index.js";
import { z } from "zod";

describe("MCPClient — onProgress e2e", () => {
  it("receives progress from server tool via onProgress callback", async () => {
    const server = new MCPServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "slow",
          description: "Reports progress",
          inputSchema: z.object({}),
          handler: async (_input: any, ctx: any) => {
            await ctx.sendProgress?.(1, 3, "Step 1");
            await ctx.sendProgress?.(2, 3, "Step 2");
            await ctx.sendProgress?.(3, 3, "Complete");
            return { content: [{ type: "text" as const, text: "done" }] };
          },
        },
      ],
    });

    const client = new MCPClient();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect({
      serverName: "t",
      transport: "in-process",
      connection: { transport: ct },
    });

    const progress: any[] = [];
    const result = await client.callTool(
      "t",
      "slow",
      {},
      {
        onProgress: (p) => progress.push(p),
      },
    );

    expect(result.content[0].text).toBe("done");
    expect(progress.length).toBe(3);
    expect(progress[0]).toEqual({ progress: 1, total: 3, message: "Step 1" });
    expect(progress[1]).toEqual({ progress: 2, total: 3, message: "Step 2" });
    expect(progress[2]).toEqual({ progress: 3, total: 3, message: "Complete" });

    await client.disconnectAll();
    await server.close();
  });

  it("receives no progress when tool doesn't call sendProgress", async () => {
    const server = new MCPServer({
      name: "test",
      version: "1.0.0",
      tools: [
        {
          name: "fast",
          description: "No progress",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text" as const, text: "quick" }] }),
        },
      ],
    });

    const client = new MCPClient();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect({
      serverName: "t",
      transport: "in-process",
      connection: { transport: ct },
    });

    const progress: any[] = [];
    const result = await client.callTool(
      "t",
      "fast",
      {},
      {
        onProgress: (p) => progress.push(p),
      },
    );

    expect(result.content[0].text).toBe("quick");
    expect(progress.length).toBe(0);

    await client.disconnectAll();
    await server.close();
  });
});
